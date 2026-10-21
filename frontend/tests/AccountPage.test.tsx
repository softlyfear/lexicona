import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AccountPage } from '../src/auth/AccountPage';
import { AuthClient } from '../src/auth/client';
import { a, b, denial, fetcher, reply, secret } from './auth-fixture';
function renderAccount(client: AuthClient, path = '/dictionary') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/dictionary"
          element={<AccountPage client={client} dictionary />}
        />
        <Route path="/login" element={<AccountPage client={client} />} />
      </Routes>
    </MemoryRouter>,
  );
}
describe('account UI', () => {
  it('redirects an authenticated member away from login and labels the current role', async () => {
    const client = new AuthClient(
      fetcher(
        reply({ user: b }, `user:${b.id}`),
        reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
      ),
    );
    await client.recheck();
    const { unmount } = renderAccount(client, '/login');
    expect(await screen.findByText(/Пользователь/)).not.toBeNull();
    unmount();
    client.suspend();
  });
  it('gates dictionary, validates labeled form and displays actual account only after validated login', async () => {
    const fetch = fetcher(
      denial(),
      reply({ csrf_token: secret(), authenticated: false }),
    );
    const client = new AuthClient(fetch);
    renderAccount(client);
    expect(
      screen.getByRole('heading', { name: 'Проверяем аккаунт' }),
    ).not.toBeNull();
    await act(async () => {
      await client.recheck();
    });
    expect(
      screen.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).not.toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(
      await screen.findByText('Логин: 3–32 латинских буквы, цифры или _.'),
    ).not.toBeNull();
    expect(screen.getByLabelText('Логин').getAttribute('aria-invalid')).toBe(
      'true',
    );
    await user.type(screen.getByLabelText('Логин'), a.login);
    await user.type(screen.getByLabelText('Пароль'), 'short');
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(
      await screen.findByText('Пароль: от 12 до 128 символов.'),
    ).not.toBeNull();
    await user.clear(screen.getByLabelText('Пароль'));
    await user.type(screen.getByLabelText('Пароль'), secret());
    fetch
      .mockResolvedValueOnce(reply({ user: a, csrf_token: secret() }))
      .mockResolvedValueOnce(reply({ user: a }, `user:${a.id}`))
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
      );
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(
      await screen.findByRole('heading', { name: 'Личный словарь' }),
    ).not.toBeNull();
    expect(screen.getByText(a.display_name)).not.toBeNull();
    expect(
      screen.getByText('Работа со словами ещё не реализована'),
    ).not.toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fetch.mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }, `user:${a.id}`),
    );
    await user.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(
      await screen.findByRole('heading', { name: 'Вход в аккаунт' }),
    ).not.toBeNull();
    expect(screen.queryByText(a.display_name)).toBeNull();
    expect(screen.getByLabelText('Пароль').getAttribute('value')).toBeNull();
  });
  it('fails closed with explicit recheck and safe localized text', async () => {
    const fetch = fetcher();
    fetch.mockRejectedValueOnce(new Error('raw private server detail'));
    const client = new AuthClient(fetch);
    renderAccount(client, '/login');
    await act(async () => {
      await client.recheck();
    });
    expect(
      screen.getByRole('heading', { name: 'Аккаунт не проверен' }),
    ).not.toBeNull();
    expect(screen.queryByText(/raw private/)).toBeNull();
    fetch
      .mockResolvedValueOnce(denial())
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: false }),
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Проверить аккаунт' }));
    expect(
      await screen.findByRole('heading', { name: 'Вход в аккаунт' }),
    ).not.toBeNull();
  });
});
