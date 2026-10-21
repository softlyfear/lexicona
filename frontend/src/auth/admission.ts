export type Principal = 'anonymous' | `user:${string}`;
export type Operation = 'me' | 'csrf' | 'login' | 'logout';
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
