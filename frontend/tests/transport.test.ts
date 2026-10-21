import { describe, expect, it, vi } from 'vitest';
import { Admission, Discarded } from '../src/auth/admission';
import { request, AuthFailure } from '../src/auth/transport';
import { meSchema, logoutSchema } from '../src/auth/wire';
import { a, b, deferred, denial, reply, secret } from './auth-fixture';

describe('transport admission', () => {
  it('validates me stamp against body and refuses B data before consumers', async () => {
    const changed = vi.fn();
    const boundary = new Admission(changed);
    const lease = boundary.capture('me');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(reply({ user: b }, `user:${a.id}`));
    await expect(
      request(lease, meSchema, new AbortController().signal, fetch),
    ).rejects.toBeInstanceOf(AuthFailure);
  });
  it.each([200, 401])(
    'drops late %s after response or body await even when abort is ignored',
    async (status) => {
      const boundary = new Admission(vi.fn());
      boundary.replace(`user:${a.id}`);
      const response = deferred<Response>();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockReturnValue(response.promise);
      const task = request(
        boundary.capture('me'),
        meSchema,
        new AbortController().signal,
        fetch,
      );
      const rejected = expect(task).rejects.toBeInstanceOf(Discarded);
      boundary.replace(`user:${b.id}`);
      response.resolve(
        status === 200 ? reply({ user: a }, `user:${a.id}`) : denial(),
      );
      await rejected;
      const body = deferred<unknown>();
      boundary.replace(`user:${a.id}`);
      const real = reply({ user: a }, `user:${a.id}`);
      const json = vi.spyOn(real, 'json').mockReturnValue(body.promise);
      fetch.mockResolvedValueOnce(real);
      const parsing = request(
        boundary.capture('me'),
        meSchema,
        new AbortController().signal,
        fetch,
      );
      const parsedRejection = expect(parsing).rejects.toBeInstanceOf(Discarded);
      await vi.waitFor(() => {
        expect(json).toHaveBeenCalled();
      });
      boundary.replace(`user:${b.id}`);
      body.resolve({ user: a });
      await parsedRejection;
    },
  );
  it('sends old expected principal/CSRF and JSON empty object for logout without retry', async () => {
    const boundary = new Admission(vi.fn());
    boundary.replace(`user:${a.id}`);
    const csrf = secret();
    const token = secret();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        reply({ csrf_token: token, authenticated: false }, `user:${a.id}`),
      );
    const result = await request(
      boundary.capture('logout'),
      logoutSchema,
      new AbortController().signal,
      fetch,
      csrf,
      {},
    );
    expect(result.authenticated).toBe(false);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.cache).toBe('no-store');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe('{}');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-CSRF-Token') === csrf).toBe(true);
    expect(headers.get('X-Lexicona-Expected-Principal')).toBe(`user:${a.id}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
