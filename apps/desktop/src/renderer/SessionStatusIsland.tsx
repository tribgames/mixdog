import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';

import { liveAgentRows, liveShellCount, liveShellRows } from './AgentActivityPane';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { ContextUsageIndicator, formatWorkElapsed } from './TranscriptView';

/** The readout ticks its own 1s clock only while its session has live work,
 *  so an idle island costs no timers. */
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

// A background shell's argv is not a label: `pwsh -NoProfile -Command "npm run
// build --prefix apps/desktop"` filled the card with flags, quotes and paths,
// so the ellipsis left fragments like `--prefix` behind (user: 쉘 돌 때 문장이
// --뭐 이런 걸로 깨져나옴). The row keeps the runnable SUBJECT — wrapper shell
// dropped, flags cut, paths reduced to their file name — and the Agents dock
// keeps the full command.
const SHELL_WRAPPER = /^(?:pwsh|powershell|cmd|bash|sh|zsh|env|npx)(?:\.exe)?$/i;
const SHELL_SUBJECT_WORDS = 4;

function shellCommandLabel(command: string): string {
  const source = command.replace(/\s+/g, ' ').trim();
  if (!source) return '';
  let tokens = source.split(' ');
  // A wrapper shell hides the real command behind its own switches.
  while (tokens.length > 1 && SHELL_WRAPPER.test(tokens[0].replace(/^.*[\\/]/, ''))) {
    const rest = tokens.slice(1);
    const subject = rest.findIndex((token) => !/^[-/]/.test(token));
    if (subject < 0) break;
    tokens = rest.slice(subject);
  }
  const words: string[] = [];
  for (const token of tokens) {
    const word = token.replace(/^["']+|["']+$/g, '');
    if (!word) continue;
    if (word.startsWith('-')) break;
    words.push(word.replace(/^.*[\\/]/, '') || word);
    if (words.length >= SHELL_SUBJECT_WORDS) break;
  }
  return words.join(' ') || source;
}

// ONE aggregate work readout (user: 쉘하고 에이전트는 합쳐서 작업 현황으로):
// agents and background shells share a single slot left of the context gauge,
// and the hover popover keeps the per-task breakdown. Separate Agent and
// Shell chips grew the island to three slots for one turn's work.
export function LiveWorkIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen?: () => void;
}) {
  const agents = liveAgentRows(snapshot);
  // A tool call publishes its count before the worker row lands; the larger
  // of the two is the honest number.
  const agentCount = Math.max(agents.length,
    Math.max(0, Number(snapshot.activeTools?.agent?.count) || 0));
  const shells = liveShellRows(snapshot);
  // Only background-promoted shells surface here: a foreground command is
  // still streaming inside its own transcript tool card.
  const shellCount = Math.max(liveShellCount(snapshot), shells.length);
  const total = agentCount + shellCount;
  const clock = useActivityClock(total > 0);
  const elapsed = (startedAt: number) => startedAt
    ? formatWorkElapsed(clock - startedAt) || '0s'
    : '';
  // Every row carries BOTH cells, empty ones included: the card lays its
  // label/value pair out on one shared grid, so a missing value cell would
  // slide the next row's label into the value column.
  const rows: { key: string; label: string; detail: string }[] = [];
  for (const agent of agents) {
    rows.push({
      key: agent.key,
      label: agent.role,
      detail: agent.queued
        ? t('Queued')
        : elapsed(agent.turnStartedAt || agent.startedAt) || agent.status,
    });
  }
  if (agentCount > agents.length) {
    rows.push({
      key: 'agent-tools',
      label: `${t('Agent')} ${agentCount - agents.length}`,
      detail: elapsed(Number(snapshot.activeTools?.agent?.startedAt) || 0),
    });
  }
  for (const shell of shells) {
    rows.push({
      key: shell.key,
      label: shellCommandLabel(shell.command) || t('Shell'),
      detail: elapsed(shell.startedAt),
    });
  }
  if (shellCount > shells.length) {
    rows.push({
      key: 'shell-jobs',
      label: `${t('Shell')} ${shellCount - shells.length}`,
      detail: String(snapshot.shellJobs?.elapsedLabel || ''),
    });
  }
  return <div className="session-work-indicator" data-active={total > 0 ? 'true' : 'false'}>
    {/* No count badge (user: 카운트로 바뀌지 말고 애니만): the slot keeps ONE
        fixed-width icon and live work reads as a quiet pulse on the glyph, so
        nothing in the capsule resizes mid-turn. The exact tally stays in the
        popover and in the accessible label. */}
    <button type="button" onClick={onOpen} disabled={!onOpen}
      aria-label={t('Background activity: {{count}} running', { count: total })}>
      <Activity className="session-work-icon" size={18} aria-hidden="true" />
    </button>
    {/* The card is ALWAYS mounted (user: 그냥 아예 안 나왔거든): an idle hover
        used to answer with nothing at all, so the slot read as dead chrome. */}
    <div className="live-work-popover" role="tooltip">
      {rows.length
        ? rows.map((row) => <div className="live-work-row" key={row.key}>
          <span>{row.label}</span>
          <small>{row.detail}</small>
        </div>)
        : <div className="live-work-row" key="idle">
          <span>{t('No background work')}</span>
          <small />
        </div>}
    </div>
  </div>;
}

// ONE translucent capsule pinned to the transcript's top-right corner (user:
// 아이폰 다이나믹 아일랜드 같은 섬). Both readouts used to live elsewhere —
// the gauge inside the composer footer, the Agent/Shell chips floating right
// above the composer — where they competed with the input surface for space
// (user: 채팅 입력을 가린다). The capsule frames exactly TWO slots: aggregate
// work status, then the context gauge.
export function SessionStatusIsland({ snapshot, onOpenContext, onOpenAgents }: {
  snapshot: Snapshot;
  onOpenContext(): void;
  onOpenAgents?: () => void;
}) {
  return <div className="session-status-island">
    <LiveWorkIndicator snapshot={snapshot} onOpen={onOpenAgents} />
    <ContextUsageIndicator snapshot={snapshot} onOpen={onOpenContext} />
  </div>;
}
