import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalTask, Snapshot } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { GoalSubmissionContext, useGoalAfterSubmission } from './session-goal-submission';
import { goalDisplayStatus, goalElapsedLabel, goalHasBackgroundWork, type GoalDisplayStatus } from './session-goal-presentation';

export { formatGoalDuration, goalCompletedTimeLabel, goalElapsedLabel, goalTimeLabel } from './session-goal-presentation';

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

// No strokeWidth override: the global pixel-snapped icon rule
// (`svg.lucide { stroke-width: 1px }`, 02-base.css) outranks presentation
// attributes anyway, so a per-glyph value is dead weight that would also
// violate the 1px small-glyph standard if it ever won.
function GoalGlyph({ status, working }: { status: GoalDisplayStatus; working: boolean }) {
  if (status === 'complete') return <MxIcon name="check" size={16} />;
  if (working) return <MxIcon name="loading" size={16} />;
  if (status === 'paused' || status === 'duration_reached') {
    return <MxIcon name="paused" size={16} />;
  }
  if (status === 'blocked' || status === 'usage_limited') {
    return <MxIcon name="warning" size={16} />;
  }
  return <MxIcon name="goal" size={16} />;
}

function GoalTaskGlyph({ status }: { status?: GoalTask['status'] }) {
  const name = status === 'completed' ? 'check'
    : status === 'in_progress' ? 'in-progress'
      // Dropped work is retired, not finished: an X separates it from a check
      // so a scoped-out row never reads as an accomplishment.
      : status === 'dropped' ? 'close-small'
        // Parked on the user, not stalled by us.
        : status === 'awaiting_approval' ? 'paused' : 'pending';
  return <MxIcon name={name} size={14} />;
}

export function SessionGoalHost({
  placement,
  children,
  submissionId = '',
}: {
  placement: 'composer';
  children?: ReactNode;
  submissionId?: string;
}) {
  return <GoalSubmissionContext.Provider value={submissionId}>
    <div className="session-goal-host"
      data-goal-placement={placement}>{children}</div>
  </GoalSubmissionContext.Provider>;
}

export function SessionGoalIsland({ snapshot }: { snapshot: Snapshot }) {
  const goal = useGoalAfterSubmission(snapshot.goal || null, String(snapshot.sessionId || ''));
  const active = goal?.status === 'active';
  const clock = useGoalClock(active);
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sessionId = String(snapshot.sessionId || '');
  const agentWorking = liveAgentRows(snapshot).some((agent) => !agent.queued);
  const backgroundWorking = goalHasBackgroundWork(snapshot, agentWorking);
  const displayStatus = goal ? goalDisplayStatus(goal, snapshot, agentWorking) : 'active';
  const waiting = displayStatus === 'responding'
    || (displayStatus === 'active' && (backgroundWorking
      || Boolean((snapshot.busy || snapshot.commandBusy) && !snapshot.toolApproval)));
  const activityLabel = displayStatus === 'responding' ? t('Responding')
    : displayStatus === 'paused' ? t('Paused')
      : displayStatus === 'active' ? t('Working') : undefined;

  useEffect(() => setOpen(false), [sessionId, goal?.id]);

  // Presence diagnostics (MIXDOG_DESKTOP_PERF=1): the capsule sits in the
  // composer dock, so every mount/unmount moves the transcript by its height.
  // A flip within one session names its cause — a lane frame that carried no
  // goal, or the post-submit mask — so a "goal blinked" report is attributable.
  const rawGoal = snapshot.goal || null;
  const visible = Boolean(goal);
  const presence = useRef('');
  useEffect(() => {
    const key = `${sessionId}\u0000${visible ? 'shown' : 'hidden'}`;
    const previous = presence.current;
    presence.current = key;
    if (!previous || !sessionId || previous === key) return;
    if (!previous.startsWith(`${sessionId}\u0000`)) return;
    try {
      window.mixdogDesktop?.perfLog?.(
        `goal-island ${visible ? 'shown' : 'hidden'} session=${sessionId}`
        + ` frame=${rawGoal ? `${String(rawGoal.id || '')}:${String(rawGoal.status || '')}` : 'null'}`
        + ` masked=${rawGoal && !visible ? 1 : 0}`,
      );
    } catch { /* diagnostics only */ }
  }, [rawGoal, sessionId, visible]);

  // Dismiss on any interaction outside the island (or Escape) so the drawer
  // never lingers over the transcript once attention moves elsewhere.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const elapsedLabel = goal ? goalElapsedLabel(goal, clock) : '';
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

  return <div ref={rootRef} className="session-goal-island"
    data-status={displayStatus} data-waiting={waiting ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}>
    <div className="session-goal-stack">
      <div className="session-goal-summary">
        <button type="button" className="session-goal-trigger"
          aria-expanded={open} aria-controls={drawerId}
          aria-label={t('Goal: {{objective}}', { objective })}
          onClick={() => setOpen((value) => !value)}>
          <span className="session-goal-title-region">
            <span className="session-goal-glyph" role={activityLabel ? 'img' : undefined}
              aria-label={activityLabel} title={activityLabel}><GoalGlyph status={displayStatus} working={waiting} /></span>
            <span className="session-goal-objective" title={objective}>{title}</span>
          </span>
          <span className="session-goal-meta">
            <span className="session-goal-progress">{progressLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="session-goal-time">{elapsedLabel}</span>
          </span>
        </button>
      </div>
      <div className="session-goal-drawer" aria-hidden={open ? 'false' : 'true'}>
        <div className="session-goal-drawer-clip">
          <section id={drawerId} className="session-goal-panel"
            role="region" aria-label={t('Goal tasks')}>
            <div className="session-goal-content">
              <div className="session-goal-tasks">
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
          </section>
        </div>
      </div>
    </div>
  </div>;
}
