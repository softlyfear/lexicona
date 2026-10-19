import { expect, it } from 'vitest';
import config from '../vite.config';

it('emits native V8 source-location JSON and covers first-party tooling', () => {
  expect(config.test?.coverage?.reporter).toContain('json');
  expect(config.test?.coverage?.include).toContain('tooling/**/*.{ts,tsx}');
  expect(config.test?.coverage).toMatchObject({
    provider: 'v8',
    thresholds: {
      perFile: true,
      lines: 100,
      branches: 100,
      statements: 100,
      functions: 100,
    },
  });
});
