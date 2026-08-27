import { AlertTriangle, Check, CirclePause, CirclePlay, Pencil, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, Snapshot } from './desktop-types';
import { t } from './i18n';
import { showDesktopToast } from './notifications';

const ACTIVE_AGENT_STAGE = /^(?:connecting|requesting|streaming|tool_running|running|cancelling)$/i;

function localeName(): string {
  if (typeof document !== 'undefined' && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return 'en';
}

export function formatGoalDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.round(Number(milliseconds || 0) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const locale = localeName();
  const unit = (value: number, name: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
  return [
    days ? unit(days, 'day') : '',
    hours ? unit(hours, 'hour') : '',
    minutes || (!days && !hours) ? unit(minutes, 'minute') : '',
  ].filter(Boolean).join(' ');
}

function useGoalClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
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
  const total = Math.max(0, Number(goal.criteriaTotal) || goal.criteria?.length || 0);
  const completed = Math.max(0, Number(goal.criteriaCompleted)
    || goal.criteria?.filter((criterion) => criterion.satisfied === true).length
    || 0);
  return total >= 2 ? `${completed}/${total}` : t('in progress');
}

function goalTimeLabel(goal: GoalSnapshot, clock: number): string {
  if (goal.status === 'complete') {
    return t('{{time}} elapsed', { time: formatGoalDuration(Number(goal.timeUsedMs) || 0) });
  }
  if (goal.status !== 'active') return '';
  const deadlineAt = Number(goal.deadlineAt) || 0;
  const remaining = deadlineAt > 0
    ? Math.max(0, deadlineAt - clock)
    : Math.max(0, Number(goal.remainingMs) || 0);
  return formatGoalDuration(remaining);
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
  if (!goal) return null;

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

  const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
  return <div ref={root} className="session-goal-island"
    data-status={goal.status || 'active'} data-waiting={waiting ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}>
    <button type="button" className="session-goal-trigger"
      aria-expanded={open} aria-haspopup="dialog"
      aria-label={t('Goal: {{objective}}', { objective: String(goal.objective || '') })}
      onClick={() => setOpen((value) => !value)}>
      <span className="session-goal-glyph"><GoalGlyph status={goal.status} /></span>
      <span className="session-goal-objective">{String(goal.objective || t('Goal'))}</span>
      <span className="session-goal-separator">·</span>
      <span className="session-goal-progress">{statusLabel}</span>
      {timeLabel ? <>
        <span className="session-goal-separator">·</span>
        <span className="session-goal-time">{timeLabel}</span>
      </> : null}
    </button>
    {open ? <section className="session-goal-popover" role="dialog" aria-label={t('Goal details')}>
      <header>
        <span className="session-goal-popover-glyph"><GoalGlyph status={goal.status} /></span>
        <div>
          <strong>{String(goal.objective || t('Goal'))}</strong>
          <small>{statusLabel}{timeLabel ? ` · ${timeLabel}` : ''}</small>
        </div>
      </header>
      {criteria.length > 0 ? <div className="session-goal-criteria">
        <b>{t('Completion conditions')} {Math.max(0, Number(goal.criteriaCompleted) || 0)}/{criteria.length}</b>
        <ul>
          {criteria.map((criterion, index) => <li key={String(criterion.id || index)}
            data-satisfied={criterion.satisfied ? 'true' : 'false'}>
            <span>{criterion.satisfied ? '✓' : '○'}</span>
            <div>
              <span>{String(criterion.text || '')}</span>
              {criterion.evidence ? <small>{String(criterion.evidence)}</small> : null}
            </div>
          </li>)}
        </ul>
      </div> : <p className="session-goal-empty">{t('No completion conditions yet.')}</p>}
      {goal.progressSummary ? <p className="session-goal-summary">{String(goal.progressSummary)}</p> : null}
      {goal.blocker ? <p className="session-goal-blocker">{String(goal.blocker)}</p> : null}
      {goal.completionEvidence ? <p className="session-goal-evidence">{String(goal.completionEvidence)}</p> : null}
      <footer>
        {goal.status === 'active'
          ? <button type="button" disabled={Boolean(workingAction)} onClick={() => void control('pause')}>
            <CirclePause size={14} />{t('Pause')}
          </button>
          : goal.status !== 'complete'
            ? <button type="button" disabled={Boolean(workingAction)} onClick={() => void control('resume')}>
              <CirclePlay size={14} />{t('Resume')}
            </button>
            : <button type="button" disabled={Boolean(workingAction)} onClick={() => void control('resume')}>
              <CirclePlay size={14} />{t('Resume')}
            </button>}
        <button type="button" disabled={Boolean(workingAction)} onClick={edit}>
          <Pencil size={14} />{t('Edit')}
        </button>
        {goal.status !== 'complete' ? <button type="button" disabled={Boolean(workingAction)}
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
