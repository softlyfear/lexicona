import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const python = join(root, 'backend/.venv/bin/python');
let directory: string | undefined;
let databasePath = '';
let server: ChildProcess | undefined;
let serverLog = '';

async function listeners(): Promise<string> {
  const { stdout } = await exec('ss', [
    '-H',
    '-ltn',
    '( sport = :8000 or sport = :5173 )',
  ]);
  return stdout.trim();
}

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
      databasePath,
      value,
    ],
    { cwd: root, timeout: 10_000 },
  );
  return stdout.trim();
}

test.beforeAll(async () => {
  // Never attach to, migrate, or stop an existing development server/database.
  expect(
    await listeners(),
    'E2E needs free localhost ports 8000 and 5173',
  ).toBe('');
  directory = await mkdtemp(join(tmpdir(), 'lexicona-e2e-'));
  databasePath = join(directory, 'test.sqlite3');
  const env = {
    ...process.env,
    LEXICONA_DATABASE_URL: `sqlite+aiosqlite:///${databasePath}`,
  };
  await exec('bash', ['scripts/migrate.sh'], {
    cwd: root,
    env,
    timeout: 30_000,
  });
  const child = spawn('bash', ['scripts/dev.sh'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  child.stdout.on('data', (data: Buffer) => {
    serverLog += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    serverLog += data.toString();
  });
  let launchError: Error | undefined;
  child.on('error', (error: Error) => {
    launchError = error;
  });
  await expect
    .poll(
      async () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Own E2E launcher exited early: ${serverLog}`);
        }
        try {
          const response = await fetch(
            'http://127.0.0.1:5173/api/v1/health/ready',
            { signal: AbortSignal.timeout(1000) },
          );
          return response.status;
        } catch {
          return 0;
        }
      },
      {
        timeout: 25_000,
        message: 'Real frontend proxy → API → SQLite readiness',
      },
    )
    .toBe(200);
});

test.afterAll(async () => {
  const child = server;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Own E2E launcher did not stop after SIGTERM'));
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.kill('SIGTERM');
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  if (server) {
    expect(await listeners(), 'Own launcher must release both ports').toBe('');
  }
});

test('real API, migrated WAL database, responsive UI and keyboard', async ({
  page,
}, testInfo) => {
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
    databasePath,
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
    expect(await response.text()).not.toContain(databasePath);
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
