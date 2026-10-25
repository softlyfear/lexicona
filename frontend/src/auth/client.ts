import { QueryClient } from '@tanstack/react-query';
import { Admission } from './admission';
import type { Principal } from './admission';
import { AuthFailure, request } from './transport';
import { InvitesResource } from './invites';
import {
  authSchema,
  csrfSchema,
  loginSchema,
  logoutSchema,
  meSchema,
  registerSchema,
} from './wire';
import type { User, Registration } from './wire';

type Phase =
  | 'unknown'
  | 'checking'
  | 'anonymous'
  | 'registering'
  | 'authenticated'
  | 'signing-out'
  | 'error';
export interface AuthSnapshot {
  phase: Phase;
  revision: number;
  user: User | null;
  privateQueries: QueryClient | null;
  message: string;
}
export type Serialize = (work: () => Promise<void>) => Promise<void>;
interface RegistrationFeedback {
  message: string;
  fields: Partial<Record<string, string[] | undefined>>;
}

/** Only this memory owner can attach a new identity+revision QueryClient. */
export class AuthClient {
  private snapshot: AuthSnapshot = {
    phase: 'unknown',
    revision: 0,
    user: null,
    privateQueries: null,
    message: '',
  };
  private readonly listeners = new Set<() => void>();
  private csrf: string | undefined;
  private controller = new AbortController();
  private tail = Promise.resolve();
  private recovering = false;
  private readonly admission = new Admission(() => {
    const signingOut = this.snapshot.phase === 'signing-out';
    this.hide(
      'error',
      'unknown',
      signingOut
        ? 'Серверный выход не подтверждён. Проверьте аккаунт.'
        : 'Аккаунт изменился. Повторите проверку.',
    );
    if (!this.recovering) {
      this.recovering = true;
      const generation = this.controller;
      queueMicrotask(() => {
        if (this.controller !== generation) {
          this.recovering = false;
          return;
        }
        void this.recheck().finally(() => {
          this.recovering = false;
        });
      });
    }
  });

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly serialize: Serialize = async (work) => {
      await work();
    },
    private readonly broadcast: () => void = () => {},
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(
    phase: Phase,
    message = '',
    user: User | null = null,
    privateQueries: QueryClient | null = null,
  ) {
    this.snapshot = {
      phase,
      revision: this.admission.revision,
      user,
      privateQueries,
      message,
    };
    for (const listener of this.listeners) listener();
  }

  private hide(
    phase: Phase,
    principal: Principal | 'unknown' = 'unknown',
    message = '',
  ) {
    this.admission.replace(principal);
    this.controller.abort();
    this.controller = new AbortController();
    this.csrf = undefined;
    const old = this.snapshot.privateQueries;
    if (old) {
      void old.cancelQueries();
      old.clear();
    }
    this.publish(phase, message);
  }

  suspend = () => {
    this.hide('unknown');
  };

  private async exclusive(work: () => Promise<void>) {
    const next = this.tail.then(async () => {
      await this.serialize(work);
    });
    this.tail = next.catch(() => {});
    await next;
  }

  private async identify(expected?: string) {
    let user: User | null = null;
    const meLease = this.admission.capture('me');
    try {
      const me = await request(
        meLease,
        meSchema,
        this.controller.signal,
        this.fetcher,
      );
      meLease.current();
      if (expected !== undefined && me.user.id !== expected)
        throw new AuthFailure();
      user = me.user;
    } catch (error) {
      meLease.current();
      if (!(
        error instanceof AuthFailure &&
        error.status === 401 &&
        expected === undefined
      ))
        throw error;
    }
    this.admission.replace(user ? `user:${user.id}` : 'anonymous');
    const lease = this.admission.capture('csrf');
    const csrf = await request(
      lease,
      csrfSchema,
      this.controller.signal,
      this.fetcher,
    );
    lease.consume(() => {
      this.csrf = csrf.csrf_token;
      this.publish(
        user ? 'authenticated' : 'anonymous',
        '',
        user,
        user
          ? new QueryClient({
              defaultOptions: {
                queries: { retry: false, gcTime: 0 },
                mutations: { retry: false },
              },
            })
          : null,
      );
    });
  }

  recheck = async () => {
    this.hide('checking');
    const ticket = this.admission.capture('me');
    const generation = this.controller;
    try {
      await this.exclusive(async () => {
        ticket.current();
        await this.identify();
      });
    } catch {
      if (this.controller !== generation) return;
      this.hide(
        'error',
        'unknown',
        'Не удалось проверить аккаунт. Повторите проверку.',
      );
    }
  };

  login = async (input: { login: string; password: string }) => {
    if (this.snapshot.phase !== 'anonymous') return;
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      this.publish('anonymous', 'Проверьте логин и пароль.');
      return;
    }
    const csrf = this.csrf;
    this.hide('checking', 'anonymous');
    const lease = this.admission.capture('login');
    const generation = this.controller;
    try {
      await this.exclusive(async () => {
        lease.current();
        const provisional = await request(
          lease,
          authSchema,
          this.controller.signal,
          this.fetcher,
          csrf,
          parsed.data,
        );
        lease.current();
        this.broadcast();
        // Resulting DTO is provisional. Only me may establish the identity.
        this.admission.replace('unknown');
        await this.identify(provisional.user.id);
      });
    } catch (error) {
      if (this.controller !== generation) return;
      if (
        error instanceof AuthFailure &&
        error.code === 'invalid_credentials'
      ) {
        this.csrf = csrf;
        this.publish('anonymous', 'Неверный логин или пароль.');
      } else
        this.hide(
          'error',
          'unknown',
          'Вход не подтверждён. Проверьте текущий аккаунт; не повторяйте вход автоматически.',
        );
    }
  };

  openInvites = () => {
    const { user, privateQueries, revision } = this.snapshot;
    if (
      this.snapshot.phase !== 'authenticated' ||
      user?.role !== 'admin' ||
      !privateQueries
    )
      throw new AuthFailure();
    return new InvitesResource({
      userId: user.id,
      revision,
      queries: privateQueries,
      fetcher: this.fetcher,
      signal: this.controller.signal,
      csrf: this.csrf,
      capture: (operation) => this.admission.capture(operation),
      subscribe: this.subscribe,
      recheck: this.recheck,
    });
  };

  cancelRegistration = () => {
    if (this.snapshot.phase === 'registering') void this.recheck();
  };

  register = async (
    input: Registration,
  ): Promise<RegistrationFeedback | undefined> => {
    if (this.snapshot.phase !== 'anonymous') return;
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success)
      return { message: 'Проверьте поля формы.', fields: {} };
    const csrf = this.csrf;
    const lease = this.admission.capture('register');
    const generation = this.controller;
    this.publish('registering');
    const outcome = { provisional: false };
    try {
      await this.exclusive(async () => {
        lease.current();
        const result = await request(
          lease,
          authSchema,
          this.controller.signal,
          this.fetcher,
          csrf,
          parsed.data,
        );
        lease.current();
        outcome.provisional = true;
        this.broadcast();
        this.csrf = undefined;
        this.admission.replace('unknown');
        this.publish('checking');
        await this.identify(result.user.id);
      });
    } catch (error) {
      if (this.controller !== generation) return;
      if (
        !outcome.provisional &&
        error instanceof AuthFailure &&
        ['validation_error', 'invite_invalid', 'login_unavailable'].includes(
          error.code,
        )
      ) {
        lease.current();
        this.publish('anonymous');
        const message =
          error.code === 'invite_invalid'
            ? 'Приглашение недействительно.'
            : error.code === 'login_unavailable'
              ? 'Логин недоступен.'
              : 'Проверьте поля формы.';
        return { message, fields: error.fields };
      }
      this.hide(
        'error',
        'unknown',
        'Регистрация не подтверждена. Проверьте текущий аккаунт; не отправляйте регистрацию повторно автоматически. Если вход не подтверждён, войдите явно с выбранными данными.',
      );
    }
  };

  logout = async () => {
    if (this.snapshot.phase !== 'authenticated') return;
    const principal = this.admission.principal;
    const csrf = this.csrf;
    this.hide('signing-out', principal);
    const lease = this.admission.capture('logout');
    const generation = this.controller;
    try {
      await this.exclusive(async () => {
        lease.current();
        const result = await request(
          lease,
          logoutSchema,
          this.controller.signal,
          this.fetcher,
          csrf,
          {},
        );
        lease.consume(() => {
          this.admission.replace('anonymous');
          this.csrf = result.csrf_token;
          this.publish('anonymous', 'Вы вышли из аккаунта.');
          this.broadcast();
        });
      });
    } catch {
      if (this.controller !== generation) return;
      this.hide(
        'error',
        'unknown',
        'Серверный выход не подтверждён. Личные данные скрыты; проверьте аккаунт.',
      );
    }
  };
}
