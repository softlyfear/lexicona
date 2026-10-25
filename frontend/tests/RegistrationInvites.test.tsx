import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it } from 'vitest';
import { AccountPage } from '../src/auth/AccountPage';
import { AuthClient } from '../src/auth/client';
import { a, b, denial, fetcher, reply, secret } from './auth-fixture';

function show(client: AuthClient, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/register"
          element={<AccountPage client={client} registration />}
        />
        <Route
          path="/admin/invites"
          element={<AccountPage client={client} invites />}
        />
        <Route
          path="/dictionary"
          element={<AccountPage client={client} dictionary />}
        />
        <Route path="/login" element={<AccountPage client={client} />} />
      </Routes>
    </MemoryRouter>,
  );
}
it('manual registration keeps same-owner inputs after a known duplicate error, with labels and no role selector', async () => {
  const fetch = fetcher(
    denial(),
    reply({ csrf_token: secret(), authenticated: false }),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  show(client, '/register');
  expect(
    screen.getByRole('heading', { name: 'Регистрация по приглашению' }),
  ).not.toBeNull();
  expect(screen.queryByLabelText('Роль')).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  expect(
    screen.getByLabelText('Код приглашения').getAttribute('aria-invalid'),
  ).toBe('true');
  const token = secret();
  await user.type(screen.getByLabelText('Код приглашения'), token);
  await user.type(screen.getByLabelText('Логин'), b.login);
  await user.type(screen.getByLabelText('Имя'), b.display_name);
  await user.type(screen.getByLabelText('Пароль'), secret());
  fetch.mockResolvedValueOnce(
    reply(
      {
        error: {
          code: 'login_unavailable',
          message: 'Логин недоступен.',
          fields: { login: ['Логин недоступен.'] },
          request_id: a.id,
        },
      },
      'anonymous',
      409,
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain(
      'Логин недоступен.',
    );
  });
  expect(
    screen.getByLabelText<HTMLInputElement>('Код приглашения').value === token,
  ).toBe(true);
  expect(screen.getByLabelText<HTMLInputElement>('Логин').value).toBe(b.login);
});
it('admin route loads real-shaped metadata, while a current ordinary member never opens a resource', async () => {
  const fetch = fetcher(
    reply({ user: a }, `user:${a.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
    reply({ items: [], next_cursor: null }, `user:${a.id}`),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  show(client, '/admin/invites');
  expect(
    await screen.findByRole('heading', { name: 'Приглашения' }),
  ).not.toBeNull();
  expect(
    await screen.findByText('Приглашений на этой странице нет.'),
  ).not.toBeNull();
  fetch
    .mockResolvedValueOnce(reply({ user: b }, `user:${b.id}`))
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
    );
  await act(async () => {
    await client.recheck();
  });
  expect(
    screen.getByRole('heading', { name: 'Недостаточно прав' }),
  ).not.toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Создать приглашение' }),
  ).toBeNull();
});
