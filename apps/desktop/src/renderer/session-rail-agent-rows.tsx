// The session panel's agent rows: a working agent in the island's row grammar
// (brand mark, its name and the step progress in a column of its own over the
// step in hand, time over tokens) and a finished one on a single muted line.
import { useId } from 'react';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { AgentRowElapsed, AgentRowFrame } from './agent-activity-groups';
import type { IslandAgentRow } from './agent-activity-model';
import { agentStateWord } from './agent-row-meta';
import { AgentProviderMark } from './agent-row-parts';
import { AgentTodoMark } from './AgentTodoMark';
import { formatCompactTokens } from './composer-usage-readout';
import { t } from './i18n';
import { formatGoalDuration } from './session-goal-presentation';
import { timeMs } from './transcript-primitives';
import { useClock } from './use-clock';

type RailAgentRowProps = {
  row: IslandAgentRow;
  /** Its tag: the group already says the role. */
  name: string;
  /** The row's ledger total; undefined while the ledger has no figure for it. */
  tokens: number | undefined;
  posInSet: number;
  setSize: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
};

/** A working agent's second line: the step in hand, else its state. */
function stepLine(state: DesktopAgentActivityState, current: string): string {
  if (state === 'queued') return t('Waiting for its turn');
  return current || agentStateWord(state);
}

/** How long a finished agent's last turn ran; 0 unless the pool still holds
 *  that turn's start (it clears it once the turn settles). */
function workedMs(agent: DesktopAgentPoolRow): number {
  const start = timeMs(agent.turnStartedAt);
  const end = timeMs(agent.settledAt) || timeMs(agent.idleSince);
  return start && end > start ? end - start : 0;
}

/** A working row's time, ticking on its own: each second repaints this alone. */
function RailAgentElapsed({ state, agent }: { state: DesktopAgentActivityState; agent: DesktopAgentPoolRow }) {
  const clock = useClock(state === 'running' || state === 'waiting');
  return <AgentRowElapsed state={state} agent={agent} clock={clock} format={formatGoalDuration} />;
}

export function RailAgentRow({ row, name, tokens, posInSet, setSize, ownerSessionId, onOpenSession }: RailAgentRowProps) {
  const { agent } = row.node;
  const id = useId();
  const current = String(agent.todo?.current || '').trim();
  const line = stepLine(row.state, current);
  // The step mark's own label already reads the step in hand.
  const described = [agent.todo && `${id}-step`, !(agent.todo && line === current) && `${id}-line`, `${id}-status`];
  return (
    <AgentRowFrame
      agent={agent}
      parentSessionId={row.node.parentSessionId}
      posInSet={posInSet}
      setSize={setSize}
      ownerSessionId={ownerSessionId}
      describedBy={described.filter(Boolean).join(' ')}
      className="session-rail-agent"
      onOpenSession={onOpenSession}
    >
      <AgentProviderMark agent={agent} />
      <b className="agent-pool-name">{name}</b>
      <AgentTodoMark todo={agent.todo} id={`${id}-step`} />
      <span className="agent-activity-status" id={`${id}-status`}>
        <RailAgentElapsed state={row.state} agent={agent} />
      </span>
      <span className="session-rail-agent-line" id={`${id}-line`}>
        {line}
      </span>
      {tokens !== undefined && (
        <span
          className="composer-island-agent-tokens"
          title={t('Total {{tokens}} tokens', { tokens: formatCompactTokens(tokens) })}
        >
          {formatCompactTokens(tokens)}
        </span>
      )}
    </AgentRowFrame>
  );
}

/** A finished agent, under its group's "Finished N" (depth 1) or listed by
 *  itself (depth 0): mark, name, then how long it ran and its tokens; its end
 *  state is read out, not shown. */
export function RailFinishedAgent({
  row,
  name,
  tokens,
  depth,
  posInSet,
  setSize,
  ownerSessionId,
  onOpenSession,
}: RailAgentRowProps & { depth: number }) {
  const { agent } = row.node;
  const statusId = useId();
  const worked = workedMs(agent);
  const figures = [worked ? formatGoalDuration(worked) : '', tokens !== undefined ? formatCompactTokens(tokens) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <AgentRowFrame
      agent={agent}
      depth={depth}
      parentSessionId={row.node.parentSessionId}
      posInSet={posInSet}
      setSize={setSize}
      ownerSessionId={ownerSessionId}
      describedBy={statusId}
      className="session-rail-agent-past"
      onOpenSession={onOpenSession}
    >
      <AgentProviderMark agent={agent} />
      <span className="agent-pool-name">{name}</span>
      <span className="session-rail-agent-figures" id={statusId}>
        <span className="sr-only">{`${agentStateWord(row.state)} `}</span>
        {figures}
      </span>
    </AgentRowFrame>
  );
}
