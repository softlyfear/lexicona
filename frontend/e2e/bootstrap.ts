import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { python, root } from './server';

const proofSchema = z.strictObject({
  success: z.boolean(),
  fault_cleaned: z.boolean(),
  noecho_checks: z.number().int(),
  output_redacted: z.literal(true),
  wal: z.literal(true),
  users: z.number().int(),
  settings: z.number().int(),
});
export async function protectedAdmin(database: string, fault = false) {
  const account = {
    login: 'cli_admin',
    password: randomBytes(32).toString('base64url'),
  };
  const proof = await new Promise<z.infer<typeof proofSchema>>(
    (resolve, reject) => {
      const child = spawn(
        python,
        [join(root, 'frontend/e2e/protected_admin.py')],
        {
          cwd: join(root, 'backend'),
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      const timer = setTimeout(() => {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      }, 20_000);
      const hard = setTimeout(() => {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      }, 23_000);
      child.stdout.on('data', (data: Buffer) => {
        output = (output + data.toString()).slice(-2048);
      });
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        clearTimeout(hard);
        reject(new Error('Protected CLI fixture failed'));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        clearTimeout(hard);
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (!(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )) {
              reject(new Error('Protected CLI group cleanup failed'));
              return;
            }
          }
        }
        try {
          if (code !== 0) throw new Error();
          resolve(proofSchema.parse(JSON.parse(output)));
        } catch {
          reject(new Error('Protected CLI fixture failed (redacted)'));
        }
      });
      child.stdin.on('error', () => {
        reject(new Error('Protected CLI input failed'));
      });
      child.stdin.end(JSON.stringify({ ...account, database, fault }));
    },
  );
  return { account, proof };
}
