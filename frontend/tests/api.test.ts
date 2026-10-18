import { describe, expect, it, vi } from 'vitest';
import { checkReady } from '../src/api';

describe('readiness API', () => {
  it('reads only the documented endpoint without caching', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'ready' })));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await expect(checkReady(controller.signal)).resolves.toEqual({
      status: 'ready',
    });
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/health/ready', {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  });
  it.each([201, 202, 203, 206])(
    'rejects unexpected HTTP %i even with a ready payload',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ status: 'ready' }), { status }),
          ),
      );
      await expect(checkReady(new AbortController().signal)).rejects.toThrow(
        'Сервис недоступен. Повторите проверку.',
      );
    },
  );
  it('aborts timed-out requests and clears its deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = expect(
      checkReady(new AbortController().signal),
    ).rejects.toThrow('Сервис недоступен.');
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('never returns a stale response after cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(() => {
        controller.abort();
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ready' })),
        );
      }),
    );
    await expect(checkReady(controller.signal)).rejects.toThrow(
      'Сервис недоступен.',
    );
  });
  it('does not start an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(checkReady(controller.signal)).rejects.toThrow(
      'Сервис недоступен.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    new Response(
      JSON.stringify({ error: { message: 'private database path' } }),
      { status: 503 },
    ),
    new Response(JSON.stringify({ status: 'alive' })),
    new Response('<html>proxy error</html>'),
  ])(
    'rejects unavailable or invalid responses without leaking details',
    async (response) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));
      await expect(checkReady(new AbortController().signal)).rejects.toThrow(
        'Сервис недоступен. Повторите проверку.',
      );
    },
  );
});
