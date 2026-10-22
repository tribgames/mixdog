/**
 * Bringing one CDP session (root document or child frame) up: the safety
 * boundary first (dialog bridge, page guards, Fetch patterns) and the page's
 * browser identity, then the quiet domains in the background. Also the Fetch
 * pattern refresh that has to reach every attached session.
 *
 * A page someone is only browsing sees no more of the debugger than Chrome
 * shows: no script context, console or accessibility observation. Those come
 * up while an agent command drives the page and go down again once it has
 * been left alone for a while (see `drive`).
 */
import type { WebContents } from 'electron';

import {
  browserIdentityNeedsEngineFacts,
  browserUserAgentOverride,
  ENGINE_FACTS_EXPRESSION,
  rememberEngineFacts,
} from './browser-identity';
import { CHROME_LIKENESS_SCRIPT, PERMISSION_STATE_PATTERN } from './chrome-likeness';
import { CDP_REQUEST_TIMEOUT_MS } from './command';
import { DIALOG_BRIDGE_PATTERN, DIALOG_BRIDGE_SCRIPT } from './dialog-bridge';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserFetchPattern } from './intercept';
import type { createBrowserCdpExecution } from './cdp-execution';

export type BrowserCdpSend = ReturnType<typeof createBrowserCdpExecution>['sendCdp'];

/** How long a page keeps its driving domains after the last agent command,
 *  so a task's next step does not pay to bring them back up. */
export const BROWSER_DRIVE_LINGER_MS = 60_000;

interface BrowserCdpSessionInitHost {
  state: BrowserGuestStateStore;
  interceptFetchPatterns(guest: WebContents): BrowserFetchPattern[];
  pageGuardScripts?(): string[];
  /** The attached debugger of a guest, once it is up; driving waits on it. */
  guestDebugger?(guest: WebContents): Promise<Electron.Debugger>;
  lingerMs?: number;
}

type Command = [method: string, params?: Record<string, unknown>];

/** What an agent's work needs and a person browsing does not: script
 *  contexts and console output, the browser log, and the accessibility tree. */
const driveCommands = (on: boolean): Command[] => [
  [on ? 'Runtime.enable' : 'Runtime.disable'],
  [on ? 'Log.enable' : 'Log.disable'],
  [on ? 'Accessibility.enable' : 'Accessibility.disable'],
];

export function createBrowserCdpSessionInit(host: BrowserCdpSessionInitHost, sendCdp: BrowserCdpSend) {
  const { state, interceptFetchPatterns } = host;
  const lingerMs = host.lingerMs ?? BROWSER_DRIVE_LINGER_MS;
  const driving = new WeakMap<WebContents, { holds: number; on: boolean; timer?: NodeJS.Timeout }>();

  /** Switch the driving domains of one session. Turning them on replays what
   *  the page logged meanwhile; entries this host already recorded are
   *  skipped by the event router through the session's replay floor. */
  async function switchDriving(
    guest: WebContents,
    cdp: Electron.Debugger,
    on: boolean,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const replay = state.for(guest).consoleReplay;
    const keys = [`${sessionId ?? ''}|runtime`, `${sessionId ?? ''}|log`];
    if (on) for (const key of keys) replay.floor.set(key, replay.seen.get(key) ?? Number.NEGATIVE_INFINITY);
    try {
      await Promise.allSettled(
        driveCommands(on).map(([method, params]) =>
          sendCdp(guest, cdp, method, params ?? {}, CDP_REQUEST_TIMEOUT_MS, signal, sessionId)
        )
      );
    } finally {
      if (on) for (const key of keys) replay.floor.delete(key);
    }
  }

  function switchAllSessions(guest: WebContents, on: boolean): void {
    const ready = host.guestDebugger?.(guest);
    if (!ready) return;
    // Registered on the attachment itself, so these commands reach Chromium
    // before whatever the driving command sends next.
    void ready.then(
      (cdp) => {
        const record = driving.get(guest);
        if (!record || record.on !== on || guest.isDestroyed()) return;
        const sessionIds: Array<string | undefined> = [undefined, ...state.for(guest).cdpSessions.keys()];
        for (const sessionId of sessionIds) void switchDriving(guest, cdp, on, sessionId);
      },
      () => undefined
    );
  }

  /** An agent command is working on `guest` until the returned release. */
  function drive(guest: WebContents): () => void {
    let record = driving.get(guest);
    if (!record) {
      record = { holds: 0, on: false };
      driving.set(guest, record);
    }
    const held = record;
    held.holds += 1;
    if (held.timer) clearTimeout(held.timer);
    held.timer = undefined;
    if (!held.on) {
      held.on = true;
      switchAllSessions(guest, true);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holds -= 1;
      if (held.holds > 0) return;
      held.timer = setTimeout(() => {
        held.timer = undefined;
        if (held.holds > 0 || !held.on) return;
        held.on = false;
        if (!guest.isDestroyed()) switchAllSessions(guest, false);
      }, lingerMs);
      held.timer.unref?.();
    };
  }

  /** Guests whose sessions already carry the identity with its metadata. */
  const identified = new WeakSet<WebContents>();

  /** The engine's own client-hint facts, read once per process in a world of
   *  a page that no page script shares, before any override. Only a secure
   *  document has them; a blank first page does not. */
  async function learnEngineFacts(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    if (!browserIdentityNeedsEngineFacts()) return;
    try {
      const { frameTree } = (await send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const { executionContextId } = (await send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'mixdog-identity',
      })) as { executionContextId: number };
      const read = (await send('Runtime.evaluate', {
        expression: ENGINE_FACTS_EXPRESSION,
        contextId: executionContextId,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      rememberEngineFacts(read?.result?.value);
    } catch {
      /* the next document tries again; until then pages keep the engine's identity */
    }
  }

  /** A top-level document committed. Until the engine's facts are known, a
   *  page keeps the engine's own identity; the first secure document teaches
   *  them, and from then on every session of the page carries Chrome's. */
  function onTopDocument(guest: WebContents, cdp: Electron.Debugger): void {
    if (identified.has(guest)) return;
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      sendCdp(guest, cdp, method, params, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId);
    void (async () => {
      await learnEngineFacts(send);
      if (browserIdentityNeedsEngineFacts() || identified.has(guest) || guest.isDestroyed()) return;
      identified.add(guest);
      const override = browserUserAgentOverride(guest.getUserAgent());
      const sessionIds: Array<string | undefined> = [undefined, ...state.for(guest).cdpSessions.keys()];
      await Promise.allSettled(
        sessionIds.map((sessionId) => send('Network.setUserAgentOverride', override, sessionId))
      );
    })().catch(() => undefined);
  }

  /** Chromium pauses exactly what these patterns name. The dialog bridge is
   *  always one of them; interception contributes the rest. */
  function fetchPatternsFor(guest: WebContents) {
    return [
      { urlPattern: DIALOG_BRIDGE_PATTERN, requestStage: 'Request' as const },
      { urlPattern: PERMISSION_STATE_PATTERN, requestStage: 'Request' as const },
      ...interceptFetchPatterns(guest),
    ];
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
    if (!sessionId) {
      await learnEngineFacts(send);
      if (!browserIdentityNeedsEngineFacts()) identified.add(guest);
    }
    // Dialog interception is the startup safety boundary, and the identity
    // has to be in place before the first document reads it. Do not make
    // first navigation wait for anything else. A frame removed meanwhile ends
    // its commands (cdp-execution endSession); that is not a failure.
    const ended = () => Boolean(sessionId) && !state.for(guest).cdpSessions.has(sessionId!);
    const boundary = Promise.all([
      send('Page.enable'),
      // Pages live in hidden windows that never hold the OS focus; the pane
      // shows them as the focused page a person is using.
      ...(!sessionId ? [send('Emulation.setFocusEmulationEnabled', { enabled: true })] : []),
      send('Network.setUserAgentOverride', browserUserAgentOverride(guest.getUserAgent())),
      newDocumentScript(DIALOG_BRIDGE_SCRIPT),
      newDocumentScript(CHROME_LIKENESS_SCRIPT),
      // Child frames run their own realm, so a guard installed only on the root
      // leaves an iframe free to do what the policy refuses.
      ...(host.pageGuardScripts?.() || []).map(newDocumentScript),
      send('Fetch.enable', { patterns: fetchPatternsFor(guest) }),
    ]);
    try {
      await boundary;
    } catch (error) {
      if (ended()) return;
      throw error;
    }
    signal.throwIfAborted();
    if (ended()) return;
    // A frame attached (or a debugger re-attached) while an agent drives the
    // page is driven with it.
    if (driving.get(guest)?.on) void switchDriving(guest, cdp, true, sessionId, signal);
    void Promise.allSettled([
      send('Network.enable'),
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

  return { applyFetchPatterns, initializeTargetSession, drive, onTopDocument };
}
