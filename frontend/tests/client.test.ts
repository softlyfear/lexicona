import { describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../src/auth/client';
import { a, b, deferred, denial, fetcher, reply, secret } from './auth-fixture';

function pair(user = a) {
  return [
    reply({ user }, `user:${user.id}`),
    reply({ csrf_token: secret(), authenticated: true }, `user:${user.id}`),
  ];
}
describe('memory auth lifecycle', () => {
  it('revalidates a current cookie mismatch once through a clean me→csrf generation', async () => {
    const fetch = fetcher(
      reply({ user: a }, `user:${a.id}`),
      reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
      ...pair(b),
    );
    const client = new AuthClient(fetch);
    await client.recheck();
    await vi.waitFor(() => {
      expect(client.getSnapshot().user?.id).toBe(b.id);
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    client.suspend();
  });
  it('does not apply an old error delayed by serialization after pagehide', async () => {
    const failure = deferred<undefined>();
    const released = deferred<undefined>();
    const fetch = fetcher(
      denial('internal_error', 'Внутренняя ошибка сервиса.', 500),
    );
    const client = new AuthClient(fetch, async (work) => {
      try {
        await work();
      } catch (error) {
        failure.resolve(undefined);
        await released.promise;
        throw error;
      }
    });
    const checking = client.recheck();
    await failure.promise;
    client.suspend();
    released.resolve(undefined);
    await checking;
    expect(client.getSnapshot().phase).toBe('unknown');
  });
  it('does not render/cache identity until me then same-principal csrf complete', async () => {
    const csrf = deferred<Response>();
    const fetch = fetcher(reply({ user: a }, `user:${a.id}`));
    fetch.mockReturnValueOnce(csrf.promise);
    const auth = new AuthClient(fetch);
    const finish = auth.recheck();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(auth.getSnapshot().user).toBeNull();
    expect(auth.getSnapshot().privateQueries).toBeNull();
    csrf.resolve(
      reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
    );
    await finish;
    expect(auth.getSnapshot().user?.id).toBe(a.id);
    expect(auth.getSnapshot().phase).toBe('authenticated');
    auth.suspend();
  });
  it('starts anonymous only after designated me401 and preauth csrf; login remains provisional until me/csrf', async () => {
    const csrf = secret();
    const fetch = fetcher(
      denial(),
      reply({ csrf_token: csrf, authenticated: false }),
    );
    const auth = new AuthClient(fetch);
    await auth.recheck();
    expect(auth.getSnapshot().phase).toBe('anonymous');
    const me = deferred<Response>();
    fetch
      .mockResolvedValueOnce(reply({ user: b, csrf_token: secret() }))
      .mockReturnValueOnce(me.promise)
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
      );
    const login = auth.login({ login: 'MEMBER_B', password: secret() });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    expect(auth.getSnapshot().user).toBeNull();
    me.resolve(reply({ user: b }, `user:${b.id}`));
    await login;
    expect(auth.getSnapshot().user?.id).toBe(b.id);
    auth.suspend();
  });
  it('hides/detaches query/mutation state synchronously before logout await; confirms only old-principal reply', async () => {
    const fetch = fetcher(...pair());
    const auth = new AuthClient(fetch);
    await auth.recheck();
    const previous = auth.getSnapshot();
    const queries = previous.privateQueries;
    if (!queries) throw new Error('Missing private client');
    queries.setQueryData(['private', a.id, 'draft'], { value: 'transient' });
    queries
      .getMutationCache()
      .build(queries, { mutationKey: ['private', a.id] });
    const held = deferred<Response>();
    fetch.mockReturnValueOnce(held.promise);
    const logout = auth.logout();
    expect(auth.getSnapshot().user).toBeNull();
    expect(auth.getSnapshot().revision).toBeGreaterThan(previous.revision);
    expect(queries.getQueryCache().getAll()).toEqual([]);
    expect(queries.getMutationCache().getAll()).toEqual([]);
    held.resolve(
      reply({ csrf_token: secret(), authenticated: false }, `user:${a.id}`),
    );
    await logout;
    expect(auth.getSnapshot().phase).toBe('anonymous');
    expect(auth.getSnapshot().message).toContain('Вы вышли');
    auth.suspend();
  });
  it('does not claim logout or anonymous from transport failure/early anonymous500', async () => {
    const fetch = fetcher(...pair());
    const auth = new AuthClient(fetch);
    await auth.recheck();
    fetch.mockRejectedValueOnce(new Error('private transport details'));
    await auth.logout();
    expect(auth.getSnapshot().message).toContain(
      'Серверный выход не подтверждён',
    );
    expect(auth.getSnapshot().phase).toBe('error');
    fetch.mockResolvedValueOnce(
      denial('internal_error', 'Внутренняя ошибка сервиса.', 500),
    );
    await auth.recheck();
    expect(auth.getSnapshot().phase).toBe('error');
    expect(auth.getSnapshot().user).toBeNull();
  });
  it('drops cookie swap me→csrf and provisional-login/me disagreement without merging accounts', async () => {
    const fetch = fetcher(
      reply({ user: a }, `user:${a.id}`),
      reply({ csrf_token: secret(), authenticated: true }, `user:${b.id}`),
    );
    const auth = new AuthClient(fetch);
    await auth.recheck();
    await vi.waitFor(() => {
      expect(auth.getSnapshot().phase).toBe('error');
    });
    fetch
      .mockResolvedValueOnce(denial())
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: false }),
      );
    await auth.recheck();
    fetch
      .mockResolvedValueOnce(reply({ user: a, csrf_token: secret() }))
      .mockResolvedValueOnce(reply({ user: b }, `user:${b.id}`));
    await auth.login({ login: a.login, password: secret() });
    expect(auth.getSnapshot().user).toBeNull();
    expect(auth.getSnapshot().phase).toBe('error');
  });
});
