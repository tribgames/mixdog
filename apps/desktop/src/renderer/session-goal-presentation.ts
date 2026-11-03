import type { GoalSnapshot, Snapshot, TodoSnapshot } from './desktop-types';
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
  // Never above the cap, whatever an older runtime stored for a spent budget.
  const limit = Math.max(0, Number(goal.timeLimitMs) || 0);
  if (goal.status !== 'active') return limit > 0 ? Math.min(limit, snapshotUsed) : snapshotUsed;
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

/** Collapsed-segment elapsed time: localized hours/minutes, no seconds, and
 *  empty under one minute ("0m" says nothing). */
export function goalSegmentTimeLabel(goal: GoalSnapshot, clock: number): string {
  const elapsed = goalElapsedMs(goal, clock);
  return elapsed < 60_000 ? '' : hoursMinutesLabel(elapsed);
}

/** Share of the time budget used (0..1), or null for a Goal with no limit. */
export function goalBudgetFraction(goal: GoalSnapshot, clock: number): number | null {
  const total = Math.max(0, Number(goal.timeLimitMs) || 0);
  if (total <= 0) return null;
  const used = goal.status === 'complete' ? Number(goal.timeUsedMs) || 0 : goalElapsedMs(goal, clock);
  return Math.min(1, Math.max(0, used / total));
}

/** Drawer elapsed time, localized and without seconds: `3h 34m`, `18m`
 *  (ko `3시간 34분`, `18분`). Unlike the segment label it never goes empty. */
export function goalElapsedHoursMinutesLabel(goal: GoalSnapshot, clock: number): string {
  return hoursMinutesLabel(goalElapsedMs(goal, clock));
}

function hoursMinutesLabel(milliseconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? t('{{hours}}h {{minutes}}m', { hours, minutes }) : t('{{minutes}}m', { minutes });
}

/** Drawer status-line time, hours/minutes only: `18m in progress` while the
 *  Goal is active, `18m elapsed` in any other state. A Goal with a time budget
 *  keeps the elapsed / total / remaining line in the same format. */
export function goalDrawerTimeLabel(goal: GoalSnapshot, clock: number): string {
  if (goal.status === 'complete') {
    return t('{{time}} elapsed', { time: hoursMinutesLabel(Number(goal.timeUsedMs) || 0) });
  }
  const total = Math.max(0, Number(goal.timeLimitMs) || 0);
  const elapsed = goalElapsedMs(goal, clock);
  if (total > 0) {
    return t('{{elapsed}} / {{total}} · {{remaining}} remaining', {
      elapsed: hoursMinutesLabel(elapsed),
      total: hoursMinutesLabel(total),
      remaining: hoursMinutesLabel(Math.max(0, total - elapsed)),
    });
  }
  const time = hoursMinutesLabel(elapsed);
  return goal.status === 'active' || !goal.status
    ? t('{{time}} in progress', { time })
    : t('{{time}} elapsed', { time });
}

export function goalStatusLabel(goal: GoalSnapshot): string {
  if (goal.status === 'paused') return t(goal.pauseReason === 'waiting' ? 'Waiting for your answer' : 'Paused');
  if (goal.status === 'duration_reached') return t('Time budget reached');
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

export type TodoProgress = {
  /** Finished steps. Abandoned steps never count as accomplished. */
  completed: number;
  /** Steps still meant to be done: the list minus the abandoned ones. */
  total: number;
  abandoned: number;
  inProgress: boolean;
};

/** Whether the snapshot carries a step list worth a segment. */
export function todoPresent(todo: TodoSnapshot | null | undefined): boolean {
  return Boolean(todo?.phases?.some((phase) => phase.tasks?.length));
}

/** Counts for the ring and the n/m label. The runtime's own totals are the
 *  source; the flags come from the rows. */
export function todoProgress(todo: TodoSnapshot | null | undefined): TodoProgress {
  const tasks = (todo?.phases ?? []).flatMap((phase) => phase.tasks ?? []);
  const abandoned = Math.max(0, Number(todo?.abandoned) || 0);
  return {
    completed: Math.max(0, Number(todo?.completed) || 0),
    total: Math.max(0, (Number(todo?.total) || 0) - abandoned),
    abandoned,
    inProgress: tasks.some((task) => task.status === 'in_progress'),
  };
}

/** The ring state of a list shown without a Goal: finished only when something
 *  was accomplished and nothing is left. */
export function todoStateKind(progress: TodoProgress): GoalStateKind {
  if (progress.total > 0 && progress.completed >= progress.total) return 'complete';
  return 'active';
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
