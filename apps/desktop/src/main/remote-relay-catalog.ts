// Session and agent rosters on the relay leg. Rosters are pushed only when
// the store changes, so a lost or undecodable patch would strand a phone on
// stale rows (status dots, unread marks) until the NEXT change — a resync
// answered with state alone never repaired it. The last roster is retained and
// re-sent IN FULL on join and on resync.
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { isNoListDelta } from '../shared/list-delta';
import { createRemoteCatalog } from '../shared/remote-catalog';
import type { DesktopService } from './desktop-service-contract';
import type { RelayClientState } from './remote-relay-clients';
import { sessionRosterLog, stampRoster } from './remote-roster-log';

export interface RelayCatalogDeps {
  host: DesktopService;
  clients: ReadonlyMap<string, RelayClientState>;
  /** The leg is open and still holds THIS state for the id: a late read may
   *  not send into a replacement connection. */
  live(clientId: string, state: RelayClientState): boolean;
  sendEncryptedFrame(clientId: string, payload: unknown, droppable: boolean): Promise<void>;
}

export interface RelayCatalogs {
  /** Re-sends both rosters in full to one client (join, resync). */
  sendClientLists(clientId: string, state: RelayClientState): void;
  publishSessions(sessions: DesktopSessionSummary[]): void;
  publishAgentPool(agents: DesktopAgentPoolRow[]): void;
}

/** One roster lane: its retained catalog, the host read that refills it, the
 *  per-client encoder, and the event it travels as. */
interface RosterLane<T> {
  catalog: ReturnType<typeof createRemoteCatalog<T>>;
  read(): Promise<T[]>;
  encoder(state: RelayClientState): { reset(): void; encode(rows: T[]): unknown };
  /** The list-delta payload as this client receives it. */
  stamp?(state: RelayClientState, rows: T[], wire: unknown): unknown;
  event: 'sessions' | 'agentPool';
  label: string;
}

export function createRelayCatalogs(deps: RelayCatalogDeps): RelayCatalogs {
  const sessions: RosterLane<DesktopSessionSummary> = {
    catalog: createRemoteCatalog<DesktopSessionSummary>(),
    read: () => deps.host.listSessions(),
    encoder: (state) => state.sessionsEncoder,
    // A phone that persists its roster learns which version each frame is.
    stamp: (state, rows, wire) =>
      state.rosterStamp ? stampRoster(sessionRosterLog<DesktopSessionSummary>(deps.host), rows, wire) : wire,
    event: 'sessions',
    label: 'session',
  };
  const agents: RosterLane<DesktopAgentPoolRow> = {
    catalog: createRemoteCatalog<DesktopAgentPoolRow>(),
    read: () => deps.host.listAgentPool(),
    encoder: (state) => state.agentPoolEncoder,
    event: 'agentPool',
    label: 'agent',
  };
  const sendRoster = <T>(lane: RosterLane<T>, clientId: string, state: RelayClientState): void => {
    void lane.catalog
      .read(lane.read)
      .then(() => {
        const rows = lane.catalog.get();
        if (!deps.live(clientId, state) || rows === null) return;
        const encoder = lane.encoder(state);
        encoder.reset();
        const wire = encoder.encode(rows);
        return deps.sendEncryptedFrame(
          clientId,
          {
            event: lane.event,
            payload: state.listDelta ? (lane.stamp?.(state, rows, wire) ?? wire) : rows,
          },
          false
        );
      })
      .catch((error) => console.error(`[mixdog-remote] ${lane.label} catalog recovery failed`, error));
  };
  const publishRoster = <T>(lane: RosterLane<T>, rows: T[]): void => {
    lane.catalog.publish(rows);
    if (deps.clients.size === 0) return;
    for (const [clientId, state] of deps.clients) {
      if (!state.channel || state.syncing) continue;
      const wire = lane.encoder(state).encode(rows);
      if (isNoListDelta(wire)) continue;
      const payload = state.listDelta ? (lane.stamp?.(state, rows, wire) ?? wire) : rows;
      // Roster frames carry delta patches: dropping one under congestion
      // breaks the chain for every later push, so they are never droppable.
      void deps.sendEncryptedFrame(clientId, { event: lane.event, payload }, false);
    }
  };
  return {
    sendClientLists: (clientId, state) => {
      // Host subscriptions announce CHANGES, not an initial roster. Do not
      // replace a phone's real rows with a fabricated empty list on first join.
      // Each lane recovers independently; an agent read fault must not hide the
      // session catalog.
      sendRoster(sessions, clientId, state);
      sendRoster(agents, clientId, state);
    },
    publishSessions: (rows) => publishRoster(sessions, rows),
    publishAgentPool: (rows) => publishRoster(agents, rows),
  };
}
