/** Page faults the guest record keeps for later replies: thrown exceptions,
 *  console output, browser log entries and failed requests. */
import type { WebContents } from 'electron';

import { type BrowserConsoleArgument, formatConsoleArguments, formatConsoleSource } from './console-format';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { explainNetworkFailure } from './network';
import { redactBrowserUrl } from './redaction';
import { isBrowserComponentAddress } from './request-scheme';

type CdpParams = Record<string, unknown>;
type CallFrame = { url?: string; lineNumber?: number };

/* Diagnostics from Chromium's own bundled components (the PDF viewer, its
 * resources) belong to the browser, not the page, and nobody can act on them.
 * Console calls and exceptions name their execution context, whose origin
 * says which component ran; log entries and failed requests name a URL. */

const contextKey = (sessionId: string | undefined, contextId: unknown) => `${sessionId ?? ''}:${String(contextId)}`;

export function onExecutionContextCreated(
  state: BrowserGuestStateStore,
  guest: WebContents,
  params: CdpParams,
  sessionId?: string
): void {
  const context = params.context as { id?: unknown; origin?: unknown } | undefined;
  if (context && isBrowserComponentAddress(context.origin)) {
    state.for(guest).browserComponentContexts.add(contextKey(sessionId, context.id));
  }
}

export function onExecutionContextDestroyed(
  state: BrowserGuestStateStore,
  guest: WebContents,
  params: CdpParams,
  sessionId?: string
): void {
  state.for(guest).browserComponentContexts.delete(contextKey(sessionId, params.executionContextId));
}

export function onExecutionContextsCleared(
  state: BrowserGuestStateStore,
  guest: WebContents,
  sessionId?: string
): void {
  const contexts = state.for(guest).browserComponentContexts;
  for (const key of contexts) {
    if (key.startsWith(`${sessionId ?? ''}:`)) contexts.delete(key);
  }
}

export function onExceptionThrown(
  state: BrowserGuestStateStore,
  guest: WebContents,
  params: CdpParams,
  sessionId?: string
): void {
  const detail = params.exceptionDetails as
    | {
        text?: string;
        url?: string;
        lineNumber?: number;
        executionContextId?: unknown;
        exception?: { description?: string };
        stackTrace?: { callFrames?: CallFrame[] };
      }
    | undefined;
  if (state.for(guest).browserComponentContexts.has(contextKey(sessionId, detail?.executionContextId))) return;
  const described = detail?.exception?.description || detail?.text || 'page exception';
  const frame = detail?.stackTrace?.callFrames?.find((candidate) => candidate.url);
  const thrownUrl = frame?.url || detail?.url;
  // A thrown Error already prints its own stack; only a bare value, such
  // as `throw 'boom'`, needs the script and line spelled out.
  const thrownLine = frame?.url ? frame.lineNumber : detail?.lineNumber;
  state
    .for(guest)
    .console.recordError(
      thrownUrl && !described.includes(thrownUrl)
        ? `${described}${formatConsoleSource(redactBrowserUrl(thrownUrl), thrownLine)}`
        : described
    );
}

export function onConsoleApiCalled(
  state: BrowserGuestStateStore,
  guest: WebContents,
  params: CdpParams,
  sessionId?: string
): void {
  if (state.for(guest).browserComponentContexts.has(contextKey(sessionId, params.executionContextId))) return;
  const type = String(params.type || '');
  const args = Array.isArray(params.args) ? (params.args as BrowserConsoleArgument[]) : [];
  // The first frame that names a script is the line a reader opens.
  const frame = (params.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames?.find(
    (candidate) => candidate.url
  );
  const source = frame?.url ? formatConsoleSource(redactBrowserUrl(frame.url), frame.lineNumber) : '';
  state.for(guest).console.record(type, `${type}: ${formatConsoleArguments(args)}${source}`);
}

export function onLogEntryAdded(state: BrowserGuestStateStore, guest: WebContents, params: CdpParams): void {
  const entry = params.entry as { level?: string; text?: string; url?: string; lineNumber?: number } | undefined;
  if (!entry || isBrowserComponentAddress(entry.url)) return;
  const diagnostics = state.for(guest);
  const refusal = entry.url ? diagnostics.refusedRequests.get(entry.url) : undefined;
  diagnostics.console.record(
    entry.level,
    `${entry.level}: ${explainNetworkFailure(entry.text || '', refusal)}${entry.url ? formatConsoleSource(redactBrowserUrl(entry.url), entry.lineNumber) : ''}`
  );
}

export function onLoadingFailed(
  state: BrowserGuestStateStore,
  guest: WebContents,
  params: CdpParams,
  sessionId?: string
): void {
  const diagnostics = state.for(guest);
  const request = diagnostics.network.loadingFailed(params, sessionId);
  if (request) {
    request.failure = explainNetworkFailure(request.failure || 'failed', diagnostics.refusedRequests.get(request.url));
  }
  // Chromium cancels a request when the address turns into a download,
  // when the page abandons a fetch, and when a navigation replaces it.
  // None of those is a fault of the page, so a cancelled request stays in
  // the network ledger but never joins the failures a reply volunteers — a
  // saved file is not a failed request.
  if (request && !request.canceled && !isBrowserComponentAddress(request.url)) {
    pushBounded(
      diagnostics.networkFailures,
      `${request.method} ${redactBrowserUrl(request.url)} — ${request.failure || 'failed'}`
    );
  }
}
