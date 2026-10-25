import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2EServer } from './server';
import { seedAccounts } from './accounts';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
let server: E2EServer;
let accounts: Awaited<ReturnType<typeof seedAccounts>>;
test.beforeEach(async () => {
  server = new E2EServer();
  await server.start();
  accounts = await seedAccounts(server.databasePath);
});
test.afterEach(async () => {
  await server.stop();
});
async function login(page: Page, account: { login: string; password: string }) {
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Вход в аккаунт' }),
  ).toBeVisible();
  await page.evaluate((account) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    );
    if (!descriptor?.set) throw new Error('Input unavailable');
    for (const [id, value] of Object.entries(account)) {
      const element = document.getElementById(id);
      if (!(element instanceof HTMLInputElement))
        throw new Error('Input unavailable');
      descriptor.set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, account);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личный словарь' }),
  ).toBeVisible();
}
test('A10 two real shared-cookie tabs without notification reject actual nonempty admin payload before old-user cache/callback', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
  });
  try {
    const first = await context.newPage();
    await login(first, accounts.member);
    const probe = first.evaluate(async () => {
      const { AuthClient } = await import('../src/auth/client.ts');
      const { Admission } = await import('../src/auth/admission.ts');
      const { request } = await import('../src/auth/transport.ts');
      const { inviteListSchema } = await import('../src/auth/wire.ts');
      const owner = new AuthClient();
      await owner.recheck();
      const original = owner.getSnapshot();
      const cache = original.privateQueries;
      if (!cache || !original.user) throw new Error('No current test owner');
      const boundary = new Admission(() => {
        owner.suspend();
      });
      boundary.replace(`user:${original.user.id}`);
      const lease = boundary.capture('inviteList');
      const changed = new Promise<void>((resolve) => {
        window.addEventListener(
          'test-cookie-changed',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      document.documentElement.dataset.testReady = 'true';
      await changed;
      let callbacks = 0;
      let actualStatus = 0;
      let hasActualItems = false;
      const actual: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        actualStatus = response.status;
        hasActualItems =
          inviteListSchema.parse(await response.clone().json()).items.length >
          0;
        return response;
      };
      const rejected = await cache
        .query({
          queryKey: ['private', original.user.id, 'shared-cookie-invites'],
          queryFn: async () => {
            const data = await request(
              lease,
              inviteListSchema,
              new AbortController().signal,
              actual,
            );
            lease.consume(() => {
              callbacks += 1;
            });
            return data;
          },
        })
        .then(
          () => false,
          () => true,
        );
      const noData = cache.getQueryCache().getAll().length === 0;
      const hidden = owner.getSnapshot().user === null;
      await owner.recheck();
      const newOwner = owner.getSnapshot().user?.role === 'admin';
      owner.suspend();
      return {
        actualStatus,
        hasActualItems,
        rejected,
        noData,
        hidden,
        newOwner,
        callbacks,
      };
    });
    await first.waitForFunction(
      () => document.documentElement.dataset.testReady === 'true',
    );
    const second = await context.newPage();
    await second.goto('/dictionary');
    await expect(
      second.getByRole('heading', { name: 'Личный словарь' }),
    ).toBeVisible();
    await second.getByRole('button', { name: 'Выйти' }).click();
    await expect(
      second.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    await login(second, accounts.admin);
    await second
      .getByRole('link', { name: 'Управление приглашениями' })
      .click();
    await second.getByRole('button', { name: 'Создать приглашение' }).click();
    await expect
      .poll(() =>
        second.evaluate(() => document.querySelector('output') !== null),
      )
      .toBe(true);
    await first.evaluate(() => {
      window.dispatchEvent(new Event('test-cookie-changed'));
    });
    expect(await probe).toEqual({
      actualStatus: 200,
      hasActualItems: true,
      rejected: true,
      noData: true,
      hidden: true,
      newOwner: true,
      callbacks: 0,
    });
  } finally {
    await context.close();
  }
});
test('A10 actual UI route departure cannot resurrect an already-committed delayed create secret', async ({
  page,
}) => {
  await login(page, accounts.admin);
  await page.getByRole('link', { name: 'Управление приглашениями' }).click();
  let arrive!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let actualStatus = 0;
  await page.route('**/api/v1/admin/invites', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    actualStatus = response.status();
    arrive();
    await barrier;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Создать приглашение' }).click();
    await arrival;
    await page.getByRole('link', { name: 'Словарь', exact: true }).click();
    release();
    await expect(
      page.getByRole('heading', { name: 'Личный словарь' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Управление приглашениями' }).click();
    await expect(
      page.getByRole('heading', { name: 'Приглашения', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.querySelector('li') !== null))
      .toBe(true);
    expect(actualStatus).toBe(201);
    expect(
      await page.evaluate(() => document.querySelector('output') === null),
    ).toBe(true);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
