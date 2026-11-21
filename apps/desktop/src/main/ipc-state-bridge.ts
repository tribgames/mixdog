import type { BrowserWindow, IpcMainEvent, PowerMonitor } from 'electron';
import {
  CONVERSATION_IMPORT_PROGRESS_EVENT,
  DESKTOP_IPC,
  type DesktopSessionStateUpdate,
  type DesktopUpdaterState,
  type SessionSnapshot,
} from '../shared/contract';
import { isSessionId, requiredSessionId, requiredSessionIds } from './desktop-state';
import { registerDesktopNoticeSink } from '../shared/core-src/runtime/shared/desktop-notice-host.mjs';
import { reportTranscriptRead } from '../shared/transcript-read-diagnostics';
import type { DesktopService } from './desktop-service-contract';
import { requiredTranscriptHistoryRequest, requiredTranscriptItemLimit } from './ipc-validation';
import {
  createSessionReadWindow,
  createSnapshotDeltaEncoder,
  isNoDelta,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import type { DesktopIpcMain, IpcHandle as Handle } from './ipc';

export interface DesktopUpdater {
  getState(): DesktopUpdaterState;
  subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
  check(): Promise<DesktopUpdaterState>;
  install(confirmed?: boolean): Promise<void>;
}

interface DesktopStateBridgeOptions {
  window: BrowserWindow;
  host: DesktopService;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  handle: Handle;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  updater?: DesktopUpdater;
  directCore?: boolean;
}

/** Window events still carried by the host preload, with state IPC for non-direct clients only. */
export class DesktopStateBridge {
  private readonly legacyState?: LegacyDesktopStateBridge;
  private readonly unsubscribeUpdater: () => void;
  private readonly unsubscribeDesktopEvents: () => void;
  private readonly unregisterNotices: () => void;
  private disposed = false;

  constructor({ window, host, ipcMain, handle, powerMonitor, updater, directCore }: DesktopStateBridgeOptions) {
    const send = (channel: string, value: unknown): boolean => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
      window.webContents.send(channel, value);
      return true;
    };
    handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
    handle(
      DESKTOP_IPC.checkForDesktopUpdate,
      () => updater?.check() ?? Promise.resolve({ status: 'disabled' } as const)
    );
    handle(DESKTOP_IPC.showDesktopUpdate, async (_event, confirmed) => {
      const current = updater?.getState() ?? ({ status: 'disabled' } as const);
      if (current.status !== 'ready' || !updater) return current;
      await updater.install(confirmed === true);
      return updater.getState();
    });

    if (!directCore) {
      this.legacyState = new LegacyDesktopStateBridge({ window, host, ipcMain, handle, powerMonitor }, send);
    }
    this.unsubscribeUpdater = updater?.subscribe((state) => send(DESKTOP_IPC.updaterState, state)) ?? (() => {});
    // Other desktop feeds reach direct windows on their own core connection; import progress still uses the host preload.
    this.unsubscribeDesktopEvents =
      host.subscribeDesktopEvents?.(({ name, value }) => {
        if (name === CONVERSATION_IMPORT_PROGRESS_EVENT) send(DESKTOP_IPC.conversationImportProgress, value);
      }) ?? (() => {});
    // The service's notices (held by its client until a window listens) and
    // this process's own (its secure storage).
    const unsubscribeServiceNotices =
      host.subscribeDesktopNotices?.((notice) => send(DESKTOP_IPC.desktopNotice, notice)) ?? (() => {});
    const unregisterOwnNotices = registerDesktopNoticeSink((notice) => send(DESKTOP_IPC.desktopNotice, notice));
    this.unregisterNotices = () => {
      unsubscribeServiceNotices();
      unregisterOwnNotices();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.legacyState?.dispose();
    this.unsubscribeUpdater();
    this.unsubscribeDesktopEvents();
    this.unregisterNotices();
  }
}

type SessionProvenance = Pick<DesktopSessionStateUpdate, 'frameSource' | 'contentRevision'>;
type LegacyStateOptions = Pick<DesktopStateBridgeOptions, 'window' | 'host' | 'ipcMain' | 'handle' | 'powerMonitor'>;

// A read's frame travels the daemon's session stream while its reply travels
// the request channel, so the reply can land first and close the read window.
// The frame still carries the read's trace id; it is admitted for this long.
const REQUESTED_READ_FRAME_GRACE_MS = 10_000;

const SESSION_RECOVERY_COALESCE_MS = 3_000;

class LegacyDesktopStateBridge {
  private readonly stateEncoder = createSnapshotDeltaEncoder();
  private readonly visibleSessionIds = new Set<string>();
  private readonly requestedReads = createSessionReadWindow();
  private readonly requestedReadTraces = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly pendingRecoveries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionEncoders = new Map<string, SnapshotDeltaEncoder>();
  private readonly latestSessionStates = new Map<string, SessionSnapshot>();
  private readonly latestSessionProvenance = new Map<string, SessionProvenance>();
  private readonly unsubscribeState: () => void;
  private readonly unsubscribeSessionStates: () => void;
  constructor(
    private readonly options: LegacyStateOptions,
    private readonly send: (channel: string, value: unknown) => void
  ) {
    const { handle, host } = options;
    handle(DESKTOP_IPC.setVisibleSessions, (_event, sessionIds) => this.setVisibleSessions(sessionIds));
    // Reads live beside the visibility filter: the frame a read publishes
    // must pass it even when no pane shows the session yet.
    handle(DESKTOP_IPC.prefetchSession, (_event, sessionId, itemLimit, readTraceId, options) => {
      const id = requiredSessionId(sessionId);
      const limit = requiredTranscriptItemLimit(itemLimit);
      const traceId = typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined;
      const retry = (options as { retry?: unknown } | null | undefined)?.retry === true ? { retry: true } : undefined;
      if (traceId) this.rememberRequestedReadTrace(traceId, id);
      return this.requestedReads.run(id, () => host.prefetchSession(id, limit, traceId, retry));
    });
    handle(DESKTOP_IPC.readTranscriptHistory, (_event, sessionId, request) => {
      const id = requiredSessionId(sessionId);
      const history = requiredTranscriptHistoryRequest(request);
      if (typeof host.readTranscriptHistory !== 'function') {
        return { items: [], hasOlder: false, hasNewer: false, unsupported: true };
      }
      return host.readTranscriptHistory(id, history);
    });
    handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());

    this.unsubscribeState = host.subscribe(this.sendEngineState);
    this.unsubscribeSessionStates = host.subscribeSessionStates(this.sendSessionState);

    options.ipcMain.on(DESKTOP_IPC.stateResync, this.onStateResync);
    options.ipcMain.on(DESKTOP_IPC.sessionStateResync, this.onSessionStateResync);
    if (typeof options.powerMonitor?.on === 'function') {
      options.powerMonitor.on('resume', this.onSystemResume);
    }
  }

  private readonly sendEngineState = (snapshot: SessionSnapshot): void => {
    const wire = this.stateEncoder.encode(snapshot);
    if (!isNoDelta(wire)) this.send(DESKTOP_IPC.state, wire);
  };

  private readonly sendSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update.sessionId || '');
    const answersRecovery = sessionId ? this.takePendingRecovery(sessionId) : false;
    const answersRequestedRead = this.takeRequestedReadTrace(sessionId, update.readTraceId) || answersRecovery;
    if (
      !sessionId ||
      (!answersRequestedRead &&
        !shouldPublishSessionState(sessionId, update.snapshot, this.visibleSessionIds, this.requestedReads))
    ) {
      reportTranscriptRead(sessionId, update.readTraceId, 'ipc-hidden');
      return;
    }
    let encoder = this.sessionEncoders.get(sessionId);
    // The preload decodes with this same build, so older-history pages travel
    // as prepends and a growing unfinished line as its new text.
    if (!encoder) encoder = createSnapshotDeltaEncoder({ prepend: true, partialAppend: true });
    else if (answersRecovery) encoder.reset();
    if (update.snapshot === null) {
      this.send(DESKTOP_IPC.sessionState, {
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
      });
      this.sessionEncoders.delete(sessionId);
      this.latestSessionStates.delete(sessionId);
      this.latestSessionProvenance.delete(sessionId);
      return;
    }
    this.sessionEncoders.set(sessionId, encoder);
    this.latestSessionStates.set(sessionId, update.snapshot);
    this.latestSessionProvenance.set(sessionId, {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
    });
    const wire = encoder.encode(update.snapshot);
    reportTranscriptRead(sessionId, update.readTraceId, isNoDelta(wire) ? 'ipc-unchanged' : 'ipc-send');
    if (isNoDelta(wire)) return;
    this.send(DESKTOP_IPC.sessionState, {
      sessionId,
      wire,
      ...(update.readTraceId ? { readTraceId: update.readTraceId } : {}),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
    });
  };

  /** One in-flight service recovery per session; the next frame or the timeout ends it. */
  private requestServiceRecovery(sessionId: string): void {
    if (this.pendingRecoveries.has(sessionId) || typeof this.options.host.requestSessionStateResync !== 'function') {
      return;
    }
    const timer = setTimeout(() => this.pendingRecoveries.delete(sessionId), SESSION_RECOVERY_COALESCE_MS);
    timer.unref?.();
    this.pendingRecoveries.set(sessionId, timer);
    this.options.host.requestSessionStateResync(sessionId);
  }

  private takePendingRecovery(sessionId: string): boolean {
    const timer = this.pendingRecoveries.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.pendingRecoveries.delete(sessionId);
    return true;
  }

  private rememberRequestedReadTrace(traceId: string, sessionId: string): void {
    const previous = this.requestedReadTraces.get(traceId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.requestedReadTraces.delete(traceId), REQUESTED_READ_FRAME_GRACE_MS);
    timer.unref?.();
    this.requestedReadTraces.set(traceId, { sessionId, timer });
  }

  /** True once for the frame answering a read this window requested. */
  private takeRequestedReadTrace(sessionId: string, traceId: string | undefined): boolean {
    if (!sessionId || !traceId) return false;
    const pending = this.requestedReadTraces.get(traceId);
    if (!pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    this.requestedReadTraces.delete(traceId);
    return true;
  }

  private async setVisibleSessions(value: unknown): Promise<boolean> {
    const normalized = requiredSessionIds(value);
    this.visibleSessionIds.clear();
    for (const sessionId of normalized) this.visibleSessionIds.add(sessionId);
    const released = releaseHiddenSessionStateEntries(
      this.visibleSessionIds,
      [this.sessionEncoders, this.latestSessionStates, this.latestSessionProvenance],
      (sessionId) => {
        const encoder = this.sessionEncoders.get(sessionId);
        this.send(DESKTOP_IPC.sessionState, {
          sessionId,
          wire: encoder ? encoder.encode(null) : null,
        });
      }
    );
    if (released.length > 0) {
      console.info(
        '[mixdog-lane] baseline released' +
          ` count=${released.length} visible=${normalized.length}` +
          ` ids=${released
            .slice(0, 6)
            .map((sessionId) => sessionId.slice(-8))
            .join(',')}`
      );
    }
    return (await this.options.host.setVisibleSessions?.(normalized)) === true;
  }

  private readonly onStateResync = (event: IpcMainEvent): void => {
    const { window, host } = this.options;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return;
    }
    this.stateEncoder.reset();
    this.sendEngineState(host.getSnapshot());
  };

  private readonly onSystemResume = (): void => {
    this.stateEncoder.reset();
    this.sendEngineState(this.options.host.getSnapshot());
  };

  private readonly onSessionStateResync = (event: IpcMainEvent, value: unknown): void => {
    const { window } = this.options;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return;
    }
    const sessionId = String(value || '');
    if (!isSessionId(sessionId)) return;
    const snapshot = this.latestSessionStates.get(sessionId);
    const provenance = this.latestSessionProvenance.get(sessionId);
    if (!snapshot || !provenance) {
      this.requestServiceRecovery(sessionId);
      return;
    }
    this.sessionEncoders.get(sessionId)?.reset();
    this.sendSessionState({
      sessionId,
      snapshot,
      ...provenance,
    });
  };

  dispose(): void {
    const { ipcMain, powerMonitor } = this.options;
    this.unsubscribeState();
    this.unsubscribeSessionStates();
    this.sessionEncoders.clear();
    this.latestSessionStates.clear();
    this.latestSessionProvenance.clear();
    this.visibleSessionIds.clear();
    for (const { timer } of this.requestedReadTraces.values()) clearTimeout(timer);
    this.requestedReadTraces.clear();
    for (const timer of this.pendingRecoveries.values()) clearTimeout(timer);
    this.pendingRecoveries.clear();
    if (typeof powerMonitor?.removeListener === 'function') {
      powerMonitor.removeListener('resume', this.onSystemResume);
    }
    ipcMain.removeListener(DESKTOP_IPC.stateResync, this.onStateResync);
    ipcMain.removeListener(DESKTOP_IPC.sessionStateResync, this.onSessionStateResync);
  }
}
