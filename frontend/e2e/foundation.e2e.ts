import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { E2EServer, python, root } from './server';

const exec = promisify(execFile);
const server = new E2EServer();

async function changeRevision(value: string): Promise<string> {
  const { stdout } = await exec(
    python,
    [
      '-c',
      'import sqlite3, sys\n' +
        'with sqlite3.connect(sys.argv[1], timeout=5) as db:\n' +
        '    previous = db.execute("SELECT version_num FROM alembic_version").fetchone()[0]\n' +
        '    db.execute("UPDATE alembic_version SET version_num = ?", (sys.argv[2],))\n' +
        '    print(previous)\n',
      server.databasePath,
      value,
    ],
    { cwd: root, timeout: 10_000 },
  );
  return stdout.trim();
}

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

test('real API, migrated WAL database, responsive UI and keyboard', async ({
  page,
}, testInfo) => {
  expect(server.services[0]?.spawnargs).toEqual(
    expect.arrayContaining(['--no-proxy-headers', '--no-access-log']),
  );
  const response = await page.request.get('/api/v1/health/ready');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ready' });
  const live = await page.request.get('/api/v1/health/live');
  expect(live.status()).toBe(200);
  expect(await live.json()).toEqual({ status: 'alive' });
  const { stdout } = await exec(python, [
    '-c',
    'import sqlite3, sys\n' +
      'with sqlite3.connect(sys.argv[1]) as db:\n' +
      '    print(db.execute("PRAGMA journal_mode").fetchone()[0] + "|" + db.execute("SELECT version_num FROM alembic_version").fetchone()[0])\n',
    server.databasePath,
  ]);
  expect(stdout.trim()).toMatch(/^wal\|\S+$/);

  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/connection');
    await expect(page.getByRole('status')).toHaveText('Сервис готов');
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`ready-${String(width)}.png`),
    });
  }
  await page.goto('/dictionary');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Словарь ещё не подключён' }),
  ).toBeVisible();
  await page.getByLabel('Тема').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Тема').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('real schema mismatch shows safe failure and retry recovers', async ({
  page,
}) => {
  await page.goto('/connection');
  await expect(page.getByRole('status')).toHaveText('Сервис готов');
  const previous = await changeRevision('e2e_mismatch');
  try {
    const response = await page.request.get('/api/v1/health/ready');
    expect(response.status()).toBe(503);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.text()).not.toContain(server.databasePath);
    const live = await page.request.get('/api/v1/health/live');
    expect(live.status()).toBe(200);
    await page.getByRole('button', { name: 'Проверить снова' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Сервис недоступен. Повторите проверку.',
    );
  } finally {
    await changeRevision(previous);
  }
  await page.getByRole('button', { name: 'Проверить снова' }).click();
  await expect(page.getByRole('status')).toHaveText('Сервис готов');
});
