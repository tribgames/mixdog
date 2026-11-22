// The session panel's Agents and Shells categories: the island's own rows,
// handlers (useSessionJobs) and footer line, in the panel's sheets.
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import { agentRoleLabel, poolRowKey, type IslandAgentRow } from './agent-activity-model';
import { AgentIslandRow } from './AgentIslandRow';
import type { JobRow } from './background-jobs-model';
import {
  clearableAgents,
  clearFinishedAgents,
  dismissShellRows,
  ShellJobItem,
  shellStateLabels,
  useAgentsUsage,
  widestClocks,
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

/** The agents by role, in the order each role first appears. */
export function railAgentRoles(agents: readonly IslandAgentRow[]): { role: string; rows: IslandAgentRow[] }[] {
  const roles = new Map<string, IslandAgentRow[]>();
  for (const row of agents) {
    const role = agentRoleLabel(row.node.agent.agent || row.node.agent.tag);
    const rows = roles.get(role);
    if (rows) rows.push(row);
    else roles.set(role, [row]);
  }
  return [...roles].map(([role, rows]) => ({ role, rows }));
}

/** An agent's name under its role's fold: its tag, the role saying the rest. */
const nameInRole = (row: IslandAgentRow, role: string) => String(row.node.agent.tag || '').trim() || role;

/** The Agents category: a fold for each role (Worker, Reviewer, …) with its
 *  agents under it, each named by its tag; the head counts them by state. */
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
  const summary = [
    running.length ? t('Running {{count}}', { count: running.length }) : '',
    waiting.length ? t('Waiting {{count}}', { count: waiting.length }) : '',
    finished.length ? t('Finished {{count}}', { count: finished.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const groups = railAgentRoles(agents).map(({ role, rows }) => ({ key: `agents:role:${role}`, role, rows }));
  return (
    <RailSection
      category="agents"
      title={t('Agents')}
      count={agents.length}
      meta={<span className="session-rail-cut">{summary}</span>}
      open={open}
      onToggle={onToggle}
      scroll
      tidy={{
        kind: 'clear-finished',
        description: t('Clear finished'),
        disabled: clearableAgents(agents).length === 0,
        onClick: () => clearFinishedAgents(sessionId, agents, shellKeys),
      }}
    >
      {groups.map((group) => {
        const shown = folds.groupOpen(group.key, true);
        const name = `${group.role} ${group.rows.length}`;
        return (
          <div key={group.key} className="session-rail-group" data-group={group.key}>
            <RailFold id={group.key} name={name} open={shown} onToggle={() => folds.setGroups({ [group.key]: !shown })} />
            {shown && (
              <div
                className="composer-island-jobs composer-island-agents schedules-list agent-pool-list"
                role="tree"
                aria-label={name}
              >
                {group.rows.map((row, index) => (
                  <div key={poolRowKey(row.node.agent, index)} className="composer-island-agent-item" role="none">
                    <AgentIslandRow
                      // Under its role an agent stands on its own line, whoever started it.
                      node={row.node.depth === 0 ? row.node : { ...row.node, depth: 0 }}
                      name={nameInRole(row, group.role)}
                      state={row.state}
                      clock={clock}
                      tokens={usage.agentRowTokens.get(row.node.sessionId)}
                      posInSet={index + 1}
                      setSize={group.rows.length}
                      ownerSessionId={sessionId}
                      onOpenSession={onOpenSession}
                    />
                  </div>
                ))}
                {/* The state column keeps a clock's width; the names take the rest of the card. */}
                <IslandColumnSizer labels={widestClocks()} />
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
