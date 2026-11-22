// The session panel's Agents and Shells categories: the island's own rows,
// handlers (useSessionJobs) and footer line, in the panel's sheets.
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import { poolRowKey, type IslandAgentRow } from './agent-activity-model';
import { AgentIslandRow } from './AgentIslandRow';
import type { JobRow } from './background-jobs-model';
import {
  AgentsSummary,
  agentStateLabels,
  clearableAgents,
  clearFinishedAgents,
  dismissShellRows,
  islandAgentCounts,
  ShellJobItem,
  shellStateLabels,
  useAgentsUsage,
} from './ComposerIsland';
import { t } from './i18n';
import { IslandColumnSizer } from './IslandPanelFoot';
import { RailSection } from './session-rail-parts';
import { useShellStops } from './shell-job-controls';
import { useClock } from './use-clock';

const RUNNING: readonly DesktopAgentActivityState[] = ['running', 'waiting', 'cancel-unconfirmed', 'needs-user'];

/** Running agents first, then queued ones, then the rest; each keeps its place otherwise. */
export function railAgentOrder(agents: readonly IslandAgentRow[]): IslandAgentRow[] {
  const rank = ({ state }: IslandAgentRow) => (RUNNING.includes(state) ? 0 : state === 'queued' ? 1 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

/** Running (with those waiting on the user), queued and finished. */
export function railAgentTally(agents: readonly IslandAgentRow[]) {
  const counts = islandAgentCounts(agents);
  const running = counts.running + counts.needsUser;
  return { running, waiting: counts.waiting, finished: agents.length - running - counts.waiting };
}

export function AgentsSection({
  sessionId,
  agents,
  poolRows,
  busy,
  shellKeys,
  open,
  onToggle,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  poolRows: Parameters<typeof useAgentsUsage>[0]['poolRows'];
  /** The session's turn runs: a settled turn asks for the usage again. */
  busy: boolean;
  shellKeys: ReadonlySet<string> | null;
  open: boolean;
  onToggle(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const shown = open && agents.length > 0;
  const clock = useClock(shown);
  const usage = useAgentsUsage({ sessionId, agentRows: agents, poolRows, busy, open: shown });
  if (agents.length === 0) return null;
  const { running, waiting, finished } = railAgentTally(agents);
  const summary = [
    running ? t('Running {{count}}', { count: running }) : '',
    waiting ? t('Waiting {{count}}', { count: waiting }) : '',
    finished ? t('Finished {{count}}', { count: finished }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const ordered = railAgentOrder(agents);
  return (
    <RailSection
      category="agents"
      title={t('Agents')}
      count={agents.length}
      meta={<span className="session-rail-cut">{summary}</span>}
      open={open}
      onToggle={onToggle}
      scroll
      foot={<AgentsSummary usage={usage} />}
      tidy={{
        kind: 'clear-finished',
        description: t('Clear finished'),
        disabled: clearableAgents(agents).length === 0,
        onClick: () => clearFinishedAgents(sessionId, agents, shellKeys),
      }}
    >
      <div
        className="composer-island-jobs composer-island-agents schedules-list agent-pool-list"
        role="tree"
        aria-label={t('Agents')}
      >
        {ordered.map(({ node, state }, index) => (
          <div key={poolRowKey(node.agent, index)} className="composer-island-agent-item" role="none">
            <AgentIslandRow
              node={node}
              state={state}
              clock={clock}
              tokens={usage.agentRowTokens.get(node.sessionId)}
              posInSet={index + 1}
              setSize={ordered.length}
              ownerSessionId={sessionId}
              onOpenSession={onOpenSession}
            />
          </div>
        ))}
        <IslandColumnSizer labels={agentStateLabels()} />
      </div>
    </RailSection>
  );
}

export function ShellsSection({
  sessionId,
  shells,
  shellKeys,
  open,
  onToggle,
}: {
  sessionId: string;
  shells: JobRow[];
  shellKeys: ReadonlySet<string> | null;
  open: boolean;
  onToggle(): void;
}) {
  const clock = useClock(open && shells.length > 0);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  if (shells.length === 0) return null;
  const running = shells.filter((row) => !row.finished).length;
  const finished = shells.filter((row) => row.finished);
  return (
    <RailSection
      category="shells"
      title={t('Shell')}
      count={shells.length}
      meta={
        <span>
          {[
            running ? t('Running {{count}}', { count: running }) : '',
            finished.length ? t('Ended {{count}}', { count: finished.length }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
      open={open}
      onToggle={onToggle}
      scroll
      tidy={{
        kind: 'close-all',
        description: t('Clear ended shells'),
        disabled: finished.length === 0,
        onClick: () => dismissShellRows(sessionId, finished, shellKeys),
      }}
    >
      <ul className="composer-island-jobs">
        {shells.map((row) => (
          <ShellJobItem
            key={row.key}
            row={row}
            clock={clock}
            stop={stopOf(row)}
            releasing={releasingOf(row)}
            onStop={stop}
            onDismiss={(dismissed) => dismissShellRows(sessionId, [dismissed], shellKeys)}
          />
        ))}
        <IslandColumnSizer element="li" labels={shellStateLabels()} />
      </ul>
    </RailSection>
  );
}
