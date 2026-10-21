import { describe, expect, it, vi } from 'vitest';
import { browserAuth } from '../src/auth/browser';
import { a, denial, fetcher, reply, secret } from './auth-fixture';
function anonymous() {
  return [denial(), reply({ csrf_token: secret(), authenticated: false })];
}
describe('coordination feature detection and fallback', () => {
  it('uses Web Locks for the complete transition and retains no-BroadcastChannel lifecycle fallback', async () => {
    const lock = vi.fn(
      async (_name: string, _options: unknown, work: () => Promise<void>) => {
        await work();
      },
    );
    vi.stubGlobal('navigator', { locks: { request: lock } });
    vi.stubGlobal('BroadcastChannel', undefined);
    const fetch = fetcher(...anonymous());
    const runtime = browserAuth(fetch);
    const stop = runtime.start();
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    fetch
      .mockResolvedValueOnce(reply({ user: a, csrf_token: secret() }))
      .mockResolvedValueOnce(reply({ user: a }, `user:${a.id}`))
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
      );
    await runtime.client.login({ login: a.login, password: secret() });
    expect(lock).toHaveBeenCalledTimes(2);
    expect(
      lock.mock.calls.every(([name]) => name === 'lexicona-auth-cookie'),
    ).toBe(true);
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(runtime.client.getSnapshot().user).toBeNull();
    for (const response of anonymous()) fetch.mockResolvedValueOnce(response);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    for (const response of anonymous()) fetch.mockResolvedValueOnce(response);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      expect(lock).toHaveBeenCalledTimes(4);
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    stop();
    const calls = fetch.mock.calls.length;
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('falls back when a partial locks implementation lacks request', async () => {
    vi.stubGlobal('navigator', { locks: {} });
    vi.stubGlobal('BroadcastChannel', undefined);
    const fetch = fetcher(...anonymous());
    const runtime = browserAuth(fetch);
    const stop = runtime.start();
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    stop();
  });
});
