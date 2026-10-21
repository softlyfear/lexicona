import { vi } from 'vitest';
import type { User } from '../src/auth/wire';
export const a: User = {
  id: '11111111-1111-4111-8111-111111111111',
  login: 'member_a',
  display_name: 'Первый аккаунт',
  role: 'admin',
  version: 1,
};
export const b: User = {
  ...a,
  id: '22222222-2222-4222-8222-222222222222',
  login: 'member_b',
  display_name: 'Второй аккаунт',
  role: 'user',
};
export function secret() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function reply(data: unknown, principal = 'anonymous', status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Lexicona-Request-Principal': principal,
      'X-Request-ID': a.id,
    },
  });
}
export function denial(
  code = 'auth_required',
  message = 'Требуется вход.',
  status = 401,
  principal = 'anonymous',
) {
  return reply(
    { error: { code, message, fields: {}, request_id: a.id } },
    principal,
    status,
  );
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fetcher(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}
