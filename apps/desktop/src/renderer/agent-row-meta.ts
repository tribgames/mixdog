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
