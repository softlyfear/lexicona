import type { z } from 'zod';
import type { Admission } from './admission';
import {
  authSchema,
  csrfSchema,
  meSchema,
  parseError,
  uuidSchema,
} from './wire';

export class AuthFailure extends Error {
  constructor(
    readonly status = 0,
    readonly code = 'unavailable',
  ) {
    super('Не удалось проверить аккаунт. Повторите проверку.');
  }
}

/** No unvalidated response, status or stale error escapes this transport. */
export async function request<T>(
  lease: ReturnType<Admission['capture']>,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  fetcher: typeof fetch,
  csrf?: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 15_000);
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    lease.current();
    combined.throwIfAborted();
    if (
      (lease.capturedPrincipal === 'unknown' && lease.operation !== 'me') ||
      (lease.operation === 'login' && lease.capturedPrincipal !== 'anonymous')
    )
      throw new AuthFailure();
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined) {
      if (!csrf) throw new AuthFailure();
      headers.set('Content-Type', 'application/json');
      headers.set('X-CSRF-Token', csrf);
      headers.set('X-Lexicona-Expected-Principal', lease.capturedPrincipal);
    }
    const response = await fetcher(`/api/v1/auth/${lease.operation}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: combined,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    lease.current();
    combined.throwIfAborted();
    const stamp = response.headers.get('X-Lexicona-Request-Principal');
    lease.check(stamp);
    const requestId = uuidSchema.parse(response.headers.get('X-Request-ID'));
    if (
      response.headers.get('Cache-Control') !== 'no-store' ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('Content-Type') ?? '',
      )
    )
      throw new AuthFailure();
    const raw: unknown = await response.json();
    lease.check(stamp);
    combined.throwIfAborted();
    if (response.status !== 200) {
      const error = parseError(lease.operation, response.status, raw);
      if (error.request_id !== requestId) throw new AuthFailure();
      throw new AuthFailure(response.status, error.code);
    }
    const result = schema.parse(raw);
    if (
      lease.operation === 'me' &&
      stamp !== `user:${meSchema.parse(result).user.id}`
    )
      throw new AuthFailure();
    if (
      lease.operation === 'csrf' &&
      csrfSchema.parse(result).authenticated !== (stamp !== 'anonymous')
    )
      throw new AuthFailure();
    if (lease.operation === 'login') authSchema.parse(result);
    lease.check(stamp);
    return result;
  } catch (error) {
    lease.current();
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure();
  } finally {
    clearTimeout(timeout);
  }
}
