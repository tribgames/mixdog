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

export function createRelayCatalogs(deps: RelayCatalogDeps): RelayCatalogs {
  const sessions = createRemoteCatalog<DesktopSessionSummary>();
  const agents = createRemoteCatalog<DesktopAgentPoolRow>();
  return {
    sendClientLists: (clientId, state) => {
      // Host subscriptions announce CHANGES, not an initial roster. Do not
      // replace a phone's real rows with a fabricated empty list on first join.
      // Each lane recovers independently; an agent read fault must not hide the
      // session catalog.
      void sessions
        .read(() => deps.host.listSessions())
        .then(() => {
          const rows = sessions.get();
          if (!deps.live(clientId, state) || rows === null) return;
          state.sessionsEncoder.reset();
          const wire = state.sessionsEncoder.encode(rows);
          return deps.sendEncryptedFrame(
            clientId,
            {
              event: 'sessions',
              payload: state.listDelta ? wire : rows,
            },
            false
          );
        })
        .catch((error) => console.error('[mixdog-remote] session catalog recovery failed', error));
      void agents
        .read(() => deps.host.listAgentPool())
        .then(() => {
          const rows = agents.get();
          if (!deps.live(clientId, state) || rows === null) return;
          state.agentPoolEncoder.reset();
          const wire = state.agentPoolEncoder.encode(rows);
          return deps.sendEncryptedFrame(
            clientId,
            {
              event: 'agentPool',
              payload: state.listDelta ? wire : rows,
            },
            false
          );
        })
        .catch((error) => console.error('[mixdog-remote] agent catalog recovery failed', error));
    },
    publishSessions: (rows) => {
      sessions.publish(rows);
      if (deps.clients.size === 0) return;
      for (const [clientId, state] of deps.clients) {
        if (!state.channel || state.syncing) continue;
        const wire = state.sessionsEncoder.encode(rows);
        if (isNoListDelta(wire)) continue;
        const payload = state.listDelta ? wire : rows;
        // Roster frames carry delta patches: dropping one under congestion
        // breaks the chain for every later push, so they are never droppable.
        void deps.sendEncryptedFrame(clientId, { event: 'sessions', payload }, false);
      }
    },
    publishAgentPool: (rows) => {
      agents.publish(rows);
      if (deps.clients.size === 0) return;
      for (const [clientId, state] of deps.clients) {
        if (!state.channel || state.syncing) continue;
        const wire = state.agentPoolEncoder.encode(rows);
        if (isNoListDelta(wire)) continue;
        const payload = state.listDelta ? wire : rows;
        void deps.sendEncryptedFrame(clientId, { event: 'agentPool', payload }, false);
      }
    },
  };
}
