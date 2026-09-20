/** Page faults the guest record keeps for later replies: thrown exceptions,
 *  console output, browser log entries and failed requests. */
import type { WebContents } from 'electron';

import { type BrowserConsoleArgument, formatConsoleArguments, formatConsoleSource } from './console-format';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { redactBrowserUrl } from './redaction';

type CdpParams = Record<string, unknown>;
type CallFrame = { url?: string; lineNumber?: number };

/** Resources Chromium's own bundled components ask for, such as the PDF
 *  viewer's stylesheet. This guest grants no extensions, so those failures
 *  belong to the browser rather than the page and nobody can act on them. */
function isBrowserComponentUrl(url: unknown): boolean {
  return typeof url === 'string' && url.startsWith('chrome-extension://');
}

export function onExceptionThrown(state: BrowserGuestStateStore, guest: WebContents, params: CdpParams): void {
  const detail = params.exceptionDetails as
    | {
        text?: string;
        url?: string;
        lineNumber?: number;
        exception?: { description?: string };
        stackTrace?: { callFrames?: CallFrame[] };
      }
    | undefined;
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

export function onConsoleApiCalled(state: BrowserGuestStateStore, guest: WebContents, params: CdpParams): void {
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
  if (!entry || isBrowserComponentUrl(entry.url)) return;
  state
    .for(guest)
    .console.record(
      entry.level,
      `${entry.level}: ${entry.text || ''}${entry.url ? formatConsoleSource(redactBrowserUrl(entry.url), entry.lineNumber) : ''}`
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
  // Chromium cancels a request when the address turns into a download,
  // when the page abandons a fetch, and when a navigation replaces it.
  // None of those is a fault of the page, so a cancelled request stays in
  // the network ledger but never joins the failures a reply volunteers —
  // a saved file used to be announced as a failed request.
  if (request && !request.canceled && !isBrowserComponentUrl(request.url)) {
    pushBounded(
      diagnostics.networkFailures,
      `${request.method} ${redactBrowserUrl(request.url)} — ${request.failure || 'failed'}`
    );
  }
}
