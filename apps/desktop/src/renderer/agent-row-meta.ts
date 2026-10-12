import type { DesktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { t } from './i18n';
import { formatWorkElapsed, timeMs } from './transcript-primitives';

/** The right-column text of an agent row, shared by the Agents pane and the
 *  composer island: time while running, otherwise the state in words. */
export function agentElapsedText(
  state: DesktopAgentActivityState,
  agent: Pick<DesktopAgentPoolRow, 'turnStartedAt' | 'startedAt'>,
  clock: number
): string {
  // Idle duration carries no information: a resting agent says only that it
  // rests. Time belongs to work.
  if (state === 'queued') return t('Queued');
  if (state === 'running') {
    const base = timeMs(agent.turnStartedAt) || timeMs(agent.startedAt);
    return base ? formatWorkElapsed(clock - base) || '0s' : '0s';
  }
  // Blocked on the user: what it waits for, never a running timer.
  if (state === 'needs-user') return t('Waiting for approval');
  if (state === 'cancel-unconfirmed') return t('Cancel unconfirmed');
  if (state === 'cancelled') return t('Cancelled');
  if (state === 'done') return t('Completed');
  if (state === 'waiting') return t('Waiting for tasks');
  if (state === 'unknown') return t('Unknown');
  return t('Idle');
}

/** 999 → "999", 128_400 → "128.4k", 1_250_000 → "1.3M". */
export function compactCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1_000) return String(n);
  let scaled = n / 1_000;
  for (const suffix of ['k', 'M', 'B']) {
    const rounded = Math.round(scaled * 10) / 10;
    if (rounded < 1_000 || suffix === 'B') return `${rounded}${suffix}`;
    scaled /= 1_000;
  }
  return String(n);
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "128.4k tokens · 48 tool calls", leaving out whichever is unknown ('' when
 *  neither is). */
export function agentUsageMeta(agent: Pick<DesktopAgentPoolRow, 'usage' | 'toolCalls'> | undefined): string {
  if (!agent) return '';
  const tokens = finiteCount(agent.usage?.totalTokens);
  const calls = finiteCount(agent.toolCalls);
  return [
    tokens === null ? '' : t('{{tokens}} tokens', { tokens: compactCount(tokens) }),
    calls === null ? '' : t('Island: {{count}} tool calls', { count: calls }),
  ]
    .filter(Boolean)
    .join(' · ');
}
