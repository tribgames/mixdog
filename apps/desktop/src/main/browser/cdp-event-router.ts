/**
 * Routing CDP events into the guest's state record: child-target attachment,
 * paused requests (dialog bridge, intercept rules, plain continuation),
 * dialogs, file choosers, console/log entries, the network ledger, tracing and
 * crashes.
 */
import type { WebContents } from 'electron';

import {
  onConsoleApiCalled,
  onExceptionThrown,
  onExecutionContextCreated,
  onExecutionContextDestroyed,
  onExecutionContextsCleared,
  onLoadingFailed,
  onLogEntryAdded,
} from './cdp-events-console';
import { onRequestPaused, type RequestPauseHost } from './cdp-events-fetch';
import { onAttachedToTarget, type TargetAttachHost } from './cdp-events-target';
import { parseDialogBridgeNotice } from './dialog-bridge';
import type { BrowserGuestStateStore } from './guest-state';
import { reportPageFault } from './page-fault-diagnostics';
import { recordWindowOpen } from './popup-focus';
import { redactBrowserText } from './redaction';

type CdpParams = Record<string, unknown>;
type GuestRecord = ReturnType<BrowserGuestStateStore['for']>;

interface BrowserCdpEventRouterHost extends RequestPauseHost, TargetAttachHost {
  /** A child target's session ended; commands still in flight on it settle. */
  targetDetached(guest: WebContents, sessionId: string): void;
}

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

/** False for a console or log entry a re-enabled domain replays although
 *  it was recorded already; otherwise records it as the newest one seen. */
function freshEntry(diagnostics: GuestRecord, key: string, timestamp: unknown): boolean {
  if (typeof timestamp !== 'number') return true;
  const { seen, floor } = diagnostics.consoleReplay;
  const replayedUpTo = floor.get(key);
  if (replayedUpTo !== undefined && timestamp <= replayedUpTo) return false;
  if (timestamp > (seen.get(key) ?? Number.NEGATIVE_INFINITY)) seen.set(key, timestamp);
  return true;
}

export function createBrowserCdpEventRouter(host: BrowserCdpEventRouterHost) {
  const { state } = host;
  const endChildSession = (guest: WebContents, ended: string) => {
    state.endTargetSession(guest, ended);
    host.targetDetached(guest, ended);
  };
  // Only the page's own session crashing is a page crash. A child target
  // (ad iframe, worker) that dies leaves the page alive: its session ends and
  // the page keeps its state.
  const targetCrashed: Route = ({ guest, sessionId, diagnostics }) => {
    if (!sessionId) {
      reportPageFault(guest, { source: 'inspector', scope: 'root', reason: 'page target crashed' });
      state.markCrashed(guest, 'page target crashed');
      return;
    }
    const childType = diagnostics.cdpSessions.get(sessionId)?.type;
    reportPageFault(guest, {
      source: 'inspector',
      scope: 'child',
      ...(childType ? { childType } : {}),
      reason: 'child target crashed',
    });
    diagnostics.console.recordInternal(`CDP child target crashed (${childType ?? 'unknown'}); page unaffected`);
    endChildSession(guest, sessionId);
  };
  const routes: Record<string, Route> = {
    'Target.attachedToTarget': ({ guest, cdp, params, sessionId }) =>
      onAttachedToTarget(host, guest, cdp, params, sessionId),
    'Target.detachedFromTarget': ({ guest, params, sessionId }) =>
      endChildSession(guest, String(params.sessionId || sessionId || '')),
    'Fetch.requestPaused': ({ guest, cdp, params, sessionId }) => onRequestPaused(host, guest, cdp, params, sessionId),
    // The page answered a press-and-move with its own HTML5 drag, so
    // Chromium hands the payload over rather than running the drag. The
    // input driver picks it up and finishes the gesture as a drop.
    'Input.dragIntercepted': ({ diagnostics, params }) => {
      const data = (params.data ?? undefined) as typeof diagnostics.interceptedDrag;
      diagnostics.interceptedDrag = data;
      // The gesture that armed interception is waiting on this exact event.
      if (data) diagnostics.notifyInterceptedDrag?.(data);
    },
    // Sent before Electron asks for the window; decides whether it comes forward.
    'Page.windowOpen': ({ diagnostics, params }) => recordWindowOpen(diagnostics, params),
    'Page.javascriptDialogOpening': ({ diagnostics, params, sessionId }) => {
      diagnostics.pendingDialog = {
        type: String(params.type || 'dialog'),
        message: redactBrowserText(params.message || ''),
        defaultPrompt: redactBrowserText(params.defaultPrompt || ''),
        openedAt: Date.now(),
        sessionId,
      };
    },
    // Only the native dialog of the closing session: a bridged one is
    // answered through its held request, never by this event.
    'Page.javascriptDialogClosed': ({ guest, sessionId }) => state.nativeDialogClosed(guest, sessionId),
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
    'Runtime.executionContextCreated': ({ guest, params, sessionId }) =>
      onExecutionContextCreated(state, guest, params, sessionId),
    'Runtime.executionContextDestroyed': ({ guest, params, sessionId }) =>
      onExecutionContextDestroyed(state, guest, params, sessionId),
    'Runtime.executionContextsCleared': ({ guest, sessionId }) => onExecutionContextsCleared(state, guest, sessionId),
    'Runtime.exceptionThrown': ({ guest, params, sessionId, diagnostics }) => {
      if (freshEntry(diagnostics, `${sessionId ?? ''}|runtime`, params.timestamp)) {
        onExceptionThrown(state, guest, params, sessionId);
      }
    },
    // The bridge reports a dialog that never reached the host through the
    // console; that call is the host's notice, not something the page logged.
    'Runtime.consoleAPICalled': ({ guest, params, sessionId, diagnostics }) => {
      if (!freshEntry(diagnostics, `${sessionId ?? ''}|runtime`, params.timestamp)) return;
      const dismissed = parseDialogBridgeNotice(params);
      if (dismissed) {
        state.noteDismissedDialog(
          guest,
          { ...dismissed, message: redactBrowserText(dismissed.message) },
          'unreachable'
        );
      } else onConsoleApiCalled(state, guest, params, sessionId);
    },
    'Log.entryAdded': ({ guest, params, sessionId, diagnostics }) => {
      const entry = params.entry as { timestamp?: unknown } | undefined;
      if (freshEntry(diagnostics, `${sessionId ?? ''}|log`, entry?.timestamp)) onLogEntryAdded(state, guest, params);
    },
    'Network.loadingFailed': ({ guest, params, sessionId }) => onLoadingFailed(state, guest, params, sessionId),
    'Tracing.dataCollected': ({ diagnostics, params }) => {
      diagnostics.performanceTrace?.trace.add(params.value);
    },
    'Tracing.tracingComplete': ({ diagnostics }) => {
      diagnostics.performanceTrace?.resolveComplete();
    },
    // Target.targetCrashed is not routed: it is browser-level and only sent
    // for discovered targets, and nothing here enables Target.setDiscoverTargets.
    'Inspector.targetCrashed': targetCrashed,
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
