import { expect, test } from '@playwright/test';
import { E2EServer } from './server';

test('real unavailable database shows safe failure and the same API recovers after filesystem repair', async ({
  page,
}) => {
  const server = new E2EServer();
  try {
    await server.start({ databaseUnavailable: true });
    const response = await page.request.get('/api/v1/health/ready');
    expect(response.status()).toBe(503);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['retry-after']).toBe('1');
    expect(await response.json()).toEqual({
      error: { code: 'not_ready', message: 'Service is not ready' },
    });
    const live = await page.request.get('/api/v1/health/live');
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual({ status: 'alive' });

    await page.goto('/connection');
    await expect(page.getByRole('status')).toHaveText(
      'Сервис недоступен. Повторите проверку.',
    );
    await server.repairDatabase();
    const recovered = await page.request.get('/api/v1/health/ready');
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'ready' });
    await page.getByRole('button', { name: 'Проверить снова' }).click();
    await expect(page.getByRole('status')).toHaveText('Сервис готов');
  } finally {
    await server.stop();
  }
});
