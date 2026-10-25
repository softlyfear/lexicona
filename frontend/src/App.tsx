import { useEffect, useState } from 'react';
import { AccountPage } from './auth/AccountPage';
import { browserAuth } from './auth/browser';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { checkReady } from './api';
import { ThemeControl } from './ThemeControl';
import styles from './App.module.css';

export function App() {
  const [auth] = useState(() => browserAuth());
  useEffect(() => auth.start(), [auth]);
  const connection = useQuery({
    queryKey: ['public', 'readiness'],
    queryFn: ({ signal }) => checkReady(signal),
    retry: false,
    gcTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main">
        К содержимому
      </a>
      <header className={styles.header}>
        <div>
          <Link className={styles.brand} to="/dictionary">
            Lexicona
          </Link>
          <p>Личный EN / RU словарь</p>
        </div>
        <ThemeControl />
      </header>
      <nav className={styles.navigation} aria-label="Основная навигация">
        <NavLink to="/dictionary">Словарь</NavLink>
        <NavLink to="/connection">Подключение</NavLink>
      </nav>
      <main className={styles.main} id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Navigate to="/dictionary" replace />} />
          <Route
            path="/dictionary"
            element={<AccountPage client={auth.client} dictionary />}
          />
          <Route path="/login" element={<AccountPage client={auth.client} />} />
          <Route
            path="/register"
            element={<AccountPage client={auth.client} registration />}
          />
          <Route
            path="/admin/invites"
            element={<AccountPage client={auth.client} invites />}
          />
          <Route
            path="/connection"
            element={
              <section>
                <h1>Подключение к сервису</h1>
                <p>
                  Проверяем только готовность API и базы данных. Содержимое
                  словаря не запрашивается.
                </p>
                <code>GET /api/v1/health/ready</code>
              </section>
            }
          />
          <Route
            path="*"
            element={
              <section>
                <h1>Страница не найдена</h1>
                <Link to="/dictionary">Вернуться в словарь</Link>
              </section>
            }
          />
        </Routes>
        <section
          className={styles.connection}
          aria-labelledby="connection-heading"
        >
          <h2 id="connection-heading">Состояние сервиса</h2>
          <p className={styles.status} role="status" aria-live="polite">
            {connection.isFetching
              ? 'Проверяем подключение…'
              : connection.isSuccess
                ? 'Сервис готов'
                : 'Сервис недоступен. Повторите проверку.'}
          </p>
          <p>
            Готовность сервиса не означает вход в аккаунт или загрузку словаря.
          </p>
          <button
            type="button"
            disabled={connection.isFetching}
            onClick={() => {
              void connection.refetch();
            }}
          >
            Проверить снова
          </button>
        </section>
      </main>
      <footer className={styles.footer}>Lexicona · основа приложения</footer>
    </div>
  );
}
