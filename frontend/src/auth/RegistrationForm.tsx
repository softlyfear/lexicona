import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { AuthClient } from './client';
import { registerSchema } from './wire';
import type { Registration } from './wire';
import styles from './AccountPage.module.css';

const fields = [
  {
    name: 'invite_token',
    label: 'Код приглашения',
    type: 'text',
    autocomplete: 'off',
    message: 'Введите канонический код приглашения из 43 символов.',
  },
  {
    name: 'login',
    label: 'Логин',
    type: 'text',
    autocomplete: 'username',
    message: 'Логин: 3–32 латинских буквы, цифры или _.',
  },
  {
    name: 'display_name',
    label: 'Имя',
    type: 'text',
    autocomplete: 'nickname',
    message: 'Имя: от 1 до 80 символов без управляющих знаков.',
  },
  {
    name: 'password',
    label: 'Пароль',
    type: 'password',
    autocomplete: 'new-password',
    message: 'Пароль: от 12 до 128 символов.',
  },
] as const;

export function RegistrationForm({
  client,
  busy,
}: {
  client: AuthClient;
  busy: boolean;
}) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Registration>({
    defaultValues: {
      invite_token: '',
      login: '',
      display_name: '',
      password: '',
    },
  });
  const [message, setMessage] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reset();
      client.cancelRegistration();
    };
  }, [client, reset]);
  return (
    <form
      className={styles.form}
      noValidate
      aria-busy={busy}
      onSubmit={(event) => {
        void handleSubmit(async (values) => {
          const revision = client.getSnapshot().revision;
          setMessage('');
          const feedback = await client.register(values);
          if (
            !active.current ||
            revision !== client.getSnapshot().revision ||
            !feedback
          )
            return;
          setMessage(feedback.message);
          for (const { name } of fields) {
            const messages = feedback.fields[name];
            if (messages)
              setError(name, { type: 'server', message: messages.join(' ') });
          }
        })(event);
      }}
    >
      <p>
        Введите приглашение вручную. Пароль и код не сохраняются приложением и
        не передаются в адресе страницы.
      </p>
      <p role="alert">{message}</p>
      {fields.map(({ name, label, type, autocomplete, message }) => (
        <div key={name} className={styles.field}>
          <label htmlFor={name}>{label}</label>
          <input
            id={name}
            type={type}
            autoComplete={autocomplete}
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            aria-invalid={Boolean(errors[name])}
            aria-describedby={`${name}-error`}
            {...register(name, {
              validate: (value) =>
                registerSchema.shape[name].safeParse(value).success || message,
            })}
          />
          <p id={`${name}-error`} className={styles.error}>
            {errors[name]?.message}
          </p>
        </div>
      ))}
      <button type="submit" disabled={busy}>
        Зарегистрироваться
      </button>
      <Link to="/login">Уже есть аккаунт — войти</Link>
    </form>
  );
}
