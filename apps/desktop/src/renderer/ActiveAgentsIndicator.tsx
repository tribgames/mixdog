import { useEffect, useState } from 'react';

import { agentIcon } from './agent-icons';
import { liveAgentRows } from './AgentActivityPane';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { formatWorkElapsed } from './TranscriptView';

// Active-agent chip left of the context gauge (user request): the side tab's
// role icon breathes while agents run in this session; clicking jumps to the
// Tasks pane of the utility dock. Hidden entirely when no agent is active.
export function ActiveAgentsIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen(): void;
}) {
  const agents = liveAgentRows(snapshot);
  const active = agents.length > 0;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const Icon = agentIcon(agents[0].roleId);
  return <div className="session-agents-indicator">
    <button type="button" onClick={onOpen}
      aria-label={t('Open agent activity: {{count}} running', { count: agents.length })}>
      <Icon className="session-agents-icon" size={16} aria-hidden="true" />
      {agents.length > 1 && <span className="session-agents-count">{agents.length}</span>}
    </button>
    <div className="live-work-popover" role="tooltip">
      {agents.map((agent) => {
        const base = agent.turnStartedAt || agent.startedAt;
        const elapsed = agent.queued
          ? t('Queued')
          : base ? formatWorkElapsed(clock - base) || '0s' : agent.status;
        return <div className="live-work-row" key={agent.key}>
          <span>{agent.role}</span>
          {elapsed && <small>{elapsed}</small>}
        </div>;
      })}
    </div>
  </div>;
}
