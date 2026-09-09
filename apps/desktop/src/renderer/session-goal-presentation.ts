import type { GoalSnapshot, Snapshot } from './desktop-types';
import { t } from './i18n';

export type GoalDisplayStatus = NonNullable<GoalSnapshot['status']> | 'responding';

type GoalExecutionSnapshot = Pick<Snapshot, 'busy' | 'commandBusy' | 'toolApproval' | 'shellJobs'>;

export function goalHasBackgroundWork(snapshot: GoalExecutionSnapshot, agentWorking = false): boolean {
  return agentWorking
    || Number(snapshot.shellJobs?.count) > 0
    || Boolean(snapshot.shellJobs?.jobs?.length);
}

// Execution and durable intent are different facts. A reply can be in flight
// while the Goal still awaits a decision; never turn that into durable approval.
export function goalDisplayStatus(
  goal: GoalSnapshot,
  snapshot: GoalExecutionSnapshot,
  agentWorking = false,
): GoalDisplayStatus {
  const status = goal.status || 'active';
  if (status !== 'active' && status !== 'paused') return status;
  const backgroundWorking = goalHasBackgroundWork(snapshot, agentWorking);
  const executing = Boolean((snapshot.busy || snapshot.commandBusy) && !snapshot.toolApproval) || backgroundWorking;
  if (status === 'paused' && executing) return 'responding';
  if (snapshot.toolApproval && !backgroundWorking) return 'paused';
  return status;
}

export function formatGoalDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function goalCompletedTimeLabel(goal: GoalSnapshot): string {
  const completedAt = Number(goal.completedAt) || 0;
  if (goal.status !== 'complete' || completedAt <= 0) return '';
  return new Date(completedAt).toLocaleTimeString(undefined, { timeStyle: 'short' });
}

function goalElapsedMs(goal: GoalSnapshot, clock: number): number {
  const snapshotUsed = Math.max(0, Number(goal.timeUsedMs) || 0);
  if (goal.status !== 'active') return snapshotUsed;
  const snapshotAt = Number(goal.snapshotAt) || 0;
  let elapsed = snapshotUsed;
  if (snapshotAt > 0) {
    elapsed += Math.max(0, clock - snapshotAt);
  }
  const deadlineAt = Number(goal.deadlineAt) || 0;
  const total = Math.max(0, Number(goal.timeLimitMs) || 0);
  if (snapshotAt <= 0 && deadlineAt > 0 && total > 0) {
    elapsed = Math.max(snapshotUsed, total - Math.max(0, deadlineAt - clock));
  }
  return total > 0 ? Math.min(total, elapsed) : elapsed;
}

export function goalElapsedLabel(goal: GoalSnapshot, clock: number): string {
  return formatGoalDuration(goalElapsedMs(goal, clock));
}

export function goalTimeLabel(goal: GoalSnapshot, clock: number): string {
  if (goal.status === 'complete') {
    return t('{{time}} elapsed', { time: formatGoalDuration(Number(goal.timeUsedMs) || 0) });
  }
  if (!['active', 'paused', 'duration_reached'].includes(String(goal.status || ''))) return '';
  const total = Math.max(0, Number(goal.timeLimitMs) || 0);
  const elapsed = goalElapsedMs(goal, clock);
  if (total <= 0) {
    return t('{{time}} elapsed', { time: formatGoalDuration(elapsed) });
  }
  const remaining = Math.max(0, total - elapsed);
  return t('{{elapsed}} / {{total}} · {{remaining}} remaining', {
    elapsed: formatGoalDuration(elapsed),
    total: formatGoalDuration(total),
    remaining: formatGoalDuration(remaining),
  });
}
