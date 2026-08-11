import { useEffect, useState } from 'react';

import { liveAgentRows, liveShellCount } from './AgentActivityPane';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { formatWorkElapsed } from './TranscriptView';

// Session-owned task chip left of the context gauge. It is the only Tasks
// entry point and disappears with the last attached agent/background shell.
export function ActiveTasksIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen(): void;
}) {
  const agents = liveAgentRows(snapshot);
  const shellCount = liveShellCount(snapshot);
  const count = agents.length + shellCount;
  const active = count > 0;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return <div className="session-agents-indicator">
    <button type="button" onClick={onOpen}
      aria-label={t('Background activity: {{count}} running', { count })}>
      <ProgressSpinner className="session-agents-icon" size={16} aria-hidden="true" />
      <span className="session-agents-count">{count}</span>
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
      {shellCount > 0 && <div className="live-work-row" key="shells">
        <span>{t('Shell')} {shellCount}</span>
        {snapshot.shellJobs?.elapsedLabel && <small>{snapshot.shellJobs.elapsedLabel}</small>}
      </div>}
    </div>
  </div>;
}
