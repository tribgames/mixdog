import { Bot, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { liveAgentRows, liveShellCount, liveShellRows } from './AgentActivityPane';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { formatWorkElapsed } from './TranscriptView';

/** Each chip ticks its own 1s clock only while its session has live work. */
function useActivityClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return clock;
}

function activityBadgeCount(count: number): string {
  return count > 9 ? '9+' : String(count);
}

// Session-owned agent chip left of the context gauge: it routes to the Agents
// side tab — an already-open tab simply stays open — and disappears with the
// last attached agent.
export function ActiveAgentsIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen(): void;
}) {
  const agents = liveAgentRows(snapshot);
  const toolCount = Math.max(0, Number(snapshot.activeTools?.agent?.count) || 0);
  const count = Math.max(agents.length, toolCount);
  const clock = useActivityClock(count > 0);
  if (count === 0) return null;
  return <div className="session-agents-indicator">
    <button type="button" onClick={onOpen} aria-label={t('{{agentCount}} agents', { agentCount: count })}>
      <Bot className="session-agents-icon" size={16} aria-hidden="true" />
      <span className="session-agents-count">{activityBadgeCount(count)}</span>
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
      {count > agents.length && <div className="live-work-row" key="agent-tools">
        <span>{t('Agent')} {count}</span>
        {snapshot.activeTools?.agent?.startedAt
          && <small>{formatWorkElapsed(clock - Number(snapshot.activeTools.agent.startedAt)) || '0s'}</small>}
      </div>}
    </div>
  </div>;
}

// Sibling shell chip: background shells own no panel, so the chip itself lists
// the session's running commands and pins that list open on click. Only jobs
// promoted to the background (shellJobs) are surfaced — a foreground command
// is still streaming in the transcript tool card, so a second chip would be
// redundant noise until it outlives the foreground budget.
export function ActiveShellsIndicator({ snapshot }: { snapshot: Snapshot }) {
  const shells = liveShellRows(snapshot);
  // Older/remote frames publish a count without job rows: the count stays the
  // visible truth and the list degrades to one summary row.
  const count = Math.max(liveShellCount(snapshot), shells.length);
  const clock = useActivityClock(count > 0);
  const [pinned, setPinned] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (count === 0) setPinned(false);
  }, [count]);
  useEffect(() => {
    if (!pinned) return undefined;
    const dismiss = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) setPinned(false);
    };
    window.document.addEventListener('mousedown', dismiss);
    return () => window.document.removeEventListener('mousedown', dismiss);
  }, [pinned]);
  if (count === 0) return null;
  return <div ref={host}
    className="session-agents-indicator session-shells-indicator"
    data-open={pinned ? 'true' : 'false'}>
    <button type="button" aria-expanded={pinned}
      onClick={() => setPinned((value) => !value)}
      aria-label={t('Shell') + ' ' + count}>
      <Terminal className="session-agents-icon" size={16} aria-hidden="true" />
      <span className="session-agents-count">{activityBadgeCount(count)}</span>
    </button>
    <div className="live-work-popover" role="tooltip">
      {shells.length > 0
        ? <>
          {shells.map((shell) => {
          const elapsed = shell.startedAt
            ? formatWorkElapsed(clock - shell.startedAt) || '0s'
            : '';
          return <div className="live-work-row" key={shell.key}>
            <span title={shell.cwd || undefined}>{shell.command || t('Shell')}</span>
            {elapsed && <small>{elapsed}</small>}
          </div>;
          })}
          {count > shells.length && <div className="live-work-row" key="shell-tools">
            <span>{t('Shell')} {count - shells.length}</span>
          </div>}
        </>
        : <div className="live-work-row" key="shells">
          <span>{t('Shell')} {count}</span>
          {snapshot.shellJobs?.elapsedLabel
            && <small>{snapshot.shellJobs.elapsedLabel}</small>}
        </div>}
    </div>
  </div>;
}
