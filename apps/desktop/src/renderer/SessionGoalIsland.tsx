import { useEffect, useId, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, GoalTask, Snapshot } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { useComposerIslandTab } from './composer-island-state';
import { useGoalAfterSubmission } from './session-goal-submission';
import {
  goalDisplayStatus,
  goalElapsedLabel,
  goalHasBackgroundWork,
  goalStatusLabel,
  goalTimeLabel,
} from './session-goal-presentation';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { useClock } from './use-clock';

export {
  formatGoalDuration,
  goalCompletedTimeLabel,
  goalElapsedLabel,
  goalTimeLabel,
} from './session-goal-presentation';

/** Task progress as a short static bar: the island segment's leading mark.
 *  It never animates; activity is named by its label, not by motion. */
function GoalBar({ completed, total, label }: { completed: number; total: number; label?: string }) {
  const progress = total > 0 ? Math.min(1, completed / total) : 0;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role="img" is set whenever label (the aria-label) is defined
    <span
      className="session-goal-bar"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      title={label}
    >
      <i style={{ width: `${progress * 100}%` }} />
    </span>
  );
}

const GOAL_TASK_GLYPHS = {
  completed: 'check',
  in_progress: 'in-progress',
  // Dropped work is retired, not finished: an X separates it from a check
  // so a scoped-out row never reads as an accomplishment.
  dropped: 'close-small',
  // Parked on the user, not stalled by us.
  awaiting_approval: 'paused',
} as const;

function GoalTaskGlyph({ status }: { status?: GoalTask['status'] }) {
  const name = (status && GOAL_TASK_GLYPHS[status as keyof typeof GOAL_TASK_GLYPHS]) || 'pending';
  return <MxIcon name={name} size={14} />;
}

export function SessionGoalIsland({ snapshot }: { snapshot: Snapshot }) {
  const goal = useGoalAfterSubmission(snapshot.goal || null, String(snapshot.sessionId || ''));
  const active = goal?.status === 'active';
  const clock = useClock(active);
  const [open, setOpen] = useComposerIslandTab('goal');
  const [editing, setEditing] = useState<GoalSnapshot | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const drawerId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const sessionId = String(snapshot.sessionId || '');
  const agentWorking = liveAgentRows(snapshot).some((agent) => !agent.queued);
  const backgroundWorking = goalHasBackgroundWork(snapshot, agentWorking);
  const displayStatus = goal ? goalDisplayStatus(goal, snapshot, agentWorking) : 'active';
  const waiting =
    displayStatus === 'responding' ||
    (displayStatus === 'active' &&
      (backgroundWorking || Boolean((snapshot.busy || snapshot.commandBusy) && !snapshot.toolApproval)));
  let activityLabel: string | undefined;
  if (displayStatus === 'responding') activityLabel = t('Responding');
  else if (displayStatus === 'paused') activityLabel = t('Paused');
  else if (displayStatus === 'active') activityLabel = t('Working');

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and goal id are triggers that reset the local UI state, not values read in the effect
  useEffect(() => {
    setOpen(false);
    setEditing(null);
    setConfirmStop(false);
    setError('');
  }, [sessionId, goal?.id]);

  // Presence diagnostics (MIXDOG_DESKTOP_PERF=1): a flip within one session
  // names its cause — a lane frame that carried no goal, or the post-submit
  // mask — so a "goal blinked" report is attributable.
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
        `goal-island ${visible ? 'shown' : 'hidden'} session=${sessionId}` +
          ` frame=${rawGoal ? `${String(rawGoal.id || '')}:${String(rawGoal.status || '')}` : 'null'}` +
          ` masked=${rawGoal && !visible ? 1 : 0}`
      );
    } catch {
      /* diagnostics only */
    }
  }, [rawGoal, sessionId, visible]);

  // Dismiss on any interaction outside the island (or Escape) so the drawer
  // never lingers over the transcript once attention moves elsewhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is re-derived each render from the same open state
  useEffect(() => {
    if (!open || editing) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current?.closest('.composer-island') ?? rootRef.current;
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
  }, [open, editing]);

  const elapsedLabel = goal ? goalElapsedLabel(goal, clock) : '';
  const control = async (action: string, values: Record<string, unknown> = {}): Promise<boolean> => {
    if (pending || !sessionId || !goal?.id) return false;
    setPending(true);
    setError('');
    try {
      const result = await window.mixdogDesktop.invokeCapability<{ ok?: boolean }>({
        sessionId,
        capability: 'goalControl',
        args: [{ action, expectedGoalId: goal.id, ...values }],
      });
      if (result?.value?.ok !== true) throw new Error(t('Goal could not be updated.'));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setOpen(true);
      return false;
    } finally {
      setPending(false);
    }
  };
  if (!goal) return null;
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const tasksTotal = Math.max(tasks.length, Number(goal.tasksTotal) || 0);
  const tasksCompleted = Math.min(
    tasksTotal,
    Math.max(tasks.filter((task) => task.status === 'completed').length, Number(goal.tasksCompleted) || 0)
  );
  const progressLabel = `${tasksCompleted}/${tasksTotal}`;
  const title = String(goal.title || goal.objective || t('Goal'));
  const objective = String(goal.objective || '');
  const terminal = goal.status === 'complete' || goal.status === 'stopped';
  const exhausted = Number(goal.timeLimitMs) > 0 && Number(goal.remainingMs) === 0;

  return (
    <div
      ref={rootRef}
      className="session-goal-island"
      data-status={displayStatus}
      data-waiting={waiting ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
    >
      {/* The island segment: progress bar, title (dropped when the island
          is crowded), n/m. Elapsed time reads in the open Goal tab only. */}
      <button
        type="button"
        className="session-goal-trigger"
        aria-expanded={open}
        aria-controls={drawerId}
        aria-label={t('Goal: {{objective}}', { objective })}
        onClick={() => setOpen(!open)}
      >
        <GoalBar completed={tasksCompleted} total={tasksTotal} label={activityLabel} />
        <span className="session-goal-objective" title={objective}>
          {title}
        </span>
        <span className="session-goal-meta">
          <span className="session-goal-progress">{progressLabel}</span>
        </span>
      </button>
      {/* The Goal tab of the expanded island: the task drawer and its
          pause / edit / stop controls. */}
      <div className="session-goal-drawer" aria-hidden={open ? 'false' : 'true'} inert={!open}>
        {/* biome-ignore lint/a11y/noRedundantRoles: the region role is spelled out for the drawer contract the Goal tests read. */}
        <section id={drawerId} className="session-goal-panel" role="region" aria-label={t('Goal tasks')}>
          <div className="composer-island-phead">
            <span className="composer-island-tab" data-active="true">
              <GoalBar completed={tasksCompleted} total={tasksTotal} />
              <span className="session-goal-meta">
                <span className="session-goal-progress">{progressLabel}</span>
                <span className="session-goal-meta-time">
                  <span aria-hidden="true">·</span>
                  <span className="session-goal-time">{elapsedLabel}</span>
                </span>
              </span>
            </span>
            <button
              type="button"
              className="composer-island-close"
              aria-label={t('Close')}
              title={t('Close')}
              onClick={() => setOpen(false)}
            >
              <MxIcon name="close-small" size={16} />
            </button>
          </div>
          <div className="session-goal-body">
              <div className="session-goal-content">
                <div className="session-goal-details" role="status">
                  {/* The header shows the objective on one ellipsized line; the
                    open drawer is where the full text reads, wrapped. */}
                  {objective && <p className="session-goal-objective-full">{objective}</p>}
                  <span>{goalStatusLabel(goal)}</span>
                  <span>{goalTimeLabel(goal, clock)}</span>
                </div>
                <div className="session-goal-tasks">
                  {tasks.length > 0 ? (
                    <ul className="session-goal-task-list" aria-label={t('Goal tasks')}>
                      {tasks.map((task, index) => {
                        const taskStatus = task.status || 'pending';
                        return (
                          <li key={String(task.id || index)} data-status={taskStatus}>
                            <span>
                              <GoalTaskGlyph status={taskStatus} />
                            </span>
                            <div>
                              <span>{String(task.text || '')}</span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="session-goal-empty">{t('No tasks yet.')}</p>
                  )}
                </div>
                {goal.blocker ? <p className="session-goal-blocker">{String(goal.blocker)}</p> : null}
                {error && (
                  <p role="alert" className="session-goal-blocker">
                    {error}
                  </p>
                )}
                {confirmStop && !terminal && (
                  // biome-ignore lint/a11y/useSemanticElements: tag must stay a div; a fieldset would change layout and styling
                  <div className="session-goal-confirm" role="group" aria-label={t('Stop goal')}>
                    <p className="session-goal-blocker">
                      {t('Stop this goal? Progress is kept, but it will not resume automatically.')}
                    </p>
                    <div className="session-goal-actions">
                      <button
                        type="button"
                        className="composer-tool"
                        disabled={pending}
                        onClick={() => setConfirmStop(false)}
                      >
                        {t('Cancel')}
                      </button>
                      <button
                        type="button"
                        className="composer-tool"
                        disabled={pending}
                        onClick={async () => {
                          if (await control('stop')) setConfirmStop(false);
                        }}
                      >
                        {t('Confirm stop')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            {!terminal && (
              <div className="session-goal-controls">
                <button
                  type="button"
                  className="session-goal-control"
                  disabled={pending}
                  aria-label={t(active ? 'Pause' : 'Resume')}
                  title={t(active ? 'Pause' : 'Resume')}
                  onClick={() => {
                    if (!active && exhausted) setEditing({ ...goal });
                    else void control(active ? 'pause' : 'resume');
                  }}
                >
                  {t(active ? 'Pause' : 'Resume')}
                </button>
                <button
                  type="button"
                  ref={editRef}
                  className="session-goal-control"
                  disabled={pending}
                  aria-label={t('Edit goal')}
                  title={t('Edit goal')}
                  onClick={() => setEditing({ ...goal })}
                >
                  {t('Edit')}
                </button>
                <button
                  type="button"
                  className="session-goal-control"
                  disabled={pending}
                  aria-label={t('Stop goal')}
                  title={t('Stop goal')}
                  onClick={() => setConfirmStop(true)}
                >
                  {t('Stop')}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
      {editing && (
        <ComposerGoalDialog
          anchor={rootRef}
          disabled={pending}
          initialGoal={editing}
          onSave={(value) => control('edit', { ...value, revision: editing.revision })}
          onClose={() => setEditing(null)}
          returnFocus={() => {
            // The trigger is hidden while the Goal tab is open; focus lands on
            // the panel's Edit control there, and on the trigger only when the
            // tab is closed (the trigger is what shows).
            const root = rootRef.current;
            if (!root) return;
            const target =
              root.dataset.open === 'true'
                ? editRef.current && !editRef.current.disabled
                  ? editRef.current
                  : root.querySelector<HTMLButtonElement>('.session-goal-panel .composer-island-close')
                : root.querySelector<HTMLButtonElement>('.session-goal-trigger');
            target?.focus();
          }}
        />
      )}
    </div>
  );
}
