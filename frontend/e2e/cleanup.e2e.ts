import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { E2EServer, listeners } from './server';

const exec = promisify(execFile);

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    )) {
      throw error;
    }
  }
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// Observer only: discover descendants BEFORE fault injection. The harness must
// not need this ancestry to recover after its original launcher/leader dies.
async function snapshot(server: E2EServer) {
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,pgid=']);
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid = 0, parent = 0, group = 0] = line
        .trim()
        .split(/\s+/)
        .map(Number);
      return { pid, parent, group };
    });
  const pids = new Set(
    server.services.map((child) => {
      if (!child.pid) throw new Error('Missing own child PID');
      return child.pid;
    }),
  );
  let count: number;
  do {
    count = pids.size;
    for (const row of rows) if (pids.has(row.parent)) pids.add(row.pid);
  } while (pids.size !== count);
  const groups = [
    ...new Set(
      rows
        .filter((row) => pids.has(row.pid) && pids.has(row.group))
        .map((row) => row.group),
    ),
  ];
  const directories = new Set<string>();
  if (server.directory) directories.add(server.directory);
  for (const pid of pids) {
    const env = await readFile(`/proc/${String(pid)}/environ`, 'utf8');
    const temp = env
      .split('\0')
      .find((entry) => entry.startsWith('TMPDIR='))
      ?.slice(7);
    if (temp && basename(temp).startsWith('lexicona-')) directories.add(temp);
  }
  return { pids: [...pids], groups, directories: [...directories] };
}

const scenarios = [
  'suspended owners',
  'suspended groups',
  'early-dead API leader',
  'early-dead Vite leader',
  'normal shutdown',
] as const;

for (const scenario of scenarios) {
  test(`${scenario}: bounded cleanup of own services and temp, unrelated sentinel survives`, async () => {
    const server = new E2EServer();
    const sentinel = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (!sentinel.pid) throw new Error('Missing sentinel PID');
    const sentinelPid = sentinel.pid;
    let owned: Awaited<ReturnType<typeof snapshot>> | undefined;
    let teardownCalled = false;
    try {
      await once(sentinel.stdout, 'data', {
        signal: AbortSignal.timeout(3000),
      });
      await server.start();
      owned = await snapshot(server);
      expect(
        owned.groups,
        'Two directly owned detached service groups',
      ).toHaveLength(2);
      expect(owned.groups).toEqual(server.services.map((child) => child.pid));
      if (scenario === 'suspended owners') {
        for (const child of server.services) {
          if (!child.pid) throw new Error('Missing own child PID');
          signal(child.pid, 'SIGSTOP');
        }
      } else if (scenario === 'suspended groups') {
        for (const group of owned.groups) signal(-group, 'SIGSTOP');
      } else if (scenario.startsWith('early-dead')) {
        const child =
          server.services[scenario === 'early-dead API leader' ? 0 : 1];
        if (!child?.pid) throw new Error('Missing own child PID');
        const exited = once(child, 'exit', {
          signal: AbortSignal.timeout(3000),
        });
        signal(child.pid, 'SIGKILL');
        await exited;
      }
      const started = performance.now();
      teardownCalled = true;
      const stopped = server.stop();
      expect(
        server.stop(),
        'Idempotent cleanup does not resignal retired groups',
      ).toBe(stopped);
      if (scenario === 'normal shutdown') {
        await expect(stopped).resolves.toBeUndefined();
      } else {
        await expect(stopped).rejects.toThrow(
          /exited early|did not stop|SIGKILL/,
        );
      }
      expect(performance.now() - started).toBeLessThan(6000);
      expect
        .soft(await listeners(), 'Cleanup must release both ports')
        .toBe('');
      for (const directory of owned.directories) {
        expect
          .soft(await pathExists(directory), `Removed ${directory}`)
          .toBe(false);
      }
      for (const pid of [
        ...owned.pids,
        ...owned.groups.map((group) => -group),
      ]) {
        expect
          .soft(exists(pid), `No own process/group ${String(pid)}`)
          .toBe(false);
      }
      expect(exists(sentinelPid), 'Unrelated sentinel survives').toBe(true);
    } finally {
      // Emergency cleanup is AFTER assertions: it cannot make a broken harness
      // pass, but a RED run still must not leak its recorded processes/temp.
      try {
        try {
          if (!teardownCalled) await server.stop();
        } finally {
          if (owned) {
            for (const group of owned.groups) signal(-group, 'SIGKILL');
            for (const pid of owned.pids) signal(pid, 'SIGKILL');
            await expect.poll(listeners, { timeout: 3000 }).toBe('');
            for (const directory of owned.directories)
              await rm(directory, { recursive: true, force: true });
          }
        }
      } finally {
        const exited = once(sentinel, 'exit', {
          signal: AbortSignal.timeout(3000),
        });
        signal(sentinelPid, 'SIGTERM');
        await exited;
      }
    }
  });
}
