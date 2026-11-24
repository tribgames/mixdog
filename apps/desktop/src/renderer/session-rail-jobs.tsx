// The session panel's Agents and Shells categories: the island's own rows and
// handlers (useSessionJobs), in the panel's sections.
import type { IslandAgentRow } from './agent-activity-model';
import type { JobRow } from './background-jobs-model';
import { agentStateWords } from './agent-row-meta';
import {
  AgentGroupList,
  agentsHeadMark,
  agentsInProgress,
  islandAgentCounts,
  widestAgentClocks,
  AgentsSummary,
  clearableAgents,
  clearFinishedAgents,
  dismissShellRows,
  jobsTabMark,
  ShellJobItem,
  useAgentsUsage,
  widestClocks,
} from './ComposerIsland';
import { t } from './i18n';
import { RailSection } from './session-rail-parts';
import { useShellStops } from './shell-job-controls';
import { useClock } from './use-clock';

/** The state column's width, unseen, in its track: its widest clock whole and the widest word of its states
 *  (`words`), whatever the rows show. An agent's state longer than that wraps in the column (session-rail.css), so
 *  it is read whole and takes nothing from the names; a shell's column holds the clock under an hour alone, so its
 *  command keeps the room, and a longer run or an end state shown is as wide as it reads. `element` follows the
 *  list (an item of a `ul`). */
function StateColumnSizer({
  clocks = widestClocks(),
  words,
  element = 'span',
}: {
  clocks?: string[];
  words: string[];
  element?: 'span' | 'li';
}) {
  const Cell = element;
  return (
    <Cell className="composer-island-col-sizer session-rail-state-col" aria-hidden="true" role="none">
      {clocks.map((clock) => (
        <span key={clock} className="agent-activity-elapsed" data-clock="">
          {clock}
        </span>
      ))}
      {words.map((word) => (
        <span key={word} className="agent-activity-elapsed">
          {word}
        </span>
      ))}
    </Cell>
  );
}

/** The Agents category: the island's agent list (AgentGroupList), one fold a
 *  kind and one line an agent. Its head ends with the mark and how many are in
 *  progress, neither with none in progress. Its foot
 *  is the agents' own usage and Clean up, the Lead's usage being Info's row. */
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
  const usage = useAgentsUsage({ sessionId, agentRows: agents, poolRows, busy, open: shown });
  const { running } = islandAgentCounts(agents);
  const inProgress = agentsInProgress(agents);
  // Only an agent at work has a clock that moves.
  const clock = useClock(shown && running > 0);
  if (agents.length === 0) return null;
  return (
    <RailSection
      category="agents"
      title={t('Agents')}
      // At the head's end, as To-do writes its own: the mark, then how many are in progress.
      count={
        inProgress > 0 ? (
          <span className="session-rail-todo-figure">
            {agentsHeadMark(agents)}
            <span>{inProgress}</span>
          </span>
        ) : undefined
      }
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
      <AgentGroupList
        sessionId={sessionId}
        agents={agents}
        usage={usage}
        clock={clock}
        className="composer-island-jobs composer-island-agents schedules-list agent-pool-list"
        sizer={<StateColumnSizer clocks={widestAgentClocks()} words={agentStateWords()} />}
        kindsOpen={false}
        onOpenSession={onOpenSession}
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
  const running = shells.filter((row) => !row.finished).length;
  const clock = useClock(open && running > 0);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  if (shells.length === 0) return null;
  const finished = shells.filter((row) => row.finished);
  return (
    <RailSection
      category="shells"
      title={t('Shell')}
      // How many still run, with the mark; neither once none runs.
      count={
        running > 0 ? (
          <span className="session-rail-todo-figure">
            {jobsTabMark('shell', [], running)}
            <span>{running}</span>
          </span>
        ) : undefined
      }
      open={open}
      onToggle={onToggle}
      scroll
      // As on the island's panel: Clean up only while an ended shell is listed.
      tidy={
        finished.length > 0
          ? {
              kind: 'close-all',
              description: t('Clear ended shells'),
              disabled: false,
              onClick: () => dismissShellRows(sessionId, finished, shellKeys),
            }
          : undefined
      }
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
        {/* The clock under an hour: a longer run, or an end state, is as wide as it reads. */}
        <StateColumnSizer element="li" clocks={widestClocks().slice(0, 1)} words={[]} />
      </ul>
    </RailSection>
  );
}
