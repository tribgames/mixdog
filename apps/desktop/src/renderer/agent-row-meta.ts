import {
  desktopAgentFailureReason,
  type DesktopAgentActivityState,
  type DesktopAgentFailureReason,
} from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { t } from './i18n';
import { formatWorkElapsed, timeMs } from './transcript-primitives';

/** The short reason word shown beside "Failed". */
export function agentFailureReasonText(reason: DesktopAgentFailureReason | ''): string {
  if (reason === 'process-restart') return t('Process restart');
  if (reason === 'stalled') return t('Stalled');
  return reason ? t('Error') : '';
}

/** What a failed row says: "Failed · <reason>". */
export function agentFailedText(agent: unknown): string {
  const reason = agentFailureReasonText(desktopAgentFailureReason(agent));
  return reason ? t('Failed · {{reason}}', { reason }) : t('Failed');
}

/** The right-column text of an agent row, shared by the Agents pane and the
 *  composer island: time while running, otherwise the state in words. */
export function agentElapsedText(
  state: DesktopAgentActivityState,
  agent: Pick<DesktopAgentPoolRow, 'turnStartedAt' | 'startedAt' | 'status' | 'stage' | 'failureReason'>,
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
  if (state === 'failed') return agentFailedText(agent);
  if (state === 'done') return t('Completed');
  if (state === 'waiting') return t('Waiting for tasks');
  if (state === 'unknown') return t('Unknown');
  return t('Idle');
}
