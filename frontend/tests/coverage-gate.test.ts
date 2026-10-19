import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as gate from '../tooling/coverage';
import { fixture, git, instrument, put } from './coverage-fixture';
const { inventory } = gate;

it('reads real V8 source-location coverage, including typed TSX (positive probe)', () => {
  const root = fixture({
    'src/View.tsx':
      '\n\n\n\n\n\n\n\n\n\nexport const View = (label: string) => <b>{label}</b>;\n',
    'tests/view.test.ts':
      "import { expect, it } from 'vitest'; import { View } from '../src/View'; it('view', () => expect(View('TSX').props.children).toBe('TSX'));",
    'src/contract.d.ts': 'export interface Word { id: string }',
  });
  roots.push(root);
  instrument(root);
  expect(gate).toHaveProperty('inspect', expect.any(Function));
  const result = gate.inspect(root);
  expect(result.failures).toEqual([]);
  expect(result.units['src/View.tsx']).toMatchObject({
    missing: [],
    lines: [11],
  });
  expect(
    result.sources.find(({ path }) => path === 'src/contract.d.ts')
      ?.applicability,
  ).toContain('type-only');
}, 30000);

it('accepts fully covered literal JSX comment delimiters from native V8', () => {
  const root = fixture({
    'vite.config.ts': readFileSync('vite.config.ts', 'utf8'),
    'src/View.tsx': `export const Slash = () => <p>// v8 ignore next</p>;
export const Block = () => <p>/* v8 ignore next */</p>;
`,
    'tests/view.test.ts': `import { expect, it } from 'vitest';
import { Slash, Block } from '../src/View';
it('renders literal children', () => {
  expect(Slash().props.children).toBe('// v8 ignore next');
  expect(Block().props.children).toBe('/* v8 ignore next */');
});`,
    'tests/setup.ts': '',
  });
  roots.push(root);
  expect(instrument(root)).toContain('passed');
  const summary = JSON.parse(
    readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8'),
  ) as { total: Record<string, { pct: number }> };
  for (const metric of ['lines', 'branches', 'functions', 'statements'])
    expect(summary.total[metric]?.pct).toBe(100);
  const result = gate.inspect(root);
  expect(result.units['src/View.tsx']?.missing).toEqual([]);
  expect(result.failures).toEqual([]);
}, 30000);

it('still rejects a genuine JSX comment beside literal JSX text with native V8', () => {
  const root = fixture({
    'vite.config.ts': readFileSync('vite.config.ts', 'utf8'),
    'src/View.tsx': `export const View = () => <p>/* c8 ignore next */{/* v8 ignore next */}// istanbul ignore next</p>;
`,
    'tests/view.test.ts': `import { expect, it } from 'vitest';
import { View } from '../src/View';
it('renders only literal children', () => {
  expect(View().props.children).toEqual(['/* c8 ignore next */', '// istanbul ignore next']);
});`,
    'tests/setup.ts': '',
  });
  roots.push(root);
  expect(instrument(root)).toContain('passed');
  const result = gate.inspect(root);
  expect(result.units['src/View.tsx']?.missing).toEqual([]);
  expect(result.failures).toEqual([
    'src/View.tsx:1: forbidden coverage directive',
  ]);
}, 30000);

const roots: string[] = [];
it('rejects a real unexecuted line and function', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\nexport function unused() {\n  return 42;\n}\n',
  });
  roots.push(root);
  instrument(root);
  expect(gate.inspect(root).failures.join('\n')).toMatch(
    /src\/value.ts: statement/,
  );
  expect(gate.inspect(root).failures.join('\n')).toMatch(
    /src\/value.ts: function/,
  );
}, 30000);
it('rejects a real missing branch even when every source line was hit', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\nexport const choose = (flag: boolean) => flag ? 1 : 2;\n',
    'tests/value.test.ts':
      "import { expect, it } from 'vitest'; import { choose } from '../src/value'; it('choice', () => expect(choose(true)).toBe(1));",
  });
  roots.push(root);
  instrument(root);
  const summary = JSON.parse(
    readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8'),
  ) as { total: { lines: { pct: number }; branches: { pct: number } } };
  expect(summary.total.lines.pct).toBe(100);
  expect(summary.total.branches.pct).toBeLessThan(100);
  expect(gate.inspect(root).failures.join('\n')).toMatch(
    /src\/value.ts: branch/,
  );
}, 30000);
it('manifests rename and untracked source before commit; both still fail real coverage', () => {
  const root = fixture({ 'src/never.ts': 'export const absent = () => 7;' });
  roots.push(root);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'mv', 'src/never.ts', 'src/renamed.ts');
  put(root, 'src/new untracked.ts', 'export const absent = () => 8;');
  put(root, 'src/value.ts', 'export const value = 1; // changed');
  instrument(root);
  expect(typeof gate.changes).toBe('function');
  expect(gate.changes(root, base)).toEqual([
    { status: 'R100', previous: 'src/never.ts', path: 'src/renamed.ts' },
    { status: 'M', path: 'src/value.ts' },
    { status: '?', path: 'src/new untracked.ts' },
  ]);
  expect(gate.inspect(root).failures.join('\n')).toMatch(/src\/renamed.ts:/);
  expect(gate.inspect(root).failures.join('\n')).toMatch(
    /src\/new untracked.ts:/,
  );
}, 30000);

it('does not allow an entirely unimported source to vanish from native coverage', () => {
  const root = fixture({ 'src/never.ts': 'export const absent = () => 7;' });
  roots.push(root);
  instrument(root);
  expect(gate.inspect(root).failures.join('\n')).toMatch(/src\/never.ts:/);
}, 30000);

it('rejects actual hidden coverage directives, but not directive-like strings or regexes', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\n/* v8 ignore next -- @preserve */\nexport function invisible() { return 99; }\n',
  });
  roots.push(root);
  instrument(root);
  const summary = JSON.parse(
    readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8'),
  ) as { total: { lines: { pct: number } } };
  expect(summary.total.lines.pct).toBe(100);
  expect(gate.inspect(root).failures.join('\n')).toMatch(
    /forbidden coverage directive/,
  );
}, 30000);

it('recognizes comment tokens across TSX/types while ignoring strings, templates, regexes, and JSX text', () => {
  const root = project({
    'src/strings.tsx': `export const a = '/* v8 ignore next */';\nexport const b = \`// c8 ignore next\`;\nexport const c = /istanbul ignore next/;\nexport const d = <b>istanbul ignore next</b>;\nexport const e = \`hello \${'/* v8 ignore next */'}\`;`,
    'src/comments.ts':
      '// c8 ignore next\nexport const a = 1; /* istanbul ignore else */\nexport const b = 2;\n// node:coverage disable\n// pragma: no branch\n',
    'src/types.d.ts': '/* v8 ignore file */\nexport interface T {}',
    'src/empty-body.tsx':
      'export const view = <>{/* v8 ignore next */}</>; export function empty() { /* c8 ignore next */ }',
  });
  const sources = inventory(root);
  expect(
    sources.find(({ path }) => path === 'src/strings.tsx')?.directives,
  ).toEqual([]);
  expect(
    sources.find(({ path }) => path === 'src/comments.ts')?.directives,
  ).toHaveLength(4);
  expect(
    sources.find(({ path }) => path === 'src/types.d.ts')?.directives,
  ).toHaveLength(1);
  expect(
    sources.find(({ path }) => path === 'src/empty-body.tsx')?.directives,
  ).toHaveLength(2);
});

it('detects baseline regression outside changed-source even with old debt and rounded 100%', () => {
  const root = fixture({
    'src/old.ts': 'export function oldDebt() { return 7; }\n',
    'src/steady.ts': 'export function steady() { return 8; }\n',
    'src/padding.ts': Array.from(
      { length: 800 },
      (_, index) => `export const pad${String(index)} = ${String(index)};`,
    ).join('\n'),
    'tests/value.test.ts':
      "import { expect, it } from 'vitest'; import { value } from '../src/value'; import { steady } from '../src/steady'; import '../src/padding'; it('value', () => { expect(value).toBe(1); expect(steady()).toBe(8); });",
  });
  roots.push(root);
  const base = git(root, 'rev-parse', 'HEAD');
  instrument(root);
  const before = gate.inspect(root);
  expect(before.failures.join('\n')).toMatch(/src\/old.ts/);
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { value } from '../src/value'; import '../src/padding'; it('value', () => expect(value).toBe(1));",
  );
  instrument(root);
  const current = gate.inspect(root);
  const summary = JSON.parse(
    readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8'),
  ) as { total: { lines: { pct: number } } };
  expect(Math.round(summary.total.lines.pct)).toBe(100);
  expect(gate.changes(root, base)).toEqual([
    { status: 'M', path: 'tests/value.test.ts' },
  ]);
  expect(typeof gate.regressions).toBe('function');
  expect(
    gate.regressions(current, before, gate.changes(root, base)).join('\n'),
  ).toMatch(/baseline regression: src\/steady.ts/);
  expect(gate.regressions(current, before, []).join('\n')).not.toMatch(
    /old.ts/,
  );
}, 30000);

it('fails closed for missing instrumentation, mismatched maps, wrong source paths and invalid locations', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\nexport const choose = (flag: boolean) => flag ? 1 : 2;\n',
    'tests/value.test.ts':
      "import { expect, it } from 'vitest'; import { value, choose } from '../src/value'; it('value', () => { expect(value).toBe(1); expect(choose(true)).toBe(1); expect(choose(false)).toBe(2); });",
  });
  roots.push(root);
  instrument(root);
  const file = join(root, 'coverage/coverage-final.json');
  const original = readFileSync(file, 'utf8');
  type Raw = Record<
    string,
    {
      path: string;
      s: Record<string, number>;
      statementMap: Record<
        string,
        {
          start: { line: number; column: number };
          end: { line: number; column: number | null };
        }
      >;
      f: Record<string, number>;
      fnMap: Record<string, unknown>;
      b: Record<string, number[]>;
      branchMap: Record<string, unknown>;
    }
  >;
  const mutations = [
    (raw: Raw) => {
      Reflect.deleteProperty(raw, join(root, 'src/value.ts'));
    },
    (raw: Raw) => {
      const entry = raw[join(root, 'src/value.ts')];
      if (entry) entry.path = '/compiled/bundle.js';
    },
    (raw: Raw) => {
      const entry = raw[join(root, 'src/value.ts')];
      if (entry) entry.s = {};
    },
    (raw: Raw) => {
      const location = raw[join(root, 'src/value.ts')]?.statementMap['0'];
      if (location) location.start.line = 99999;
    },
    (raw: Raw) => {
      const location = raw[join(root, 'src/value.ts')]?.statementMap['0'];
      if (location) location.end.line = 99999;
    },
    (raw: Raw) => {
      const location = raw[join(root, 'src/value.ts')]?.statementMap['0'];
      if (location) {
        location.start.line = 2;
        location.end.line = 1;
      }
    },
    (raw: Raw) => {
      const entry = raw[join(root, 'src/value.ts')];
      if (entry) {
        entry.statementMap = {};
        entry.s = {};
        entry.fnMap = {};
        entry.f = {};
        entry.branchMap = {};
        entry.b = {};
      }
    },
    (raw: Raw) => {
      const entry = raw[join(root, 'src/value.ts')];
      if (entry) entry.b['0'] = [];
    },
    (raw: Raw) => {
      const entry = raw[join(root, 'src/value.ts')];
      if (entry) Reflect.deleteProperty(entry, 'b');
    },
  ];
  for (const mutate of mutations) {
    const raw = JSON.parse(original) as Raw;
    mutate(raw);
    writeFileSync(file, JSON.stringify(raw));
    expect(() => gate.inspect(root)).toThrow();
  }
  writeFileSync(file, original);
  expect(gate.inspect(root).failures).toEqual([]);
}, 30000);

it('runs candidate instrumentation and writes independent manifest/baseline provenance', () => {
  const baselineRoot = fixture();
  roots.push(baselineRoot);
  instrument(baselineRoot);
  const root = clone(baselineRoot);
  const base = git(root, 'rev-parse', 'HEAD');
  expect(typeof gate.run).toBe('function');
  const report = gate.run(root, [base, baselineRoot, 'coverage']);
  expect(report.failures).toEqual([]);
  expect(report.baseline.commit).toBe(base);
  expect(report.candidate.snapshot.units['src/value.ts']?.missing).toEqual([]);
  expect(
    readFileSync(join(root, 'artifacts/coverage-gate.json'), 'utf8'),
  ).toContain(base);
  expect(
    readFileSync(join(root, 'artifacts/coverage-gate-native.log'), 'utf8'),
  ).toContain('1 passed');
}, 30000);

it('rejects native test failure and refuses real missing coverage even when native thresholds permit it', () => {
  const baselineRoot = fixture();
  roots.push(baselineRoot);
  instrument(baselineRoot);
  const root = clone(baselineRoot);
  const base = git(root, 'rev-parse', 'HEAD');
  put(root, 'src/untracked.ts', 'export const never = () => 7;');
  expect(() => gate.run(root, [base, baselineRoot, 'coverage'])).toThrow(
    /Coverage gate failed/,
  );
  expect(
    readFileSync(join(root, 'artifacts/coverage-gate.json'), 'utf8'),
  ).toContain('src/untracked.ts');
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; it('broken', () => expect(1).toBe(2));",
  );
  expect(() => gate.run(root, [base, baselineRoot, 'coverage'])).toThrow(
    /Native Vitest failed/,
  );
}, 30000);

it('requires an immutable separate baseline with the same locked/installed toolchain', () => {
  const baselineRoot = fixture();
  roots.push(baselineRoot);
  instrument(baselineRoot);
  const root = clone(baselineRoot);
  const base = git(root, 'rev-parse', 'HEAD');
  expect(() => gate.run(root, [base, root, 'coverage'])).toThrow(
    /separate baseline/,
  );
  expect(() =>
    gate.run(root, ['0'.repeat(40), baselineRoot, 'coverage']),
  ).toThrow(/Baseline HEAD/);
  put(baselineRoot, 'src/value.ts', 'export const value = 2;');
  expect(() => gate.run(root, [base, baselineRoot, 'coverage'])).toThrow(
    /Baseline is dirty/,
  );
  put(baselineRoot, 'src/value.ts', 'export const value: number = 1;\n');
  put(root, 'package-lock.json', '{}');
  expect(() => gate.run(root, [base, baselineRoot, 'coverage'])).toThrow(
    /toolchain/,
  );
  expect(() => gate.run(root, ['HEAD', baselineRoot, 'coverage'])).toThrow();
  expect(() => gate.run(root, [])).toThrow();
}, 30000);

it('keeps baseline branch outcomes across rename and fails closed if a snapshot lost units', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\nexport const choose = (flag: boolean) => flag ? 1 : 2;\n',
    'tests/value.test.ts':
      "import { expect, it } from 'vitest'; import { choose } from '../src/value'; it('choice', () => { expect(choose(true)).toBe(1); expect(choose(false)).toBe(2); });",
  });
  roots.push(root);
  instrument(root);
  const before = gate.inspect(root);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'mv', 'src/value.ts', 'src/renamed.ts');
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { choose } from '../src/renamed'; it('choice', () => expect(choose(true)).toBe(1));",
  );
  instrument(root);
  const current = gate.inspect(root);
  expect(
    gate.regressions(current, before, gate.changes(root, base)).join('\n'),
  ).toContain('baseline regression: src/renamed.ts: branch:');
  Reflect.deleteProperty(current.units, 'src/renamed.ts');
  expect(() =>
    gate.regressions(current, before, gate.changes(root, base)),
  ).toThrow(/Missing baseline\/candidate instrumentation/);
  const complete = gate.inspect(root);
  Reflect.deleteProperty(before.units, 'src/value.ts');
  expect(() =>
    gate.regressions(complete, before, gate.changes(root, base)),
  ).toThrow(/Missing baseline\/candidate instrumentation/);
}, 30000);

it('records deletion/rename-to-nonsource in changed-source, including a nested frontend prefix', () => {
  const baselineRoot = fixture({ 'src/extra.ts': 'export const extra = 2;' });
  roots.push(baselineRoot);
  put(
    baselineRoot,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { value } from '../src/value'; import '../src/extra'; it('value', () => expect(value).toBe(1));",
  );
  git(baselineRoot, 'add', '.');
  git(
    baselineRoot,
    '-c',
    'user.name=Coverage Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'extra coverage',
  );
  instrument(baselineRoot);
  const root = clone(baselineRoot);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'mv', 'src/extra.ts', 'extra.txt');
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { value } from '../src/value'; it('value', () => expect(value).toBe(1));",
  );
  put(root, 'note.txt', 'not source');
  const report = gate.run(root, [base, baselineRoot, 'coverage']);
  expect(report.changedSource).toContainEqual({
    status: 'R100',
    previous: 'src/extra.ts',
    path: 'extra.txt',
  });
  expect(report.changedSource).not.toContainEqual({
    status: '?',
    path: 'note.txt',
  });
  expect(gate.changes(join(root, 'src'), base)).toContainEqual({
    status: 'D',
    path: 'extra.ts',
  });
  put(root, 'src/new untracked.ts', 'export const missed = 7;');
  expect(gate.changes(join(root, 'src'), base)).toContainEqual({
    status: '?',
    path: 'new untracked.ts',
  });
}, 30000);

it('rejects source changing during instrumentation instead of accepting stale source-location JSON', () => {
  const baselineRoot = fixture();
  roots.push(baselineRoot);
  instrument(baselineRoot);
  const root = clone(baselineRoot);
  const base = git(root, 'rev-parse', 'HEAD');
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { writeFileSync } from 'node:fs'; import { value } from '../src/value'; it('mutates source', () => { expect(value).toBe(1); writeFileSync('src/value.ts', 'export const value = 1;\\nexport const newUncovered = () => 7;'); });",
  );
  expect(() => gate.run(root, [base, baselineRoot, 'coverage'])).toThrow(
    /Source changed during instrumentation/,
  );
}, 30000);

it('validates native implicit-else locations without dropping their uncovered outcomes', () => {
  const root = fixture({
    'src/value.ts':
      'export const value = 1;\nexport function choose(flag: boolean) { if (flag) return 1; return 2; }\n',
    'tests/value.test.ts':
      "import { expect, it } from 'vitest'; import { choose } from '../src/value'; it('choice', () => { expect(choose(true)).toBe(1); expect(choose(false)).toBe(2); });",
  });
  roots.push(root);
  instrument(root);
  expect(gate.inspect(root).failures).toEqual([]);
  const reportPath = join(root, 'coverage/coverage-final.json');
  const original = readFileSync(reportPath, 'utf8');
  const raw = JSON.parse(original) as Record<
    string,
    { branchMap: Record<string, { type: string; locations: unknown[] }> }
  >;
  const branch = raw[join(root, 'src/value.ts')]?.branchMap['0'];
  expect(branch).toBeDefined();
  if (!branch) throw new Error('Native fixture did not produce a branch');
  branch.type = 'cond-expr';
  writeFileSync(reportPath, JSON.stringify(raw));
  expect(() => gate.inspect(root)).toThrow(/Invalid implicit-else/);
  branch.type = 'if';
  branch.locations.reverse();
  writeFileSync(reportPath, JSON.stringify(raw));
  expect(() => gate.inspect(root)).toThrow(/Invalid implicit-else/);
  writeFileSync(reportPath, original);
  put(
    root,
    'tests/value.test.ts',
    "import { expect, it } from 'vitest'; import { choose } from '../src/value'; it('choice', () => expect(choose(true)).toBe(1));",
  );
  instrument(root);
  expect(gate.inspect(root).failures.join('\n')).toContain('branch:');
}, 30000);

function clone(baselineRoot: string) {
  const root = mkdtempSync(join(process.cwd(), 'artifacts', 'candidate-'));
  roots.push(root);
  execFileSync('git', [
    'clone',
    '--quiet',
    '--no-hardlinks',
    baselineRoot,
    root,
  ]);
  symlinkSync(
    join(process.cwd(), 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  return root;
}

it('does not silently exclude runtime directories named like build outputs; rejects source symlinks', () => {
  const root = project({
    'src/artifacts/hidden.ts': 'export const hidden = 1;',
  });
  expect(inventory(root).map(({ path }) => path)).toContain(
    'src/artifacts/hidden.ts',
  );
  symlinkSync(join(root, 'src/artifacts'), join(root, 'linked-source'), 'dir');
  expect(() => inventory(root)).toThrow(/Source symlink/);
});

function project(files: Record<string, string>) {
  mkdirSync('artifacts', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'artifacts', 'inventory-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('has an independent source inventory, not just imported coverage entries', () => {
  expect(inventory(process.cwd())).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'src/main.tsx',
        applicability: 'executable',
      }),
      expect.objectContaining({
        path: 'tooling/coverage.ts',
        applicability: 'executable',
      }),
    ]),
  );
});

it('makes pure types and declarations explicit N/A without excluding runtime TS/JS', () => {
  const root = project({
    'src/contracts.ts':
      'export interface Word { id: string }; export type Id = string;',
    'src/global.d.ts': 'declare const publicValue: string;',
    'src/empty.ts': '// empty',
    'src/only-import.ts':
      "import type { Id } from './contracts'; export type Key = Id;",
    'src/value.js': 'export const value = 1;',
    'src/value-import.ts':
      "import { Id } from './contracts'; export type Key = Id;",
    'src/extra.tsx': 'export const view = <b>Hello</b>;',
    'tooling/value.mjs': 'export const value = 1;',
    'unexpected.cjs': 'module.exports = 2;',
    'tests/support.ts': 'export const helper = 1;',
    'e2e/server.ts': 'export const helper = 1;',
    'vite.config.ts': 'export default {};',
    'node_modules/hidden.ts': 'export const value = 1;',
    'dist/hidden.js': 'export const value = 1;',
    'coverage/hidden.js': 'export const value = 1;',
    'artifacts/hidden.ts': 'export const value = 1;',
    '.git/hidden.ts': 'export const value = 1;',
    'src/style.css': 'body {}',
  });
  expect(
    inventory(root).map(({ path, applicability }) => [path, applicability]),
  ).toEqual([
    ['e2e/server.ts', 'test-support'],
    ['src/contracts.ts', 'type-only: no emitted executable units'],
    ['src/empty.ts', 'type-only: no emitted executable units'],
    ['src/extra.tsx', 'executable'],
    ['src/global.d.ts', 'type-only: no emitted executable units'],
    ['src/only-import.ts', 'type-only: no emitted executable units'],
    ['src/value-import.ts', 'executable'],
    ['src/value.js', 'executable'],
    ['tests/support.ts', 'test-support'],
    ['tooling/value.mjs', 'executable'],
    ['unexpected.cjs', 'executable'],
    ['vite.config.ts', 'configuration'],
  ]);
});
