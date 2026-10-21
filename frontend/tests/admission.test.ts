import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { Admission, Discarded } from '../src/auth/admission';

const a = 'user:11111111-1111-4111-8111-111111111111';
const b = 'user:22222222-2222-4222-8222-222222222222';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('request admission before private cache and callbacks', () => {
  it.each([200, 401])(
    'detaches late mutation %s and suppresses success/error/settled effects',
    async (status) => {
      const boundary = new Admission(vi.fn());
      boundary.replace(a);
      const captured = boundary.capture('logout');
      const held = deferred<number>();
      const effects = vi.fn<() => void>();
      const cache = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const admitted = () => {
        try {
          captured.consume(effects);
        } catch (error) {
          if (!(error instanceof Discarded)) throw error;
        }
      };
      const mutation = cache.getMutationCache().build(cache, {
        mutationFn: async () => {
          const result = await held.promise;
          captured.check(a);
          return result;
        },
        onSuccess: admitted,
        onError: admitted,
        onSettled: admitted,
      });
      const pending = mutation.execute(undefined);
      const rejected = expect(pending).rejects.toBeInstanceOf(Discarded);
      boundary.replace(b);
      cache.clear();
      held.resolve(status);
      await rejected;
      expect(effects).not.toHaveBeenCalled();
      expect(cache.getMutationCache().getAll()).toEqual([]);
      expect(boundary.principal).toBe(b);
    },
  );
  it.each([200, 401])(
    'discards an unabortable late A %s after B is current',
    async (status) => {
      const changed = vi.fn();
      const boundary = new Admission(changed);
      boundary.replace(a);
      const captured = boundary.capture('me');
      const response = deferred<{ status: number; principal: string }>();
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const callback = vi.fn<(status: number) => void>();
      const request = cache.query({
        queryKey: ['private', a, 'me'],
        queryFn: async () => {
          const result = await response.promise;
          captured.check(result.principal);
          captured.consume(() => {
            callback(result.status);
          });
          return result;
        },
      });
      const rejection = expect(request).rejects.toBeInstanceOf(Discarded);
      boundary.replace(b);
      response.resolve({ status, principal: a });
      await rejection;
      expect(callback).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(cache.getQueryData(['private', a, 'me'])).toBeUndefined();
      expect(boundary.principal).toBe(b);
      cache.clear();
    },
  );

  it('rejects a body that finishes parsing after the generation changes', () => {
    const boundary = new Admission(vi.fn());
    boundary.replace(a);
    const captured = boundary.capture('me');
    captured.check(a);
    boundary.replace(b);
    expect(() => {
      captured.consume(vi.fn<() => void>());
    }).toThrow(Discarded);
  });

  it('only a designated unknown me may admit a valid identity stamp', () => {
    const boundary = new Admission(vi.fn());
    boundary.capture('me').check(a);
    expect(() => {
      boundary.capture('csrf').check(a);
    }).toThrow(Discarded);
    for (const invalid of [
      null,
      'unknown',
      'anonymous, anonymous',
      'user:11111111-1111-1111-8111-111111111111',
    ]) {
      boundary.replace('unknown');
      expect(() => {
        boundary.capture('me').check(invalid);
      }).toThrow(Discarded);
    }
  });

  it('invalidates the current A generation for a response authorized by cookie B', () => {
    const changed = vi.fn();
    const boundary = new Admission(changed);
    boundary.replace(a);
    const captured = boundary.capture('me');
    expect(() => {
      captured.check(b);
    }).toThrow(Discarded);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(boundary.principal).toBe('unknown');
    expect(() => {
      captured.check(a);
    }).toThrow(Discarded);
  });
});
