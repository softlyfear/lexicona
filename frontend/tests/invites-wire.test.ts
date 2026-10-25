import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Admission } from '../src/auth/admission';
import { request, AuthFailure } from '../src/auth/transport';
import {
  cursorSchema,
  inviteCreatedSchema,
  inviteListSchema,
  inviteSchema,
  parseError,
  registerSchema,
  timestampSchema,
} from '../src/auth/wire';
import { a, b, reply, secret } from './auth-fixture';

const invite = {
  id: b.id,
  created_by: null,
  created_at: '2026-10-22T00:00:00.000000Z',
  expires_at: '2026-10-25T00:00:00.000000Z',
  used_at: null,
  revoked_at: null,
  state: 'active',
  version: 1,
};
function encode(raw: string) {
  return btoa(raw)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export const cursor = encode(
  JSON.stringify({
    v: 1,
    created_at_us: 9223372036854775807n.toString(),
    id: a.id,
  }).replace('"9223372036854775807"', '9223372036854775807'),
);
it('validates strict actual invite DTOs/timestamps/tokens/JS-safe versions and canonical opaque cursor without int64 rounding', () => {
  expect(
    inviteCreatedSchema.safeParse({ invite, invite_token: secret() }).success,
  ).toBe(true);
  expect(
    inviteListSchema.safeParse({ items: [invite], next_cursor: cursor })
      .success,
  ).toBe(true);
  for (const invalid of [
    { ...invite, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...invite, version: true },
    { ...invite, used_by: a.id },
    { ...invite, state: 'unpublished' },
    { ...invite, id: '../auth/logout' },
    { ...invite, created_at: '2026-10-22T00:00:00Z' },
  ])
    expect(inviteSchema.safeParse(invalid).success).toBe(false);
  expect(timestampSchema.safeParse('2026-99-99T00:00:00.000000Z').success).toBe(
    false,
  );
  expect(timestampSchema.safeParse('2026-02-30T00:00:00.000000Z').success).toBe(
    false,
  );
  for (const value of [
    'a',
    '!',
    '',
    cursor + '=',
    encode('{}'),
    encode(`{"v":1,"created_at_us":9223372036854775808,"id":"${a.id}"}`),
    encode(`{"v":1,"created_at_us":1,"id":"${a.id.replace('4111', '1111')}"}`),
    encode(`{"v":1,"created_at_us":-1,"id":"${a.id}"}`),
  ])
    expect(cursorSchema.safeParse(value).success).toBe(false);
  const short = encode(`{"v":1,"created_at_us":1,"id":"${a.id}"}`);
  const last = short.at(-1);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (!last) throw new Error('Missing fixture suffix');
  const replacement = alphabet[alphabet.indexOf(last) + 1];
  if (replacement === undefined) throw new Error('Missing fixture replacement');
  const noncanonical = short.slice(0, -1) + replacement;
  expect(cursorSchema.safeParse(noncanonical).success).toBe(false);
  expect(
    registerSchema.safeParse({
      login: 'member',
      password: '😀'.repeat(12),
      invite_token: secret(),
      display_name: 'Имя',
      role: 'admin',
    }).success,
  ).toBe(false);
});
it('allows only exact login_unavailable fields and all actual canonical validation field names', () => {
  const error = {
    code: 'login_unavailable',
    message: 'Логин недоступен.',
    request_id: a.id,
    fields: { login: ['Логин недоступен.'] },
  };
  expect(parseError('register', 409, { error }).fields.login).toEqual([
    'Логин недоступен.',
  ]);
  for (const fields of [
    {},
    { login: [] },
    { login: ['Недопустимое значение.'] },
    { login: ['Логин недоступен.', 'Логин недоступен.'] },
    { ...error.fields, password: ['Логин недоступен.'] },
  ])
    expect(() =>
      parseError('register', 409, { error: { ...error, fields } }),
    ).toThrow();
  const fields = Object.fromEntries(
    [
      'login',
      'display_name',
      'password',
      'invite_token',
      'expected_version',
      'invite_id',
      'limit',
      'cursor',
      '_request',
    ].map((f) => [f, ['Недопустимое значение.']]),
  );
  expect(
    Object.keys(
      parseError('register', 422, {
        error: {
          code: 'validation_error',
          message: 'Проверьте поля формы.',
          request_id: a.id,
          fields,
        },
      }).fields,
    ),
  ).toHaveLength(9);
});
it('limits dispatch to exact descriptor method/status and canonical encoded list/revoke parameters', async () => {
  const boundary = new Admission(vi.fn());
  boundary.replace(`user:${a.id}`);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(reply(invite, `user:${a.id}`));
  await request(
    boundary.capture('inviteRevoke'),
    inviteSchema,
    new AbortController().signal,
    fetch,
    secret(),
    { expected_version: 1 },
    { invite_id: b.id },
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/admin/invites/${b.id}/revoke`);
  fetch.mockResolvedValue(
    reply({ items: [], next_cursor: null }, `user:${a.id}`),
  );
  await request(
    boundary.capture('inviteList'),
    inviteListSchema,
    new AbortController().signal,
    fetch,
    undefined,
    undefined,
    { limit: 100, cursor },
  );
  expect(fetch.mock.calls[1]?.[0]).toBe(
    '/api/v1/admin/invites?limit=100&cursor=' + encodeURIComponent(cursor),
  );
  for (const parameters of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: '../' },
    { invite_id: b.id },
  ])
    await expect(
      request(
        boundary.capture('inviteList'),
        inviteListSchema,
        new AbortController().signal,
        fetch,
        undefined,
        undefined,
        parameters,
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
  await expect(
    request(
      boundary.capture('inviteRevoke'),
      inviteSchema,
      new AbortController().signal,
      fetch,
      secret(),
      { expected_version: 1 },
      { invite_id: '../auth/logout' },
    ),
  ).rejects.toBeInstanceOf(AuthFailure);
  await expect(
    request(
      boundary.capture('me'),
      z.unknown(),
      new AbortController().signal,
      fetch,
      secret(),
      {},
    ),
  ).rejects.toBeInstanceOf(AuthFailure);
  for (const status of [200, 202]) {
    fetch.mockResolvedValue(
      reply({ invite, invite_token: secret() }, `user:${a.id}`, status),
    );
    await expect(
      request(
        boundary.capture('inviteCreate'),
        inviteCreatedSchema,
        new AbortController().signal,
        fetch,
        secret(),
        {},
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
  }
  boundary.replace(`user:${b.id}`);
  await expect(
    request(
      boundary.capture('register'),
      z.unknown(),
      new AbortController().signal,
      fetch,
      secret(),
      {},
    ),
  ).rejects.toBeInstanceOf(AuthFailure);
});
