import type {
  DesktopAgentPoolRow,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  SessionSnapshot,
} from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';

interface SessionViewSyncSnapshot {
  snapshot: SessionSnapshot;
  sessions: DesktopSessionSummary[];
  sessionStates: DesktopSessionStateUpdate[];
}

interface ViewSyncSnapshot extends SessionViewSyncSnapshot {
  agents: DesktopAgentPoolRow[];
}

type SessionViewSyncHost = Pick<
  DesktopService,
  'getSnapshot' | 'listSessions' | 'subscribeSessions' | 'replaySessionStates'
>;

type ViewSyncHost = SessionViewSyncHost & Pick<DesktopService, 'listAgentPool' | 'subscribeAgentPool'>;

/** One catalog read; a live publication during the read outranks its result. */
function readCatalog<T>(subscribe: (listener: (rows: T) => void) => () => void, list: () => Promise<T>) {
  let pushed: T | undefined;
  const stop = subscribe((rows) => {
    pushed = rows;
  });
  return { listed: list(), latest: (rows: T): T => pushed ?? rows, stop };
}

async function synchronize(
  host: SessionViewSyncHost & Partial<Pick<DesktopService, 'listAgentPool' | 'subscribeAgentPool'>>,
  sessionIds: string[],
  withAgents: boolean,
  deliver: (snapshot: SessionViewSyncSnapshot & { agents?: DesktopAgentPoolRow[] }) => void
): Promise<void> {
  const sessions = readCatalog<DesktopSessionSummary[]>(
    (listener) => host.subscribeSessions(listener),
    () => host.listSessions()
  );
  const agents = withAgents
    ? readCatalog<DesktopAgentPoolRow[]>(
        (listener) => host.subscribeAgentPool!(listener),
        () => host.listAgentPool!()
      )
    : null;
  try {
    const [sessionRows, agentRows] = await Promise.all([sessions.listed, agents?.listed]);
    const publish = (sessionStates: DesktopSessionStateUpdate[]) =>
      deliver({
        snapshot: host.getSnapshot(),
        sessions: sessions.latest(sessionRows),
        ...(agents ? { agents: agents.latest(agentRows ?? []) } : {}),
        sessionStates,
      });
    if (host.replaySessionStates) await host.replaySessionStates(sessionIds, publish);
    else publish([]); // Older embedders retain their own session replay lane.
  } finally {
    sessions.stop();
    agents?.stop();
  }
}

/** Both transports use the same recovery boundary. Reads refresh the host;
 * delivery is synchronous so live publications cannot overtake a baseline
 * between capture and enqueue. A caller acknowledges only after its writes. */
export async function synchronizeViewSnapshot(
  host: ViewSyncHost,
  sessionIds: string[],
  deliver: (snapshot: ViewSyncSnapshot) => void
): Promise<void> {
  await synchronize(host, sessionIds, true, (snapshot) => deliver(snapshot as ViewSyncSnapshot));
}

/** The same boundary without the Agents pool, for a consumer that takes the
 * pool as its own lane: the pool's first read after a daemon start opens every
 * worker session record and must not hold the conversations behind it. */
export async function synchronizeSessionViewSnapshot(
  host: SessionViewSyncHost,
  sessionIds: string[],
  deliver: (snapshot: SessionViewSyncSnapshot) => void
): Promise<void> {
  await synchronize(host, sessionIds, false, deliver);
}
