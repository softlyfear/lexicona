import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { InvitesPage } from '../src/auth/InvitesPage';
import { AccountPage } from '../src/auth/AccountPage';
import { AuthClient } from '../src/auth/client';
import { a, b, deferred, denial, fetcher, reply, secret } from './auth-fixture';
const invite = {
  id: b.id,
  created_by: null,
  created_at: '2026-10-22T00:00:00.000000Z',
  expires_at: '2026-10-25T00:00:00.000000Z',
  used_at: null,
  revoked_at: null,
  state: 'active',
  version: 1,
};
const rows = [
  invite,
  {
    ...invite,
    id: a.id,
    state: 'used',
    used_at: invite.created_at,
    created_by: b.id,
  },
  {
    ...invite,
    id: '33333333-3333-4333-8333-333333333333',
    state: 'revoked',
    revoked_at: invite.created_at,
  },
];
async function admin() {
  const fetch = fetcher(
    reply({ user: a }, `user:${a.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  return { client, fetch };
}
it('does not label a failed initial administrative read as an empty committed list', async () => {
  const { client, fetch } = await admin();
  fetch.mockRejectedValueOnce(new Error('private transport detail'));
  const shown = render(<InvitesPage client={client} />);
  await screen.findByText('Не удалось загрузить приглашения. Обновите список.');
  expect(screen.queryByText('Приглашений на этой странице нет.')).toBeNull();
  shown.unmount();
  client.suspend();
});
it('renders metadata, explicit create/copy/revoke/pagination/refresh and clears one-time output on route unmount', async () => {
  const user = userEvent.setup();
  const { client, fetch } = await admin();
  const next = btoa(
    JSON.stringify({ v: 1, created_at_us: 1, id: a.id }),
  ).replaceAll('=', '');
  const list = () => reply({ items: rows, next_cursor: next }, `user:${a.id}`);
  fetch.mockResolvedValueOnce(list());
  const shown = render(<InvitesPage client={client} />);
  await screen.findByText('Действует');
  expect(screen.getAllByRole('button', { name: 'Отозвать' })).toHaveLength(3);
  fetch
    .mockResolvedValueOnce(
      reply({ invite, invite_token: secret() }, `user:${a.id}`, 201),
    )
    .mockResolvedValueOnce(list());
  await user.click(screen.getByRole('button', { name: 'Создать приглашение' }));
  await waitFor(() => {
    expect(document.querySelector('output') !== null).toBe(true);
  });
  await user.click(screen.getByRole('button', { name: 'Скопировать код' }));
  await screen.findByText('Секрет скопирован по вашему действию.');
  await waitFor(() => {
    expect(
      screen
        .getByRole('button', { name: 'Создать приглашение' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
  fetch
    .mockResolvedValueOnce(
      reply(
        { ...invite, state: 'revoked', revoked_at: invite.created_at },
        `user:${a.id}`,
      ),
    )
    .mockResolvedValueOnce(list());
  await user.click(
    screen.getAllByRole('button', { name: 'Отозвать' })[0] ?? document.body,
  );
  await waitFor(() => {
    expect(
      screen
        .getByRole('button', { name: 'Следующая страница' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
  fetch.mockResolvedValueOnce(
    reply({ items: [], next_cursor: null }, `user:${a.id}`),
  );
  await user.click(screen.getByRole('button', { name: 'Следующая страница' }));
  await screen.findByText('Приглашений на этой странице нет.');
  fetch.mockResolvedValueOnce(list());
  await user.click(screen.getByRole('button', { name: 'Обновить список' }));
  await screen.findByText('Использовано');
  shown.unmount();
  client.suspend();
});
it('registration consumes success/unknown feedback safely and does not apply a late caller result after leave', async () => {
  const input = {
    invite_token: secret(),
    login: b.login,
    display_name: b.display_name,
    password: secret(),
  };
  const fetch = fetcher(
    denial(),
    reply({ csrf_token: secret(), authenticated: false }),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  const shown = render(
    <MemoryRouter>
      <AccountPage client={client} registration />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  for (const [label, value] of [
    ['Код приглашения', input.invite_token],
    ['Логин', input.login],
    ['Имя', input.display_name],
    ['Пароль', input.password],
  ] as const)
    await user.type(screen.getByLabelText(label), value);
  const held = deferred<Response>();
  fetch
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce(denial())
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }),
    );
  await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  shown.unmount();
  await act(async () => {
    held.resolve(reply({ user: b, csrf_token: secret() }, 'anonymous', 201));
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(client.getSnapshot().phase).toBe('anonymous');
  });
  client.suspend();
});
