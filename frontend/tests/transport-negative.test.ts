import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admission } from '../src/auth/admission';
import { AuthFailure, request } from '../src/auth/transport';
import { csrfSchema, logoutSchema, meSchema } from '../src/auth/wire';
import { a, b, denial, reply, secret } from './auth-fixture';

afterEach(() => {
  vi.useRealTimers();
});
describe('fail-closed transport negative matrix', () => {
  it('rejects unknown private/login dispatch, missing csrf and pre-aborted requests before fetch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const boundary = new Admission(vi.fn());
    const controller = new AbortController();
    await expect(
      request(boundary.capture('csrf'), csrfSchema, controller.signal, fetch),
    ).rejects.toBeInstanceOf(AuthFailure);
    boundary.replace(`user:${a.id}`);
    await expect(
      request(boundary.capture('login'), meSchema, controller.signal, fetch),
    ).rejects.toBeInstanceOf(AuthFailure);
    await expect(
      request(
        boundary.capture('logout'),
        logoutSchema,
        controller.signal,
        fetch,
        undefined,
        {},
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
    controller.abort();
    await expect(
      request(boundary.capture('me'), meSchema, controller.signal, fetch),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects response metadata, malformed JSON, error correlation and csrf boolean mismatch', async () => {
    const boundary = new Admission(vi.fn());
    boundary.replace(`user:${a.id}`);
    const badCache = reply({ user: a }, `user:${a.id}`);
    badCache.headers.delete('Cache-Control');
    const noType = reply({ user: a }, `user:${a.id}`);
    noType.headers.delete('Content-Type');
    const badType = reply({ user: a }, `user:${a.id}`);
    badType.headers.set('Content-Type', 'text/html');
    const badJson = reply({ user: a }, `user:${a.id}`);
    vi.spyOn(badJson, 'json').mockRejectedValue(
      new Error('untrusted parse detail'),
    );
    const wrongId = denial(
      'auth_required',
      'Требуется вход.',
      401,
      `user:${a.id}`,
    );
    wrongId.headers.set('X-Request-ID', b.id);
    const invalidId = reply({ user: a }, `user:${a.id}`);
    invalidId.headers.set('X-Request-ID', 'not-a-uuid');
    for (const response of [
      badCache,
      noType,
      badType,
      badJson,
      wrongId,
      invalidId,
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response);
      await expect(
        request(
          boundary.capture('me'),
          meSchema,
          new AbortController().signal,
          fetch,
        ),
      ).rejects.toBeInstanceOf(AuthFailure);
    }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        reply({ csrf_token: secret(), authenticated: false }, `user:${a.id}`),
      );
    await expect(
      request(
        boundary.capture('csrf'),
        csrfSchema,
        new AbortController().signal,
        fetch,
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
  });
  it('times out without retry and discards after a post-headers abort', async () => {
    vi.useFakeTimers();
    const boundary = new Admission(vi.fn());
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('Stopped'));
          });
        }),
    );
    const task = request(
      boundary.capture('me'),
      meSchema,
      new AbortController().signal,
      fetch,
    );
    const rejected = expect(task).rejects.toBeInstanceOf(AuthFailure);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    fetch.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(reply({ user: a }, `user:${a.id}`));
    });
    await expect(
      request(boundary.capture('me'), meSchema, controller.signal, fetch),
    ).rejects.toBeInstanceOf(AuthFailure);
  });
});
