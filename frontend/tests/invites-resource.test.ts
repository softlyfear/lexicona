import { expect, it, vi } from 'vitest';
import { AuthClient } from '../src/auth/client';
import { Discarded } from '../src/auth/admission';
import { a, b, deferred, denial, fetcher, reply, secret } from './auth-fixture';

export const invite = {
  id: b.id,
  created_by: a.id,
  created_at: '2026-10-22T00:00:00.000000Z',
  expires_at: '2026-10-25T00:00:00.000000Z',
  used_at: null,
  revoked_at: null,
  state: 'active' as const,
  version: 1,
};

it('route leave drops an unabortable create body without retaining its token in mutation cache or callbacks', async () => {
  const fetch = fetcher(
    reply({ user: a }, `user:${a.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  const resource = client.openInvites();
  const body = deferred<unknown>();
  const response = reply(
    { invite, invite_token: secret() },
    `user:${a.id}`,
    201,
  );
  const json = vi.spyOn(response, 'json').mockReturnValue(body.promise);
  fetch.mockResolvedValueOnce(response);
  const changed = vi.fn();
  resource.subscribe(changed);
  const pending = resource.create();
  await vi.waitFor(() => {
    expect(json).toHaveBeenCalled();
  });
  resource.dispose();
  const count = changed.mock.calls.length;
  body.resolve({ invite, invite_token: secret() });
  await pending;
  expect(resource.getSnapshot().token).toBeNull();
  expect(changed).toHaveBeenCalledTimes(count);
  expect(
    client.getSnapshot().privateQueries?.getMutationCache().getAll(),
  ).toEqual([]);
  expect(client.getSnapshot().user?.id).toBe(a.id);
  client.suspend();
});

it('registration201 is provisional until same-user me and csrf and carries known field errors without auth switch', async () => {
  const fetch = fetcher(
    denial(),
    reply({ csrf_token: secret(), authenticated: false }),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  const revision = client.getSnapshot().revision;
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
  const input = {
    login: b.login,
    password: secret(),
    invite_token: secret(),
    display_name: b.display_name,
  };
  const feedback = await client.register(input);
  expect(feedback?.fields.login).toEqual(['Логин недоступен.']);
  expect(client.getSnapshot().revision).toBe(revision);
  const me = deferred<Response>();
  fetch
    .mockResolvedValueOnce(
      reply({ user: b, csrf_token: secret() }, 'anonymous', 201),
    )
    .mockReturnValueOnce(me.promise)
    .mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
    );
  const pending = client.register(input);
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  expect(client.getSnapshot().user).toBeNull();
  me.resolve(reply({ user: b }, `user:${b.id}`));
  await pending;
  expect(client.getSnapshot().user?.id).toBe(b.id);
  client.suspend();
});

it('a resource owner becomes discarded at auth switch, not authority derived from an invite DTO', async () => {
  const fetch = fetcher(
    reply({ user: a }, `user:${a.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
  );
  const client = new AuthClient(fetch);
  await client.recheck();
  const resource = client.openInvites();
  client.suspend();
  expect(() => {
    resource.current();
  }).toThrow(Discarded);
  resource.dispose();
});
