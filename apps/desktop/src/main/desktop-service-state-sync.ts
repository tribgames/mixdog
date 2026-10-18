import type { DesktopSessionStateUpdate, SessionSnapshot } from '../shared/contract';
import { reportTranscriptRead } from '../shared/transcript-read-diagnostics';
import type { SessionHost } from './session-host';
import type { DesktopServiceInbound, DesktopServiceOutbound } from './desktop-service-protocol';
import { createSnapshotStateMailbox } from './snapshot-state-mailbox';
import {
  createSessionReadWindow,
  createSnapshotDeltaEncoder,
  isNoDelta,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { synchronizeViewSnapshot } from './view-synchronizer';
import { requiredSessionIds, requiredVisibleSessionVersion } from './desktop-state';

/** Per-session transcript deltas: one encoder per session, the last snapshot it
 *  encoded, and where that snapshot came from. Every session-state frame the
 *  service emits is built here, which is what lets a resync rebuild the same
 *  frame from a reset encoder instead of asking the host again. */
function createSessionStatePublisher(emit: (message: DesktopServiceOutbound) => void) {
  const encoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSnapshots = new Map<string, SessionSnapshot>();
  const latestProvenance = new Map<
    string,
    {
      frameSource: 'live' | 'replay';
      contentRevision?: number;
    }
  >();
  const post = (update: DesktopSessionStateUpdate): void => {
    const { sessionId, snapshot } = update;
    let encoder = encoders.get(sessionId);
    // Main decodes with this same build, so older-history pages travel as
    // prepends and a growing unfinished line as its new text.
    if (!encoder) encoder = createSnapshotDeltaEncoder({ prepend: true, partialAppend: true });
    if (snapshot === null) {
      emit({
        kind: 'session-state',
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
      });
      encoders.delete(sessionId);
      latestSnapshots.delete(sessionId);
      latestProvenance.delete(sessionId);
      return;
    }
    encoders.set(sessionId, encoder);
    latestSnapshots.set(sessionId, snapshot);
    latestProvenance.set(sessionId, update);
    const wire = encoder.encode(snapshot);
    reportTranscriptRead(sessionId, update.readTraceId, isNoDelta(wire) ? 'service-unchanged' : 'service-send');
    if (isNoDelta(wire)) return;
    emit({
      kind: 'session-state',
      sessionId,
      wire,
      ...(update.readTraceId ? { readTraceId: update.readTraceId } : {}),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
    });
  };
  return {
    post,
    /** Drops one session's encoder, so its next frame is a full snapshot. */
    forget(sessionId: string): void {
      encoders.delete(sessionId);
    },
    /** A view sync restarts every lane from a full snapshot. */
    resetEncoders(): void {
      encoders.clear();
    },
    /** Re-sends what this session last published, from a reset encoder. */
    republish(sessionId: string): void {
      const encoder = encoders.get(sessionId);
      const snapshot = latestSnapshots.get(sessionId);
      const provenance = latestProvenance.get(sessionId);
      if (!encoder || snapshot === undefined || !provenance) return;
      encoder.reset();
      post({
        sessionId,
        snapshot,
        ...provenance,
      });
    },
    /** A session the window stopped showing keeps no delta state here. */
    releaseHidden(visibleSessionIds: Set<string>): void {
      releaseHiddenSessionStateEntries(visibleSessionIds, [encoders, latestSnapshots, latestProvenance], (sessionId) =>
        encoders.get(sessionId)?.reset()
      );
    },
    clear(): void {
      encoders.clear();
      latestSnapshots.clear();
      latestProvenance.clear();
    },
  };
}

export interface DesktopServiceStateSync {
  /** `setVisibleSessions`: newest request per daemon-issued client epoch wins. */
  setDeliveryFilter(args: unknown[]): Promise<boolean>;
  /** Release only this client's visibility; other attached desktops stay live. */
  releaseClient(epoch: number): Promise<void>;
  /** The window's own read: its frames pass the filter while `run` is open. */
  runDesktopRead<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  /** State ACK, full view resync and single-lane resync. */
  control(message: DesktopServiceInbound): Promise<void>;
  /** Stops every delivery; a replay still in flight emits nothing more. */
  dispose(): void;
}

/** Everything the service delivers to the window about view state: the
 *  host subscriptions, the acknowledged state mailbox, per-session deltas and
 *  serialized full-view replays. */
export function createDesktopServiceStateSync({
  host,
  emit,
}: {
  host: SessionHost;
  emit(message: DesktopServiceOutbound): void;
}): DesktopServiceStateSync {
  let viewsSyncing = false;
  let viewVersion = 0;
  const visibilitySources = new Map<number, { version: number; sessionIds: string[] }>();
  let serviceClosed = false;
  let viewSyncQueue: Promise<void> = Promise.resolve();
  const visibleSessionIds = new Set<string>();
  const desktopReads = createSessionReadWindow();
  const sessionStates = createSessionStatePublisher(emit);
  const updateVisibleSessions = (): Promise<boolean> => {
    viewVersion += 1;
    visibleSessionIds.clear();
    for (const source of visibilitySources.values()) {
      for (const sessionId of source.sessionIds) visibleSessionIds.add(sessionId);
    }
    sessionStates.releaseHidden(visibleSessionIds);
    return host.setVisibleSessions([...visibleSessionIds]);
  };

  const stateMailbox = createSnapshotStateMailbox<SessionSnapshot>((sequence, wire) => {
    emit({ kind: 'state', sequence, wire });
  });

  const unsubscribeState = host.subscribe((snapshot) => {
    if (!viewsSyncing) stateMailbox.publish(snapshot);
  });
  const unsubscribeSessions = host.subscribeSessions((sessions) => {
    if (!viewsSyncing) emit({ kind: 'sessions', sessions });
  });
  const unsubscribeAgentPool = host.subscribeAgentPool((agents) => {
    if (!viewsSyncing) emit({ kind: 'agent-pool', agents });
  });
  const unsubscribeSessionStates = host.subscribeSessionStates((update) => {
    if (viewsSyncing) {
      reportTranscriptRead(update.sessionId, update.readTraceId, 'service-syncing');
      return;
    }
    if (!shouldPublishSessionState(update.sessionId, update.snapshot, visibleSessionIds, desktopReads)) {
      reportTranscriptRead(update.sessionId, update.readTraceId, 'service-hidden');
      return;
    }
    sessionStates.post(update);
  });
  stateMailbox.publish(host.getSnapshot());
  const synchronizeViews = (): Promise<void> => {
    const run = viewSyncQueue
      .catch(() => undefined)
      .then(async () => {
        let version: number;
        do {
          if (serviceClosed) return;
          version = viewVersion;
          viewsSyncing = true;
          try {
            await host.setVisibleSessions([...visibleSessionIds]);
            await synchronizeViewSnapshot(host, [...visibleSessionIds], (snapshot) => {
              if (serviceClosed) return;
              stateMailbox.reset(snapshot.snapshot);
              sessionStates.resetEncoders();
              for (const update of snapshot.sessionStates) sessionStates.post(update);
              emit({ kind: 'sessions', sessions: snapshot.sessions });
              emit({ kind: 'agent-pool', agents: snapshot.agents });
              viewsSyncing = false;
              if (version === viewVersion) emit({ kind: 'view-sync-complete' });
            });
          } finally {
            viewsSyncing = false;
          }
        } while (version !== viewVersion);
      });
    viewSyncQueue = run;
    return run;
  };

  return {
    async setDeliveryFilter(args: unknown[]): Promise<boolean> {
      const epoch = args[2] === undefined ? 0 : requiredVisibleSessionVersion(args[2]);
      const prior = visibilitySources.get(epoch);
      const version = args[1] === undefined ? (prior?.version ?? 0) : requiredVisibleSessionVersion(args[1]);
      // The daemon retains this adapter across desktop restarts. Fence
      // out-of-order requests within each attachment, not across independent
      // desktops, and keep every active attachment's conversations visible.
      if (args[1] !== undefined && prior && version <= prior.version) return true;
      visibilitySources.set(epoch, { version, sessionIds: requiredSessionIds(args[0]) });
      return updateVisibleSessions();
    },
    async releaseClient(epoch: number): Promise<void> {
      if (visibilitySources.delete(epoch)) await updateVisibleSessions();
    },
    runDesktopRead<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
      return desktopReads.run(sessionId, run);
    },
    async control(message: DesktopServiceInbound): Promise<void> {
      if (message.kind === 'state-ack' && Number.isSafeInteger(message.sequence)) {
        stateMailbox.acknowledge(message.sequence);
        return;
      }
      if (message.kind === 'state-resync') {
        await synchronizeViews();
        return;
      }
      if (message.kind !== 'session-state-resync') return;
      const sessionId = String(message.sessionId || '');
      if (host.replaySessionStates) {
        await host.replaySessionStates([sessionId], (updates) => {
          for (const update of updates) {
            sessionStates.forget(update.sessionId);
            sessionStates.post(update);
          }
        });
        return;
      }
      sessionStates.republish(sessionId);
    },
    dispose(): void {
      serviceClosed = true;
      unsubscribeState();
      unsubscribeSessions();
      unsubscribeAgentPool();
      unsubscribeSessionStates();
      stateMailbox.clear();
      sessionStates.clear();
      visibleSessionIds.clear();
      visibilitySources.clear();
    },
  };
}
