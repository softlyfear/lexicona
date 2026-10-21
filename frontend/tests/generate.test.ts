import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../tooling/generate';
import { inventory } from '../tooling/coverage';
import ts from 'typescript';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lexicona-generation-'));
  folders.push(root);
  mkdirSync(join(root, 'frontend/src/shared/api'), { recursive: true });
  mkdirSync(join(root, 'tooling/openapi'), { recursive: true });
  mkdirSync(join(root, 'backend/openapi'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(root, 'frontend/node_modules'));
  symlinkSync(
    resolve('../tooling/openapi/node_modules'),
    join(root, 'tooling/openapi/node_modules'),
  );
  writeFileSync(
    join(root, 'frontend/.prettierrc.json'),
    readFileSync(resolve('.prettierrc.json')),
  );
  const schema = join(root, 'backend/openapi/auth-v1.json');
  writeFileSync(
    schema,
    readFileSync(resolve('../backend/openapi/auth-v1.json')),
  );
  return {
    root: join(root, 'frontend'),
    schema,
    output: join(root, 'frontend/src/shared/api/generated.ts'),
  };
}
describe('canonical actual-schema generation', () => {
  it('proves generated actual output is AST type-only and emits no executable units', () => {
    const path = 'src/shared/api/generated.ts';
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(source.statements.length).toBeGreaterThan(0);
    expect(
      source.statements.every(
        (node) =>
          ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
      ),
    ).toBe(true);
    expect(
      inventory(process.cwd()).find((entry) => entry.path === path)
        ?.applicability,
    ).toBe('type-only: no emitted executable units');
  });
  it('is deterministic, read-only in check mode, and rejects missing/stale/invalid input', () => {
    const f = fixture();
    expect(() => {
      generate(f.root, ['check']);
    }).toThrow();
    generate(f.root, ['generate']);
    const bytes = readFileSync(f.output, 'utf8');
    generate(f.root, ['check']);
    generate(f.root, ['generate']);
    expect(readFileSync(f.output, 'utf8')).toBe(bytes);
    writeFileSync(f.output, bytes + '// stale\n');
    expect(() => {
      generate(f.root, ['check']);
    }).toThrow('Generated types drift');
    expect(readFileSync(f.output, 'utf8')).toBe(bytes + '// stale\n');
    expect(() => {
      generate(f.root, ['unknown']);
    }).toThrow();
    writeFileSync(f.schema, '{broken');
    expect(() => {
      generate(f.root, ['generate']);
    }).toThrow();
    expect(readFileSync(f.output, 'utf8')).toBe(bytes + '// stale\n');
  }, 20_000);
});
