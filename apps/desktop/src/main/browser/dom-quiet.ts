/** A quiet observer with cooperative completion. Satisfying a postcondition
 * must not terminate page execution or fence the following observation. */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

interface DomQuietHost {
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  quietMs: number;
  timeoutMs: number;
}

export function createBrowserDomQuiet(host: DomQuietHost) {
  return async (guest: WebContents, signal?: AbortSignal, until?: Promise<unknown>): Promise<void> => {
    const key = JSON.stringify(`__mixdogQuiet_${randomUUID()}`);
    signal?.throwIfAborted();
    // Registration returns immediately; cutoff cannot race ahead of it.
    await host.evaluate<void>(guest, `(() => {
      let quietTimer;
      let hardTimer;
      let done = false;
      let resolve;
      const promise = new Promise((finish) => { resolve = finish; });
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(hardTimer);
        clearTimeout(quietTimer);
        delete globalThis[${key}];
        resolve();
      };
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, ${host.quietMs});
      };
      const observer = new MutationObserver(arm);
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      Object.defineProperty(globalThis, ${key}, {
        configurable: true, value: { promise, finish },
      });
      hardTimer = setTimeout(finish, ${host.timeoutMs});
      arm();
    })()`, signal);
    let finished = false;
    void until?.then(async () => {
      if (!finished) {
        // Only real command cancellation reaches CDP. A soft cutoff resolves
        // the observer's own promise, with no Runtime.terminateExecution.
        await host.evaluate<void>(guest, `globalThis[${key}]?.finish()`, signal);
      }
    }, () => undefined).catch(() => {
      // Navigation/cancellation may remove the context. The hard timer still
      // bounds the observer if its document remains alive.
    });
    try {
      await host.evaluate<void>(guest, `globalThis[${key}]?.promise`, signal);
    } finally {
      finished = true;
    }
  };
}
