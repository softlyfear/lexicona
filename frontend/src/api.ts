import { z } from 'zod';

const readiness = z.object({ status: z.literal('ready') });

export async function checkReady(signal: AbortSignal) {
  const deadline = new AbortController();
  const timeout = setTimeout(() => {
    deadline.abort();
  }, 8000);
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    requestSignal.throwIfAborted();
    const response = await fetch('/api/v1/health/ready', {
      signal: requestSignal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) throw new Error('Unavailable');
    const data: unknown = await response.json();
    requestSignal.throwIfAborted();
    return readiness.parse(data);
  } catch {
    throw new Error('Сервис недоступен. Повторите проверку.');
  } finally {
    clearTimeout(timeout);
  }
}
