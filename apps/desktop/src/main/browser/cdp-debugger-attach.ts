/** Attaching Electron's debugger to a guest once per document, routing its
 *  messages, and forgetting every per-guest record when it detaches. */
import type { WebContents } from 'electron';

import { bounded } from './cdp-bounded';
import { CDP_REQUEST_TIMEOUT_MS, OPEN_SURFACE_TIMEOUT_MS } from './command';
import type { BrowserGuestStateStore } from './guest-state';

type CdpParams = Record<string, unknown>;

export interface DebuggerAttachmentHost {
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
  const debuggerListeners = new WeakMap<WebContents, (...args: unknown[]) => void>();
  const debuggerLifetime = new WeakMap<WebContents, AbortController>();
  const detaching = new WeakSet<WebContents>();

  async function waitForInitialDocument(guest: WebContents): Promise<void> {
    if (guest.isDestroyed()) throw new Error('browser page is unavailable');
    if (guest.getURL()) return;
    // A newly constructed hidden BrowserWindow has no committed document and
    // will not emit dom-ready until its first explicit load.
    await bounded(guest.loadURL('about:blank'), OPEN_SURFACE_TIMEOUT_MS, 'browser page initialization');
  }

  /** The debugger detached (page gone or Chromium dropped it): forget every
   *  per-guest record and leave the reason on the guest as its fault. */
  function onDetached(guest: WebContents, cdp: Electron.Debugger, lifetime: AbortController, reason: string): void {
    if (debuggerLifetime.get(guest) !== lifetime) return;
    debuggerLifetime.delete(guest);
    const listener = debuggerListeners.get(guest);
    if (listener) cdp.removeListener('message', listener);
    debuggerListeners.delete(guest);
    debuggerReady.delete(guest);
    const record = state.for(guest);
    record.cdpSessions.clear();
    record.performanceTrace?.resolveComplete();
    record.performanceTrace = undefined;
    record.fault = reason;
  }

  /** Attach, wire the message and detach listeners, and bring the root session up. */
  async function attach(
    guest: WebContents,
    lifetime: AbortController,
    onDestroyed: () => void
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
    if (debuggerReady.get(guest) === ready) debuggerReady.delete(guest);
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

  /** The attached debugger for a guest, initialised once per document. */
  async function guestDebugger(guest: WebContents): Promise<Electron.Debugger> {
    if (guest.isDestroyed() || detaching.has(guest)) throw new Error('browser page is unavailable');
    const existing = debuggerReady.get(guest);
    if (existing) return existing;
    const lifetime = new AbortController();
    debuggerLifetime.set(guest, lifetime);
    const onDestroyed = () => lifetime.abort(new Error('browser page is unavailable'));
    guest.once('destroyed', onDestroyed);
    const ready = attach(guest, lifetime, onDestroyed);
    debuggerReady.set(guest, ready);
    ready.catch(() => abandonAttachment(guest, lifetime, ready, onDestroyed));
    return ready;
  }

  /** Drop the debugger for a guest whose bridge is going away. */
  async function detach(guest: WebContents, options: { uninstallScript?: string } = {}): Promise<void> {
    if (detaching.has(guest)) return;
    detaching.add(guest);
    debuggerLifetime.get(guest)?.abort(new Error('CDP detaching'));
    debuggerReady.delete(guest);
    try {
      if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
      if (options.uninstallScript) {
        try {
          await bounded(
            guest.debugger.sendCommand('Runtime.evaluate', {
              expression: options.uninstallScript,
              awaitPromise: true,
            }),
            CDP_REQUEST_TIMEOUT_MS,
            'browser bridge uninstall'
          );
        } catch {
          /* page may be gone or blocked by a native dialog */
        }
      }
      try {
        guest.debugger.detach();
      } catch {
        /* already detached */
      }
    } finally {
      detaching.delete(guest);
    }
  }

  return {
    guestDebugger,
    detach,
    waitForInitialDocument,
    /** The debugger lifetime of a guest, or undefined once it is gone. */
    lifetimeSignal: (guest: WebContents): AbortSignal | undefined => debuggerLifetime.get(guest)?.signal,
  };
}
