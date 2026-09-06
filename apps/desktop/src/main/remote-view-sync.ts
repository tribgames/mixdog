import type { DesktopService } from './desktop-service-contract';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { KeyedListDeltaEncoder } from '../shared/list-delta';
import type { SnapshotDeltaEncoder } from './state-delta';
import { createSnapshotDeltaEncoder } from './state-delta';
import { synchronizeViewSnapshot } from './view-synchronizer';
import { remoteTranscriptSnapshot } from './remote-transcript';

export interface RelayViewSyncState {
  syncing?: boolean;
  visibleSessionIds: Set<string>;
  compactWire: boolean;
  listDelta: boolean;
  sessionStateEncoders: Map<string, SnapshotDeltaEncoder>;
  sessionsEncoder: KeyedListDeltaEncoder<DesktopSessionSummary>;
  agentPoolEncoder: KeyedListDeltaEncoder<DesktopAgentPoolRow>;
  stateLane: { reset(snapshot: unknown): Promise<void> } | null;
}

export async function registerAndSynchronizeRelayViews(
  host: DesktopService,
  clientId: string,
  state: RelayViewSyncState,
  params: unknown,
  current: () => boolean,
  send: (frame: unknown) => Promise<void>,
): Promise<void> {
  if (!Array.isArray(params) || !Array.isArray(params[0]) || params[0].length > 128
    || params[0].some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id))) {
    throw new TypeError('View synchronization request is invalid.');
  }
  if (!current()) throw new Error('Remote view was replaced during synchronization.');
  const ids = [...new Set(params[0] as string[])];
  state.syncing = true;
  state.visibleSessionIds = new Set(ids);
  try {
    await (host.setVisibleSessionsForSource
      ? host.setVisibleSessionsForSource(`remote:${clientId}`, ids)
      : host.setVisibleSessions?.(ids));
    await synchronizeRelayViews(host, state, current, send);
  } finally { state.syncing = false; }
}

/** Enqueue all full baselines before reopening live publication. Encryption
 * preserves that order; the RPC receipt follows the completed socket writes.
 * No transcript payload is combined into one oversized multi-session frame. */
export async function synchronizeRelayViews(
  host: DesktopService,
  state: RelayViewSyncState,
  current: () => boolean,
  send: (frame: unknown) => Promise<void>,
): Promise<void> {
  state.syncing = true;
  const writes: Promise<void>[] = [];
  try {
    await synchronizeViewSnapshot(host, [...state.visibleSessionIds], (snapshot) => {
      if (!current()) throw new Error('Remote view was replaced during synchronization.');
      state.sessionStateEncoders.clear();
      state.sessionsEncoder.reset();
      state.agentPoolEncoder.reset();
      if (state.stateLane) writes.push(state.stateLane.reset(snapshot.snapshot));
      writes.push(send({
        event: 'sessions',
        payload: state.listDelta ? state.sessionsEncoder.encode(snapshot.sessions) : snapshot.sessions,
      }));
      writes.push(send({
        event: 'agentPool',
        payload: state.listDelta ? state.agentPoolEncoder.encode(snapshot.agents) : snapshot.agents,
      }));
      for (const update of snapshot.sessionStates) {
        const encoder = createSnapshotDeltaEncoder({ compact: state.compactWire });
        state.sessionStateEncoders.set(update.sessionId, encoder);
        writes.push(send({
          event: 'sessionState',
          payload: { ...update, wire: encoder.encode(remoteTranscriptSnapshot(update.snapshot)), snapshot: undefined },
        }));
      }
      // All baseline encryptions are already queued. A later live frame now
      // follows them, including a change occurring before the receipt arrives.
      state.syncing = false;
      for (const write of writes) void write.catch(() => undefined);
    });
    await Promise.all(writes);
    if (!current()) throw new Error('Remote view was replaced during synchronization.');
  } finally {
    state.syncing = false;
  }
}
