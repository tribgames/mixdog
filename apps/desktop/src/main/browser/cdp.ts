/**
 * The host's one way of talking to a guest page: attach Electron's debugger,
 * bring the CDP domains up, route every event into the guest's state record,
 * and send bounded, cancellable commands. Every other module reaches the page
 * through the functions returned here rather than touching the debugger.
 */
import type { WebContents } from 'electron';

import {
  CDP_REQUEST_TIMEOUT_MS,
  MAX_CHILD_CDP_SESSIONS,
  OPEN_SURFACE_TIMEOUT_MS,
} from './command';
import {
  DIALOG_BRIDGE_PATTERN,
  DIALOG_BRIDGE_SCRIPT,
  dialogBridgeFulfillParams,
  parseDialogBridgeRequest,
} from './dialog-bridge';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import {
  type BrowserFetchPattern,
  type BrowserInterceptRule,
  interceptFulfillParams,
} from './intercept';
import { redactBrowserText, redactBrowserUrl } from './redaction';
import { pause } from './settle';

export interface BrowserGuestCdpHost {
  state: BrowserGuestStateStore;
  /** Extra Fetch patterns interception wants paused on this guest. */
  interceptFetchPatterns(guest: WebContents): BrowserFetchPattern[];
  matchInterceptRule(
    guest: WebContents,
    url: string,
    resourceType: string,
  ): BrowserInterceptRule | undefined;
}

export interface BrowserCdpCallOptions {
  /** Address a child target (frame, worker) instead of the root session. */
  sessionId?: string;
  timeoutMs?: number;
}

/** The narrow CDP surface a page service depends on; tests fake this shape. */
export type BrowserCdpPort = Pick<
  BrowserGuestCdp,
  'call' | 'sendCdp' | 'sendCdpInput' | 'guestDebugger'
>;

export interface BrowserGuestCdp {
  /** Race a promise against a timeout and the caller's cancellation. */
  bounded<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void,
  ): Promise<T>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T>;
  /** One command against a guest: resolves the attached debugger and applies
   *  the default request timeout. Page services reach CDP through this. */
  call<T>(
    guest: WebContents,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    options?: BrowserCdpCallOptions,
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
  ): Promise<'completed' | 'dialog'>;
  evaluate<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T>;
  /** The attached debugger for a guest, initialised once per document. */
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  waitForInitialDocument(guest: WebContents): Promise<void>;
  /** Push the current Fetch patterns to the root and every child session. */
  applyFetchPatterns(guest: WebContents, signal?: AbortSignal): Promise<void>;
  /** Drop the debugger for a guest whose bridge is going away. */
  detach(guest: WebContents, options?: { uninstallScript?: string }): Promise<void>;
}

export function createBrowserGuestCdp(host: BrowserGuestCdpHost): BrowserGuestCdp {
  const { state, interceptFetchPatterns, matchInterceptRule } = host;
  const debuggerReady = new WeakMap<WebContents, Promise<Electron.Debugger>>();
  const debuggerListeners = new WeakMap<WebContents, (...args: unknown[]) => void>();

  async function bounded<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void,
  ): Promise<T> {
    if (signal?.aborted) throw signal.reason || new Error(`${label} cancelled`);
    let timer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      const cancellation = signal
        ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason || new Error(`${label} cancelled`));
          signal.addEventListener('abort', abortListener, { once: true });
        })
        : new Promise<never>(() => undefined);
      return await Promise.race([promise, timeout, cancellation]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  async function sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T> {
    return await bounded(
      cdp.sendCommand(method, params, sessionId) as Promise<T>,
      timeoutMs,
      `CDP ${method}`,
      signal,
      () => {
        if (method === 'Runtime.evaluate') {
          void cdp.sendCommand('Runtime.terminateExecution').catch(() => undefined);
        }
        state.for(guest).console.recordError(`CDP ${method} timed out`);
      },
    );
  }

  async function call<T>(
    guest: WebContents,
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    options: BrowserCdpCallOptions = {},
  ): Promise<T> {
    return await sendCdp<T>(
      guest,
      await guestDebugger(guest),
      method,
      params,
      options.timeoutMs ?? CDP_REQUEST_TIMEOUT_MS,
      signal,
      options.sessionId,
    );
  }

  async function sendCdpInput(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<'completed' | 'dialog'> {
    const dispatch = sendCdp<void>(guest, cdp, method, params, CDP_REQUEST_TIMEOUT_MS, signal);
    const outcome = dispatch.then(
      () => ({ done: true as const, error: null }),
      (error: unknown) => ({ done: true as const, error }),
    );
    for (;;) {
      const next = await Promise.race([
        outcome,
        pause(25, signal).then(() => ({ done: false as const, error: null })),
      ]);
      if (next.done) {
        if (next.error) throw next.error;
        return 'completed';
      }
      if (state.for(guest).pendingDialog) return 'dialog';
    }
  }

  async function waitForInitialDocument(guest: WebContents): Promise<void> {
    if (guest.isDestroyed()) throw new Error('browser page is unavailable');
    if (guest.getURL()) return;
    // A newly constructed hidden BrowserWindow has no committed document and
    // will not emit dom-ready until its first explicit load.
    await bounded(
      guest.loadURL('about:blank'),
      OPEN_SURFACE_TIMEOUT_MS,
      'browser page initialization',
    );
  }

  /** Chromium pauses exactly what these patterns name. The dialog bridge is
   *  always one of them; interception contributes the rest. */
  function fetchPatternsFor(guest: WebContents) {
    return [
      { urlPattern: DIALOG_BRIDGE_PATTERN, requestStage: 'Request' as const },
      ...interceptFetchPatterns(guest),
    ];
  }

  /** A rule change has to reach every attached session, not just the root one:
   *  an out-of-process frame runs its own Fetch domain and would otherwise keep
   *  answering from the network while the page above it is intercepted. */
  async function applyFetchPatterns(guest: WebContents, signal?: AbortSignal): Promise<void> {
    const cdp = await guestDebugger(guest);
    const patterns = fetchPatternsFor(guest);
    const sessionIds: Array<string | undefined> = [
      undefined,
      ...state.for(guest).cdpSessions.keys(),
    ];
    for (const sessionId of sessionIds) {
      await sendCdp(
        guest,
        cdp,
        'Fetch.enable',
        { patterns },
        CDP_REQUEST_TIMEOUT_MS,
        signal,
        sessionId,
      ).catch(() => undefined);
    }
  }

  async function initializeTargetSession(
    guest: WebContents,
    cdp: Electron.Debugger,
    sessionId?: string,
  ): Promise<void> {
    // Dialog interception is the startup safety boundary. Do not make first
    // navigation wait for unrelated observability domains or child targets.
    await Promise.all([
      sendCdp(guest, cdp, 'Page.enable', {}, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Runtime.enable', {}, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Page.addScriptToEvaluateOnNewDocument', {
        source: DIALOG_BRIDGE_SCRIPT,
        runImmediately: true,
      }, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Fetch.enable', {
        patterns: fetchPatternsFor(guest),
      }, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
    ]);
    void Promise.allSettled([
      sendCdp(guest, cdp, 'Network.enable', {}, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Log.enable', {}, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Accessibility.enable', {}, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      // A native file picker would block the window; Chromium reports it as
      // an event instead and `upload` answers it with approved paths.
      sendCdp(guest, cdp, 'Page.setInterceptFileChooserDialog', {
        enabled: true,
      }, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
      sendCdp(guest, cdp, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId),
    ]);
  }

  /** Answer a paused request: the dialog bridge, an intercept rule, or plain
   *  continuation. A paused request nobody releases leaves the page waiting
   *  on it forever, so every branch answers. */
  function onRequestPaused(
    guest: WebContents,
    cdp: Electron.Debugger,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const diagnostics = state.for(guest);
    const request = (params.request && typeof params.request === 'object'
      ? params.request
      : {}) as { url?: string };
    const requestUrl = String(request.url || '');
    const bridgeDialog = parseDialogBridgeRequest(requestUrl);
    if (bridgeDialog) {
      const requestId = String(params.requestId || '');
      if (!requestId) return;
      if (diagnostics.pendingDialog) {
        void sendCdp(
          guest,
          cdp,
          'Fetch.fulfillRequest',
          dialogBridgeFulfillParams(requestId, false, ''),
          CDP_REQUEST_TIMEOUT_MS,
          undefined,
          sessionId,
        ).catch(() => undefined);
        return;
      }
      diagnostics.pendingDialog = {
        type: bridgeDialog.type,
        message: redactBrowserText(bridgeDialog.message),
        defaultPrompt: redactBrowserText(bridgeDialog.defaultPrompt),
        openedAt: Date.now(),
        sessionId,
        bridgeRequestId: requestId,
      };
      return;
    }
    const pausedRequestId = String(params.requestId || '');
    if (!pausedRequestId) return;
    const rule = matchInterceptRule(guest, requestUrl, String(params.resourceType || ''));
    // A pause carrying a status is already past the request stage, where
    // only continueResponse may release it.
    const atResponseStage = params.responseStatusCode !== undefined;
    const answered = !rule
      ? sendCdp(
        guest,
        cdp,
        atResponseStage ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
        { requestId: pausedRequestId },
        CDP_REQUEST_TIMEOUT_MS,
        undefined,
        sessionId,
      )
      : rule.abort
        ? sendCdp(guest, cdp, 'Fetch.failRequest', {
          requestId: pausedRequestId,
          errorReason: 'Aborted',
        }, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId)
        : sendCdp(
          guest,
          cdp,
          'Fetch.fulfillRequest',
          interceptFulfillParams(rule, pausedRequestId),
          CDP_REQUEST_TIMEOUT_MS,
          undefined,
          sessionId,
        );
    // A request that could not be answered would otherwise fail silently
    // and look like a hung page, so the reason joins the page console.
    void answered.catch((error) => diagnostics.console.recordError(
      `intercept could not answer ${redactBrowserUrl(requestUrl)}: ${(error as Error).message}`,
    ));
  }

  function onAttachedToTarget(
    guest: WebContents,
    cdp: Electron.Debugger,
    params: Record<string, unknown>,
    parentSessionId: string | undefined,
  ): void {
    const diagnostics = state.for(guest);
    const attachedSessionId = String(params.sessionId || '');
    const targetInfo = (params.targetInfo && typeof params.targetInfo === 'object'
      ? params.targetInfo
      : {}) as { targetId?: string; type?: string; url?: string };
    if (!attachedSessionId || targetInfo.type !== 'iframe') return;
    if (diagnostics.cdpSessions.size >= MAX_CHILD_CDP_SESSIONS) {
      diagnostics.console.recordError(
        `CDP child target limit reached (${MAX_CHILD_CDP_SESSIONS}); detached excess iframe`,
      );
      void cdp.sendCommand('Target.detachFromTarget', {
        sessionId: attachedSessionId,
      }).catch(() => undefined);
      return;
    }
    const ready = initializeTargetSession(guest, cdp, attachedSessionId);
    diagnostics.cdpSessions.set(attachedSessionId, {
      type: String(targetInfo.type || 'iframe'),
      url: redactBrowserUrl(String(targetInfo.url || '').slice(0, 8_000)),
      frameId: String(targetInfo.targetId || ''),
      parentSessionId,
      ready,
    });
    ready.catch((error) => diagnostics.console.recordError(
      `CDP child target initialization failed: ${(error as Error).message}`,
    ));
  }

  /** Route one CDP event into the guest's state record. */
  function onCdpEvent(
    guest: WebContents,
    cdp: Electron.Debugger,
    name: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const diagnostics = state.for(guest);
    switch (name) {
      case 'Target.attachedToTarget':
        onAttachedToTarget(guest, cdp, params, sessionId);
        return;
      case 'Target.detachedFromTarget':
        diagnostics.cdpSessions.delete(String(params.sessionId || sessionId || ''));
        return;
      case 'Fetch.requestPaused':
        onRequestPaused(guest, cdp, params, sessionId);
        return;
      case 'Page.javascriptDialogOpening':
        diagnostics.pendingDialog = {
          type: String(params.type || 'dialog'),
          message: redactBrowserText(params.message || ''),
          defaultPrompt: redactBrowserText(params.defaultPrompt || ''),
          openedAt: Date.now(),
          sessionId,
        };
        return;
      case 'Page.javascriptDialogClosed':
        diagnostics.pendingDialog = null;
        return;
      case 'Page.fileChooserOpened': {
        const backendNodeId = Number(params.backendNodeId);
        diagnostics.pendingFileChooser = {
          mode: String(params.mode || 'selectSingle'),
          backendNodeId: Number.isFinite(backendNodeId) && backendNodeId > 0 ? backendNodeId : undefined,
          frameId: String(params.frameId || '') || undefined,
          sessionId,
          openedAt: Date.now(),
        };
        return;
      }
      case 'Runtime.exceptionThrown': {
        const detail = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        diagnostics.console.recordError(
          detail?.exception?.description || detail?.text || 'page exception',
        );
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const type = String(params.type || '');
        const args = Array.isArray(params.args) ? params.args as Array<{ value?: unknown; description?: string }> : [];
        diagnostics.console.record(
          type,
          `${type}: ${args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
        );
        return;
      }
      case 'Log.entryAdded': {
        const entry = params.entry as { level?: string; text?: string; url?: string; lineNumber?: number } | undefined;
        if (entry) diagnostics.console.record(
          entry.level,
          `${entry.level}: ${entry.text || ''}${entry.url ? ` (${redactBrowserUrl(entry.url)}:${entry.lineNumber || 0})` : ''}`,
        );
        return;
      }
      case 'Network.requestWillBeSent':
        diagnostics.network.requestWillBeSent(params, sessionId);
        return;
      case 'Network.responseReceived':
        diagnostics.network.responseReceived(params, sessionId);
        return;
      case 'Network.loadingFinished':
        diagnostics.network.loadingFinished(params, sessionId);
        return;
      case 'Network.loadingFailed': {
        const request = diagnostics.network.loadingFailed(params, sessionId);
        if (request) {
          pushBounded(
            diagnostics.networkFailures,
            `${request.method} ${redactBrowserUrl(request.url)} — ${request.failure || 'failed'}`,
          );
        }
        return;
      }
      case 'Network.webSocketCreated':
        diagnostics.network.webSocketCreated(params, sessionId);
        return;
      case 'Network.webSocketHandshakeResponseReceived':
        diagnostics.network.webSocketHandshakeResponse(params, sessionId);
        return;
      case 'Network.webSocketFrameSent':
        diagnostics.network.webSocketFrame(params, 'sent', sessionId);
        return;
      case 'Network.webSocketFrameReceived':
        diagnostics.network.webSocketFrame(params, 'received', sessionId);
        return;
      case 'Network.webSocketClosed':
        diagnostics.network.webSocketClosed(params, sessionId);
        return;
      case 'Network.webSocketFrameError':
        diagnostics.network.loadingFailed({
          requestId: params.requestId,
          errorText: params.errorMessage || 'WebSocket frame error',
        }, sessionId);
        return;
      case 'Tracing.dataCollected':
        diagnostics.performanceTrace?.trace.add(params.value);
        return;
      case 'Tracing.tracingComplete':
        diagnostics.performanceTrace?.resolveComplete();
        return;
      case 'Inspector.targetCrashed':
      case 'Target.targetCrashed':
        state.markCrashed(guest, 'page target crashed');
        return;
      default:
    }
  }

  async function guestDebugger(guest: WebContents): Promise<Electron.Debugger> {
    const existing = debuggerReady.get(guest);
    if (existing) return existing;
    const ready = (async () => {
      await waitForInitialDocument(guest);
      const cdp = guest.debugger;
      if (!cdp.isAttached()) cdp.attach('1.3');
      const onMessage = (
        _event: unknown,
        method: unknown,
        rawParams: unknown,
        rawSessionId?: unknown,
      ): void => {
        const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
        onCdpEvent(guest, cdp, String(method || ''), params, String(rawSessionId || '') || undefined);
      };
      debuggerListeners.set(guest, onMessage);
      cdp.on('message', onMessage);
      cdp.once('detach', (_event, reason) => {
        const listener = debuggerListeners.get(guest);
        if (listener) cdp.removeListener('message', listener);
        debuggerListeners.delete(guest);
        debuggerReady.delete(guest);
        const record = state.for(guest);
        record.performanceTrace?.resolveComplete();
        record.performanceTrace = undefined;
        record.fault = `CDP detached: ${String(reason || 'unknown reason')}`;
      });
      await initializeTargetSession(guest, cdp);
      return cdp;
    })();
    debuggerReady.set(guest, ready);
    ready.catch(() => debuggerReady.delete(guest));
    return ready;
  }

  async function evaluate<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const cdp = await guestDebugger(guest);
    const response = await sendCdp<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(guest, cdp, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      includeCommandLineAPI: true,
      userGesture: true,
    }, timeoutMs, signal);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text || 'page script failed';
      throw new Error(redactBrowserText(detail.split('\n')[0]));
    }
    return response.result?.value as T;
  }

  async function detach(
    guest: WebContents,
    options: { uninstallScript?: string } = {},
  ): Promise<void> {
    if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
    if (options.uninstallScript) {
      try {
        await guest.debugger.sendCommand('Runtime.evaluate', {
          expression: options.uninstallScript,
          awaitPromise: true,
        });
      } catch { /* page may be gone or blocked by a native dialog */ }
    }
    try { guest.debugger.detach(); } catch { /* already detached */ }
  }

  return {
    bounded,
    sendCdp,
    call,
    sendCdpInput,
    evaluate,
    guestDebugger,
    waitForInitialDocument,
    applyFetchPatterns,
    detach,
  };
}
