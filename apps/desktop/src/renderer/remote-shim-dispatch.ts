// Inbound frame dispatch: one entry point that routes every decoded frame to
// its lane.
import type {
  DesktopAgentPoolRow,
  DesktopBrowserImportProgress,
  DesktopBrowserOpenRequest,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
  DesktopLspDiagnosticEvent,
  DesktopLspStatusEvent,
  DesktopSessionSummary,
  DesktopSessionStateUpdate,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../shared/contract';
import { type CodedErrorParams, codedErrorParams } from '../shared/coded-error';
import { readSettingsChange, SETTINGS_CHANGED_EVENT, UPDATER_STATE_EVENT } from '../shared/settings-changed';
import { ORCHESTRATION_MODE_EVENT, readOrchestrationModeChange } from '../shared/orchestration-mode';
import { BROWSER_APPROVAL_SESSIONS_EVENT, readBrowserApprovalSessions } from '../shared/browser-approval-sessions';
import { isRemotePaintProbe } from '../shared/remote-performance';
import { RELAY_ROUTING_CAPS_EVENT, readRelayPayloadRejection } from '../shared/remote-payload-limit';
import { createSnapshotDeltaDecoder } from '../main/state-delta';
import { markCompactPayload } from './remote-compact-frames';
import { VIEW_BASELINE_EVENT } from '../shared/remote-view-baseline';
import {
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionState,
  takeRemoteConnectionTimeline,
} from './remote-connection-state';

/** The relay's cleartext notice that this phone's PC leg is gone. */
const REMOTE_DESKTOP_GONE_NOTICE = 'desktop-gone';
import type { RemoteShimContext } from './remote-shim-state';
import { ACTIVITY_RAIL_PINS_EVENT, readActivityRailPinsState } from '../shared/activity-rail-pins';
import {
  REMOTE_BROWSER_FRAME_EVENT,
  REMOTE_BROWSER_IMPORT_PROGRESS_EVENT,
  REMOTE_BROWSER_OPEN_EVENT,
  REMOTE_BROWSER_TABS_EVENT,
} from '../shared/remote-browser';
import { PROVIDER_MODELS_EVENT, readProviderModelsChange } from '../shared/provider-models';
import { REMOTE_WEBRTC_SIGNAL_EVENT, readRemoteWebrtcDesktopSignal } from '../shared/remote-webrtc';
import { readTerminalActivityEvent } from '../shared/terminal-activity';
import { REMOTE_TERMINAL_RUN_EVENT, readRemoteTerminalRun } from '../shared/terminal-command';
import { type DesktopVisualizeEvent, REMOTE_VISUALIZE_CHANGED_EVENT } from '../shared/visualize';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Shape check for a pushed live frame; a malformed one is dropped. */
function readRemoteBrowserStreamFrame(value: unknown): DesktopRemoteBrowserStreamFrame | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Partial<DesktopRemoteBrowserStreamFrame>;
  if (typeof frame.sessionId !== 'string' || !frame.sessionId) return null;
  if (typeof frame.documentId !== 'string' || !frame.documentId) return null;
  if (!Number.isSafeInteger(frame.seq)) return null;
  if (!finite(frame.width) || !finite(frame.height) || !finite(frame.viewportWidth) || !finite(frame.viewportHeight)) {
    return null;
  }
  if (typeof frame.url !== 'string' || typeof frame.title !== 'string') return null;
  if (frame.image !== undefined) {
    const image = frame.image as { mimeType?: unknown; data?: unknown };
    if (!image || (image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/png')) return null;
    if (typeof image.data !== 'string') return null;
  }
  if (frame.dialog !== undefined) {
    const dialog = frame.dialog as { id?: unknown; type?: unknown; message?: unknown; defaultPrompt?: unknown };
    if (!dialog || typeof dialog.id !== 'string' || typeof dialog.type !== 'string') return null;
    if (typeof dialog.message !== 'string') return null;
    if (dialog.defaultPrompt !== undefined && typeof dialog.defaultPrompt !== 'string') return null;
  }
  return frame as DesktopRemoteBrowserStreamFrame;
}

/** Shape check for a pushed tab list; malformed rows are dropped. */
function readRemoteBrowserTabs(value: unknown): DesktopRemoteBrowserTab[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (row): row is DesktopRemoteBrowserTab =>
        Boolean(row) && typeof row.id === 'string' && typeof row.title === 'string' && typeof row.url === 'string'
    )
    .map((row) => ({ id: row.id, title: row.title, url: row.url, loading: row.loading === true }));
}

export const installRemoteDispatch = (ctx: RemoteShimContext): void => {
  /** Fan a push out to one lane's listeners. A faulting renderer listener
   *  must never stop the frame from reaching the rest. */
  const fanOut = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        /* renderer listener fault */
      }
    }
  };

  const dispatchState = (snapshot: SessionSnapshot): void => fanOut(ctx.stateListeners, snapshot);

  const handleMessage = (
    frame: Record<string, unknown>,
    /** Whether this frame arrived over an authenticated channel. Required, so
     *  every call site states it: on a non-E2EE connection clear relay data
     *  reaches this same handler and must not be trusted with victim
     *  selection. */
    authenticated: boolean
  ): void => {
    // Any inbound frame proves the socket is alive to the keepalive; only a
    // pong answers a wake probe. Pong frames carry nothing else.
    ctx.awaitingPong = false;
    if ('pong' in frame) {
      ctx.answerWakeProbe();
      return;
    }
    if (frame.event === VIEW_BASELINE_EVENT) {
      if (!authenticated) return;
      try {
        handleMessage(ctx.viewBaselines.restore(frame.payload), true);
      } catch (error) {
        // Never acknowledge a recovery with missing data. Redial without
        // cached claims; the existing recovery path requests full baselines.
        ctx.viewBaselines.clear();
        throw error;
      }
      return;
    }
    let message = frame;
    if (frame.e === 'S') {
      // Compact app-state push: same payload, envelope reduced to two keys.
      const wire = frame.w;
      markCompactPayload(wire);
      message = { event: 'state', payload: wire };
    } else if (frame.e === 'T') {
      const expanded = ctx.compactFrames.expand(frame);
      if (!expanded) {
        // This browser's handle map disagrees with the desktop's. Only a fresh
        // handshake rebuilds both sides, and the reconnect loop performs one.
        try {
          ctx.socket?.close();
        } catch {
          /* reconnect loop takes over */
        }
        return;
      }
      message = expanded;
    }
    // Relay hint: a state push was dropped for this leg (background tab, slow
    // link). The next patch would expose the gap, but a finished turn sends
    // no next patch — ask for a full snapshot now.
    if ('resync' in message) {
      ctx.requestResync();
      return;
    }
    if (typeof message.id === 'number') {
      // Before the caller lookup: a call that timed out here still held the
      // PC's frame budget until this answer.
      ctx.settleCallCredit(message.id);
      const entry = ctx.pending.get(message.id);
      if (!entry) return;
      ctx.pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value);
      else {
        const failure: Error & { code?: string; details?: CodedErrorParams } = new Error(
          typeof message.error === 'string' && message.error ? message.error : 'remote call failed.'
        );
        // Transport pass-through: the main side puts an errored call's `code`
        // on the frame (remote-methods.ts `RemoteFrameResponse.errorCode`)
        // because JSON drops custom Error properties. Putting it back here
        // keeps a remote caller on the same contract as an in-process one.
        if (typeof message.errorCode === 'string' && message.errorCode) {
          failure.code = message.errorCode;
        }
        const params = codedErrorParams(message.errorCode, message.errorParams);
        if (params) failure.details = params;
        entry.reject(failure);
      }
      return;
    }
    // The desktop declined to send a frame (or was told the relay refused
    // one). Read AFTER the response branch above, so an ordinary call error can
    // never be mistaken for one; it carries no state, so it never resyncs.
    const rejectedPayload = readRelayPayloadRejection(message, authenticated);
    if (rejectedPayload) {
      // Only the desktop names a call here, and only one it finished with.
      if (rejectedPayload.callId !== null) ctx.settleCallCredit(rejectedPayload.callId);
      ctx.limits.applyRelayPayloadRejection(rejectedPayload);
      return;
    }
    // The relay changed this leg's ceilings mid-connection and the desktop
    // forwarded the new ones. Applied at once, so the very next frame is
    // measured against the ceiling now in force and fails HERE, naming its own
    // call, instead of being refused at the relay where nothing can attribute
    // it. Authenticated only: what this leg may put on the wire is exactly the
    // decision a cleartext frame must never be able to move.
    if (message.event === RELAY_ROUTING_CAPS_EVENT) {
      if (authenticated && message.payload && typeof message.payload === 'object') {
        ctx.limits.learnRoutingCaps(message.payload as Record<string, unknown>);
      }
      return;
    }
    if (message.event === 'state') {
      const snapshot = ctx.applyStatePayload(message.payload ?? null);
      if (snapshot !== null) dispatchState(snapshot);
    } else if (message.event === 'sessions') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopSessionSummary[] }
        : ctx.sessionsDecoder.decode(message.payload);
      if (!decoded.ok) {
        reportRemoteConnectionIssue('sessions-gap');
        ctx.requestResync();
        return;
      }
      ctx.sessionsCatalog.publish(decoded.items ?? []);
      ctx.rosterCache.observe(message.payload);
    } else if (message.event === 'agentPool') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopAgentPoolRow[] }
        : ctx.agentPoolDecoder.decode(message.payload);
      if (!decoded.ok) {
        reportRemoteConnectionIssue('agents-gap');
        ctx.requestResync();
        return;
      }
      ctx.agentsCatalog.publish(decoded.items ?? []);
    } else if (message.event === 'sessionState') {
      const payload = message.payload as DesktopSessionStateUpdate & {
        wire?: unknown;
        perfProbe?: unknown;
      };
      if (!payload || typeof payload !== 'object' || !String(payload.sessionId || '')) return;
      const receivedAt = performance.now();
      let update: DesktopSessionStateUpdate = payload;
      if (Object.hasOwn(payload, 'wire')) {
        let decoder = ctx.sessionStateDecoders.get(payload.sessionId);
        if (!decoder) {
          decoder = createSnapshotDeltaDecoder();
          ctx.sessionStateDecoders.set(payload.sessionId, decoder);
        }
        const decoded = decoder.decode(payload.wire);
        if (!decoded.ok) {
          reportRemoteConnectionIssue('transcript-gap');
          ctx.requestResync();
          return;
        }
        update = {
          sessionId: payload.sessionId,
          snapshot: decoded.snapshot as SessionSnapshot,
          frameSource: payload.frameSource,
          ...(payload.laneEnd ? { laneEnd: payload.laneEnd } : {}),
          ...(typeof payload.contentRevision === 'number' ? { contentRevision: payload.contentRevision } : {}),
        };
        if (update.snapshot === null) ctx.sessionStateDecoders.delete(payload.sessionId);
      }
      ctx.sessionInbox.publish(update);
      const timeline = update.snapshot ? takeRemoteConnectionTimeline() : '';
      if (timeline) ctx.fire('reportConnectionTimeline', [timeline]);
      if (isRemotePaintProbe(payload.perfProbe)) {
        const probe = payload.perfProbe;
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => {
            const receiveToPaintMs = performance.now() - receivedAt;
            console.info(
              `[mixdog-remote-perf] session=${payload.sessionId}` + ` receive-to-paint=${receiveToPaintMs.toFixed(1)}ms`
            );
            ctx.fire('remotePerfPaint', [probe.id, receiveToPaintMs]);
          })
        );
      }
    } else if (message.event === ACTIVITY_RAIL_PINS_EVENT) {
      if (!authenticated) return;
      const state = readActivityRailPinsState(message.payload);
      if (state) fanOut(ctx.activityRailPinsListeners, state);
    } else if (message.event === PROVIDER_MODELS_EVENT) {
      if (!authenticated) return;
      const change = readProviderModelsChange(message.payload);
      if (change) fanOut(ctx.providerModelsListeners, change);
    } else if (message.event === SETTINGS_CHANGED_EVENT) {
      if (!authenticated) return;
      const change = readSettingsChange(message.payload);
      if (change) fanOut(ctx.settingsChangedListeners, change);
    } else if (message.event === ORCHESTRATION_MODE_EVENT) {
      if (!authenticated) return;
      const change = readOrchestrationModeChange(message.payload);
      if (change) fanOut(ctx.orchestrationModeListeners, change);
    } else if (message.event === UPDATER_STATE_EVENT) {
      if (!authenticated) return;
      const state = message.payload as DesktopUpdaterState | null;
      if (state && typeof state === 'object' && typeof state.status === 'string') {
        fanOut(ctx.updaterListeners, state);
      }
    } else if (message.event === BROWSER_APPROVAL_SESSIONS_EVENT) {
      if (!authenticated) return;
      const ids = readBrowserApprovalSessions(message.payload);
      if (!ids) return;
      ctx.browserApprovalSessionIds = ids;
      fanOut(ctx.browserApprovalSessionListeners, ids);
    } else if (message.event === REMOTE_BROWSER_FRAME_EVENT) {
      if (!authenticated) return;
      const frame = readRemoteBrowserStreamFrame(message.payload);
      if (frame) fanOut(ctx.remoteBrowserFrameListeners, frame);
    } else if (message.event === REMOTE_WEBRTC_SIGNAL_EVENT) {
      if (!authenticated) return;
      const signal = readRemoteWebrtcDesktopSignal(message.payload);
      if (signal) fanOut(ctx.remoteBrowserWebrtcListeners, signal);
    } else if (message.event === REMOTE_BROWSER_TABS_EVENT) {
      if (!authenticated) return;
      const tabs = readRemoteBrowserTabs(message.payload);
      if (tabs) fanOut(ctx.remoteBrowserTabListeners, tabs);
    } else if (message.event === REMOTE_BROWSER_IMPORT_PROGRESS_EVENT) {
      if (!authenticated) return;
      const progress = message.payload as DesktopBrowserImportProgress | null;
      if (progress && typeof progress === 'object' && typeof progress.jobId === 'string') {
        fanOut(ctx.browserImportProgressListeners, progress);
      }
    } else if (message.event === REMOTE_BROWSER_OPEN_EVENT) {
      if (!authenticated) return;
      const request = message.payload as DesktopBrowserOpenRequest | null;
      if (request && typeof request === 'object' && typeof request.sessionId === 'string' && request.sessionId) {
        fanOut(ctx.browserOpenListeners, request);
      }
    } else if (message.event === REMOTE_TERMINAL_RUN_EVENT) {
      if (!authenticated) return;
      const request = readRemoteTerminalRun(message.payload);
      if (request) fanOut(ctx.terminalRunListeners, request);
    } else if (message.event === REMOTE_VISUALIZE_CHANGED_EVENT) {
      if (!authenticated) return;
      const event = message.payload as DesktopVisualizeEvent | null;
      const state = event?.state;
      if (
        event &&
        typeof event.sessionId === 'string' &&
        event.sessionId &&
        state &&
        typeof state === 'object' &&
        Array.isArray(state.tabs)
      ) {
        // Only state and reveal: web URLs reach a client through the browser handoff.
        fanOut(ctx.visualizeListeners, {
          sessionId: event.sessionId,
          state: { ...state, sessionId: event.sessionId },
          ...(event.reveal === true ? { reveal: true } : {}),
          ...(event.reveal === true && typeof event.tab === 'string' && event.tab ? { tab: event.tab } : {}),
        });
      }
    } else if (message.event === 'termData') {
      const payload = (message.payload ?? {}) as { id?: unknown; data?: unknown };
      fanOut(ctx.termListeners, { id: String(payload.id || ''), data: String(payload.data ?? '') });
    } else if (message.event === 'termSizeOwner') {
      const payload = (message.payload ?? {}) as { id?: unknown; cols?: unknown; rows?: unknown; own?: unknown };
      fanOut(ctx.termSizeOwnerListeners, {
        id: String(payload.id || ''),
        cols: Number(payload.cols) || 0,
        rows: Number(payload.rows) || 0,
        own: payload.own === true,
      });
    } else if (message.event === 'termActivity') {
      const event = readTerminalActivityEvent(message.payload);
      if (event) fanOut(ctx.termActivityListeners, event);
    } else if (message.event === 'folderChanged') {
      const dir = String(message.payload || '');
      if (!dir) return;
      fanOut(ctx.folderChangeListeners, dir);
    } else if (message.event === 'lspDiagnostics') {
      const payload = message.payload as DesktopLspDiagnosticEvent;
      if (!payload || typeof payload !== 'object') return;
      fanOut(ctx.lspDiagnosticsListeners, payload);
    } else if (message.event === 'lspStatus') {
      const payload = message.payload as DesktopLspStatusEvent;
      if (!payload || typeof payload !== 'object') return;
      fanOut(ctx.lspStatusListeners, payload);
    }
  };

  /** The relay parked this socket: the PC's leg is gone, so nothing sent on
   *  this channel can be answered. The calls it still owed fail as interrupted
   *  and return their credits, and the socket stays open for the PC's next
   *  handshake (the challenge path re-keys it in place). No error: the state
   *  is the ordinary reconnecting one. The relay repeats the notice, so this
   *  is idempotent. Cleartext and unauthenticated, like every resync: it can
   *  only make this side wait, never pick a call or a victim. */
  const parkUntilDesktopReturns = (): void => {
    const ws = ctx.socket;
    if (!ws) return;
    if (ctx.connectionReady) {
      ctx.connectionReady = false;
      ctx.viewSync.close();
      ctx.resetDeltaState();
    }
    setRemoteConnectionState('reconnecting');
    const failure = remoteConnectionInterruptedError();
    for (const entry of [...ctx.pending.values()]) entry.reject(failure);
    ctx.pending.clear();
    ctx.retireCallCredits(ws);
  };

  /** A cleartext `resync` off the socket. A relay refusal rides `resync` on
   *  purpose: it is the one cleartext key this browser acts on BEFORE
   *  decryption, so it can never reach decryptJson. It is also
   *  unauthenticated, so it may report a size and a ceiling but must never
   *  select a victim — it surfaces the error and tightens the pre-send check.
   *  An unrelated resync hint yields no rejection at all. */
  const handleClearResync = (clear: Record<string, unknown>): void => {
    if (clear.resync === REMOTE_DESKTOP_GONE_NOTICE) {
      parkUntilDesktopReturns();
      return;
    }
    const rejected = readRelayPayloadRejection(clear, false);
    if (rejected) ctx.limits.applyRelayPayloadRejection(rejected);
    ctx.requestResync();
  };

  Object.assign(ctx, { fanOut, dispatchState, handleMessage, handleClearResync });
};
