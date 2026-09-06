import type {
  DesktopAgentPoolRow, DesktopSessionStateUpdate, DesktopSessionSummary, SessionSnapshot,
} from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';

export interface ViewSyncSnapshot {
  snapshot: SessionSnapshot;
  sessions: DesktopSessionSummary[];
  agents: DesktopAgentPoolRow[];
  sessionStates: DesktopSessionStateUpdate[];
}

/** Both transports use the same recovery boundary. Reads refresh the host;
 * delivery is synchronous so live publications cannot overtake a baseline
 * between capture and enqueue. A caller acknowledges only after its writes. */
export async function synchronizeViewSnapshot(
  host: Pick<DesktopService, 'getSnapshot' | 'listSessions' | 'listAgentPool'
    | 'subscribeSessions' | 'subscribeAgentPool' | 'replaySessionStates'>,
  sessionIds: string[],
  deliver: (snapshot: ViewSyncSnapshot) => void,
): Promise<void> {
  let pushedSessions: DesktopSessionSummary[] | undefined;
  let pushedAgents: DesktopAgentPoolRow[] | undefined;
  const stopSessions = host.subscribeSessions((rows) => { pushedSessions = rows; });
  const stopAgents = host.subscribeAgentPool((rows) => { pushedAgents = rows; });
  try {
    const [sessions, agents] = await Promise.all([host.listSessions(), host.listAgentPool()]);
    const publish = (sessionStates: DesktopSessionStateUpdate[]) => deliver({
      snapshot: host.getSnapshot(),
      sessions: pushedSessions ?? sessions,
      agents: pushedAgents ?? agents,
      sessionStates,
    });
    if (host.replaySessionStates) await host.replaySessionStates(sessionIds, publish);
    else publish([]); // Older embedders retain their own session replay lane.
  } finally {
    stopSessions();
    stopAgents();
  }
}
