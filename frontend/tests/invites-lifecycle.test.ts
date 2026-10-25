import { expect, it, vi } from 'vitest';
import { AuthClient } from '../src/auth/client';
import { AuthFailure } from '../src/auth/transport';
import * as transport from '../src/auth/transport';
import { a, b, deferred, denial, fetcher, reply, secret } from './auth-fixture';
const invite = {
  id: b.id,
  created_by: a.id,
  created_at: '2026-10-22T00:00:00.000000Z',
  expires_at: '2026-10-25T00:00:00.000000Z',
  used_at: null,
  revoked_at: null,
  state: 'active' as const,
  version: 1,
};
const list = () =>
  reply({ items: [invite], next_cursor: null }, `user:${a.id}`);
async function setup() {
  const fetch = fetcher(
    reply({ user: a }, `user:${a.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  const cache = client.getSnapshot().privateQueries;
  if (!cache) throw new Error('Missing owner');
  return { client, fetch, cache, resource: client.openInvites() };
}
it('keeps the committed one-time token only in its live route store, never mutation/query caches; copy and revoke are explicit', async () => {
  const { client, fetch, cache, resource } = await setup();
  const write = vi
    .fn<(token: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  await resource.copy(write);
  expect(write).not.toHaveBeenCalled();
  const token = secret();
  fetch
    .mockResolvedValueOnce(
      reply({ invite, invite_token: token }, `user:${a.id}`, 201),
    )
    .mockResolvedValueOnce(list());
  await resource.create();
  expect(resource.getSnapshot().token === token).toBe(true);
  expect(
    JSON.stringify(
      cache
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ).includes(token),
  ).toBe(false);
  expect(cache.getMutationCache().getAll()).toHaveLength(0);
  await resource.copy(write);
  expect(write).toHaveBeenCalledTimes(1);
  expect(resource.getSnapshot().message).toContain('скопирован');
  write.mockRejectedValueOnce(new Error('clipboard details'));
  await resource.copy(write);
  expect(resource.getSnapshot().message).toContain('вручную');
  fetch
    .mockResolvedValueOnce(
      reply(
        {
          ...invite,
          state: 'revoked',
          revoked_at: invite.created_at,
          version: 2,
        },
        `user:${a.id}`,
      ),
    )
    .mockResolvedValueOnce(list());
  await resource.revoke(invite);
  const body = fetch.mock.calls.at(-2)?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected encoded revoke body');
  expect(JSON.parse(body)).toEqual({
    expected_version: 1,
  });
  const other = cache
    .getMutationCache()
    .build(cache, { mutationKey: ['other'] });
  resource.dispose();
  expect(cache.getMutationCache().getAll()).toEqual([other]);
  cache.clear();
  client.suspend();
});
it('silences copy completion and generic copy failure after route leave', async () => {
  for (const fail of [false, true]) {
    const { client, fetch, resource } = await setup();
    fetch
      .mockResolvedValueOnce(
        reply({ invite, invite_token: secret() }, `user:${a.id}`, 201),
      )
      .mockResolvedValueOnce(list());
    await resource.create();
    const held = deferred<undefined>();
    const callbacks = vi.fn();
    const pending = resource.copy(async () => {
      await held.promise;
      if (fail) throw new Error('clipboard failure');
    });
    resource.subscribe(callbacks);
    resource.dispose();
    held.resolve(undefined);
    await pending;
    expect(callbacks).not.toHaveBeenCalled();
    expect(resource.getSnapshot().token).toBeNull();
    client.suspend();
  }
});
it('never retries unsafe requests, blocks duplicate clicks, and explains unknown create/revoke and CAS conflicts', async () => {
  const { client, fetch, resource } = await setup();
  const response = deferred<Response>();
  fetch.mockReturnValueOnce(response.promise);
  const pending = resource.create();
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  await resource.create();
  response.resolve(
    reply(
      {
        error: {
          code: 'internal_error',
          message: 'Внутренняя ошибка сервиса.',
          fields: {},
          request_id: a.id,
        },
      },
      `user:${a.id}`,
      500,
    ),
  );
  await pending;
  expect(resource.getSnapshot().message).toContain(
    'Секрет восстановить нельзя',
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockRejectedValueOnce(new Error('private network detail'));
  await resource.revoke(invite);
  expect(resource.getSnapshot().message).toContain('Отзыв не подтверждён');
  fetch.mockResolvedValueOnce(
    reply(
      {
        error: {
          code: 'version_conflict',
          message: 'Данные изменились. Обновите страницу.',
          fields: {},
          request_id: a.id,
        },
      },
      `user:${a.id}`,
      409,
    ),
  );
  await resource.revoke(invite);
  expect(resource.getSnapshot().message).toContain(
    'не повторяется автоматически',
  );
  vi.spyOn(transport, 'request').mockRejectedValueOnce(
    new Error('unexpected runtime boundary'),
  );
  await resource.load();
  expect(resource.getSnapshot().message).toContain('Не удалось загрузить');
  resource.dispose();
  client.suspend();
});
it('discards old list pages/errors and cancels queries on same-account route departure', async () => {
  const { client, fetch, resource } = await setup();
  const first = deferred<Response>();
  fetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(list());
  const pending = resource.load();
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  await resource.load(
    btoa(JSON.stringify({ v: 1, created_at_us: 1, id: a.id })).replaceAll(
      '=',
      '',
    ),
  );
  first.resolve(reply({ items: [], next_cursor: null }, `user:${a.id}`));
  await pending;
  expect(resource.getSnapshot().items).toHaveLength(1);
  const failure = deferred<Response>();
  fetch.mockReturnValueOnce(failure.promise).mockResolvedValueOnce(list());
  const failed = resource.load();
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  await resource.load(
    btoa(JSON.stringify({ v: 1, created_at_us: 1, id: a.id })).replaceAll(
      '=',
      '',
    ),
  );
  failure.resolve(reply({}, `user:${a.id}`, 500));
  await failed;
  expect(resource.getSnapshot().message).toBe('');
  const body = deferred<Response>();
  fetch.mockReturnValueOnce(body.promise);
  const leaving = resource.load();
  resource.dispose();
  body.resolve(list());
  await leaving;
  expect(resource.getSnapshot().items).toHaveLength(0);
  client.suspend();
});
it('current forbidden/401/412 responses hide admin state and revalidate without unsafe resend', async () => {
  for (const [code, message, status] of [
    ['forbidden', 'Недостаточно прав.', 403],
    ['auth_required', 'Требуется вход.', 401],
    ['principal_mismatch', 'Аккаунт изменился. Обновите страницу.', 412],
  ] as const) {
    const { client, fetch, resource } = await setup();
    fetch
      .mockResolvedValueOnce(
        reply(
          { error: { code, message, fields: {}, request_id: a.id } },
          `user:${a.id}`,
          status,
        ),
      )
      .mockResolvedValueOnce(reply({ user: b }, `user:${b.id}`))
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
      );
    await resource.create();
    await vi.waitFor(() => {
      expect(client.getSnapshot().user?.id).toBe(b.id);
    });
    expect(resource.getSnapshot().token).toBeNull();
    expect(() => {
      client.openInvites();
    }).toThrow(AuthFailure);
    client.suspend();
  }
});
it('guards registration known errors, invalid input, unknown commit, mismatch and cancelled route ownership', async () => {
  const input = {
    login: b.login,
    password: secret(),
    invite_token: secret(),
    display_name: b.display_name,
  };
  const fetch = fetcher(
    denial(),
    reply({ csrf_token: secret(), authenticated: false }),
  );
  const client = new AuthClient(fetch);
  expect(await client.register(input)).toBeUndefined();
  expect(() => {
    client.openInvites();
  }).toThrow(AuthFailure);
  await client.recheck();
  expect(
    (await client.register({ ...input, password: 'short' }))?.message,
  ).toBe('Проверьте поля формы.');
  for (const [code, message, status, fields] of [
    ['invite_invalid', 'Приглашение недействительно.', 400, {}],
    [
      'validation_error',
      'Проверьте поля формы.',
      422,
      { display_name: ['Недопустимое значение.'] },
    ],
  ] as const) {
    fetch.mockResolvedValueOnce(
      reply(
        { error: { code, message, fields, request_id: a.id } },
        'anonymous',
        status,
      ),
    );
    expect((await client.register(input))?.message).toBe(message);
    expect(client.getSnapshot().phase).toBe('anonymous');
  }
  fetch.mockRejectedValueOnce(new Error('response lost'));
  await client.register(input);
  expect(client.getSnapshot().message).toContain('Регистрация не подтверждена');
  fetch
    .mockResolvedValueOnce(denial())
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }),
    );
  await client.recheck();
  fetch
    .mockResolvedValueOnce(
      reply({ user: b, csrf_token: secret() }, 'anonymous', 201),
    )
    .mockResolvedValueOnce(reply({ user: a }, `user:${a.id}`));
  await client.register(input);
  expect(client.getSnapshot().phase).toBe('error');
  fetch
    .mockResolvedValueOnce(denial())
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }),
    );
  await client.recheck();
  const held = deferred<Response>();
  fetch
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce(denial())
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }),
    );
  const pending = client.register(input);
  await vi.waitFor(() => {
    expect(client.getSnapshot().phase).toBe('registering');
  });
  client.cancelRegistration();
  held.resolve(reply({ user: b, csrf_token: secret() }, 'anonymous', 201));
  await pending;
  await vi.waitFor(() => {
    expect(client.getSnapshot().phase).toBe('anonymous');
  });
  expect(client.getSnapshot().user).toBeNull();
  client.suspend();
});
