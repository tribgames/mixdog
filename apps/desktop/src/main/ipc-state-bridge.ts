import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  PowerMonitor,
} from 'electron';
import {
  DESKTOP_IPC,
  type DesktopSessionStateUpdate,
  type DesktopUpdaterState,
  type SessionSnapshot,
} from '../shared/contract';
import { requiredSessionId } from './desktop-state';
import type { DesktopService } from './desktop-service-contract';
import {
  createSnapshotDeltaEncoder,
  isNoDelta,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

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

type SessionProvenance = Pick<
  DesktopSessionStateUpdate,
  'frameSource' | 'contentRevision'
>;

export class DesktopStateBridge {
  private readonly stateEncoder = createSnapshotDeltaEncoder();
  private readonly visibleSessionIds = new Set<string>();
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
    handle(DESKTOP_IPC.setVisibleSessions, (_event, sessionIds) =>
      this.setVisibleSessions(sessionIds));
    handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());
    handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
    handle(DESKTOP_IPC.checkForDesktopUpdate, () =>
      updater?.check() ?? Promise.resolve({ status: 'disabled' } as const));
    handle(DESKTOP_IPC.showDesktopUpdate, () => this.installDesktopUpdate());

    this.unsubscribeState = host.subscribe(this.sendEngineState);
    this.unsubscribeSessions = typeof host.subscribeSessions === 'function'
      ? host.subscribeSessions((sessions) => this.send(DESKTOP_IPC.sessionsChanged, sessions))
      : () => {};
    this.unsubscribeAgentPool = typeof host.subscribeAgentPool === 'function'
      ? host.subscribeAgentPool((agents) => this.send(DESKTOP_IPC.agentPoolChanged, agents))
      : () => {};
    this.unsubscribeSessionStates = host.subscribeSessionStates(this.sendSessionState);
    this.unsubscribeUpdater = updater?.subscribe((state) =>
      this.send(DESKTOP_IPC.updaterState, state)) ?? (() => {});
    this.unsubscribeDesktopEvents = host.subscribeDesktopEvents?.(({ name, value }) => {
      if (name === 'folder-changed') this.send(DESKTOP_IPC.folderChanged, value);
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
    if (!sessionId
      || !shouldPublishSessionState(sessionId, update.snapshot, this.visibleSessionIds)) {
      return;
    }
    let encoder = this.sessionEncoders.get(sessionId);
    if (!encoder) encoder = createSnapshotDeltaEncoder();
    if (update.snapshot === null) {
      this.send(DESKTOP_IPC.sessionState, {
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number'
          ? { contentRevision: update.contentRevision }
          : {}),
      });
      this.sessionEncoders.delete(sessionId);
      this.latestSessionStates.delete(sessionId);
      this.latestSessionProvenance.delete(sessionId);
      return;
    }
    this.sessionEncoders.set(sessionId, encoder);
    this.latestSessionStates.delete(sessionId);
    this.latestSessionStates.set(sessionId, update.snapshot);
    this.latestSessionProvenance.set(sessionId, {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
    this.send(DESKTOP_IPC.sessionState, {
      sessionId,
      wire: encoder.encode(update.snapshot),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
  };

  private async setVisibleSessions(value: unknown): Promise<boolean> {
    if (!Array.isArray(value) || value.length > 256) {
      throw new TypeError('sessionIds must be a bounded array.');
    }
    const normalized = [...new Set(value.map((sessionId) => requiredSessionId(sessionId)))];
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
      },
    );
    if (released.length > 0) {
      console.error('[mixdog-lane] baseline released'
        + ` count=${released.length} visible=${normalized.length}`
        + ` ids=${released.slice(0, 6).map((sessionId) => sessionId.slice(-8)).join(',')}`);
    }
    return (await this.options.host.setVisibleSessions?.(normalized)) === true;
  }

  private async installDesktopUpdate(): Promise<DesktopUpdaterState> {
    const { updater } = this.options;
    const current = updater?.getState() ?? { status: 'disabled' } as const;
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
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !this.latestSessionStates.has(sessionId)) return;
    const provenance = this.latestSessionProvenance.get(sessionId);
    if (!provenance) return;
    this.sessionEncoders.get(sessionId)?.reset();
    this.sendSessionState({
      sessionId,
      snapshot: this.latestSessionStates.get(sessionId)!,
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
    if (typeof powerMonitor?.removeListener === 'function') {
      powerMonitor.removeListener('resume', this.onSystemResume);
    }
    ipcMain.removeListener(DESKTOP_IPC.stateResync, this.onStateResync);
    ipcMain.removeListener(DESKTOP_IPC.sessionStateResync, this.onSessionStateResync);
  }
}
