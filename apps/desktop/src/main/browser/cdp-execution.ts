/** A cancelled reply is not proof that Chromium stopped. Fence subsequent
 * commands until the original dispatch and any termination request settle. */
import type { Debugger, WebContents } from 'electron';
import { CDP_REQUEST_TIMEOUT_MS } from './command';

interface BrowserCdpExecutionHost {
  bounded<T>(
    promise: Promise<T>, timeoutMs: number, label: string,
    signal?: AbortSignal, onTimeout?: () => void,
  ): Promise<T>;
  diagnostic(guest: WebContents, message: string): void;
}

const EXECUTION_METHODS = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn']);
// These release an already-blocked operation rather than start another input.
const CLEANUP_METHODS = new Set([
  'Runtime.terminateExecution', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Page.handleJavaScriptDialog', 'Fetch.fulfillRequest', 'Fetch.failRequest',
  'Fetch.continueRequest', 'Fetch.continueResponse',
]);
const CLEANUP_TIMEOUT_MS = 2_000;

export function createBrowserCdpExecution(host: BrowserCdpExecutionHost) {
  const settling = new WeakMap<WebContents, Promise<void>>();

  async function waitForIdle(guest: WebContents, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (;;) {
      const barrier = settling.get(guest);
      if (!barrier) return;
      await host.bounded(
        barrier, CLEANUP_TIMEOUT_MS,
        'browser execution cleanup is pending; wait or reload the page before retrying',
        signal,
      );
      signal?.throwIfAborted();
    }
  }

  async function sendCdp<T>(
    guest: WebContents,
    cdp: Debugger,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
    sessionId?: string,
    beforeDispatch?: () => void,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!CLEANUP_METHODS.has(method)) {
      // Recheck after each wait: another concurrent observation may have been
      // interrupted while this one was waiting for the previous generation.
      while (settling.has(guest)) await waitForIdle(guest, signal);
    }
    signal?.throwIfAborted();
    beforeDispatch?.();
    const dispatch = cdp.sendCommand(method, params, sessionId) as Promise<T>;
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      const previous = settling.get(guest);
      const terminate = EXECUTION_METHODS.has(method)
        ? Promise.resolve().then(() => host.bounded(
          cdp.sendCommand('Runtime.terminateExecution', {}, sessionId),
          CLEANUP_TIMEOUT_MS, 'browser execution termination',
        )).catch((error) => {
          host.diagnostic(guest, `CDP execution cleanup: ${String(error)}`);
        })
        : Promise.resolve();
      const barrier = Promise.allSettled([previous, dispatch, terminate]).then(() => undefined);
      settling.set(guest, barrier);
      // A cleanup timeout does not remove the fence. The actual old dispatch
      // must finish (or be rejected by navigation/destruction) before reuse.
      void barrier.then(() => {
        if (settling.get(guest) === barrier) settling.delete(guest);
      });
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    // A synchronous bridge implementation can cancel during sendCommand.
    if (signal?.aborted) interrupt();
    try {
      return await host.bounded(dispatch, timeoutMs, `CDP ${method}`, signal, () => {
        interrupt();
        host.diagnostic(guest, `CDP ${method} timed out`);
      });
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  }

  return { sendCdp, waitForIdle };
}
