export type Principal = 'anonymous' | `user:${string}`;
export const operations = {
  me: { path: '/api/v1/auth/me', method: 'GET', status: 200 },
  csrf: { path: '/api/v1/auth/csrf', method: 'GET', status: 200 },
  login: { path: '/api/v1/auth/login', method: 'POST', status: 200 },
  logout: { path: '/api/v1/auth/logout', method: 'POST', status: 200 },
  register: { path: '/api/v1/auth/register', method: 'POST', status: 201 },
  inviteList: { path: '/api/v1/admin/invites', method: 'GET', status: 200 },
  inviteCreate: { path: '/api/v1/admin/invites', method: 'POST', status: 201 },
  inviteRevoke: {
    path: '/api/v1/admin/invites/{invite_id}/revoke',
    method: 'POST',
    status: 200,
  },
} as const;
export type Operation = keyof typeof operations;
export class Discarded extends Error {}

/** Captures are immutable. Every awaited transport/body step must re-admit. */
export class Admission {
  revision = 0;
  principal: Principal | 'unknown' = 'unknown';

  constructor(private readonly mismatch: () => void) {}

  replace(principal: Principal | 'unknown') {
    this.revision += 1;
    this.principal = principal;
  }

  capture(operation: Operation) {
    const authRevision = this.revision;
    const capturedPrincipal = this.principal;
    const current = () => {
      if (
        this.revision !== authRevision ||
        this.principal !== capturedPrincipal
      )
        throw new Discarded();
    };
    return Object.freeze({
      authRevision,
      capturedPrincipal,
      operation,
      current,
      check: (stamp: string | null) => {
        current();
        if (
          !/^(?:anonymous|user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
            stamp ?? '',
          ) ||
          (stamp !== capturedPrincipal &&
            !(capturedPrincipal === 'unknown' && operation === 'me'))
        ) {
          this.replace('unknown');
          this.mismatch();
          throw new Discarded();
        }
      },
      consume: <T>(callback: () => T): T => {
        current();
        return callback();
      },
    });
  }
}
