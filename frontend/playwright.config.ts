import { defineConfig } from '@playwright/test';

// Playwright's default failure aria snapshot can contain one-time invite output.
// The installed runner checks this flag before capturing any page snapshot.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalTimeout: 180_000,
  outputDir: './artifacts/playwright',
  reporter: [
    ['list'],
    ['json', { outputFile: './artifacts/playwright-results.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    headless: true,
    // Auth traffic contains designated CSRF responses: never retain traces.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
