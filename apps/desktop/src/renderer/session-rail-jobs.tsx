// The session panel's Agents and Shells categories, on the island's own job
// rows and handlers (useSessionJobs).
import { useId } from 'react';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import { AgentRowElapsed, AgentRowFrame } from './agent-activity-groups';
import { poolRowKey, type IslandAgentRow } from './agent-activity-model';
import { agentRowName } from './agent-chat-summary';
import { AgentProviderMark } from './agent-row-parts';
import { AgentTodoMark } from './AgentTodoMark';
import type { JobRow } from './background-jobs-model';
import { clearableAgents, clearFinishedAgents, dismissShellRows, islandAgentCounts } from './ComposerIsland';
import { t } from './i18n';
import { RailList, RailSection } from './session-rail-parts';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import { useClock } from './use-clock';

export const RAIL_AGENT_ROWS = 4;
export const RAIL_SHELL_ROWS = 3;

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

function RailAgentRow({
  row,
  clock,
  index,
  total,
  ownerSessionId,
  onOpenSession,
}: {
  row: IslandAgentRow;
  clock: number;
  index: number;
  total: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const { node, state } = row;
  const statusId = useId();
  return (
    <AgentRowFrame
      agent={node.agent}
      depth={node.depth}
      parentSessionId={node.parentSessionId}
      posInSet={index + 1}
      setSize={total}
      ownerSessionId={ownerSessionId}
      describedBy={statusId}
      onOpenSession={onOpenSession}
    >
      <AgentProviderMark agent={node.agent} size={14} />
      <span className="session-rail-cut session-rail-grow">
        {agentRowName(node.agent, node.sessionId === ownerSessionId)}
      </span>
      <AgentTodoMark todo={node.agent.todo} />
      <span className="session-rail-el" id={statusId}>
        <AgentRowElapsed state={state} agent={node.agent} clock={clock} />
      </span>
    </AgentRowFrame>
  );
}

export function AgentsSection({
  sessionId,
  agents,
  shellKeys,
  open,
  onToggle,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  shellKeys: ReadonlySet<string> | null;
  open: boolean;
  onToggle(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const clock = useClock(open && agents.length > 0);
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
      open={open}
      onToggle={onToggle}
      summary={<span>{summary}</span>}
      tidy={{
        kind: 'clear-finished',
        description: t('Clear finished'),
        disabled: clearableAgents(agents).length === 0,
        onClick: () => clearFinishedAgents(sessionId, agents, shellKeys),
      }}
    >
      <RailList
        budget={RAIL_AGENT_ROWS}
        list={(shown) => (
          <div className="session-rail-list agent-pool-list" role="tree" aria-label={t('Agents')}>
            {shown}
          </div>
        )}
        rows={ordered.map((row, index) => (
            <RailAgentRow
              key={poolRowKey(row.node.agent, index)}
              row={row}
              clock={clock}
              index={index}
              total={ordered.length}
              ownerSessionId={sessionId}
              onOpenSession={onOpenSession}
            />
          ))}
      />
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
      open={open}
      onToggle={onToggle}
      summary={
        <span>
          {running
            ? t('Running {{count}}', { count: running })
            : t('Ended {{count}}', { count: finished.length })}
        </span>
      }
      tidy={{
        kind: 'close-all',
        description: t('Clear ended shells'),
        disabled: finished.length === 0,
        onClick: () => dismissShellRows(sessionId, finished, shellKeys),
      }}
    >
      <RailList
        budget={RAIL_SHELL_ROWS}
        list={(shown) => <ul className="session-rail-list session-rail-shells">{shown}</ul>}
        rows={shells.map((row) => (
            <li
              key={row.key}
              className="session-rail-row"
              data-finished={row.finished || undefined}
              title={row.cwd ? `${row.label}\n${row.cwd}` : row.label}
            >
              <ShellJobContent row={row} clock={clock} stop={stopOf(row)} releasing={releasingOf(row)} />
              <span className="session-rail-row-actions">
                <ShellRowButton
                  row={row}
                  stop={stopOf(row)}
                  releasing={releasingOf(row)}
                  onStop={stop}
                  onDismiss={(dismissed) => dismissShellRows(sessionId, [dismissed], shellKeys)}
                />
              </span>
            </li>
          ))}
      />
    </RailSection>
  );
}
