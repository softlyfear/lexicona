import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

const point = z.object({
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});
const location = z.object({
  start: point,
  end: point.extend({ column: z.number().int().nonnegative().nullable() }),
});
const implicitLocation = z.object({
  start: z.strictObject({}),
  end: z.strictObject({}),
});
const branch = z
  .object({
    loc: location,
    type: z.string(),
    locations: z.array(z.union([location, implicitLocation])),
  })
  .transform(({ loc, type, locations }) => ({
    locations: locations.map((range, index) => {
      if ('line' in range.start) return location.parse(range);
      if (type !== 'if' || index !== 1)
        throw new Error('Invalid implicit-else location');
      return loc;
    }),
  }));
const count = z.number().int().nonnegative();
const coverageSchema = z.record(
  z.string(),
  z.object({
    path: z.string(),
    statementMap: z.record(z.string(), location),
    s: z.record(z.string(), count),
    fnMap: z.record(z.string(), z.object({ loc: location })),
    f: z.record(z.string(), count),
    branchMap: z.record(z.string(), branch),
    b: z.record(z.string(), z.array(count)),
  }),
);

export function inspect(root: string, directory = 'coverage') {
  const sources = inventory(root);
  const raw = coverageSchema.parse(
    JSON.parse(
      readFileSync(resolve(root, directory, 'coverage-final.json'), 'utf8'),
    ),
  );
  const units: Record<string, { missing: string[]; lines: number[] }> = {};
  for (const source of sources.filter(
    ({ applicability }) => applicability === 'executable',
  )) {
    const file = raw[join(root, source.path)];
    if (!file) throw new Error(`Uninstrumented source: ${source.path}`);
    if (file.path !== join(root, source.path))
      throw new Error(`Not original source TS/TSX: ${source.path}`);
    for (const [map, hits] of [
      [file.statementMap, file.s],
      [file.fnMap, file.f],
      [file.branchMap, file.b],
    ] as const) {
      if (
        JSON.stringify(Object.keys(map).sort()) !==
        JSON.stringify(Object.keys(hits).sort())
      )
        throw new Error(`Incomplete coverage maps: ${source.path}`);
    }
    const lines = readFileSync(join(root, source.path), 'utf8').split('\n');
    const locations = [
      ...Object.values(file.statementMap),
      ...Object.values(file.fnMap).map(({ loc }) => loc),
      ...Object.values(file.branchMap).flatMap(({ locations }) => locations),
    ];
    if (locations.length === 0)
      throw new Error(`No instrumented units: ${source.path}`);
    for (const loc of locations) {
      if (
        loc.start.line > lines.length ||
        loc.end.line > lines.length ||
        loc.start.line > loc.end.line
      )
        throw new Error(`Location outside original source: ${source.path}`);
    }
    const branches = Object.entries(file.branchMap).map(
      ([id, { locations }]) => {
        const outcomes = z.array(count).parse(file.b[id]);
        if (locations.length !== outcomes.length)
          throw new Error(`Incomplete branch outcomes: ${source.path}`);
        return { locations, outcomes };
      },
    );
    units[source.path] = {
      missing: [
        ...Object.entries(file.s)
          .filter(([, hits]) => hits === 0)
          .map(([id]) => `statement:${JSON.stringify(file.statementMap[id])}`),
        ...Object.entries(file.f)
          .filter(([, hits]) => hits === 0)
          .map(([id]) => `function:${JSON.stringify(file.fnMap[id])}`),
        ...branches.flatMap(({ locations, outcomes }) =>
          outcomes.flatMap((hits, index) =>
            hits === 0
              ? [`branch:${JSON.stringify(locations[index])}:${String(index)}`]
              : [],
          ),
        ),
      ],
      lines: [
        ...new Set(
          Object.values(file.statementMap).map(({ start }) => start.line),
        ),
      ].sort((a, b) => a - b),
    };
  }
  return {
    sources,
    units,
    failures: [
      ...sources.flatMap(({ directives }) => directives),
      ...Object.entries(units).flatMap(([path, unit]) =>
        unit.missing.map((missing) => `${path}: ${missing}`),
      ),
    ],
  };
}

export function run(root: string, args: string[]) {
  const [baseline, baselineRoot, baselineDirectory] = z
    .tuple([
      z.string().regex(/^[a-f0-9]{40}$/),
      z.string().min(1),
      z.string().min(1),
    ])
    .parse(args);
  if (realpathSync(root) === realpathSync(baselineRoot))
    throw new Error('Use a separate baseline environment');
  if (git(baselineRoot, 'rev-parse', 'HEAD') !== baseline)
    throw new Error('Baseline HEAD does not match immutable B');
  if (changes(baselineRoot, baseline).length > 0)
    throw new Error('Baseline is dirty');
  const tools = toolchain(root);
  if (JSON.stringify(tools) !== JSON.stringify(toolchain(baselineRoot)))
    throw new Error(
      'Incompatible baseline toolchain; rerun/explain separately',
    );
  const before = JSON.stringify(inventory(root));
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage'],
    { cwd: root, encoding: 'utf8', timeout: 120000 },
  );
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    join(root, 'artifacts/coverage-gate-native.log'),
    result.stdout + result.stderr,
  );
  if (result.status !== 0)
    throw new Error(
      `Native Vitest failed: ${String(result.status)}; see artifacts/coverage-gate-native.log`,
    );
  const current = inspect(root);
  if (JSON.stringify(current.sources) !== before)
    throw new Error('Source changed during instrumentation');
  const old = inspect(baselineRoot, baselineDirectory);
  const changed = changes(root, baseline);
  const report = {
    createdAt: new Date().toISOString(),
    runtime: process.version,
    toolchain: tools,
    baseline: {
      commit: baseline,
      root: baselineRoot,
      snapshot: old,
      coverageSha256: digest(
        readFileSync(
          resolve(baselineRoot, baselineDirectory, 'coverage-final.json'),
          'utf8',
        ),
      ),
    },
    candidate: {
      commit: git(root, 'rev-parse', 'HEAD'),
      root,
      snapshot: current,
      nativeExit: result.status,
      coverageSha256: digest(
        readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
      ),
    },
    changed,
    changedSource: changed.filter(({ path, previous }) =>
      [...current.sources, ...old.sources].some(
        (source) => source.path === path || source.path === previous,
      ),
    ),
    diffSha256: digest(git(root, 'diff', '--binary', baseline, '--', '.')),
    failures: [...current.failures, ...regressions(current, old, changed)],
  };
  writeFileSync(
    join(root, 'artifacts/coverage-gate.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (report.failures.length > 0)
    throw new Error('Coverage gate failed; see artifacts/coverage-gate.json');
  return report;
}

function toolchain(root: string) {
  return {
    lockSha256: digest(readFileSync(join(root, 'package-lock.json'), 'utf8')),
    installed: ['typescript', 'vitest', '@vitest/coverage-v8'].map((name) => ({
      name,
      version: z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            readFileSync(
              join(root, 'node_modules', name, 'package.json'),
              'utf8',
            ),
          ),
        ).version,
    })),
  };
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
}

export function changes(root: string, baseline: string) {
  const prefix = git(root, 'rev-parse', '--show-prefix');
  const tokens = git(
    root,
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    baseline,
    '--',
    '.',
  )
    .split('\0')
    .filter(Boolean);
  const changed: { status: string; path: string; previous?: string }[] = [];
  while (tokens.length > 0) {
    const status = z.string().parse(tokens.shift());
    const first = z.string().parse(tokens.shift()).slice(prefix.length);
    if (status.startsWith('R')) {
      changed.push({
        status,
        previous: first,
        path: z.string().parse(tokens.shift()).slice(prefix.length),
      });
    } else {
      changed.push({ status, path: first });
    }
  }
  for (const path of git(
    root,
    'ls-files',
    '--full-name',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
  )
    .split('\0')
    .filter(Boolean)) {
    changed.push({ status: '?', path: path.slice(prefix.length) });
  }
  return changed;
}

export function regressions(
  current: ReturnType<typeof inspect>,
  baseline: ReturnType<typeof inspect>,
  changed: ReturnType<typeof changes>,
) {
  return current.sources.flatMap((source) => {
    const previous =
      changed.find((entry) => entry.path === source.path)?.previous ??
      source.path;
    const old = baseline.sources.find((entry) => entry.path === previous);
    if (
      !old ||
      source.hash !== old.hash ||
      source.applicability !== 'executable'
    )
      return [];
    const oldUnit = baseline.units[previous];
    const unit = current.units[source.path];
    if (!oldUnit || !unit)
      throw new Error(
        `Missing baseline/candidate instrumentation: ${source.path}`,
      );
    return unit.missing
      .filter((item) => !oldUnit.missing.includes(item))
      .map((item) => `baseline regression: ${source.path}: ${item}`);
  });
}

const ignored = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'artifacts',
]);
const configuration = new Set([
  'vite.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
]);

function directives(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = new Set<number>();
  const messages: string[] = [];
  function visit(node: ts.Node) {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const { pos, end } of ranges) {
      if (
        !found.has(pos) &&
        /\b(?:v8|c8|istanbul)\s+ignore\b|\bnode:coverage\s+(?:ignore|disable)|\bpragma\s*:\s*no\s+(?:cover|branch)/i.test(
          text.slice(pos, end),
        )
      ) {
        found.add(pos);
        messages.push(
          `${path}:${String(source.getLineAndCharacterOfPosition(pos).line + 1)}: forbidden coverage directive`,
        );
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  }
  visit(source);
  return messages;
}

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function inventory(root: string) {
  function walk(directory: string): string[] {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
      (entry) => {
        const path = join(directory, entry.name);
        if (directory === '' && ignored.has(entry.name)) return [];
        if (entry.isSymbolicLink())
          throw new Error(`Source symlink is not supported: ${path}`);
        if (entry.isDirectory()) return walk(path);
        return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) ? [path] : [];
      },
    );
  }
  return walk('')
    .sort()
    .map((path) => {
      const text = readFileSync(join(root, path), 'utf8');
      const emitted = ts
        .transpileModule(text, {
          fileName: path.replace(/\.d\.ts$/, '.ts'),
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            removeComments: true,
            verbatimModuleSyntax: true,
          },
        })
        .outputText.trim();
      return {
        path,
        hash: digest(text),
        directives: directives(path, text),
        applicability:
          path.startsWith('tests/') || path.startsWith('e2e/')
            ? 'test-support'
            : configuration.has(path)
              ? 'configuration'
              : /^(?:\s|;|"use strict";|export\s*\{\s*\}\s*;?)*$/.test(emitted)
                ? 'type-only: no emitted executable units'
                : 'executable',
      };
    });
}
