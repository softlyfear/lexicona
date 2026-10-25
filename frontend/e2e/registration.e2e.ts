import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { E2EServer } from './server';
import { protectedAdmin } from './bootstrap';
import { seedAccounts, expireInvite } from './accounts';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const server = new E2EServer();
let admin: { login: string; password: string };
const member = {
  login: 'registered_member',
  password: randomBytes(32).toString('base64url'),
};
let usedToken = '';
let revokedToken = '';

test.describe('fresh protected CLI vertical flow', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    await server.start();
    const fault = await protectedAdmin(server.databasePath, true);
    expect(fault.proof).toEqual({
      success: false,
      fault_cleaned: true,
      noecho_checks: 0,
      output_redacted: true,
      wal: true,
      users: 0,
      settings: 0,
    });
    const success = await protectedAdmin(server.databasePath);
    expect(success.proof).toEqual({
      success: true,
      fault_cleaned: false,
      noecho_checks: 2,
      output_redacted: true,
      wal: true,
      users: 1,
      settings: 1,
    });
    admin = success.account;
  });
  test.afterAll(async () => {
    await server.stop();
  });

  async function fill(page: Page, values: Record<string, string>) {
    await page.evaluate((values) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      if (!descriptor?.set) throw new Error('Input setup unavailable');
      for (const [id, value] of Object.entries(values)) {
        const element = document.getElementById(id);
        if (!(element instanceof HTMLInputElement))
          throw new Error('Input unavailable');
        descriptor.set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, values);
  }
  async function login(
    page: Page,
    account: { login: string; password: string },
  ) {
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: 'Вход в аккаунт' }),
    ).toBeVisible();
    await fill(page, account);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(
      page.getByRole('heading', { name: 'Личный словарь' }),
    ).toBeVisible();
  }
  async function token(page: Page) {
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('output') !== null),
      )
      .toBe(true);
    return page.evaluate(
      () => document.querySelector('output')?.textContent ?? '',
    );
  }

  test('A09 protected CLI→admin create/copy→independent registration→reload/logout/login, real list/cursor/revoke and negatives', async ({
    browser,
  }) => {
    const admins = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 320, height: 950 },
    });
    const members = await browser.newContext({
      viewport: { width: 320, height: 950 },
    });
    try {
      const a = await admins.newPage();
      const b = await members.newPage();
      await login(a, admin);
      await a.getByRole('link', { name: 'Управление приглашениями' }).click();
      await expect(
        a.getByRole('heading', { name: 'Приглашения', exact: true }),
      ).toBeVisible();
      await a.getByRole('button', { name: 'Создать приглашение' }).click();
      usedToken = await token(a);
      await a.getByRole('button', { name: 'Скопировать код' }).click();
      expect(
        await a.evaluate(
          async (expected) =>
            (await navigator.clipboard.readText()) === expected,
          usedToken,
        ),
      ).toBe(true);
      await b.goto('/register');
      await expect(
        b.getByRole('heading', { name: 'Регистрация по приглашению' }),
      ).toBeVisible();
      await b.getByRole('button', { name: 'Зарегистрироваться' }).click();
      expect(
        await b.evaluate(
          () =>
            document.activeElement?.id === 'invite_token' &&
            document
              .querySelector('#invite_token')
              ?.getAttribute('aria-invalid') === 'true',
        ),
      ).toBe(true);
      expect(
        await b.evaluate(() =>
          [
            ...document.querySelectorAll('form input, form button, form a'),
          ].every((element) => element.getBoundingClientRect().height >= 44),
        ),
      ).toBe(true);
      await fill(b, {
        invite_token: usedToken,
        login: admin.login,
        display_name: 'Новый участник',
        password: member.password,
      });
      await b.getByRole('button', { name: 'Зарегистрироваться' }).click();
      await expect(b.getByRole('alert')).toContainText('Логин недоступен.');
      expect(
        await b.evaluate(
          (expected) =>
            document.querySelector<HTMLInputElement>('#invite_token')?.value ===
            expected,
          usedToken,
        ),
      ).toBe(true);
      await fill(b, { login: member.login });
      await b.getByRole('button', { name: 'Зарегистрироваться' }).click();
      await expect(
        b.getByRole('heading', { name: 'Личный словарь' }),
      ).toBeVisible();
      await expect(
        b.getByText('Новый участник', { exact: true }),
      ).toBeVisible();
      await b.reload();
      await expect(
        b.getByText('Новый участник', { exact: true }),
      ).toBeVisible();
      await b.getByRole('button', { name: 'Выйти' }).click();
      await expect(
        b.getByRole('heading', { name: 'Вход в аккаунт' }),
      ).toBeVisible();
      await login(b, member);
      await b.goto('/admin/invites');
      await expect(
        b.getByRole('heading', { name: 'Недостаточно прав' }),
      ).toBeVisible();
      expect(
        await b.evaluate(
          async () =>
            (await fetch('/api/v1/admin/invites', { cache: 'no-store' }))
              .status,
        ),
      ).toBe(403);
      await a.getByRole('button', { name: 'Обновить список' }).click();
      await expect(
        a.getByRole('heading', { name: 'Использовано', exact: true }),
      ).toBeVisible();
      await a.getByRole('button', { name: 'Создать приглашение' }).click();
      revokedToken = await token(a);
      await a
        .locator('li')
        .filter({
          has: a.getByRole('heading', { name: 'Действует', exact: true }),
        })
        .getByRole('button', { name: 'Отозвать', exact: true })
        .click();
      await expect(
        a.getByRole('heading', { name: 'Отозвано', exact: true }),
      ).toBeVisible();
      await a.getByRole('button', { name: 'Создать приглашение' }).click();
      await token(a);
      await a.getByRole('button', { name: 'Следующая страница' }).click();
      await expect(
        a.getByRole('heading', { name: 'Использовано', exact: true }),
      ).toBeVisible();
      expect(
        await a.evaluate(
          () =>
            document
              .querySelector('li')
              ?.textContent.includes('invite_token') ?? true,
        ),
      ).toBe(false);
      await a.getByRole('link', { name: 'Словарь', exact: true }).click();
      await a.getByRole('link', { name: 'Управление приглашениями' }).click();
      await expect(a.locator('output')).toHaveCount(0);
      await a.reload();
      await expect(
        a.getByRole('heading', { name: 'Приглашения', exact: true }),
      ).toBeVisible();
      await expect(a.locator('output')).toHaveCount(0);
      for (const page of [a, b]) {
        expect(
          await page.evaluate(async () => ({
            overflow:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
            local: localStorage.length,
            session: sessionStorage.length,
            idb: (await indexedDB.databases()).length,
            cache: (await caches.keys()).length,
            targets: [
              ...document.querySelectorAll('button,input,select,nav a'),
            ].filter((e) => e.getBoundingClientRect().height < 44).length,
          })),
        ).toEqual({
          overflow: false,
          local: 0,
          session: 0,
          idb: 0,
          cache: 0,
          targets: 0,
        });
        await page.getByLabel('Тема').selectOption('light');
        await page.getByLabel('Тема').selectOption('system');
        await page.getByLabel('Тема').selectOption('dark');
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => document.activeElement !== document.body),
        ).toBe(true);
      }
      const activeId = await a.evaluate(async () => {
        const { inviteListSchema } = await import('../src/auth/wire.ts');
        return (
          inviteListSchema
            .parse(
              await (
                await fetch('/api/v1/admin/invites', { cache: 'no-store' })
              ).json(),
            )
            .items.find((item) => item.state === 'active')?.id ?? ''
        );
      });
      await expireInvite(server.databasePath, activeId);
      await a.getByRole('button', { name: 'Обновить список' }).click();
      // Moving created_at for the expiry fixture also moves its descending keyset position.
      await a.getByRole('button', { name: 'Следующая страница' }).click();
      await expect(
        a.getByRole('heading', { name: 'Истекло', exact: true }),
      ).toBeVisible();
      // Direct actual API CAS/used/expired-state negatives, never dump DTOs.
      const negative = await a.evaluate(async () => {
        const { csrfSchema, inviteListSchema } =
          await import('../src/auth/wire.ts');
        const csrf = csrfSchema.parse(
          await (
            await fetch('/api/v1/auth/csrf', { cache: 'no-store' })
          ).json(),
        );
        const list = inviteListSchema.parse(
          await (
            await fetch('/api/v1/admin/invites', { cache: 'no-store' })
          ).json(),
        );
        const used = list.items.find((i) => i.state === 'used');
        const expired = list.items.find((i) => i.state === 'expired');
        const current = await fetch('/api/v1/auth/me', { cache: 'no-store' });
        const principal = current.headers.get('X-Lexicona-Request-Principal');
        if (!used || !expired || !principal)
          throw new Error('Missing committed metadata');
        const statuses = [];
        for (const [item, version] of [
          [used, used.version],
          [used, used.version + 1],
          [expired, expired.version],
        ] as const) {
          const response = await fetch(
            `/api/v1/admin/invites/${item.id}/revoke`,
            {
              method: 'POST',
              cache: 'no-store',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf.csrf_token,
                'X-Lexicona-Expected-Principal': principal,
              },
              body: JSON.stringify({ expected_version: version }),
            },
          );
          statuses.push(response.status);
        }
        return {
          statuses,
          listHasSecrets: JSON.stringify(list).includes('invite_token'),
        };
      });
      expect(negative).toEqual({
        statuses: [409, 409, 409],
        listHasSecrets: false,
      });
    } finally {
      await admins.close();
      await members.close();
    }
  });

  test('A09 invalid, reused and revoked invitations cannot register or erase same-owner input', async ({
    page,
  }) => {
    expect(usedToken.length === 43 && revokedToken.length === 43).toBe(true);
    await page.goto('/register');
    await expect(
      page.getByRole('heading', { name: 'Регистрация по приглашению' }),
    ).toBeVisible();
    for (const invite_token of [
      randomBytes(32).toString('base64url'),
      usedToken,
      revokedToken,
    ]) {
      await fill(page, {
        invite_token,
        login: 'rejected_member',
        display_name: 'Отказ',
        password: randomBytes(32).toString('base64url'),
      });
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
      await expect(page.getByRole('alert')).toHaveText(
        'Приглашение недействительно.',
      );
      expect(
        await page.evaluate(
          (expected) =>
            document.querySelector<HTMLInputElement>('#invite_token')?.value ===
            expected,
          invite_token,
        ),
      ).toBe(true);
    }
  });
});
for (const mode of ['list', 'create', '401', 'leave'] as const) {
  test.describe(`independent real resource ${mode}`, () => {
    const isolatedServer = new E2EServer();
    let accounts: Awaited<ReturnType<typeof seedAccounts>>;
    test.beforeAll(async () => {
      await isolatedServer.start();
      accounts = await seedAccounts(isolatedServer.databasePath);
    });
    test.afterAll(async () => {
      await isolatedServer.stop();
    });
    test(`A10 held actual private ${mode} payload/body cannot reach B or resurrect a departed route secret`, async ({
      page,
    }) => {
      await page.goto('/login');
      await expect(
        page.getByRole('heading', { name: 'Вход в аккаунт' }),
      ).toBeVisible();
      const result = await page.evaluate(
        async ({ admin, member, mode }) => {
          const { AuthClient } = await import('../src/auth/client.ts');
          const { Admission, Discarded } =
            await import('../src/auth/admission.ts');
          const { request } = await import('../src/auth/transport.ts');
          const { inviteListSchema } = await import('../src/auth/wire.ts');
          const control = new AuthClient();
          await control.recheck();
          await control.login(admin);
          let arrived!: () => void;
          let release!: () => void;
          const arrival = new Promise<void>((r) => {
            arrived = r;
          });
          const barrier = new Promise<void>((r) => {
            release = r;
          });
          let actualStatus = 0;
          const delayed: typeof fetch = async (input, init) => {
            const response = await fetch(input, { ...init, signal: null });
            const path =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            if (path.includes('/admin/invites')) {
              actualStatus = response.status;
              const body = response.json.bind(response);
              if (
                mode === '401' ||
                (response.status !== 200 && response.status !== 201)
              ) {
                await response.clone().json();
                arrived();
                await barrier;
              } else
                response.json = async () => {
                  const data: unknown = await body();
                  arrived();
                  await barrier;
                  return data;
                };
            }
            return response;
          };
          const isolated = new AuthClient(delayed);
          await isolated.recheck();
          const original = isolated.getSnapshot();
          const cache = original.privateQueries;
          if (!original.user || !cache) throw new Error('No real admin owner');
          const resource = isolated.openInvites();
          if (mode === '401') await control.logout();
          const pending =
            mode === 'create' || mode === 'leave'
              ? resource.create()
              : resource.load();
          await arrival;
          let callbacks = 0;
          resource.subscribe(() => {
            callbacks += 1;
          });
          if (mode === 'leave') resource.dispose();
          else {
            if (mode !== '401') await control.logout();
            await control.login(member);
            await isolated.recheck();
          }
          release();
          await pending;
          const now = isolated.getSnapshot();
          const changed =
            mode === 'leave'
              ? now.user?.id === original.user.id
              : now.user?.login === member.login;
          const clean =
            resource.getSnapshot().token === null &&
            cache.getMutationCache().getAll().length === 0 &&
            cache.getQueryCache().getAll().length === 0;
          // Shared cookie without notification: an A capture sees real admin-B list200.
          if (mode !== 'leave') {
            await control.logout();
            await control.login(admin);
          }
          const old = new Admission(() => {});
          old.replace(
            `user:${mode === 'leave' ? original.user.id : (now.user?.id ?? '')}`,
          );
          if (mode === 'leave') {
            resource.dispose();
            isolated.suspend();
            control.suspend();
            return {
              actualStatus,
              callbacks,
              changed,
              clean,
              stampRejected: true,
            };
          }
          let stampRejected = false;
          try {
            await request(
              old.capture('inviteList'),
              inviteListSchema,
              new AbortController().signal,
              fetch,
            );
          } catch (error) {
            stampRejected = error instanceof Discarded;
          }
          isolated.suspend();
          control.suspend();
          return { actualStatus, callbacks, changed, clean, stampRejected };
        },
        { admin: accounts.admin, member: accounts.member, mode },
      );
      expect(result).toEqual({
        actualStatus:
          mode === 'create' || mode === 'leave'
            ? 201
            : mode === '401'
              ? 401
              : 200,
        callbacks: 0,
        changed: true,
        clean: true,
        stampRejected: true,
      });
    });
  });
}
