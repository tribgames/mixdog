import { Bot } from 'lucide-react';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { cachedAutoEffortCapable } from './auto-effort-store';
import { modelDisplayName, ModelRouteLabel, ProviderIcon, routeDaybreakBlue } from './provider-display';

/** The brand of the model an agent runs on marks its row. */
export function AgentProviderMark({ agent }: { agent: DesktopAgentPoolRow }) {
  return (
    <span className="sidebar-resource-icon" aria-hidden="true">
      {agent.provider ? <ProviderIcon provider={String(agent.provider)} width={16} height={16} /> : <Bot size={16} />}
    </span>
  );
}

/** An agent row's second line: model and effort. */
export function AgentRouteSummary({ agent }: { agent: DesktopAgentPoolRow }) {
  const modelParameters = agent.modelParameters as Record<string, string> | undefined;
  return (
    <small className="agent-route-summary" title={String(agent.model || '') || undefined}>
      <ModelRouteLabel
        model={modelDisplayName(String(agent.model || ''), String(agent.provider || ''))}
        effort={String(agent.effort || '').trim()}
        fast={agent.fast === true}
        ultra={modelParameters?.serviceTier === 'ultrafast'}
        blue={routeDaybreakBlue(modelParameters)}
        autoEffortCapable={cachedAutoEffortCapable(String(agent.provider || ''), String(agent.model || ''))}
        autoEffort={agent.autoEffort}
      />
    </small>
  );
}
