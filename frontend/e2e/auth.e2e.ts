import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2EServer } from './server';
import { seedAccounts } from './accounts';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const server = new E2EServer();
let credentials: Awaited<ReturnType<typeof seedAccounts>>;
test.beforeAll(async () => {
  await server.start();
  credentials = await seedAccounts(server.databasePath);
});
test.afterAll(async () => {
  await server.stop();
});

async function login(page: Page, account: { login: string; password: string }) {
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Вход в аккаунт' }),
  ).toBeVisible();
  // No Playwright fill/typing call logs containing secrets, even on failure.
  await page.evaluate((values) => {
    const login = document.querySelector<HTMLInputElement>('#login');
    const password = document.querySelector<HTMLInputElement>('#password');
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    );
    if (!login || !password || !descriptor?.set)
      throw new Error('Missing login form');
    for (const [element, value] of [
      [login, values.login],
      [password, values.password],
    ] as const) {
      descriptor.set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, account);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личный словарь' }),
  ).toBeVisible();
}

test('real separate accounts, reload/logout/back and no persistent private data', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await login(a, credentials.admin);
    await expect(a.locator('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );
    await login(b, credentials.member);
    await expect(
      a.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    await expect(b.getByText('Fixture member', { exact: true })).toBeVisible();
    await expect(a.getByText('Fixture member', { exact: true })).toHaveCount(0);
    await a.reload();
    await expect(
      a.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    for (const page of [a, b]) {
      const storage = await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        idb: (await indexedDB.databases()).length,
        cache: (await caches.keys()).length,
        sw: (await navigator.serviceWorker.getRegistrations()).length,
      }));
      expect(storage).toEqual({
        local: 0,
        session: 0,
        idb: 0,
        cache: 0,
        sw: 0,
      });
    }
    await a.getByRole('button', { name: 'Выйти' }).click();
    await expect(
      a.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    await a.goBack();
    await expect(
      a.getByText('Fixture administrator', { exact: true }),
    ).toHaveCount(0);
    await expect(b.getByText('Fixture member', { exact: true })).toBeVisible();
    await a.goto('/connection');
    await expect(a.getByRole('status')).toHaveText('Сервис готов');
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test('shared-cookie tabs hide immediately on notification and revalidate the new account', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    await login(first, credentials.admin);
    await expect(
      first.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    const snapshotExposed = await first.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true }),
      );
      return document.body.textContent.includes('Fixture administrator');
    });
    expect(snapshotExposed).toBe(false);
    await first.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
    });
    await expect(
      first.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    const second = await context.newPage();
    await second.goto('/dictionary');
    await expect(
      second.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    await second.getByRole('button', { name: 'Выйти' }).click();
    await expect(
      second.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    await expect(
      first.getByText('Fixture administrator', { exact: true }),
    ).toHaveCount(0);
    await login(second, credentials.member);
    await first.bringToFront();
    await expect(
      first.getByText('Fixture member', { exact: true }),
    ).toBeVisible();
    await expect(
      first.getByText('Fixture administrator', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('without BroadcastChannel/Web Locks, focus and bfcache boundaries recheck shared cookies without snapshots', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    Reflect.deleteProperty(Navigator.prototype, 'locks');
  });
  try {
    const first = await context.newPage();
    await first.setViewportSize({ width: 320, height: 900 });
    await login(first, credentials.admin);
    const second = await context.newPage();
    await second.goto('/dictionary');
    await expect(
      second.getByText('Fixture administrator', { exact: true }),
    ).toBeVisible();
    await second.getByRole('button', { name: 'Выйти' }).click();
    await expect(
      second.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    const exposed = await first.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      return document.body.textContent.includes('Fixture administrator');
    });
    expect(exposed).toBe(false);
    await expect(
      first.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    await login(second, credentials.member);
    await first.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
    });
    await expect(
      first.getByText('Fixture member', { exact: true }),
    ).toBeVisible();
    expect(
      await first.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      await first.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  } finally {
    await context.close();
  }
});

for (const heldStatus of [200, 401]) {
  test(`held real ${String(heldStatus)} cannot reach B cache/callback; cookie-B stamp and unsafe expected-A fail closed`, async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    const result = await page.evaluate(
      async ({ accounts, heldStatus }) => {
        const { AuthClient } = await import('../src/auth/client.ts');
        const { Admission, Discarded } =
          await import('../src/auth/admission.ts');
        const { request } = await import('../src/auth/transport.ts');
        const { meSchema, csrfSchema } = await import('../src/auth/wire.ts');
        // Reuse the app's real Query implementation; no fabricated server bodies.
        const control = new AuthClient();
        await control.recheck();
        await control.login(accounts.admin);
        const userA = control.getSnapshot().user;
        const isolated = new AuthClient();
        await isolated.recheck();
        const cache = isolated.getSnapshot().privateQueries;
        if (!userA || !cache) throw new Error('Real A login failed');
        const boundary = new Admission(() => {});
        boundary.replace(`user:${userA.id}`);
        const captured = boundary.capture('me');
        let release!: () => void;
        let arrived!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const arrival = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        if (heldStatus === 401) await control.logout();
        let actualStatus = 0;
        let callbacks = 0;
        const delayed: typeof fetch = async (input, init) => {
          // Ignore abort deliberately; retain a real, already-received HTTP response.
          const response = await fetch(input, { ...init, signal: null });
          actualStatus = response.status;
          arrived();
          await barrier;
          return response;
        };
        const task = cache
          .query({
            queryKey: ['private', userA.id, 'held'],
            queryFn: async () => {
              const dto = await request(
                captured,
                meSchema,
                new AbortController().signal,
                delayed,
              );
              captured.consume(() => {
                callbacks += 1;
              });
              return dto;
            },
          })
          .then(
            () => false,
            (error: unknown) => error instanceof Discarded,
          );
        await arrival;
        if (heldStatus === 200) await control.logout();
        await control.login(accounts.member);
        const userB = control.getSnapshot().user;
        if (!userB) throw new Error('Real B login failed');
        boundary.replace(`user:${userB.id}`);
        release();
        const discarded = await task;
        const dataAbsent =
          cache.getQueryData(['private', userA.id, 'held']) === undefined;
        let mismatched = 0;
        const old = new Admission(() => {
          mismatched += 1;
        });
        old.replace(`user:${userA.id}`);
        let rejectedCookieB = false;
        try {
          await request(
            old.capture('me'),
            meSchema,
            new AbortController().signal,
            fetch,
          );
        } catch (error) {
          rejectedCookieB = error instanceof Discarded;
        }
        const csrfResponse = await fetch('/api/v1/auth/csrf', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const csrf = csrfSchema.parse(await csrfResponse.json());
        const unsafe = await fetch('/api/v1/auth/logout', {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf.csrf_token,
            'X-Lexicona-Expected-Principal': `user:${userA.id}`,
          },
          body: '{}',
        });
        const currentResponse = await fetch('/api/v1/auth/me', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const current = meSchema.parse(await currentResponse.json());
        control.suspend();
        return {
          actualStatus,
          discarded,
          dataAbsent,
          callbacks,
          rejectedCookieB,
          mismatched,
          unsafeStatus: unsafe.status,
          bUnaffected: current.user.id === userB.id,
        };
      },
      { accounts: credentials, heldStatus },
    );
    expect(result).toEqual({
      actualStatus: heldStatus,
      discarded: true,
      dataAbsent: true,
      callbacks: 0,
      rejectedCookieB: true,
      mismatched: 1,
      unsafeStatus: 412,
      bUnaffected: true,
    });
  });
}
