import type { BrowserWindow, IpcMain, IpcMainEvent, PowerMonitor } from 'electron';
import {
  DESKTOP_IPC,
  type DesktopSessionStateUpdate,
  type DesktopUpdaterState,
  type SessionSnapshot,
} from '../shared/contract';
import { isSessionId, requiredSessionId, requiredSessionIds } from './desktop-state';
import { SETTINGS_CHANGED_EVENT } from '../shared/settings-changed';
import { reportTranscriptRead } from '../shared/transcript-read-diagnostics';
import type { DesktopService } from './desktop-service-contract';
import { requiredTranscriptItemLimit } from './ipc-validation';
import {
  createSessionReadWindow,
  createSnapshotDeltaEncoder,
  isNoDelta,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import type { IpcHandle as Handle } from './ipc';

export interface DesktopUpdater {
  getState(): DesktopUpdaterState;
  subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
  check(): Promise<DesktopUpdaterState>;
  install(): Promise<void>;
}

interface DesktopStateBridgeOptions {
  window: BrowserWindow;
  host: DesktopService;
  ipcMain: Pick<IpcMain, 'on' | 'removeListener'>;
  handle: Handle;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  updater?: DesktopUpdater;
}

type SessionProvenance = Pick<DesktopSessionStateUpdate, 'frameSource' | 'contentRevision'>;

// A read's frame travels the daemon's session stream while its reply travels
// the request channel, so the reply can land first and close the read window.
// The frame still carries the read's trace id; it is admitted for this long.
const REQUESTED_READ_FRAME_GRACE_MS = 10_000;

export class DesktopStateBridge {
  private readonly stateEncoder = createSnapshotDeltaEncoder();
  private readonly visibleSessionIds = new Set<string>();
  private readonly requestedReads = createSessionReadWindow();
  private readonly requestedReadTraces = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly sessionEncoders = new Map<string, SnapshotDeltaEncoder>();
  private readonly latestSessionStates = new Map<string, SessionSnapshot>();
  private readonly latestSessionProvenance = new Map<string, SessionProvenance>();
  private readonly unsubscribeState: () => void;
  private readonly unsubscribeSessions: () => void;
  private readonly unsubscribeAgentPool: () => void;
  private readonly unsubscribeSessionStates: () => void;
  private readonly unsubscribeUpdater: () => void;
  private readonly unsubscribeDesktopEvents: () => void;
  private disposed = false;

  constructor(private readonly options: DesktopStateBridgeOptions) {
    const { handle, host, updater } = options;
    handle(DESKTOP_IPC.setVisibleSessions, (_event, sessionIds) => this.setVisibleSessions(sessionIds));
    // Reads live beside the visibility filter: the frame a read publishes
    // must pass it even when no pane shows the session yet.
    handle(DESKTOP_IPC.prefetchSession, (_event, sessionId, itemLimit, readTraceId) => {
      const id = requiredSessionId(sessionId);
      const limit = requiredTranscriptItemLimit(itemLimit);
      const traceId = typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined;
      if (traceId) this.rememberRequestedReadTrace(traceId, id);
      return this.requestedReads.run(id, () => host.prefetchSession(id, limit, traceId));
    });
    handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());
    handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
    handle(
      DESKTOP_IPC.checkForDesktopUpdate,
      () => updater?.check() ?? Promise.resolve({ status: 'disabled' } as const)
    );
    handle(DESKTOP_IPC.showDesktopUpdate, () => this.installDesktopUpdate());

    this.unsubscribeState = host.subscribe(this.sendEngineState);
    this.unsubscribeSessions =
      typeof host.subscribeSessions === 'function'
        ? host.subscribeSessions((sessions) => this.send(DESKTOP_IPC.sessionsChanged, sessions))
        : () => {};
    this.unsubscribeAgentPool =
      typeof host.subscribeAgentPool === 'function'
        ? host.subscribeAgentPool((agents) => this.send(DESKTOP_IPC.agentPoolChanged, agents))
        : () => {};
    this.unsubscribeSessionStates = host.subscribeSessionStates(this.sendSessionState);
    this.unsubscribeUpdater = updater?.subscribe((state) => this.send(DESKTOP_IPC.updaterState, state)) ?? (() => {});
    this.unsubscribeDesktopEvents =
      host.subscribeDesktopEvents?.(({ name, value }) => {
        if (name === 'folder-changed') this.send(DESKTOP_IPC.folderChanged, value);
        else if (name === 'activity-rail-pins-changed') this.send(DESKTOP_IPC.activityRailPinsChanged, value);
        else if (name === 'provider-models-changed') this.send(DESKTOP_IPC.providerModelsChanged, value);
        else if (name === SETTINGS_CHANGED_EVENT) this.send(DESKTOP_IPC.settingsChanged, value);
        else if (name === 'lsp-diagnostics') this.send(DESKTOP_IPC.lspDiagnostics, value);
        else if (name === 'lsp-status') this.send(DESKTOP_IPC.lspStatus, value);
        else if (name === 'relay-payload-refused') {
          this.send(DESKTOP_IPC.relayPayloadRefused, value);
        } else if (name === 'remote-client-claim') {
          // Delivery stays global, but only Settings → Connection renders it.
          this.send(DESKTOP_IPC.remoteClientClaim, value);
        }
      }) ?? (() => {});

    options.ipcMain.on(DESKTOP_IPC.stateResync, this.onStateResync);
    options.ipcMain.on(DESKTOP_IPC.sessionStateResync, this.onSessionStateResync);
    if (typeof options.powerMonitor?.on === 'function') {
      options.powerMonitor.on('resume', this.onSystemResume);
    }
  }

  private send(channel: string, value: unknown): void {
    const { window } = this.options;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, value);
    }
  }

  private readonly sendEngineState = (snapshot: SessionSnapshot): void => {
    const wire = this.stateEncoder.encode(snapshot);
    if (!isNoDelta(wire)) this.send(DESKTOP_IPC.state, wire);
  };

  private readonly sendSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update.sessionId || '');
    const answersRequestedRead = this.takeRequestedReadTrace(sessionId, update.readTraceId);
    if (
      !sessionId ||
      (!answersRequestedRead &&
        !shouldPublishSessionState(sessionId, update.snapshot, this.visibleSessionIds, this.requestedReads))
    ) {
      reportTranscriptRead(sessionId, update.readTraceId, 'ipc-hidden');
      return;
    }
    let encoder = this.sessionEncoders.get(sessionId);
    // The preload decodes with this same build, so older-history pages travel as prepends.
    if (!encoder) encoder = createSnapshotDeltaEncoder({ prepend: true });
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
      console.error(
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

  private async installDesktopUpdate(): Promise<DesktopUpdaterState> {
    const { updater } = this.options;
    const current = updater?.getState() ?? ({ status: 'disabled' } as const);
    if (current.status !== 'ready' || !updater) return current;
    await updater.install();
    return updater.getState();
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
    if (!snapshot) return;
    const provenance = this.latestSessionProvenance.get(sessionId);
    if (!provenance) return;
    this.sessionEncoders.get(sessionId)?.reset();
    this.sendSessionState({
      sessionId,
      snapshot,
      ...provenance,
    });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { ipcMain, powerMonitor } = this.options;
    this.unsubscribeState();
    this.unsubscribeSessions();
    this.unsubscribeAgentPool();
    this.unsubscribeSessionStates();
    this.unsubscribeUpdater();
    this.unsubscribeDesktopEvents();
    this.sessionEncoders.clear();
    this.latestSessionStates.clear();
    this.latestSessionProvenance.clear();
    this.visibleSessionIds.clear();
    for (const { timer } of this.requestedReadTraces.values()) clearTimeout(timer);
    this.requestedReadTraces.clear();
    if (typeof powerMonitor?.removeListener === 'function') {
      powerMonitor.removeListener('resume', this.onSystemResume);
    }
    ipcMain.removeListener(DESKTOP_IPC.stateResync, this.onStateResync);
    ipcMain.removeListener(DESKTOP_IPC.sessionStateResync, this.onSessionStateResync);
  }
}
