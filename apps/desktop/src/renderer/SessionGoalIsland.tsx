import { AlertTriangle, Check, CirclePause, CirclePlay, Pencil, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, Snapshot } from './desktop-types';
import { t } from './i18n';
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
  if (goal.status !== 'active' && goal.status !== 'paused') return snapshotUsed;
  const deadlineAt = Number(goal.deadlineAt) || 0;
  const remaining = deadlineAt > 0
    ? Math.max(0, deadlineAt - clock)
    : Math.max(0, Number(goal.remainingMs) || 0);
  const total = Math.max(0, Number(goal.timeLimitMs) || snapshotUsed + remaining);
  return total > 0 ? Math.min(total, Math.max(snapshotUsed, total - remaining)) : snapshotUsed;
}

export function goalElapsedLabel(goal: GoalSnapshot, clock: number): string {
  return formatGoalDuration(goalElapsedMs(goal, clock));
}

export function goalTimeLabel(goal: GoalSnapshot, clock: number): string {
  if (goal.status === 'complete') {
    return t('{{time}} elapsed', { time: formatGoalDuration(Number(goal.timeUsedMs) || 0) });
  }
  if (goal.status !== 'active' && goal.status !== 'paused') return '';
  const deadlineAt = Number(goal.deadlineAt) || 0;
  const remaining = deadlineAt > 0
    ? Math.max(0, deadlineAt - clock)
    : Math.max(0, Number(goal.remainingMs) || 0);
  const snapshotUsed = Math.max(0, Number(goal.timeUsedMs) || 0);
  const total = Math.max(0, Number(goal.timeLimitMs) || snapshotUsed + remaining);
  if (total <= 0) {
    return t('{{time}} elapsed', { time: formatGoalDuration(snapshotUsed) });
  }
  const elapsed = goalElapsedMs(goal, clock);
  return t('{{elapsed}} / {{total}} · {{remaining}} remaining', {
    elapsed: formatGoalDuration(elapsed),
    total: formatGoalDuration(total),
    remaining: formatGoalDuration(remaining),
  });
}

function GoalGlyph({ status }: { status?: GoalSnapshot['status'] }) {
  if (status === 'complete') return <Check size={16} aria-hidden="true" />;
  if (status === 'paused') return <CirclePause size={16} aria-hidden="true" />;
  if (status === 'blocked' || status === 'budget_limited' || status === 'usage_limited') {
    return <AlertTriangle size={16} aria-hidden="true" />;
  }
  return <Target size={16} aria-hidden="true" />;
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
  if (!goal) return null;
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const tasksTotal = Math.max(tasks.length, Number(goal.tasksTotal) || 0);
  const tasksCompleted = Math.min(tasksTotal, Math.max(
    tasks.filter((task) => task.status === 'completed').length,
    Number(goal.tasksCompleted) || 0,
  ));
  const progressLabel = `${tasksCompleted}/${tasksTotal}`;
  const canComplete = tasks.length > 0
    && tasks.every((task) => task.status === 'completed')
    && tasks.some((task) => task.kind === 'verification' && task.status === 'completed');
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
      <span className="session-goal-progress">{progressLabel}</span>
      <span className="session-goal-time">{elapsedLabel}</span>
    </button>
    {open ? <section className="session-goal-popover" role="dialog" aria-label={t('Goal details')}>
      <header>
        <span className="session-goal-popover-glyph"><GoalGlyph status={goal.status} /></span>
        <div>
          <strong title={objective}>{title}</strong>
          <small>{statusLabel}{timeLabel ? ` · ${timeLabel}` : ''}</small>
        </div>
      </header>
      <div className="session-goal-content">
        <div className="session-goal-tasks">
          <b>{t('Tasks')} {tasksCompleted}/{tasksTotal}</b>
          {tasks.length > 0 ? <ul className="session-goal-task-list" aria-label={t('Goal tasks')}>
            {tasks.map((task, index) => {
              const taskStatus = task.status || 'pending';
              return <li key={String(task.id || index)} data-status={taskStatus}>
                <span>{taskStatus === 'completed' ? '✓' : taskStatus === 'in_progress' ? '◐' : '○'}</span>
                <div>
                  <span>{String(task.text || '')}</span>
                  {task.kind === 'verification' ? <small>{t('Verification')}</small> : null}
                </div>
              </li>;
            })}
          </ul> : <p className="session-goal-empty">{t('No tasks yet.')}</p>}
        </div>
        {goal.blocker ? <p className="session-goal-blocker">{String(goal.blocker)}</p> : null}
      </div>
      <footer>
        {goal.status === 'active'
          ? <button type="button" disabled={Boolean(workingAction)} onClick={() => void control('pause')}>
            <CirclePause size={14} />{t('Pause')}
          </button>
          : goal.status !== 'complete'
            ? <button type="button" disabled={Boolean(workingAction)} onClick={() => void control('resume')}>
              <CirclePlay size={14} />{t('Resume')}
            </button>
            : null}
        <button type="button" disabled={Boolean(workingAction)} onClick={edit}>
          <Pencil size={14} />{t('Edit')}
        </button>
        {goal.status !== 'complete' ? <button type="button" className="primary"
          disabled={Boolean(workingAction) || !canComplete}
          onClick={() => void control('complete')}>
          <Check size={14} />{t('Complete')}
        </button> : null}
        <button type="button" className="danger" disabled={Boolean(workingAction)}
          onClick={() => void control('clear')}>
          <Trash2 size={14} />{t('Clear')}
        </button>
      </footer>
    </section> : null}
  </div>;
}
