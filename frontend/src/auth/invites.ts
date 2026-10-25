import type { QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { Discarded } from './admission';
import type { Admission, Operation } from './admission';
import { AuthFailure, request } from './transport';
import { inviteCreatedSchema, inviteListSchema, inviteSchema } from './wire';
import type { Invite } from './wire';

type PrivateOperation = Extract<
  Operation,
  'inviteList' | 'inviteCreate' | 'inviteRevoke'
>;
export interface InvitesOwner {
  userId: string;
  revision: number;
  queries: QueryClient;
  fetcher: typeof fetch;
  signal: AbortSignal;
  csrf: string | undefined;
  capture: (operation: PrivateOperation) => ReturnType<Admission['capture']>;
  subscribe: (listener: () => void) => () => void;
  recheck: () => Promise<void>;
}
interface Snapshot {
  loaded: boolean;
  items: Invite[];
  next: string | null;
  loading: boolean;
  busy: boolean;
  token: string | null;
  message: string;
}
let sequence = 0;

/** A route lifetime, narrower than an identity revision. Secrets never enter Query. */
export class InvitesResource {
  private snapshot: Snapshot = {
    loaded: false,
    items: [],
    next: null,
    loading: false,
    busy: false,
    token: null,
    message: '',
  };
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private readonly ticket: ReturnType<Admission['capture']>;
  private readonly prefix: readonly unknown[];
  private readonly unsubscribe: () => void;
  private disposed = false;
  private loadSequence = 0;

  constructor(private readonly owner: InvitesOwner) {
    this.ticket = owner.capture('inviteList');
    this.prefix = [
      'private',
      owner.userId,
      'invites',
      owner.revision,
      ++sequence,
    ];
    this.unsubscribe = owner.subscribe(() => {
      try {
        this.current();
      } catch {
        this.dispose();
      }
    });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  current = () => {
    if (this.disposed) throw new Discarded();
    this.ticket.current();
  };
  private publish(patch: Partial<Snapshot>) {
    this.current();
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.owner.queries.removeQueries({ queryKey: this.prefix });
    for (const mutation of this.owner.queries.getMutationCache().getAll()) {
      if (mutation.options.mutationKey === this.prefix)
        this.owner.queries.getMutationCache().remove(mutation);
    }
    this.snapshot = {
      items: [],
      loaded: false,
      next: null,
      loading: false,
      busy: false,
      token: null,
      message: '',
    };
    this.listeners.clear();
    this.unsubscribe();
  };
  private async run<T>(
    operation: PrivateOperation,
    schema: z.ZodType<T>,
    body?: unknown,
    parameters?: { invite_id?: string; limit?: number; cursor?: string },
  ) {
    this.current();
    const lease = this.owner.capture(operation);
    const current = () => {
      this.current();
      lease.current();
    };
    const guarded = {
      ...lease,
      current,
      check: (stamp: string | null) => {
        current();
        lease.check(stamp);
      },
    };
    try {
      const data = await request(
        guarded,
        schema,
        AbortSignal.any([this.controller.signal, this.owner.signal]),
        this.owner.fetcher,
        this.owner.csrf,
        body,
        parameters,
      );
      current();
      return data;
    } catch (error) {
      current();
      if (
        error instanceof AuthFailure &&
        [401, 403, 412].includes(error.status)
      ) {
        void this.owner.recheck();
        throw new Discarded();
      }
      throw error;
    }
  }
  load = async (cursor?: string) => {
    this.current();
    const load = ++this.loadSequence;
    this.publish({ loading: true, message: '' });
    try {
      const data = await this.owner.queries.query({
        queryKey: [...this.prefix, cursor],
        queryFn: async () => {
          const data = await this.run(
            'inviteList',
            inviteListSchema,
            undefined,
            { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
          );
          this.current();
          return data;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
      });
      this.current();
      if (load !== this.loadSequence) return;
      this.publish({ items: data.items, next: data.next_cursor, loaded: true });
    } catch (error) {
      if (error instanceof Discarded || this.disposed) return;
      this.current();
      if (load === this.loadSequence)
        this.publish({
          message: 'Не удалось загрузить приглашения. Обновите список.',
        });
    } finally {
      if (!this.disposed && load === this.loadSequence)
        this.publish({ loading: false });
    }
  };
  private async mutate(work: () => Promise<void>, creating: boolean) {
    this.current();
    if (this.snapshot.busy) return;
    this.publish({ busy: true, token: null, message: '' });
    const mutation = this.owner.queries
      .getMutationCache()
      .build(this.owner.queries, {
        mutationKey: this.prefix,
        mutationFn: work,
        retry: false,
        gcTime: 0,
      });
    try {
      await mutation.execute(undefined);
      this.current();
      await this.load();
    } catch (error) {
      if (error instanceof Discarded || this.disposed) return;
      this.current();
      this.publish({
        message:
          error instanceof AuthFailure && error.status === 409
            ? 'Состояние приглашения изменилось. Обновите список; отзыв не повторяется автоматически.'
            : creating
              ? 'Результат создания не подтверждён. Секрет восстановить нельзя. Обновите список, отзовите лишнее и создайте новое только явно.'
              : 'Отзыв не подтверждён. Обновите список перед новым действием.',
      });
    } finally {
      this.owner.queries.getMutationCache().remove(mutation);
      if (!this.disposed) this.publish({ busy: false });
    }
  }
  create = () =>
    this.mutate(async () => {
      const data = await this.run('inviteCreate', inviteCreatedSchema, {});
      this.current();
      this.publish({
        token: data.invite_token,
        message:
          'Приглашение создано. Скопируйте секрет сейчас: повторно он не показывается.',
      });
    }, true);
  revoke = (invite: Invite) =>
    this.mutate(async () => {
      await this.run(
        'inviteRevoke',
        inviteSchema,
        { expected_version: invite.version },
        { invite_id: invite.id },
      );
      this.current();
      this.publish({ message: 'Приглашение отозвано.' });
    }, false);
  copy = async (write: (token: string) => Promise<void>) => {
    this.current();
    if (this.snapshot.token === null) return;
    try {
      await write(this.snapshot.token);
      this.current();
      this.publish({ message: 'Секрет скопирован по вашему действию.' });
    } catch (error) {
      if (error instanceof Discarded || this.disposed) return;
      this.current();
      this.publish({
        message:
          'Копирование недоступно. Выделите секрет и скопируйте вручную.',
      });
    }
  };
}
