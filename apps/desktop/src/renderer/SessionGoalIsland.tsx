import { useEffect, useMemo, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, Snapshot } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { showDesktopToast } from './notifications';

const ACTIVE_AGENT_STAGE = /^(?:connecting|requesting|streaming|tool_running|running|cancelling)$/i;

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

function useGoalClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return clock;
}

function activeAgentWaiting(snapshot: Snapshot): boolean {
  if (liveAgentRows(snapshot).length > 0) return true;
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  if (jobs.some((job) => String(job?.status || '').toLowerCase() === 'running')) return true;
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  return workers.some((worker) =>
    ACTIVE_AGENT_STAGE.test(String(worker?.status || ''))
    || ACTIVE_AGENT_STAGE.test(String(worker?.stage || worker?.worker_stage || '')));
}

function goalStatusLabel(goal: GoalSnapshot): string {
  const status = String(goal.status || '');
  if (status === 'complete') return t('Complete');
  if (status === 'paused') return t('Paused');
  if (status === 'blocked') return t('Blocked');
  if (status === 'budget_limited') return t('Time limit reached');
  if (status === 'usage_limited') return t('Usage limited');
  return t('in progress');
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
  if (goal.status !== 'active' && goal.status !== 'paused') return '';
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

// No strokeWidth override: the global pixel-snapped icon rule
// (`svg.lucide { stroke-width: 1px }`, 02-base.css) outranks presentation
// attributes anyway, so a per-glyph value is dead weight that would also
// violate the 1px small-glyph standard if it ever won.
function GoalGlyph({ status }: { status?: GoalSnapshot['status'] }) {
  if (status === 'complete') return <MxIcon name="check" size={16} />;
  if (status === 'paused') return <MxIcon name="paused" size={16} />;
  if (status === 'blocked' || status === 'budget_limited' || status === 'usage_limited') {
    return <MxIcon name="warning" size={16} />;
  }
  return <MxIcon name="goal" size={16} />;
}

function GoalTaskGlyph({ status }: { status?: 'pending' | 'in_progress' | 'completed' }) {
  const name = status === 'completed' ? 'check'
    : status === 'in_progress' ? 'in-progress' : 'pending';
  return <MxIcon name={name} size={14} />;
}

export function SessionGoalIsland({ snapshot }: { snapshot: Snapshot }) {
  const goal = snapshot.goal || null;
  const active = goal?.status === 'active';
  const clock = useGoalClock(active);
  const [open, setOpen] = useState(false);
  const [workingAction, setWorkingAction] = useState('');
  const root = useRef<HTMLDivElement | null>(null);
  const sessionId = String(snapshot.sessionId || '');
  const waiting = Boolean(goal && active && activeAgentWaiting(snapshot));

  useEffect(() => setOpen(false), [sessionId, goal?.id]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const statusLabel = useMemo(() => goal ? goalStatusLabel(goal) : '', [goal]);
  const timeLabel = goal ? goalTimeLabel(goal, clock) : '';
  const elapsedLabel = goal ? goalElapsedLabel(goal, clock) : '';
  const completedTimeLabel = goal ? goalCompletedTimeLabel(goal) : '';
  if (!goal) return null;
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const tasksTotal = Math.max(tasks.length, Number(goal.tasksTotal) || 0);
  const tasksCompleted = Math.min(tasksTotal, Math.max(
    tasks.filter((task) => task.status === 'completed').length,
    Number(goal.tasksCompleted) || 0,
  ));
  const progressLabel = `${tasksCompleted}/${tasksTotal}`;
  const title = String(goal.title || goal.objective || t('Goal'));
  const objective = String(goal.objective || '');

  const control = async (action: string) => {
    if (!sessionId || workingAction) return;
    setWorkingAction(action);
    try {
      await window.mixdogDesktop.invokeCapability({
        capability: 'goalControl',
        args: [{ action }],
        sessionId,
      });
      if (action === 'clear') setOpen(false);
    } catch (error) {
      showDesktopToast(String((error as Error)?.message || error || t('Goal update failed')), 'error');
    } finally {
      setWorkingAction('');
    }
  };

  const edit = () => {
    window.dispatchEvent(new CustomEvent('mixdog:composer-draft', {
      detail: `/goal edit ${String(goal.objective || '')}`,
    }));
    setOpen(false);
  };

  return <div ref={root} className="session-goal-island"
    data-status={goal.status || 'active'} data-waiting={waiting ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}>
    <button type="button" className="session-goal-trigger"
      aria-expanded={open} aria-haspopup="dialog"
      aria-label={t('Goal: {{objective}}', { objective })}
      onClick={() => setOpen((value) => !value)}>
      <span className="session-goal-title-region">
        <span className="session-goal-glyph"><GoalGlyph status={goal.status} /></span>
        <span className="session-goal-objective" title={objective}>{title}</span>
      </span>
      <span className="session-goal-meta">
        <span className="session-goal-progress">{progressLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="session-goal-time">{elapsedLabel}</span>
      </span>
    </button>
    {open ? <section className="session-goal-popover" role="dialog" aria-label={t('Goal details')}>
      <header className={goal.status === 'complete' ? 'has-menu' : undefined}>
        <div>
          <strong title={objective}>{title}</strong>
          <small>{[statusLabel, timeLabel, completedTimeLabel].filter(Boolean).join(' · ')}</small>
        </div>
        {goal.status === 'complete' ? <details className="session-goal-menu">
          <summary aria-label={t('Actions')}>
            <MxIcon name="more" size={16} />
          </summary>
          <div role="menu">
            <button type="button" role="menuitem" disabled={Boolean(workingAction)}
              onClick={() => void control('clear')}>
              <MxIcon name="delete" size={14} />{t('Delete')}
            </button>
          </div>
        </details> : null}
      </header>
      <div className="session-goal-content">
        <div className="session-goal-tasks">
          <b>{t('Tasks')}<span className="session-goal-task-count">{tasksCompleted}/{tasksTotal}</span></b>
          {tasks.length > 0 ? <ul className="session-goal-task-list" aria-label={t('Goal tasks')}>
            {tasks.map((task, index) => {
              const taskStatus = task.status || 'pending';
              return <li key={String(task.id || index)} data-status={taskStatus}>
                <span><GoalTaskGlyph status={taskStatus} /></span>
                <div>
                  <span>{String(task.text || '')}</span>
                </div>
              </li>;
            })}
          </ul> : <p className="session-goal-empty">{t('No tasks yet.')}</p>}
        </div>
        {goal.blocker ? <p className="session-goal-blocker">{String(goal.blocker)}</p> : null}
      </div>
      <footer>
        <button type="button" disabled={Boolean(workingAction)} onClick={edit}>
          <MxIcon name="edit" size={14} />{t('Edit goal')}
        </button>
        {goal.status === 'complete'
          ? <span className="session-goal-complete" role="status">
            <MxIcon name="check" size={14} />{t('Complete')}
          </span>
          : <button type="button" className="session-goal-stop" disabled={Boolean(workingAction)}
            onClick={() => void control('clear')}>
            <MxIcon name="stop" size={12} />{t('Stop goal')}
          </button>}
      </footer>
    </section> : null}
  </div>;
}
