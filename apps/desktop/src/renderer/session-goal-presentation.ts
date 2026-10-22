import type { GoalSnapshot, Snapshot } from './desktop-types';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';

export type GoalDisplayStatus = NonNullable<GoalSnapshot['status']> | 'responding';

type GoalExecutionSnapshot = Pick<Snapshot, 'busy' | 'commandBusy' | 'toolApproval' | 'shellJobs'>;

export function goalHasBackgroundWork(snapshot: GoalExecutionSnapshot, agentWorking = false): boolean {
  return agentWorking || Number(snapshot.shellJobs?.count) > 0 || Boolean(snapshot.shellJobs?.jobs?.length);
}

// Execution and durable intent are different facts. A reply can be in flight
// while the Goal still awaits a decision; never turn that into durable approval.
export function goalDisplayStatus(
  goal: GoalSnapshot,
  snapshot: GoalExecutionSnapshot,
  agentWorking = false
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
  return new Date(completedAt).toLocaleTimeString(uiFormatLocale(), { timeStyle: 'short', ...timeFormatOptions() });
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

/** Collapsed-segment elapsed time: `12m`, or `1h 05m` from an hour; no seconds.
 *  Empty under one minute: "0m" says nothing, and the label sits inline so
 *  hiding it moves no layout. */
export function goalElapsedMinutesLabel(goal: GoalSnapshot, clock: number): string {
  const totalMinutes = Math.floor(goalElapsedMs(goal, clock) / 60_000);
  if (totalMinutes < 1) return '';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

export function goalStatusLabel(goal: GoalSnapshot): string {
  if (goal.status === 'paused') return t(goal.pauseReason === 'waiting' ? 'Waiting for your answer' : 'Paused');
  if (goal.status === 'duration_reached')
    return t(goal.timeMode === 'max' ? 'Time budget reached' : 'Requested duration reached');
  if (goal.status === 'blocked') return t('Blocked');
  if (goal.status === 'usage_limited') return t('Provider usage limit reached');
  if (goal.status === 'stopped') return t('Stopped');
  if (goal.status === 'complete') return t('Complete');
  return t('Goal state: In progress');
}

export type GoalStateKind = 'active' | 'paused' | 'blocked' | 'waiting' | 'complete' | 'stopped';

/** The one state the island shows: it picks the leading icon, the tint and
 *  whether a status label takes the title's place. */
export function goalStateKind(goal: GoalSnapshot, displayStatus: GoalDisplayStatus): GoalStateKind {
  if (displayStatus === 'complete') return 'complete';
  if (displayStatus === 'stopped') return 'stopped';
  if (displayStatus === 'paused') {
    return goal.status === 'paused' && goal.pauseReason === 'waiting' ? 'waiting' : 'paused';
  }
  if (displayStatus === 'active' || displayStatus === 'responding') return 'active';
  return 'blocked';
}

export function goalStateLabel(goal: GoalSnapshot, kind: GoalStateKind, displayStatus?: GoalDisplayStatus): string {
  if (displayStatus === 'responding') return t('Responding');
  if (kind === 'active') return t('Goal state: In progress');
  if (kind === 'paused') return t('Paused');
  if (kind === 'waiting') return t('Waiting for your answer');
  return goalStatusLabel(goal);
}

type GoalProgressCell = 'completed' | 'in_progress' | 'awaiting_approval' | 'pending';

export type GoalTaskProgress = {
  completed: number;
  total: number;
  /** GOAL_PROGRESS_CELLS cells whatever the task count: the finished share of
   *  the counted tasks (dropped excluded), rounded down so only a finished
   *  list fills them all, then one cell for the work in hand. */
  pips: GoalProgressCell[];
};

const GOAL_PROGRESS_CELLS = 5;

export function goalTaskProgress(goal: GoalSnapshot): GoalTaskProgress {
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const summaryTotal = Number(goal.tasksTotal) || 0;
  let completed: number;
  let total: number;
  if (tasks.length > 0 && tasks.length >= summaryTotal) {
    const counted = tasks.filter((task) => task.status !== 'dropped');
    completed = counted.filter((task) => task.status === 'completed').length;
    total = counted.length;
  } else {
    total = Math.max(tasks.length, summaryTotal);
    completed = Math.min(
      total,
      Math.max(tasks.filter((task) => task.status === 'completed').length, Number(goal.tasksCompleted) || 0)
    );
  }
  const filled = total > 0 ? Math.floor((completed * GOAL_PROGRESS_CELLS) / total) : 0;
  // Work that needs the user's answer outranks work in hand.
  let current: GoalProgressCell = 'pending';
  if (tasks.some((task) => task.status === 'awaiting_approval')) current = 'awaiting_approval';
  else if (tasks.some((task) => task.status === 'in_progress')) current = 'in_progress';
  const pips = Array.from({ length: GOAL_PROGRESS_CELLS }, (_, index): GoalProgressCell => {
    if (index < filled) return 'completed';
    return index === filled ? current : 'pending';
  });
  return { completed, total, pips };
}

export function goalTimeLabel(goal: GoalSnapshot, clock: number): string {
  if (goal.status === 'complete') {
    return t('{{time}} elapsed', { time: formatGoalDuration(Number(goal.timeUsedMs) || 0) });
  }
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
