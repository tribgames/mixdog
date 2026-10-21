/** Attaching Electron's debugger to a guest once per document, routing its
 *  messages, and forgetting every per-guest record when it detaches. */
import type { WebContents } from 'electron';

import { bounded } from './cdp-bounded';
import { OPEN_SURFACE_TIMEOUT_MS } from './command';
import type { BrowserGuestStateStore } from './guest-state';

type CdpParams = Record<string, unknown>;

interface DebuggerAttachmentHost {
  state: BrowserGuestStateStore;
  onCdpEvent(
    guest: WebContents,
    cdp: Electron.Debugger,
    name: string,
    params: CdpParams,
    sessionId: string | undefined
  ): void;
  initializeTargetSession(guest: WebContents, cdp: Electron.Debugger, signal: AbortSignal): Promise<void>;
}

export function createGuestDebuggerAttachment(host: DebuggerAttachmentHost) {
  const { state } = host;
  const debuggerReady = new WeakMap<WebContents, Promise<Electron.Debugger>>();
  const debuggerAttached = new WeakMap<WebContents, Promise<Electron.Debugger>>();
  const debuggerListeners = new WeakMap<WebContents, (...args: unknown[]) => void>();
  const debuggerLifetime = new WeakMap<WebContents, AbortController>();
  /** Pages window.open created: their first navigation is the opener's. */
  const openedPages = new WeakSet<WebContents>();

  async function waitForInitialDocument(guest: WebContents): Promise<void> {
    if (guest.isDestroyed()) throw new Error('browser page is unavailable');
    // Loading about:blank into an opened page would replace the document its
    // opener is navigating it to.
    if (guest.getURL() || openedPages.has(guest)) return;
    // A newly constructed hidden BrowserWindow has no committed document and
    // will not emit dom-ready until its first explicit load.
    try {
      await bounded(guest.loadURL('about:blank'), OPEN_SURFACE_TIMEOUT_MS, 'browser page initialization');
    } catch (error) {
      // An address loaded into the blank page supersedes this load (ERR_ABORTED,
      // -3): the page is already navigating, which is not an initialization failure.
      if (!/\bERR_ABORTED\b|\(-3\)/.test(String((error as Error)?.message))) throw error;
    }
  }

  /** The debugger detached (page gone or Chromium dropped it): forget every
   *  per-guest record, settle the prompts it held, and leave the reason on
   *  the guest as its fault. */
  function onDetached(guest: WebContents, cdp: Electron.Debugger, lifetime: AbortController, reason: string): void {
    if (debuggerLifetime.get(guest) !== lifetime) return;
    debuggerLifetime.delete(guest);
    const listener = debuggerListeners.get(guest);
    if (listener) cdp.removeListener('message', listener);
    debuggerListeners.delete(guest);
    debuggerReady.delete(guest);
    debuggerAttached.delete(guest);
    state.endTargetSession(guest);
    const record = state.for(guest);
    record.performanceTrace?.resolveComplete();
    record.performanceTrace = undefined;
    record.fault = reason;
  }

  /** Attach, wire the message and detach listeners, and bring the root session up. */
  async function attach(
    guest: WebContents,
    lifetime: AbortController,
    onDestroyed: () => void,
    attached: (debugger_: Electron.Debugger) => void
  ): Promise<Electron.Debugger> {
    await waitForInitialDocument(guest);
    lifetime.signal.throwIfAborted();
    const cdp = guest.debugger;
    if (!cdp.isAttached()) cdp.attach('1.3');
    const onMessage = (_event: unknown, method: unknown, rawParams: unknown, rawSessionId?: unknown): void => {
      const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as CdpParams;
      host.onCdpEvent(guest, cdp, String(method || ''), params, String(rawSessionId || '') || undefined);
    };
    debuggerListeners.set(guest, onMessage);
    cdp.on('message', onMessage);
    cdp.once('detach', (_event, reason) => {
      const detachedReason = `CDP detached: ${String(reason || 'unknown reason')}`;
      lifetime.abort(new Error(detachedReason));
      guest.removeListener('destroyed', onDestroyed);
      onDetached(guest, cdp, lifetime, detachedReason);
    });
    // Answering an existing dialog must not wait for the scripts that the
    // dialog itself has suspended. Normal commands still await full setup.
    attached(cdp);
    await host.initializeTargetSession(guest, cdp, lifetime.signal);
    return cdp;
  }

  /** Initialization failed: release the half-attached debugger. */
  function abandonAttachment(
    guest: WebContents,
    lifetime: AbortController,
    ready: Promise<Electron.Debugger>,
    onDestroyed: () => void
  ): void {
    if (debuggerReady.get(guest) === ready) {
      debuggerReady.delete(guest);
      debuggerAttached.delete(guest);
    }
    guest.removeListener('destroyed', onDestroyed);
    if (debuggerLifetime.get(guest) !== lifetime) return;
    lifetime.abort(new Error('CDP initialization failed'));
    if (!guest.isDestroyed() && guest.debugger.isAttached()) {
      try {
        guest.debugger.detach();
      } catch {
        /* already detached */
      }
    }
    if (debuggerLifetime.get(guest) === lifetime) debuggerLifetime.delete(guest);
  }

  /** The attached debugger for a guest, initialised once per document; an
   *  answer to its open dialog waits for the attachment alone (see attach). */
  async function guestDebugger(guest: WebContents, answeringDialog = false): Promise<Electron.Debugger> {
    if (guest.isDestroyed()) throw new Error('browser page is unavailable');
    if (!debuggerReady.has(guest)) startAttachment(guest);
    return answeringDialog ? debuggerAttached.get(guest)! : debuggerReady.get(guest)!;
  }

  /** Attach a page window.open just created, before its first document
   *  commits: that document's scripts must already find the dialog bridge,
   *  or a dialog they open while parsing never reaches the pane. */
  function attachOpenedPage(guest: WebContents): Promise<Electron.Debugger> {
    openedPages.add(guest);
    return guestDebugger(guest);
  }

  function startAttachment(guest: WebContents): void {
    const lifetime = new AbortController();
    debuggerLifetime.set(guest, lifetime);
    const onDestroyed = () => lifetime.abort(new Error('browser page is unavailable'));
    guest.once('destroyed', onDestroyed);
    let resolveAttached!: (debugger_: Electron.Debugger) => void;
    let rejectAttached!: (error: unknown) => void;
    const attached = new Promise<Electron.Debugger>((resolve, reject) => {
      resolveAttached = resolve;
      rejectAttached = reject;
    });
    void attached.catch(() => undefined);
    const ready = attach(guest, lifetime, onDestroyed, resolveAttached);
    debuggerReady.set(guest, ready);
    debuggerAttached.set(guest, attached);
    ready.catch((error) => {
      rejectAttached(error);
      abandonAttachment(guest, lifetime, ready, onDestroyed);
    });
  }

  /** Drop the debugger for a guest whose bridge is going away. */
  async function detach(guest: WebContents): Promise<void> {
    debuggerLifetime.get(guest)?.abort(new Error('CDP detaching'));
    debuggerReady.delete(guest);
    debuggerAttached.delete(guest);
    if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
    try {
      guest.debugger.detach();
    } catch {
      /* already detached */
    }
  }

  return {
    guestDebugger,
    attachOpenedPage,
    detach,
    waitForInitialDocument,
    /** The debugger lifetime of a guest, or undefined once it is gone. */
    lifetimeSignal: (guest: WebContents): AbortSignal | undefined => debuggerLifetime.get(guest)?.signal,
  };
}
