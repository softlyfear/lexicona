import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Canonicalize in memory; failed generation/check never rewrites the target. */
export function generate(frontend: string, args: string[]) {
  const [mode] = z.tuple([z.enum(['generate', 'check'])]).parse(args);
  const root = resolve(frontend, '..');
  const target = join(frontend, 'src/shared/api/generated.ts');
  const raw = execFileSync(
    process.execPath,
    [
      join(root, 'tooling/openapi/node_modules/openapi-typescript/bin/cli.js'),
      join(root, 'backend/openapi/auth-v1.json'),
      '--silent',
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const canonical = execFileSync(
    process.execPath,
    [
      join(frontend, 'node_modules/prettier/bin/prettier.cjs'),
      '--config',
      join(frontend, '.prettierrc.json'),
      '--stdin-filepath',
      target,
    ],
    { input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (mode === 'check') {
    if (readFileSync(target, 'utf8') !== canonical)
      throw new Error('Generated types drift');
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, canonical);
  }
}
