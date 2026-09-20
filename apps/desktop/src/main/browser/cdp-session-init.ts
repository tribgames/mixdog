/**
 * Bringing one CDP session (root document or child frame) up: the safety
 * boundary first (dialog bridge, page guards, Fetch patterns), then the
 * observability domains in the background. Also the Fetch pattern refresh that
 * has to reach every attached session.
 */
import type { WebContents } from 'electron';

import { CDP_REQUEST_TIMEOUT_MS } from './command';
import { DIALOG_BRIDGE_PATTERN, DIALOG_BRIDGE_SCRIPT } from './dialog-bridge';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserFetchPattern } from './intercept';
import type { createBrowserCdpExecution } from './cdp-execution';

export type BrowserCdpSend = ReturnType<typeof createBrowserCdpExecution>['sendCdp'];

export interface BrowserCdpSessionInitHost {
  state: BrowserGuestStateStore;
  interceptFetchPatterns(guest: WebContents): BrowserFetchPattern[];
  pageGuardScripts?(): string[];
}

export function createBrowserCdpSessionInit(host: BrowserCdpSessionInitHost, sendCdp: BrowserCdpSend) {
  const { state, interceptFetchPatterns } = host;

  /** Chromium pauses exactly what these patterns name. The dialog bridge is
   *  always one of them; interception contributes the rest. */
  function fetchPatternsFor(guest: WebContents) {
    return [{ urlPattern: DIALOG_BRIDGE_PATTERN, requestStage: 'Request' as const }, ...interceptFetchPatterns(guest)];
  }

  /** A rule change has to reach every attached session, not just the root one:
   *  an out-of-process frame runs its own Fetch domain and would otherwise keep
   *  answering from the network while the page above it is intercepted. */
  async function applyFetchPatterns(guest: WebContents, cdp: Electron.Debugger, signal?: AbortSignal): Promise<void> {
    const patterns = fetchPatternsFor(guest);
    const sessionIds: Array<string | undefined> = [undefined, ...state.for(guest).cdpSessions.keys()];
    for (const sessionId of sessionIds) {
      await sendCdp(guest, cdp, 'Fetch.enable', { patterns }, CDP_REQUEST_TIMEOUT_MS, signal, sessionId).catch(
        () => undefined
      );
    }
  }

  async function initializeTargetSession(
    guest: WebContents,
    cdp: Electron.Debugger,
    signal: AbortSignal,
    sessionId?: string
  ): Promise<void> {
    const send = (method: string, params: Record<string, unknown> = {}) =>
      sendCdp(guest, cdp, method, params, CDP_REQUEST_TIMEOUT_MS, signal, sessionId);
    const newDocumentScript = (source: string) =>
      send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true });
    // Dialog interception is the startup safety boundary. Do not make first
    // navigation wait for unrelated observability domains or child targets.
    await Promise.all([
      send('Page.enable'),
      send('Runtime.enable'),
      ...(!sessionId ? [send('Emulation.setFocusEmulationEnabled', { enabled: true })] : []),
      newDocumentScript(DIALOG_BRIDGE_SCRIPT),
      // Child frames run their own realm, so a guard installed only on the root
      // leaves an iframe free to do what the policy refuses.
      ...(host.pageGuardScripts?.() || []).map(newDocumentScript),
      send('Fetch.enable', { patterns: fetchPatternsFor(guest) }),
    ]);
    signal.throwIfAborted();
    if (sessionId && !state.for(guest).cdpSessions.has(sessionId)) return;
    void Promise.allSettled([
      send('Network.enable'),
      send('Log.enable'),
      send('Accessibility.enable'),
      // A native file picker would block the window; Chromium reports it as
      // an event instead and `upload` answers it with approved paths.
      send('Page.setInterceptFileChooserDialog', { enabled: true }),
      // Mitigate the observed TargetHandler::AutoAttach native crash by not
      // recursively registering auto-attach on child sessions. Flatten only
      // changes session routing; nested OOPIF coverage is not guaranteed.
      ...(!sessionId
        ? [send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })]
        : []),
    ]);
  }

  return { fetchPatternsFor, applyFetchPatterns, initializeTargetSession };
}
