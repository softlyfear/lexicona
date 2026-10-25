import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { python, root } from './server';

/** Test-only direct DB fixture. Secrets cross stdin, never argv/env/output. */
export async function seedAccounts(database: string) {
  const accounts = {
    admin: {
      login: 'fixture_admin',
      password: randomBytes(32).toString('base64url'),
    },
    member: {
      login: 'fixture_member',
      password: randomBytes(32).toString('base64url'),
    },
  };
  const script = `
import json, sqlite3, sys, time, uuid
from lexicona.auth.passwords import ArgonHasher
try:
    accounts = json.load(sys.stdin)
    hasher = ArgonHasher()
    prepared = [(str(uuid.uuid4()), value['login'], hasher.hash(value['password']), role) for role, value in accounts.items()]
    with sqlite3.connect(sys.argv[1]) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        for user_id, login, encoded, role in prepared:
            now = time.time_ns() // 1000
            db.execute('INSERT INTO users (id,login,display_name,password_hash,role,is_active,version,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)', (user_id, login, 'Fixture administrator' if role == 'admin' else 'Fixture member', encoded, 'admin' if role == 'admin' else 'user', now, now))
            db.execute("INSERT INTO user_settings (user_id,timezone,theme,daily_goal,speech_rate,english_locale,version,created_at,updated_at) VALUES (?,'UTC','dark',10,1.0,'en-US',1,?,?)", (user_id, now, now))
    print('seeded')
except Exception:
    print('Fixture setup failed', file=sys.stderr)
    sys.exit(1)
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ['-c', script, database], {
      cwd: root,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.resume();
    child.on('error', () => {
      reject(new Error('Fixture process failed'));
    });
    child.on('exit', (code) => {
      if (code === 0 && output.trim() === 'seeded') resolve();
      else reject(new Error('Fixture setup failed'));
    });
    child.stdin.on('error', () => {
      reject(new Error('Fixture input failed'));
    });
    child.stdin.end(JSON.stringify(accounts));
  });
  return accounts;
}

/** Test-only clock-boundary setup on one known real API-issued invitation. */
export async function expireInvite(database: string, id: string) {
  const script = `
import sqlite3, sys, time, uuid
try:
    target = sys.argv[2]
    if str(uuid.UUID(target)) != target: raise ValueError()
    now = time.time_ns() // 1000
    with sqlite3.connect(sys.argv[1]) as db:
        changed = db.execute('UPDATE invites SET created_at=?,expires_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL', (now-259200000001,now-1,target)).rowcount
        if changed != 1: raise ValueError()
    print('expired')
except Exception:
    print('Expiry fixture failed', file=sys.stderr)
    sys.exit(1)
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ['-c', script, database, id], {
      cwd: root,
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.on('error', () => {
      reject(new Error('Expiry fixture failed'));
    });
    child.on('exit', (code) => {
      if (code === 0 && output.trim() === 'expired') resolve();
      else reject(new Error('Expiry fixture failed'));
    });
  });
}
