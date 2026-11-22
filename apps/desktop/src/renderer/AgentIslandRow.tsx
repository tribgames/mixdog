import { useId } from 'react';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import { AgentRowElapsed, AgentRowFrame } from './agent-activity-groups';
import type { AgentActivityNode } from './agent-activity-model';
import { agentRowName } from './agent-chat-summary';
import { AgentProviderMark, AgentRouteSummary } from './agent-row-parts';
import { AgentTodoMark } from './AgentTodoMark';
import { formatCompactTokens } from './composer-usage-readout';
import { t } from './i18n';

/** One agent in the composer island's panel: the Agents window's row with the
 *  step mark after the model (the panel has no room for a column of its own)
 *  and the row's token total under its state. */
export function AgentIslandRow({
  node,
  state,
  clock,
  tokens,
  posInSet,
  setSize,
  ownerSessionId,
  onOpenSession,
}: {
  node: AgentActivityNode;
  /** The lifecycle state the island resolved (it merges worker and job entries). */
  state: DesktopAgentActivityState;
  clock: number;
  /** The row's ledger total; undefined while the ledger has no figure for it. */
  tokens: number | undefined;
  posInSet: number;
  setSize: number;
  ownerSessionId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const { agent } = node;
  const statusId = useId();
  return (
    <AgentRowFrame
      agent={agent}
      depth={node.depth}
      parentSessionId={node.parentSessionId}
      posInSet={posInSet}
      setSize={setSize}
      ownerSessionId={ownerSessionId}
      describedBy={statusId}
      onOpenSession={onOpenSession}
    >
      <AgentProviderMark agent={agent} />
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name">{agentRowName(agent, node.sessionId === ownerSessionId)}</b>
        </span>
        <span className="island-agent-route">
          <AgentRouteSummary agent={agent} />
          <AgentTodoMark todo={agent.todo} />
        </span>
      </span>
      <span className="agent-pool-figures">
        <span className="agent-activity-status" id={statusId}>
          <AgentRowElapsed state={state} agent={agent} clock={clock} />
        </span>
        {tokens !== undefined && (
          <span
            className="composer-island-agent-tokens"
            title={t('Total {{tokens}} tokens', { tokens: formatCompactTokens(tokens) })}
          >
            {formatCompactTokens(tokens)}
          </span>
        )}
      </span>
    </AgentRowFrame>
  );
}
