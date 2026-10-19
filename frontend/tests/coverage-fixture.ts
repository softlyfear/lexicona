import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const frontend = process.cwd();
export function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
export function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
export function fixture(files: Record<string, string> = {}) {
  mkdirSync(join(frontend, 'artifacts'), { recursive: true });
  const root = mkdtempSync(join(frontend, 'artifacts', 'probe-'));
  symlinkSync(
    join(frontend, 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  put(root, '.gitignore', 'node_modules\ncoverage/\nartifacts/\n');
  put(root, 'package.json', '{"type":"module"}');
  put(
    root,
    'package-lock.json',
    readFileSync(join(frontend, 'package-lock.json'), 'utf8'),
  );
  // Negative collectors must emit real missing units; production keeps all four thresholds at 100.
  put(
    root,
    'vite.config.ts',
    `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'],
coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}', 'tooling/**/*.{ts,tsx}'],
reporter: ['json', 'json-summary'], thresholds: { perFile: true, lines: 0, branches: 0, functions: 0, statements: 0 } } } });`,
  );
  put(root, 'src/value.ts', 'export const value: number = 1;\n');
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { value } from '../src/value'; it('value', () => expect(value).toBe(1));\n",
  );
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Coverage Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'baseline fixture',
  );
  return root;
}
export function instrument(root: string) {
  return execFileSync(
    process.execPath,
    [join(frontend, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}
