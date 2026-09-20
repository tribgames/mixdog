/**
 * Routing CDP events into the guest's state record: child-target attachment,
 * paused requests (dialog bridge, intercept rules, plain continuation),
 * dialogs, file choosers, console/log entries, the network ledger, tracing and
 * crashes.
 */
import type { WebContents } from 'electron';

import { onConsoleApiCalled, onExceptionThrown, onLoadingFailed, onLogEntryAdded } from './cdp-events-console';
import { onRequestPaused, type RequestPauseHost } from './cdp-events-fetch';
import { onAttachedToTarget, type TargetAttachHost } from './cdp-events-target';
import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserText } from './redaction';

type CdpParams = Record<string, unknown>;
type GuestRecord = ReturnType<BrowserGuestStateStore['for']>;

export interface BrowserCdpEventRouterHost extends RequestPauseHost, TargetAttachHost {}

interface EventContext {
  guest: WebContents;
  cdp: Electron.Debugger;
  params: CdpParams;
  sessionId: string | undefined;
  diagnostics: GuestRecord;
}
type Route = (context: EventContext) => void;
type LedgerRoute = (network: GuestRecord['network'], params: CdpParams, sessionId: string | undefined) => void;

/** Network events that only feed the guest's request ledger. */
const NETWORK_LEDGER_ROUTES: Record<string, LedgerRoute> = {
  'Network.requestWillBeSent': (network, params, sessionId) => network.requestWillBeSent(params, sessionId),
  'Network.requestWillBeSentExtraInfo': (network, params, sessionId) =>
    network.requestWillBeSentExtraInfo(params, sessionId),
  'Network.responseReceived': (network, params, sessionId) => network.responseReceived(params, sessionId),
  'Network.loadingFinished': (network, params, sessionId) => network.loadingFinished(params, sessionId),
  'Network.webSocketCreated': (network, params, sessionId) => network.webSocketCreated(params, sessionId),
  'Network.webSocketWillSendHandshakeRequest': (network, params, sessionId) =>
    network.webSocketWillSendHandshakeRequest(params, sessionId),
  'Network.webSocketHandshakeResponseReceived': (network, params, sessionId) =>
    network.webSocketHandshakeResponse(params, sessionId),
  'Network.webSocketFrameSent': (network, params, sessionId) => network.webSocketFrame(params, 'sent', sessionId),
  'Network.webSocketFrameReceived': (network, params, sessionId) =>
    network.webSocketFrame(params, 'received', sessionId),
  'Network.webSocketClosed': (network, params, sessionId) => network.webSocketClosed(params, sessionId),
  'Network.webSocketFrameError': (network, params, sessionId) =>
    network.loadingFailed(
      {
        requestId: params.requestId,
        errorText: params.errorMessage || 'WebSocket frame error',
      },
      sessionId
    ),
};

export function createBrowserCdpEventRouter(host: BrowserCdpEventRouterHost) {
  const { state } = host;
  const markCrashed: Route = ({ guest }) => state.markCrashed(guest, 'page target crashed');
  const routes: Record<string, Route> = {
    'Target.attachedToTarget': ({ guest, cdp, params, sessionId }) =>
      onAttachedToTarget(host, guest, cdp, params, sessionId),
    'Target.detachedFromTarget': ({ diagnostics, params, sessionId }) => {
      diagnostics.cdpSessions.delete(String(params.sessionId || sessionId || ''));
    },
    'Fetch.requestPaused': ({ guest, cdp, params, sessionId }) => onRequestPaused(host, guest, cdp, params, sessionId),
    // The page answered a press-and-move with its own HTML5 drag, so
    // Chromium hands the payload over rather than running the drag. The
    // input driver picks it up and finishes the gesture as a drop.
    'Input.dragIntercepted': ({ diagnostics, params }) => {
      diagnostics.interceptedDrag = (params.data ?? undefined) as typeof diagnostics.interceptedDrag;
    },
    'Page.javascriptDialogOpening': ({ diagnostics, params, sessionId }) => {
      diagnostics.pendingDialog = {
        type: String(params.type || 'dialog'),
        message: redactBrowserText(params.message || ''),
        defaultPrompt: redactBrowserText(params.defaultPrompt || ''),
        openedAt: Date.now(),
        sessionId,
      };
    },
    'Page.javascriptDialogClosed': ({ diagnostics }) => {
      diagnostics.pendingDialog = null;
    },
    'Page.fileChooserOpened': ({ diagnostics, params, sessionId }) => {
      const backendNodeId = Number(params.backendNodeId);
      diagnostics.pendingFileChooser = {
        mode: String(params.mode || 'selectSingle'),
        backendNodeId: Number.isFinite(backendNodeId) && backendNodeId > 0 ? backendNodeId : undefined,
        frameId: String(params.frameId || '') || undefined,
        sessionId,
        openedAt: Date.now(),
      };
    },
    'Runtime.exceptionThrown': ({ guest, params }) => onExceptionThrown(state, guest, params),
    'Runtime.consoleAPICalled': ({ guest, params }) => onConsoleApiCalled(state, guest, params),
    'Log.entryAdded': ({ guest, params }) => onLogEntryAdded(state, guest, params),
    'Network.loadingFailed': ({ guest, params, sessionId }) => onLoadingFailed(state, guest, params, sessionId),
    'Tracing.dataCollected': ({ diagnostics, params }) => {
      diagnostics.performanceTrace?.trace.add(params.value);
    },
    'Tracing.tracingComplete': ({ diagnostics }) => {
      diagnostics.performanceTrace?.resolveComplete();
    },
    'Inspector.targetCrashed': markCrashed,
    'Target.targetCrashed': markCrashed,
  };

  /** Route one CDP event into the guest's state record. */
  return function onCdpEvent(
    guest: WebContents,
    cdp: Electron.Debugger,
    name: string,
    params: CdpParams,
    sessionId: string | undefined
  ): void {
    const diagnostics = state.for(guest);
    const ledgerRoute = NETWORK_LEDGER_ROUTES[name];
    if (ledgerRoute) {
      ledgerRoute(diagnostics.network, params, sessionId);
      return;
    }
    routes[name]?.({ guest, cdp, params, sessionId, diagnostics });
  };
}
