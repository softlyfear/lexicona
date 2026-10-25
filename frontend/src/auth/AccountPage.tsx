import { useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { QueryClientProvider } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { RegistrationForm } from './RegistrationForm';
import { InvitesPage } from './InvitesPage';
import type { AuthClient } from './client';
import { loginSchema } from './wire';
import styles from './AccountPage.module.css';

function LoginForm({ client }: { client: AuthClient }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<{ login: string; password: string }>({
    defaultValues: { login: '', password: '' },
  });
  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        void handleSubmit((values) => {
          reset();
          void client.login(values);
        })(event);
      }}
    >
      <label htmlFor="login">Логин</label>
      <input
        id="login"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={Boolean(errors.login)}
        aria-describedby="login-error"
        {...register('login', {
          validate: (value) =>
            loginSchema.shape.login.safeParse(value).success ||
            'Логин: 3–32 латинских буквы, цифры или _.',
        })}
      />
      <p id="login-error" className={styles.error}>
        {errors.login?.message}
      </p>
      <label htmlFor="password">Пароль</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        aria-invalid={Boolean(errors.password)}
        aria-describedby="password-error"
        {...register('password', {
          validate: (value) =>
            loginSchema.shape.password.safeParse(value).success ||
            'Пароль: от 12 до 128 символов.',
        })}
      />
      <p id="password-error" className={styles.error}>
        {errors.password?.message}
      </p>
      <button type="submit">Войти</button>
      <p>
        <Link to="/register">Регистрация по приглашению</Link>. Пароль не
        сохраняется приложением.
      </p>
    </form>
  );
}

export function AccountPage({
  client,
  dictionary = false,
  registration = false,
  invites = false,
}: {
  client: AuthClient;
  dictionary?: boolean;
  registration?: boolean;
  invites?: boolean;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  if (state.phase === 'authenticated' && state.user && state.privateQueries) {
    if (invites)
      return state.user.role === 'admin' ? (
        <InvitesPage key={state.revision} client={client} />
      ) : (
        <section>
          <h1>Недостаточно прав</h1>
          <p>Приглашения доступны только текущему администратору.</p>
          <Link className={styles.link} to="/dictionary">
            Вернуться в словарь
          </Link>
        </section>
      );
    if (!dictionary) return <Navigate to="/dictionary" replace />;
    return (
      <QueryClientProvider key={state.revision} client={state.privateQueries}>
        <section>
          <p>Текущий аккаунт</p>
          <strong>{state.user.display_name}</strong>
          <p className={styles.identity}>
            @{state.user.login} ·{' '}
            {state.user.role === 'admin' ? 'Администратор' : 'Пользователь'}
          </p>
          <button
            type="button"
            onClick={() => {
              void client.logout();
            }}
          >
            Выйти
          </button>
          <h1>Личный словарь</h1>
          {state.user.role === 'admin' && (
            <p>
              <Link className={styles.link} to="/admin/invites">
                Управление приглашениями
              </Link>
            </p>
          )}
          <h2>Работа со словами ещё не реализована</h2>
          <p>
            Аккаунт проверен сервером. Здесь пока нет сохранённых записей,
            демонстрационных слов или API словаря.
          </p>
        </section>
      </QueryClientProvider>
    );
  }
  if (state.phase === 'anonymous' || state.phase === 'registering') {
    if (dictionary || invites) return <Navigate to="/login" replace />;
    if (registration)
      return (
        <section>
          <h1>Регистрация по приглашению</h1>
          <RegistrationForm
            key={state.revision}
            client={client}
            busy={state.phase === 'registering'}
          />
        </section>
      );
    return (
      <section>
        <h1>Вход в аккаунт</h1>
        <p role="alert">{state.message}</p>
        <LoginForm key={state.revision} client={client} />
      </section>
    );
  }
  if (state.phase === 'error')
    return (
      <section>
        <h1>Аккаунт не проверен</h1>
        <p role="alert">{state.message}</p>
        <button
          type="button"
          onClick={() => {
            void client.recheck();
          }}
        >
          Проверить аккаунт
        </button>
      </section>
    );
  return (
    <section aria-busy="true">
      <h1>Проверяем аккаунт</h1>
      <p>
        {state.phase === 'signing-out'
          ? 'Личные данные скрыты. Ожидаем подтверждение выхода.'
          : 'Личные данные скрыты до проверки сессии.'}
      </p>
    </section>
  );
}
