import type { WebContents } from 'electron';
import type { BrowserFrameHost } from './document-frames';
import { createBrowserReadPool, settleBrowserReads } from './parallel-read';

const binding = '__mixdogWaitChanged';
let nextId = 0;

/** A latched wakeup prevents a change between reading and waiting being lost. */
export function createBrowserChangeLatch() {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    get version() { return version; },
    notify() { version++; for (const listener of [...listeners]) listener(); },
    wait(since: number, ms: number, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (version !== since) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(finish);
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) reject(signal.reason);
          else resolve();
        };
        const abort = () => finish();
        const timer = setTimeout(finish, ms);
        listeners.add(finish);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || version !== since) finish();
      });
    },
  };
}

export async function observeBrowserDocumentChanges(
  host: BrowserFrameHost,
  collect: <T>(guest: WebContents, expression: string, signal?: AbortSignal) => Promise<T[]>,
  roots: string,
  guest: WebContents,
  signal?: AbortSignal,
) {
  const id = String(++nextId);
  const latch = createBrowserChangeLatch();
  const port = await host.cdp.guestDebugger(guest);
  const message = (_event: unknown, method: string, params: { name?: string; payload?: string }) => {
    if ((method === 'Runtime.bindingCalled' && params.name === binding && params.payload === id)
      || method === 'Page.frameNavigated' || method === 'Page.frameAttached'
      || method === 'Page.frameDetached' || method === 'Page.navigatedWithinDocument') latch.notify();
  };
  port.on('message', message);
  const close = async () => {
    port.removeListener('message', message);
    // A document that disappeared cannot be cleaned; the lease also bounds
    // observers in a detached or otherwise inaccessible execution context.
    await collect(guest, `(() => {
      const state = globalThis.__mixdogWaitObserver;
      if (state?.id === ${JSON.stringify(id)}) state.close();
      return true;
    })()`, AbortSignal.timeout(500)).catch(() => undefined);
  };
  try {
    const targets = [undefined, ...[...host.sessions(guest)]
      .filter(([, target]) => target.type === 'iframe').map(([sessionId]) => sessionId)];
    if (targets.length > 32) throw new Error('too many frame targets for a complete observation');
    const read = createBrowserReadPool();
    await settleBrowserReads(targets.map(async (sessionId) => {
      await host.sessions(guest).get(sessionId || '')?.ready;
      await read(() => host.cdp.call(guest, 'Runtime.addBinding', {
        name: binding, executionContextName: 'mixdog-observation',
      }, signal, { sessionId }));
    }));
    await collect(guest, `(() => {
      globalThis.__mixdogWaitObserver?.close();
      const notify = () => globalThis[${JSON.stringify(binding)}](${JSON.stringify(id)});
      const observer = new MutationObserver(notify);
      const state = {id: ${JSON.stringify(id)}, close() {
        observer.disconnect();
        clearTimeout(timer);
        document.removeEventListener('input', notify, true);
        document.removeEventListener('change', notify, true);
        if (globalThis.__mixdogWaitObserver === state) delete globalThis.__mixdogWaitObserver;
      }};
      const timer = setTimeout(() => state.close(), 35000);
      globalThis.__mixdogWaitObserver = state;
      for (const root of (${roots})()) {
        observer.observe(root, {subtree: true, childList: true, attributes: true, characterData: true});
      }
      document.addEventListener('input', notify, true);
      document.addEventListener('change', notify, true);
      return true;
    })()`, signal);
  } catch (error) {
    await close();
    if (signal?.aborted) throw signal.reason || error;
    // Observation failures must never prove absence. The caller still reads
    // every frame and uses a bounded fallback for unobservable changes.
  }
  return { latch, close };
}
