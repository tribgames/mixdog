import type { DesktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { t } from './i18n';
import { formatWorkElapsed, timeMs } from './transcript-primitives';
import { uiTimeUnit } from './ui-format';

/** The right-column text of an agent row, shared by the Agents pane and the
 *  composer island: time while running (in `format`), otherwise the state in
 *  words. */
export function agentElapsedText(
  state: DesktopAgentActivityState,
  agent: Pick<DesktopAgentPoolRow, 'turnStartedAt'>,
  clock: number,
  format: (elapsed: number) => string = formatWorkElapsed
): string {
  // Idle duration carries no information: a resting agent says only that it
  // rests. Time belongs to work.
  if (state === 'running' || state === 'waiting') {
    const base = timeMs(agent.turnStartedAt);
    if (base) return format(clock - base) || uiTimeUnit(0, 'second');
    return state === 'waiting' ? agentStateWord(state) : '';
  }
  // Blocked on the user: what it waits for, never a running timer.
  return agentStateWord(state);
}

/** Every state an agent row can be in: a key each, so a state added to the type has to be named here. */
const ROW_STATES: Record<DesktopAgentActivityState, true> = {
  queued: true,
  running: true,
  'needs-user': true,
  waiting: true,
  'cancel-unconfirmed': true,
  cancelled: true,
  failed: true,
  done: true,
  unknown: true,
  idle: true,
};
export const AGENT_ROW_STATES = Object.keys(ROW_STATES) as DesktopAgentActivityState[];

/** Every word an agent row's state column can read besides a clock: agentElapsedText in each state with no turn
 *  clock to show. */
export function agentStateWords(): string[] {
  const words = AGENT_ROW_STATES.map((state) => agentElapsedText(state, { turnStartedAt: null }, 0));
  return [...new Set(words.filter(Boolean))];
}

/** An agent's state in words. */
export function agentStateWord(state: DesktopAgentActivityState): string {
  if (state === 'queued') return t('Queued');
  if (state === 'running') return t('Running');
  if (state === 'waiting') return t('Waiting for tasks');
  if (state === 'needs-user') return t('Waiting for approval');
  if (state === 'cancel-unconfirmed') return t('Cancel unconfirmed');
  if (state === 'cancelled') return t('Cancelled');
  if (state === 'failed') return t('Failed');
  if (state === 'done') return t('Completed');
  if (state === 'unknown') return t('Unknown');
  return t('Idle');
}
