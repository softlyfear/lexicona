import { expect, it, vi } from 'vitest';
import { Admission, Discarded } from '../src/auth/admission';
import { request } from '../src/auth/transport';
import { inviteCreatedSchema } from '../src/auth/wire';
import { a, b, reply, secret } from './auth-fixture';
it('re-admits after synchronous serialization before any unsafe dispatch can use a new cookie owner', async () => {
  const boundary = new Admission(vi.fn());
  boundary.replace(`user:${a.id}`);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(reply({}, `user:${a.id}`, 201));
  const body = {
    toJSON() {
      boundary.replace(`user:${b.id}`);
      return {};
    },
  };
  await expect(
    request(
      boundary.capture('inviteCreate'),
      inviteCreatedSchema,
      new AbortController().signal,
      fetch,
      secret(),
      body,
    ),
  ).rejects.toBeInstanceOf(Discarded);
  expect(fetch.mock.calls.length).toBe(0);
});
