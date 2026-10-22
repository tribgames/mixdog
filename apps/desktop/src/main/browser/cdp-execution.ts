/** A cancelled reply is not proof that Chromium stopped. Fence subsequent
 * commands until the original dispatch and any termination request settle. */
import type { Debugger, WebContents } from 'electron';
import { CDP_REQUEST_TIMEOUT_MS } from './command';

interface BrowserCdpExecutionHost {
  bounded<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void
  ): Promise<T>;
  diagnostic(guest: WebContents, message: string): void;
  /** The page is parked on a dialog the host has yet to answer. */
  awaitingDialog?(guest: WebContents): boolean;
}

const EXECUTION_METHODS = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn']);
// These release an already-blocked operation rather than start another input.
const CLEANUP_METHODS = new Set([
  'Runtime.terminateExecution',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Page.handleJavaScriptDialog',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueRequest',
  'Fetch.continueResponse',
]);
const CLEANUP_TIMEOUT_MS = 2_000;

export function createBrowserCdpExecution(host: BrowserCdpExecutionHost) {
  const settling = new WeakMap<WebContents, Promise<void>>();
  /** Commands in flight per child session, settled when that session ends. */
  const inFlight = new WeakMap<WebContents, Map<string, Set<(error: Error) => void>>>();

  /** A child target detached: its frame was removed or replaced, so nothing
   *  of its document can still run. Chromium never answers a command that was
   *  in flight on it (the reply only comes once the whole page is destroyed),
   *  which would hold the fence on this page forever; settle those here. */
  function endSession(guest: WebContents, sessionId: string): void {
    const sessions = inFlight.get(guest);
    const pending = sessions?.get(sessionId);
    if (!sessions || !pending) return;
    sessions.delete(sessionId);
    for (const end of pending) end(new Error('Inspected target navigated or closed (frame target detached)'));
  }

  function send<T>(
    guest: WebContents,
    cdp: Debugger,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    const sent = cdp.sendCommand(method, params, sessionId) as Promise<T>;
    if (!sessionId) return sent;
    let sessions = inFlight.get(guest);
    if (!sessions) {
      sessions = new Map();
      inFlight.set(guest, sessions);
    }
    let pending = sessions.get(sessionId);
    if (!pending) {
      pending = new Set();
      sessions.set(sessionId, pending);
    }
    const owners = sessions;
    const group = pending;
    let end!: (error: Error) => void;
    const ended = new Promise<never>((_resolve, reject) => {
      end = reject;
    });
    group.add(end);
    return Promise.race([sent, ended]).finally(() => {
      group.delete(end);
      if (!group.size && owners.get(sessionId) === group) owners.delete(sessionId);
    });
  }

  async function waitForIdle(guest: WebContents, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (;;) {
      const barrier = settling.get(guest);
      if (!barrier) return;
      await host.bounded(
        barrier,
        CLEANUP_TIMEOUT_MS,
        'browser execution cleanup is pending; wait or reload the page before retrying',
        signal
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
    beforeDispatch?: () => void
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!CLEANUP_METHODS.has(method)) {
      // Recheck after each wait: another concurrent observation may have been
      // interrupted while this one was waiting for the previous generation.
      while (settling.has(guest)) await waitForIdle(guest, signal);
    }
    signal?.throwIfAborted();
    beforeDispatch?.();
    const dispatch = send<T>(guest, cdp, method, params, sessionId);
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      const previous = settling.get(guest);
      // A script stuck behind an open dialog is waiting for handle_dialog, not
      // running away. Termination cannot land while the dialog holds it, so V8
      // keeps the request and kills the script the moment the answer arrives —
      // the page never sees the value handle_dialog reported as delivered.
      const terminate =
        EXECUTION_METHODS.has(method) && !host.awaitingDialog?.(guest)
          ? Promise.resolve()
              .then(() =>
                host.bounded(
                  send(guest, cdp, 'Runtime.terminateExecution', {}, sessionId),
                  CLEANUP_TIMEOUT_MS,
                  'browser execution termination'
                )
              )
              .catch((error) => {
                host.diagnostic(guest, `CDP execution cleanup: ${String(error)}`);
              })
          : Promise.resolve();
      const barrier = Promise.allSettled([previous, dispatch, terminate]).then(() => undefined);
      settling.set(guest, barrier);
      // A cleanup timeout does not remove the fence. The actual old dispatch
      // must finish, be rejected by navigation/destruction, or lose its child
      // target (endSession) before reuse.
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

  return { sendCdp, waitForIdle, endSession };
}
