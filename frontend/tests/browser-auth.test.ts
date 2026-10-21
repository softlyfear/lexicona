import { describe, expect, it, vi } from 'vitest';
import { browserAuth } from '../src/auth/browser';
import { a, denial, fetcher, reply, secret } from './auth-fixture';

describe('browser lifecycle adapter', () => {
  it('uses payload-free notification, hides on pagehide, and rechecks pageshow/focus without persistence', async () => {
    const posts: unknown[] = [];
    const close = vi.fn();
    let receive: (event: MessageEvent) => void = () => {};
    class Channel {
      constructor(readonly name: string) {}
      postMessage(value: unknown) {
        posts.push(value);
      }
      close = close;
      set onmessage(handler: (event: MessageEvent) => void) {
        receive = handler;
      }
    }
    vi.stubGlobal('BroadcastChannel', Channel);
    const fetch = fetcher(
      denial(),
      reply({ csrf_token: secret(), authenticated: false }),
      reply({ user: a, csrf_token: secret() }),
      reply({ user: a }, `user:${a.id}`),
      reply({ csrf_token: secret(), authenticated: true }, `user:${a.id}`),
    );
    const runtime = browserAuth(fetch);
    const stop = runtime.start();
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    await runtime.client.login({ login: a.login, password: secret() });
    expect(posts).toEqual(['auth-changed']);
    window.dispatchEvent(new Event('pagehide'));
    expect(runtime.client.getSnapshot().user).toBeNull();
    fetch
      .mockResolvedValueOnce(denial())
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: false }),
      );
    window.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    receive(
      new MessageEvent('message', { data: { type: 'auth-changed', id: a.id } }),
    );
    expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    fetch
      .mockResolvedValueOnce(denial())
      .mockResolvedValueOnce(
        reply({ csrf_token: secret(), authenticated: false }),
      );
    receive(new MessageEvent('message', { data: 'auth-changed' }));
    expect(runtime.client.getSnapshot().phase).toBe('checking');
    await vi.waitFor(() => {
      expect(runtime.client.getSnapshot().phase).toBe('anonymous');
    });
    stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.client.getSnapshot().user).toBeNull();
  });
});
