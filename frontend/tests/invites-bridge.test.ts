import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { Admission, Discarded } from '../src/auth/admission';
import { request } from '../src/auth/transport';
import { a, b, deferred, reply, secret } from './auth-fixture';

const listSchema = z.strictObject({
  items: z.array(z.never()),
  next_cursor: z.null(),
});

it('dispatches the actual administrative list path and admits its private payload before cache/callback', async () => {
  const boundary = new Admission(vi.fn());
  boundary.replace(`user:${a.id}`);
  const lease = boundary.capture('inviteList');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(reply({ items: [], next_cursor: null }, `user:${a.id}`));
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const callback = vi.fn();
  const result = await cache.query({
    queryKey: ['private', a.id, 'invites'],
    queryFn: async () => {
      const data = await request(
        lease,
        listSchema,
        new AbortController().signal,
        fetch,
      );
      return lease.consume(() => {
        callback();
        return data;
      });
    },
  });
  expect(result.items).toHaveLength(0);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/admin/invites');
  expect(callback).toHaveBeenCalledTimes(1);
  cache.clear();
});

it('accepts only the actual committed201 create status on the administrative path', async () => {
  const boundary = new Admission(vi.fn());
  boundary.replace(`user:${a.id}`);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      reply({ items: [], next_cursor: null }, `user:${a.id}`, 201),
    );
  const data = await request(
    boundary.capture('inviteCreate'),
    listSchema,
    new AbortController().signal,
    fetch,
    secret(),
    {},
  );
  expect(data.items).toHaveLength(0);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/admin/invites');
});

it('drops a private invite body finishing after A→B before query return and caller callback', async () => {
  const boundary = new Admission(vi.fn());
  boundary.replace(`user:${a.id}`);
  const lease = boundary.capture('inviteList');
  const body = deferred<unknown>();
  const response = reply({ items: [], next_cursor: null }, `user:${a.id}`);
  const json = vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const callback = vi.fn();
  const task = cache.query({
    queryKey: ['private', a.id, 'invites'],
    queryFn: async () => {
      const data = await request(
        lease,
        listSchema,
        new AbortController().signal,
        fetch,
      );
      return lease.consume(() => {
        callback();
        return data;
      });
    },
  });
  const rejected = expect(task).rejects.toBeInstanceOf(Discarded);
  await vi.waitFor(() => {
    expect(json).toHaveBeenCalledTimes(1);
  });
  boundary.replace(`user:${b.id}`);
  body.resolve({ items: [], next_cursor: null });
  await rejected;
  expect(callback).not.toHaveBeenCalled();
  expect(cache.getQueryData(['private', a.id, 'invites'])).toBeUndefined();
  expect(boundary.principal).toBe(`user:${b.id}`);
  cache.clear();
});
