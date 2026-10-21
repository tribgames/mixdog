/**
 * The host's one way of talking to a guest page: attach Electron's debugger
 * (cdp-debugger-attach), bring the CDP domains up (cdp-session-init), route
 * every event into the guest's state record (cdp-event-router), and send
 * bounded, cancellable commands (cdp-execution, cdp-calls). Every other module
 * reaches the page through the functions returned here rather than touching
 * the debugger.
 */
import type { WebContents } from 'electron';

import { bounded } from './cdp-bounded';
import { createBrowserCdpCalls, type BrowserCdpCallOptions } from './cdp-calls';
import { createGuestDebuggerAttachment } from './cdp-debugger-attach';
import { createBrowserCdpEventRouter } from './cdp-event-router';
import { createBrowserCdpExecution } from './cdp-execution';
import { createBrowserCdpSessionInit } from './cdp-session-init';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserFetchPattern, BrowserInterceptRule } from './intercept';
import type { UserWaitClock } from './user-wait';

export type { BrowserCdpCallOptions } from './cdp-calls';

interface BrowserGuestCdpHost {
  state: BrowserGuestStateStore;
  /** Extra Fetch patterns interception wants paused on this guest. */
  interceptFetchPatterns(guest: WebContents): BrowserFetchPattern[];
  matchInterceptRule(guest: WebContents, url: string, resourceType: string): BrowserInterceptRule | undefined;
  /** Whether a person refused `origin` a permission (by engine name). */
  permissionRefused?(origin: string, name: string): boolean;
  /** Policy-driven guards installed into every document and child frame,
   *  alongside the dialog bridge. Empty unless an operator restricts the page. */
  pageGuardScripts?(): string[];
  /** How long driving domains outlive the last agent command (tests). */
  lingerMs?: number;
}

/** The narrow CDP surface a page service depends on; tests fake this shape. */
export type BrowserCdpPort = Pick<BrowserGuestCdp, 'call' | 'sendCdp' | 'sendCdpInput' | 'guestDebugger'>;

export interface BrowserGuestCdp {
  /** Do not reuse a page while a cancelled dispatch is still executing. */
  waitForIdle(guest: WebContents, signal?: AbortSignal): Promise<void>;
  /** Race a promise against a timeout and the caller's cancellation; the
   *  timeout stands still while `userWait` has a wait open (cdp-bounded.ts). */
  bounded<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void,
    userWait?: UserWaitClock
  ): Promise<T>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    sessionId?: string,
    beforeDispatch?: () => void
  ): Promise<T>;
  /** One command against a guest: resolves the attached debugger and applies
   *  the default request timeout. Page services reach CDP through this. */
  call<T>(
    guest: WebContents,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    options?: BrowserCdpCallOptions
  ): Promise<T>;
  /** Input commands can remain pending while a JavaScript dialog blocks its
   *  event handler. Return control as soon as the dialog event arrives so the
   *  caller can issue handle_dialog instead of waiting for the CDP timeout. */
  sendCdpInput(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    sessionId?: string,
    beforeDispatch?: () => void
  ): Promise<'completed' | 'dialog'>;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
  /** The attached debugger for a guest, initialised once per document. */
  guestDebugger(guest: WebContents, answeringDialog?: boolean): Promise<Electron.Debugger>;
  /** Attach a page window.open created without blanking the navigation its
   *  opener started, so its first document already has the dialog bridge. */
  attachOpenedPage(guest: WebContents): Promise<Electron.Debugger>;
  waitForInitialDocument(guest: WebContents): Promise<void>;
  /** Push the current Fetch patterns to the root and every child session. */
  applyFetchPatterns(guest: WebContents, signal?: AbortSignal): Promise<void>;
  /** An agent command works on the page until the returned release: the
   *  domains only that work needs are up meanwhile (see cdp-session-init). */
  drive(guest: WebContents): () => void;
  /** Drop the debugger for a guest whose bridge is going away. */
  detach(guest: WebContents): Promise<void>;
}

export function createBrowserGuestCdp(host: BrowserGuestCdpHost): BrowserGuestCdp {
  const { state } = host;
  const { sendCdp, waitForIdle } = createBrowserCdpExecution({
    bounded,
    diagnostic: (guest, message) => state.for(guest).console.recordInternal(message),
    awaitingDialog: (guest) => Boolean(state.peek(guest)?.pendingDialog),
  });
  const sessions = createBrowserCdpSessionInit(
    { ...host, guestDebugger: (guest) => attachment.guestDebugger(guest) },
    sendCdp
  );
  // The attachment routes messages through the router, and the router reads
  // the attachment's lifetimes; messages only arrive once both exist.
  const attachment = createGuestDebuggerAttachment({
    state,
    onCdpEvent: (guest, cdp, name, params, sessionId) => onCdpEvent(guest, cdp, name, params, sessionId),
    initializeTargetSession: sessions.initializeTargetSession,
  });
  const onCdpEvent = createBrowserCdpEventRouter({
    state,
    sendCdp,
    matchInterceptRule: host.matchInterceptRule,
    permissionRefused: host.permissionRefused,
    initializeTargetSession: sessions.initializeTargetSession,
    lifetimeSignal: attachment.lifetimeSignal,
    onTopDocument: sessions.onTopDocument,
  });
  const calls = createBrowserCdpCalls({ state, sendCdp, guestDebugger: attachment.guestDebugger });

  async function applyFetchPatterns(guest: WebContents, signal?: AbortSignal): Promise<void> {
    await sessions.applyFetchPatterns(guest, await attachment.guestDebugger(guest), signal);
  }

  return {
    bounded,
    waitForIdle,
    sendCdp,
    call: calls.call,
    sendCdpInput: calls.sendCdpInput,
    evaluate: calls.evaluate,
    guestDebugger: attachment.guestDebugger,
    attachOpenedPage: attachment.attachOpenedPage,
    waitForInitialDocument: attachment.waitForInitialDocument,
    applyFetchPatterns,
    drive: sessions.drive,
    detach: attachment.detach,
  };
}
