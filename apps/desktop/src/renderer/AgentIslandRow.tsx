import { useId } from 'react';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { AgentRowElapsed, AgentRowFrame } from './agent-activity-groups';
import { type AgentActivityNode, agentRoleLabel } from './agent-activity-model';
import { useAgentRouteText } from './agent-row-parts';
import { AgentTodoRing, type StepGlyph, agentTodoFigure, agentTodoLabel } from './AgentTodoMark';
import { formatCompactTokens, tokensReadoutItem } from './composer-usage-readout';
import { t } from './i18n';
import { formatWorkClock, formatWorkElapsed, timeMs } from './transcript-primitives';
import { plainFloorNote } from './usage-stats-model';

/** An agent's own name under its kind's group: its tag, or its kind when the tag says no more (the Lead). */
function agentOwnName(agent: DesktopAgentPoolRow, lead: boolean): string {
  const role = agentRoleLabel(agent.agent || agent.tag);
  const tag = String(agent.tag || '').trim();
  return !lead && tag && tag.toLowerCase() !== role.toLowerCase() ? tag : role;
}

function stepGlyph(state: DesktopAgentActivityState, finished: boolean): StepGlyph {
  if (state === 'cancelled') return 'dropped';
  return finished ? 'complete' : 'active';
}

/** How long a finished agent's last turn ran; 0 unless the pool still holds that turn's start. */
function workedMs(agent: DesktopAgentPoolRow): number {
  const start = timeMs(agent.turnStartedAt);
  const end = timeMs(agent.settledAt) || timeMs(agent.idleSince);
  return start && end > start ? end - start : 0;
}

/** One agent in an agents list (the island's Agents tab, the session panel's
 *  Agents section), built as a to-do row: one line under its kind's group
 *  (level 2 of the tree, whatever its depth in the pool), its step ring where
 *  a to-do's state circle stands, its own name, then a single right-aligned
 *  trailing meta cluster combining its step figure (when present) and state.
 *  An agent at work is marked data-working; its name stays a row name. Its
 *  tooltip and description say the rest: the model, the step in hand, a
 *  finished agent's worked time and the ledger total. */
export function AgentIslandRow({
  node,
  state,
  finished,
  clock,
  tokens,
  tokensFloor,
  posInSet,
  setSize,
  ownerSessionId,
  onOpenSession,
}: {
  node: AgentActivityNode;
  /** The lifecycle state the island resolved (it merges worker and job entries). */
  state: DesktopAgentActivityState;
  /** Idle, done or cancelled. */
  finished: boolean;
  clock: number;
  /** The row's ledger total; undefined while the ledger has no figure for it. */
  tokens: number | undefined;
  /** `tokens` counts only the calls whose usage was reported. */
  tokensFloor: boolean;
  posInSet: number;
  setSize: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const { agent } = node;
  const statusId = useId();
  const detailId = useId();
  const worked = finished ? workedMs(agent) : 0;
  const detail = [
    useAgentRouteText(agent),
    agent.todo?.current ? agentTodoLabel(agent.todo) : '',
    worked ? t('Worked {{time}}', { time: formatWorkElapsed(worked) }) : '',
    agentRowTokensText(tokens, tokensFloor),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <AgentRowFrame
      agent={agent}
      depth={node.depth}
      level={2}
      parentSessionId={node.parentSessionId}
      posInSet={posInSet}
      setSize={setSize}
      ownerSessionId={ownerSessionId}
      describedBy={detail ? `${statusId} ${detailId}` : statusId}
      title={detail}
      working={state === 'running' || state === 'waiting'}
      onOpenSession={onOpenSession}
    >
      {/* The ring in the column of a to-do's state circle, with or without a step list. */}
      <span className="agent-row-ring" aria-hidden="true">
        <AgentTodoRing todo={agent.todo} glyph={stepGlyph(state, finished)} size={12} />
      </span>
      <span className="schedules-row-copy agent-pool-heading">
        <b className="agent-pool-name">{agentOwnName(agent, node.sessionId === ownerSessionId)}</b>
      </span>
      <span className="agent-activity-status" id={statusId}>
        {agent.todo && (
          <>
            <span
              className="agent-row-steps"
              data-active={!finished ? 'true' : undefined}
              role="img"
              aria-label={agentTodoLabel(agent.todo)}
              title={agentTodoLabel(agent.todo)}
            >
              {agentTodoFigure(agent.todo)}
            </span>
            <span className="agent-row-meta-sep" aria-hidden="true">
              ·
            </span>
          </>
        )}
        <AgentRowElapsed state={state} agent={agent} clock={clock} format={formatWorkClock} />
      </span>
      {detail && (
        <span id={detailId} hidden>
          {detail}
        </span>
      )}
    </AgentRowFrame>
  );
}

/** An agent row's ledger total in words ("1.6k tokens"), a floor's note on a line of its own; empty while the
 *  ledger has no figure for it. */
function agentRowTokensText(tokens: number | undefined, floor: boolean): string {
  if (tokens === undefined) return '';
  const { word } = tokensReadoutItem(formatCompactTokens(tokens));
  return floor ? `${word}\n${plainFloorNote()}` : word;
}
