import { flushSync } from 'react-dom';
import { AuthClient } from './client';

/** Best effort same-origin coordination, never an HTTP-cookie CAS guarantee. */
export function browserAuth(fetcher: typeof fetch = fetch) {
  let channel: BroadcastChannel | undefined;
  const client = new AuthClient(
    fetcher,
    async (work) => {
      if (
        'locks' in navigator &&
        typeof navigator.locks.request === 'function'
      ) {
        await navigator.locks.request(
          'lexicona-auth-cookie',
          { mode: 'exclusive' },
          work,
        );
      } else await work();
    },
    () => {
      channel?.postMessage('auth-changed');
    },
  );
  return {
    client,
    start: () => {
      // A memory update alone may leave A's React DOM in a frozen page snapshot.
      // Browser boundary events must remove it before the handler returns.
      const suspend = () => {
        flushSync(client.suspend);
      };
      const recheck = () => {
        flushSync(() => {
          void client.recheck();
        });
      };
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel('lexicona-auth');
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === 'auth-changed') recheck();
        };
      }
      const visibility = () => {
        if (document.visibilityState === 'hidden') suspend();
        else recheck();
      };
      window.addEventListener('focus', recheck);
      window.addEventListener('pageshow', recheck);
      window.addEventListener('pagehide', suspend);
      document.addEventListener('visibilitychange', visibility);
      // Initial mounting happens inside React's effect: never flushSync here.
      void client.recheck();
      return () => {
        window.removeEventListener('focus', recheck);
        window.removeEventListener('pageshow', recheck);
        window.removeEventListener('pagehide', suspend);
        document.removeEventListener('visibilitychange', visibility);
        channel?.close();
        channel = undefined;
        client.suspend();
      };
    },
  };
}
