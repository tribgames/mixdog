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
  ShellJobItem,
  shellStateLabels,
  useAgentsUsage,
} from './ComposerIsland';
import { t } from './i18n';
import { IslandColumnSizer } from './IslandPanelFoot';
import type { useSessionRailFolds } from './session-rail-folds';
import { RailFold, RailSection } from './session-rail-parts';
import { useShellStops } from './shell-job-controls';
import { useClock } from './use-clock';

const RUNNING: readonly DesktopAgentActivityState[] = ['running', 'waiting', 'cancel-unconfirmed', 'needs-user'];

type Folds = ReturnType<typeof useSessionRailFolds>;

/** The agents by where they stand: at work (with those waiting on the user
 *  or on their own tasks), queued, and the rest; each keeps its place. */
export function railAgentGroups(agents: readonly IslandAgentRow[]) {
  const working = (state: DesktopAgentActivityState) => RUNNING.includes(state);
  return {
    running: agents.filter(({ state }) => working(state)),
    waiting: agents.filter(({ state }) => state === 'queued'),
    finished: agents.filter(({ state }) => !working(state) && state !== 'queued'),
  };
}

/** The Agents category: a fold for each state, as To-do folds its steps. The
 *  finished ones stay folded while any agent is at work or queued. */
export function AgentsSection({
  sessionId,
  agents,
  poolRows,
  busy,
  shellKeys,
  open,
  onToggle,
  folds,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  folds: Folds;
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
  const { running, waiting, finished } = railAgentGroups(agents);
  const active = running.length + waiting.length > 0;
  const groups = [
    { key: 'agents:running', name: t('Running {{count}}', { count: running.length }), rows: running, byDefault: true },
    { key: 'agents:waiting', name: t('Waiting {{count}}', { count: waiting.length }), rows: waiting, byDefault: true },
    {
      key: 'agents:finished',
      name: t('Finished {{count}}', { count: finished.length }),
      rows: finished,
      byDefault: !active,
    },
  ].filter((group) => group.rows.length > 0);
  const summary = groups.map((group) => group.name).join(' · ');
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
      {groups.map((group) => {
        const shown = folds.groupOpen(group.key, group.byDefault);
        return (
          <div key={group.key} className="session-rail-group" data-group={group.key}>
            <RailFold
              id={group.key}
              name={group.name}
              open={shown}
              onToggle={() => folds.setGroups({ [group.key]: !shown })}
            />
            {shown && (
              <div
                className="composer-island-jobs composer-island-agents schedules-list agent-pool-list"
                role="tree"
                aria-label={group.name}
              >
                {group.rows.map(({ node, state }, index) => (
                  <div key={poolRowKey(node.agent, index)} className="composer-island-agent-item" role="none">
                    <AgentIslandRow
                      node={node}
                      state={state}
                      clock={clock}
                      tokens={usage.agentRowTokens.get(node.sessionId)}
                      posInSet={index + 1}
                      setSize={group.rows.length}
                      ownerSessionId={sessionId}
                      onOpenSession={onOpenSession}
                    />
                  </div>
                ))}
                <IslandColumnSizer labels={agentStateLabels()} />
              </div>
            )}
          </div>
        );
      })}
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
