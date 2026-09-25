/** Answering a paused request: the dialog bridge, an intercept rule, or plain
 *  continuation. A paused request nobody releases leaves the page waiting on
 *  it forever, so every branch answers. */
import type { WebContents } from 'electron';

import { CDP_REQUEST_TIMEOUT_MS } from './command';
import type { BrowserCdpSend } from './cdp-session-init';
import { dialogBridgeFulfillParams, parseDialogBridgeRequest } from './dialog-bridge';
import type { BrowserGuestStateStore } from './guest-state';
import { type BrowserInterceptRule, interceptFulfillParams } from './intercept';
import { redactBrowserText, redactBrowserUrl } from './redaction';

type CdpParams = Record<string, unknown>;
type GuestRecord = ReturnType<BrowserGuestStateStore['for']>;
type BridgeDialog = NonNullable<ReturnType<typeof parseDialogBridgeRequest>>;

export interface RequestPauseHost {
  state: BrowserGuestStateStore;
  sendCdp: BrowserCdpSend;
  matchInterceptRule(guest: WebContents, url: string, resourceType: string): BrowserInterceptRule | undefined;
}

/** The page asked the host a question through the dialog bridge: the request
 *  is held until handle_dialog answers it, or refused while another dialog is
 *  already open. */
function holdDialogBridgeRequest(
  host: RequestPauseHost,
  guest: WebContents,
  cdp: Electron.Debugger,
  diagnostics: GuestRecord,
  params: CdpParams,
  bridgeDialog: BridgeDialog,
  sessionId?: string
): void {
  const requestId = String(params.requestId || '');
  if (!requestId) return;
  if (diagnostics.pendingDialog) {
    void host
      .sendCdp(
        guest,
        cdp,
        'Fetch.fulfillRequest',
        dialogBridgeFulfillParams(requestId, false, ''),
        CDP_REQUEST_TIMEOUT_MS,
        undefined,
        sessionId
      )
      .catch(() => undefined);
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
}

/** The page's own request: failed or fulfilled by an intercept rule, or let
 *  through at whichever stage it paused. */
function answerInterceptedRequest(
  host: RequestPauseHost,
  guest: WebContents,
  cdp: Electron.Debugger,
  diagnostics: GuestRecord,
  params: CdpParams,
  requestUrl: string,
  sessionId?: string
): void {
  const pausedRequestId = String(params.requestId || '');
  if (!pausedRequestId) return;
  // Fetch-domain pauses can classify fetch() as XHR. Match the same
  // Network-domain identity used by the request report, without conflating
  // real XMLHttpRequests with fetch requests or crossing target sessions.
  const resourceType =
    diagnostics.network.inflightResourceType(String(params.networkId || ''), sessionId) ??
    String(params.resourceType || '');
  const rule = host.matchInterceptRule(guest, requestUrl, resourceType);
  // A pause carrying a status is already past the request stage, where
  // only continueResponse may release it.
  const atResponseStage = params.responseStatusCode !== undefined;
  const answer = (method: string, answerParams: CdpParams) =>
    host.sendCdp(guest, cdp, method, answerParams, CDP_REQUEST_TIMEOUT_MS, undefined, sessionId);
  let answered: Promise<unknown>;
  if (!rule) {
    answered = answer(atResponseStage ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {
      requestId: pausedRequestId,
    });
  } else if (rule.abort) {
    answered = answer('Fetch.failRequest', { requestId: pausedRequestId, errorReason: 'Aborted' });
  } else {
    answered = answer('Fetch.fulfillRequest', interceptFulfillParams(rule, pausedRequestId, params));
  }
  // A request that could not be answered would otherwise fail silently
  // and look like a hung page, so the reason stays in the console — as the
  // browser's own fault, since the interception is ours, not the page's.
  void answered.catch((error) =>
    diagnostics.console.recordInternal(
      `intercept could not answer ${redactBrowserUrl(requestUrl)}: ${(error as Error).message}`
    )
  );
}

export function onRequestPaused(
  host: RequestPauseHost,
  guest: WebContents,
  cdp: Electron.Debugger,
  params: CdpParams,
  sessionId?: string
): void {
  const diagnostics = host.state.for(guest);
  const request = (params.request && typeof params.request === 'object' ? params.request : {}) as { url?: string };
  const requestUrl = String(request.url || '');
  const bridgeDialog = parseDialogBridgeRequest(requestUrl);
  if (bridgeDialog) {
    holdDialogBridgeRequest(host, guest, cdp, diagnostics, params, bridgeDialog, sessionId);
    return;
  }
  answerInterceptedRequest(host, guest, cdp, diagnostics, params, requestUrl, sessionId);
}
