import { expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const root = resolve(import.meta.dirname, '../..');
export const python = join(root, 'backend/.venv/bin/python');
const graceMs = 1500;

export async function listeners(): Promise<string> {
  const { stdout } = await exec(
    'ss',
    ['-H', '-ltn', '( sport = :8000 or sport = :5173 )'],
    { timeout: 3000 },
  );
  return stdout.trim();
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function untilStopped(services: ChildProcess[]): Promise<boolean> {
  const deadline = performance.now() + graceMs;
  do {
    const active = services.some(
      (child) =>
        (child.pid !== undefined && signalGroup(child.pid, 0)) ||
        (child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null),
    );
    if (!active) return true;
    // Condition-based, bounded wait for group disappearance AND child reaping,
    // not a fixed sleep that assumes shutdown has completed.
    await delay(25);
  } while (performance.now() < deadline);
  return false;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class E2EServer {
  directory: string | undefined;
  databasePath = '';
  readonly services: ChildProcess[] = [];
  private readonly failures: Error[] = [];
  private stopping = false;
  private cleanup: Promise<void> | undefined;
  private serverLog = '';
  private databaseRepair:
    { link: string; target: string; temporary: string } | undefined;

  private launch(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): void {
    // Each immediate child is its own session/process-group leader. Its group
    // remains ours even if that leader exits before teardown (e.g. Vite/esbuild).
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.services.push(child);
    const log = (data: Buffer) => {
      this.serverLog = (this.serverLog + data.toString()).slice(-65_536);
    };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.on('error', (error: Error) => this.failures.push(error));
    child.on('exit', (code, signal) => {
      // Vite may translate our SIGTERM to exit code 128 + 15 (143).
      // Only accept it after teardown started; any earlier exit is a failure.
      if (
        !this.stopping ||
        (code !== null && code !== 0 && code !== 143) ||
        (signal !== null && signal !== 'SIGTERM')
      ) {
        this.failures.push(
          new Error(
            `Own E2E service exited early (${String(code ?? signal)}): ${this.serverLog}`,
          ),
        );
      }
    });
  }

  async start(options: { databaseUnavailable?: boolean } = {}): Promise<void> {
    // Never attach to, migrate, or stop an existing development server/database.
    expect(
      await listeners(),
      'E2E needs free localhost ports 8000 and 5173',
    ).toBe('');
    try {
      this.directory = await mkdtemp(join(resolve(tmpdir()), 'lexicona-e2e-'));
      const databaseDirectory = options.databaseUnavailable
        ? join(this.directory, 'database')
        : this.directory;
      this.databasePath = join(databaseDirectory, 'test.sqlite3');
      const env = {
        ...process.env,
        TMPDIR: this.directory,
        LEXICONA_DATABASE_URL: `sqlite+aiosqlite:///${this.databasePath}`,
      };
      await exec('bash', ['scripts/migrate.sh'], {
        cwd: root,
        env,
        timeout: 30_000,
      });
      if (options.databaseUnavailable) {
        const target = join(this.directory, 'available-database');
        const blocker = join(this.directory, 'database-blocker');
        await rename(databaseDirectory, target);
        await writeFile(blocker, 'Owned E2E database blocker\n', {
          flag: 'wx',
        });
        await symlink(blocker, databaseDirectory);
        this.databaseRepair = {
          link: databaseDirectory,
          target,
          temporary: join(this.directory, 'database-repair'),
        };
      }
      this.launch(
        join(root, 'backend/.venv/bin/uvicorn'),
        [
          'lexicona.app:create_app',
          '--factory',
          '--host',
          '127.0.0.1',
          '--port',
          '8000',
          '--workers',
          '1',
          '--no-proxy-headers',
          '--no-access-log',
        ],
        join(root, 'backend'),
        env,
      );
      // Direct Vite avoids an unnecessary npm/shell launcher between us and the
      // service. Vite's subprocesses (esbuild) inherit this owned group.
      this.launch(
        process.execPath,
        [
          join(root, 'frontend/node_modules/vite/bin/vite.js'),
          '--host',
          '127.0.0.1',
          '--port',
          '5173',
          '--strictPort',
        ],
        join(root, 'frontend'),
        env,
      );
      await expect
        .poll(
          async () => {
            if (this.failures.length)
              throw new AggregateError(
                this.failures,
                this.failures.map(message).join('\n'),
              );
            try {
              const response = await fetch(
                'http://127.0.0.1:5173/api/v1/health/ready',
                {
                  signal: AbortSignal.timeout(1000),
                },
              );
              return response.status;
            } catch {
              return 0;
            }
          },
          {
            timeout: 25_000,
            message: 'Real frontend proxy → API → SQLite readiness',
          },
        )
        .toBe(options.databaseUnavailable ? 503 : 200);
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${message(error)}; ${message(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  async repairDatabase(): Promise<void> {
    const repair = this.databaseRepair;
    if (!repair)
      throw new Error('No own unavailable database fixture to repair');
    // Atomically swap only our symlink: a concurrent probe cannot create an
    // empty database in a gap between removing the blocker and restoring data.
    await symlink(repair.target, repair.temporary);
    await rename(repair.temporary, repair.link);
    this.databaseRepair = undefined;
  }

  stop(): Promise<void> {
    // afterAll can call again after failed setup; never signal recycled IDs.
    this.cleanup ??= this.stopOwned();
    return this.cleanup;
  }

  private async stopOwned(): Promise<void> {
    this.stopping = true;
    const cleanupFailures: unknown[] = [];
    const signalAll = (signal: NodeJS.Signals) => {
      for (const child of this.services) {
        if (child.pid === undefined) continue; // spawn failed: error is retained.
        try {
          signalGroup(child.pid, signal);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    };
    try {
      signalAll('SIGTERM');
      if (!(await untilStopped(this.services))) {
        cleanupFailures.push(
          new Error(
            'Own E2E service groups did not stop after SIGTERM; SIGKILL required',
          ),
        );
        signalAll('SIGKILL');
        if (!(await untilStopped(this.services))) {
          cleanupFailures.push(
            new Error(
              'Own E2E service groups remain after bounded SIGKILL fallback',
            ),
          );
        }
      }
    } catch (error) {
      cleanupFailures.push(error);
      // Inspection failure cannot skip the hard fallback for our recorded groups.
      signalAll('SIGKILL');
    } finally {
      try {
        if (this.directory)
          await rm(this.directory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      } finally {
        try {
          if (this.services.length) {
            expect(
              await listeners(),
              'Own E2E services must release both ports',
            ).toBe('');
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    const failures = [...this.failures, ...cleanupFailures];
    if (failures.length) {
      throw new AggregateError(
        failures,
        `E2E cleanup failed: ${failures.map(message).join('\n')}`,
      );
    }
  }
}
