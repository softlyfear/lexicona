import { describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../src/auth/client';
import { meSchema } from '../src/auth/wire';
import { a, b, deferred, denial, fetcher, reply, secret } from './auth-fixture';
function pair(user = a) {
  return [
    reply({ user }, `user:${user.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${user.id}`),
  ];
}
function anonymous() {
  return [denial(), reply({ csrf_token: secret(), authenticated: false })];
}

describe('current failure vs stale failure effects', () => {
  it('rechecks ownership in the caller microtask after validated me returns', async () => {
    const fetch = fetcher(...pair());
    const client = new AuthClient(fetch);
    const parse = meSchema.parse.bind(meSchema);
    vi.spyOn(meSchema, 'parse').mockImplementationOnce((input) => {
      const result = parse(input);
      queueMicrotask(client.suspend);
      return result;
    });
    await client.recheck();
    expect(client.getSnapshot().phase).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch private transitions before admission and validates form without normalization', async () => {
    const fetch = fetcher(...anonymous());
    const client = new AuthClient(fetch);
    await client.login({ login: a.login, password: secret() });
    await client.logout();
    expect(fetch).not.toHaveBeenCalled();
    await client.recheck();
    await client.login({ login: ' invalid ', password: secret() });
    expect(client.getSnapshot().message).toBe('Проверьте логин и пароль.');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(
      denial('invalid_credentials', 'Неверный логин или пароль.'),
    );
    await client.login({ login: a.login, password: secret() });
    expect(client.getSnapshot().phase).toBe('anonymous');
    expect(client.getSnapshot().message).toBe('Неверный логин или пароль.');
    fetch.mockResolvedValueOnce(reply({ user: a, csrf_token: secret() }));
    for (const response of pair()) fetch.mockResolvedValueOnce(response);
    await client.login({ login: a.login, password: secret() });
    expect(client.getSnapshot().user?.id).toBe(a.id);
    client.suspend();
  });
  it.each(['login', 'logout'] as const)(
    'discards old %s result/error after synchronous suspend',
    async (operation) => {
      for (const fail of [false, true]) {
        const fetch = fetcher(
          ...(operation === 'login' ? anonymous() : pair()),
        );
        const client = new AuthClient(fetch);
        await client.recheck();
        const held = deferred<Response>();
        fetch.mockReturnValueOnce(held.promise);
        const task =
          operation === 'login'
            ? client.login({ login: a.login, password: secret() })
            : client.logout();
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(3);
        });
        client.suspend();
        held.resolve(
          fail
            ? denial()
            : operation === 'login'
              ? reply({ user: a, csrf_token: secret() })
              : reply(
                  { csrf_token: secret(), authenticated: false },
                  `user:${a.id}`,
                ),
        );
        await task;
        expect(client.getSnapshot().phase).toBe('unknown');
        expect(client.getSnapshot().user).toBeNull();
      }
    },
  );
  it('bounds automatic mismatch recovery and does not restart a suspended queued recovery', async () => {
    const fetch = fetcher(reply({ user: a }, `user:${b.id}`));
    const client = new AuthClient(fetch);
    // Valid header but mismatched DTO is a safe protocol failure, not anonymous.
    await client.recheck();
    expect(client.getSnapshot().phase).toBe('error');
    const tasks: VoidFunction[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      tasks.push(callback);
    });
    fetch.mockResolvedValueOnce(reply({ user: a }, 'bad stamp'));
    await client.recheck();
    expect(tasks).toHaveLength(1);
    client.suspend();
    tasks[0]?.();
    expect(client.getSnapshot().phase).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('stops repeated malformed principal recovery after one fresh attempt', async () => {
    const fetch = fetcher(
      reply({ user: a }, 'invalid'),
      reply({ user: a }, 'invalid'),
    );
    const client = new AuthClient(fetch);
    await client.recheck();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(client.getSnapshot().phase).toBe('error');
    });
  });
  it('does not silently confirm mismatched logout and recovers only in a new generation', async () => {
    const fetch = fetcher(...pair());
    const client = new AuthClient(fetch);
    await client.recheck();
    const messages: string[] = [];
    const off = client.subscribe(() => {
      messages.push(client.getSnapshot().message);
    });
    fetch.mockResolvedValueOnce(
      reply({ csrf_token: secret(), authenticated: false }, `user:${b.id}`),
    );
    for (const response of pair(b)) fetch.mockResolvedValueOnce(response);
    await client.logout();
    await vi.waitFor(() => {
      expect(client.getSnapshot().user?.id).toBe(b.id);
    });
    expect(
      messages.some((message) =>
        message.includes('Серверный выход не подтверждён'),
      ),
    ).toBe(true);
    off();
    client.suspend();
  });
  it('handles lock-provider failure without unsafe mutation retry or leaking its exception', async () => {
    let fail = false;
    const fetch = fetcher(...anonymous());
    const client = new AuthClient(fetch, async (work) => {
      if (fail) throw new Error('private lock detail');
      await work();
    });
    await client.recheck();
    fail = true;
    await client.login({ login: a.login, password: secret() });
    expect(client.getSnapshot().phase).toBe('error');
    expect(client.getSnapshot().message).not.toContain('private lock detail');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
