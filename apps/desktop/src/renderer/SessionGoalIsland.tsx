import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, GoalTask, Snapshot } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { useComposerIslandTab } from './composer-island-state';
import { useGoalAfterSubmission } from './session-goal-submission';
import {
  goalDisplayStatus,
  goalBudgetFraction,
  goalDrawerTimeLabel,
  goalElapsedHoursMinutesLabel,
  goalSegmentTimeLabel,
  goalHasBackgroundWork,
  goalStateKind,
  goalStateLabel,
  goalStatusLabel,
  goalTaskProgress,
  type GoalStateKind,
  type GoalTaskProgress,
} from './session-goal-presentation';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { useClock } from './use-clock';

export {
  formatGoalDuration,
  goalCompletedTimeLabel,
  goalElapsedLabel,
  goalTimeLabel,
} from './session-goal-presentation';

const RING_RADIUS = 6.2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The state glyph at the ring's centre; its shape names the state, so the
 *  state reads without colour. */
function GoalRingGlyph({ kind }: { kind: GoalStateKind }) {
  const common = { fill: 'currentColor', 'data-glyph': kind } as const;
  switch (kind) {
    case 'paused':
      return (
        <g {...common}>
          <rect x="5.9" y="5.5" width="1.5" height="5" rx=".5" />
          <rect x="8.6" y="5.5" width="1.5" height="5" rx=".5" />
        </g>
      );
    case 'blocked':
      return (
        <g {...common}>
          <rect x="7.25" y="4.6" width="1.5" height="4.3" rx=".7" />
          <circle cx="8" cy="11.1" r=".9" />
        </g>
      );
    case 'waiting':
      return (
        <g {...common}>
          <circle cx="5.7" cy="8" r=".95" />
          <circle cx="8" cy="8" r=".95" />
          <circle cx="10.3" cy="8" r=".95" />
        </g>
      );
    case 'complete':
      return (
        <path
          data-glyph={kind}
          d="m5.3 8.2 1.8 1.8 3.6-3.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'stopped':
      return <rect data-glyph={kind} x="6" y="6" width="4" height="4" rx=".7" fill="currentColor" />;
    default:
      return <circle data-glyph={kind} cx="8" cy="8" r="2.2" fill="currentColor" />;
  }
}

/** The Goal's one mark: a 16px ring whose arc is the finished share of the
 *  tasks (from 12 o'clock) around a glyph for the state, all in the state
 *  tint. Static: activity is named by its label, never by motion. */
function GoalRing({ kind, progress, label }: { kind: GoalStateKind; progress: GoalTaskProgress; label?: string }) {
  const fraction =
    kind === 'complete' ? 1 : progress.total > 0 ? Math.min(1, Math.max(0, progress.completed / progress.total)) : 0;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role="img" is set whenever label (the aria-label) is defined
    <span
      className="session-goal-state"
      data-state={kind}
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
    >
      <svg
        className="session-goal-ring"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <circle className="session-goal-ring-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="1.8" />
        {fraction > 0 && (
          <circle
            className="session-goal-ring-arc"
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeDasharray={`${(RING_LENGTH * fraction).toFixed(2)} ${RING_LENGTH.toFixed(2)}`}
            transform="rotate(-90 8 8)"
          />
        )}
        <GoalRingGlyph kind={kind} />
      </svg>
    </span>
  );
}

const GOAL_TASK_GLYPHS = {
  completed: 'check',
  in_progress: 'in-progress',
  // Dropped work is retired, not finished: an X separates it from a check
  // so a scoped-out row never reads as an accomplishment.
  dropped: 'close-small',
} as const;

const REMAINING_VISIBLE = 5;

function GoalTaskRow({ task, kind }: { task: GoalTask; kind: GoalStateKind }) {
  const taskStatus = task.status || 'pending';
  // The running row carries the Goal's blocker; the one parked on the user
  // asks for the answer. Both read by wash and glyph, not by a text badge.
  const stalled = taskStatus === 'in_progress' && kind === 'blocked';
  return (
    <li data-status={taskStatus} data-stalled={stalled ? 'true' : undefined}>
      <span>
        <GoalTaskGlyph status={taskStatus} stalled={stalled} />
      </span>
      <div>
        <span>{String(task.text || '')}</span>
      </div>
    </li>
  );
}

function GoalTaskGlyph({ status, stalled = false }: { status?: GoalTask['status']; stalled?: boolean }) {
  // Stalled (!) and parked on the user (...) share a ringed 14px glyph.
  if (stalled || status === 'awaiting_approval') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
        data-glyph={stalled ? 'stalled' : 'awaiting'}
      >
        <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {stalled ? (
          <g fill="currentColor">
            <rect x="7.25" y="4.6" width="1.5" height="4.3" rx=".7" />
            <circle cx="8" cy="11.1" r=".9" />
          </g>
        ) : (
          <g fill="currentColor">
            <circle cx="5.7" cy="8" r=".95" />
            <circle cx="8" cy="8" r=".95" />
            <circle cx="10.3" cy="8" r=".95" />
          </g>
        )}
      </svg>
    );
  }
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
  const [showDone, setShowDone] = useState<boolean | null>(null);
  const [showRest, setShowRest] = useState(false);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const [objectiveOverflows, setObjectiveOverflows] = useState(false);
  const longTextRef = useRef<HTMLParagraphElement | null>(null);
  const drawerId = useId();
  const doneListId = useId();
  const restListId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wasConfirming = useRef(false);
  const sessionId = String(snapshot.sessionId || '');
  const agentWorking = liveAgentRows(snapshot).some((agent) => !agent.queued);
  const backgroundWorking = goalHasBackgroundWork(snapshot, agentWorking);
  const displayStatus = goal ? goalDisplayStatus(goal, snapshot, agentWorking) : 'active';
  const waiting =
    displayStatus === 'responding' ||
    (displayStatus === 'active' &&
      (backgroundWorking || Boolean((snapshot.busy || snapshot.commandBusy) && !snapshot.toolApproval)));

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and goal id are triggers that reset the local UI state, not values read in the effect
  useEffect(() => {
    setOpen(false);
    setEditing(null);
    setConfirmStop(false);
    setError('');
    setShowDone(null);
    setShowRest(false);
    setObjectiveExpanded(false);
  }, [sessionId, goal?.id]);

  // The confirmation takes the focused Stop button's place: focus follows it
  // to Cancel, and returns to Stop when it closes.
  useEffect(() => {
    if (confirmStop) cancelRef.current?.focus();
    else if (wasConfirming.current) stopRef.current?.focus();
    wasConfirming.current = confirmStop;
  }, [confirmStop]);

  // The 24px bottom fade shows only while the content overflows and is not
  // scrolled to its end, so a final row is never obscured when nothing scrolls.
  // Runs after every render: folds and rows change the content's height.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return undefined;
    const update = () => {
      const fade =
        element.scrollHeight > element.clientHeight + 1 &&
        element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      element.dataset.fade = fade ? 'true' : 'false';
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  });

  // The "More" toggle exists only while the 3-line clamp actually hides text.
  // Measured while clamped; the drawer is display:none when closed (0 height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: objective text, open and expanded are the triggers; the measured element is read through the ref
  useLayoutEffect(() => {
    const element = longTextRef.current;
    if (!element || objectiveExpanded) return undefined;
    const measure = () => {
      if (element.clientHeight > 0) setObjectiveOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [goal?.objective, goal?.title, open, objectiveExpanded]);

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

  const elapsedLabel = goal ? goalElapsedHoursMinutesLabel(goal, clock) : '';
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
  const remainingTasks = tasks.filter((task) => task.status !== 'completed' && task.status !== 'dropped');
  const doneTasks = tasks.filter((task) => task.status === 'completed' || task.status === 'dropped');
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const droppedCount = doneTasks.length - completedCount;
  const progress = goalTaskProgress(goal);
  const progressLabel = `${progress.completed}/${progress.total}`;
  const kind = goalStateKind(goal, displayStatus);
  const stateLabel = goalStateLabel(goal, kind, displayStatus);
  const segmentTime = goalSegmentTimeLabel(goal, clock);
  const objective = String(goal.objective || '');
  const title = String(goal.title || objective || t('Goal'));
  // Without a distinct short title the objective is the title itself.
  const showObjective = Boolean(objective) && Boolean(goal.title) && title !== objective;
  const budget = goalBudgetFraction(goal, clock);
  const terminal = goal.status === 'complete' || goal.status === 'stopped';
  const exhausted = Number(goal.timeLimitMs) > 0 && Number(goal.remainingMs) === 0;
  // The first rows stay; every running or parked row always makes the cut.
  const shownIndexes = new Set<number>();
  remainingTasks.forEach((task, index) => {
    if (task.status === 'in_progress' || task.status === 'awaiting_approval') shownIndexes.add(index);
  });
  for (let index = 0; index < remainingTasks.length && shownIndexes.size < REMAINING_VISIBLE; index += 1) {
    shownIndexes.add(index);
  }
  const shownTasks = remainingTasks.filter((_, index) => shownIndexes.has(index));
  const restTasks = remainingTasks.filter((_, index) => !shownIndexes.has(index));
  // A finished list opens its done rows: they are all there is to read.
  const doneOpen = showDone ?? (kind === 'complete' && remainingTasks.length === 0);
  const noteTone = kind === 'blocked' ? 'blocked' : kind === 'waiting' ? 'waiting' : undefined;
  const confirming = confirmStop && !terminal;
  const primary = active ? 'pause' : 'resume';

  return (
    <div
      ref={rootRef}
      className="session-goal-island"
      data-status={displayStatus}
      data-state={kind}
      data-waiting={waiting ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
    >
      {/* The island segment: numbers only — the progress ring (state glyph
          inside), n/m and elapsed time (dropped when the island is narrow). */}
      <button
        type="button"
        className="session-goal-trigger"
        aria-expanded={open}
        aria-controls={drawerId}
        aria-label={t('Goal: {{objective}}, {{status}}, {{completed}} of {{total}} tasks done', {
          objective,
          status: stateLabel,
          completed: progress.completed,
          total: progress.total,
        })}
        onClick={() => setOpen(!open)}
      >
        <GoalRing kind={kind} progress={progress} label={stateLabel} />
        <span className="session-goal-meta">
          <span className="session-goal-progress">{progressLabel}</span>
          {segmentTime && <span className="session-goal-trigger-time">{segmentTime}</span>}
        </span>
      </button>
      {/* A finished Goal lets go of its segment in one click; the open tab
          carries the same action. */}
      {terminal && (
        <button
          type="button"
          className="session-goal-dismiss"
          disabled={pending}
          aria-label={t('Dismiss goal')}
          title={t('Dismiss goal')}
          onClick={() => void control('dismiss')}
        >
          <MxIcon name="close-small" size={14} />
        </button>
      )}
      {/* The Goal tab of the expanded island: the task drawer and its
          pause / edit / stop controls, or dismiss once the Goal has finished. */}
      <div className="session-goal-drawer" aria-hidden={open ? 'false' : 'true'} inert={!open}>
        {/* biome-ignore lint/a11y/noRedundantRoles: the region role is spelled out for the drawer contract the Goal tests read. */}
        <section id={drawerId} className="session-goal-panel" role="region" aria-label={t('Goal tasks')}>
          <div className="composer-island-phead">
            <span className="composer-island-tab" data-active="true">
              <GoalRing kind={kind} progress={progress} />
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
            <div ref={contentRef} className="session-goal-content">
              <div className="session-goal-details">
                <p
                  ref={showObjective ? undefined : longTextRef}
                  className="session-goal-title"
                  data-clamped={!showObjective && !objectiveExpanded ? 'true' : 'false'}
                >
                  {title}
                </p>
                {showObjective && (
                  <p
                    ref={longTextRef}
                    className="session-goal-objective-full"
                    data-clamped={objectiveExpanded ? 'false' : 'true'}
                  >
                    {objective}
                  </p>
                )}
                {(objectiveOverflows || objectiveExpanded) && (
                  <button
                    type="button"
                    className="session-goal-link"
                    aria-expanded={objectiveExpanded}
                    onClick={() => setObjectiveExpanded(!objectiveExpanded)}
                  >
                    {t(objectiveExpanded ? 'Show less' : 'Show more')}
                  </button>
                )}
              </div>
              <div className="session-goal-status" role="status">
                <span className="session-goal-statusline">
                  <span className="session-goal-statusline-state">{goalStatusLabel(goal)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{goalDrawerTimeLabel(goal, clock)}</span>
                </span>
                {budget !== null && (
                  <span className="session-goal-budget" aria-hidden="true">
                    <i style={{ width: `${Math.round(budget * 100)}%` }} />
                  </span>
                )}
              </div>
              {error ? (
                <p role="alert" className="session-goal-note" data-tone="error">
                  {error}
                </p>
              ) : goal.blocker ? (
                <p className="session-goal-note" data-tone={noteTone}>
                  {String(goal.blocker)}
                </p>
              ) : null}
              <div className="session-goal-tasks">
                {tasks.length === 0 && <p className="session-goal-empty">{t('No tasks yet.')}</p>}
                {remainingTasks.length > 0 && (
                  <div className="session-goal-group">
                    <p className="session-goal-group-label">{t('Remaining {{n}}', { n: remainingTasks.length })}</p>
                    <ul className="session-goal-task-list" aria-label={t('Goal tasks')}>
                      {shownTasks.map((task, index) => (
                        <GoalTaskRow key={String(task.id || index)} task={task} kind={kind} />
                      ))}
                    </ul>
                    {restTasks.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="session-goal-fold"
                          data-fold="rest"
                          aria-expanded={showRest}
                          aria-controls={restListId}
                          onClick={() => setShowRest(!showRest)}
                        >
                          <MxIcon name="chevron-down" size={12} />
                          {t('Rest {{n}}', { n: restTasks.length })}
                        </button>
                        <ul id={restListId} className="session-goal-task-list" hidden={!showRest}>
                          {restTasks.map((task, index) => (
                            <GoalTaskRow key={String(task.id || index)} task={task} kind={kind} />
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                {doneTasks.length > 0 && (
                  <div className="session-goal-group">
                    <button
                      type="button"
                      className="session-goal-fold"
                      data-fold="done"
                      aria-expanded={doneOpen}
                      aria-controls={doneListId}
                      onClick={() => setShowDone(!doneOpen)}
                    >
                      <MxIcon name="chevron-down" size={12} />
                      {[
                        completedCount > 0 || droppedCount === 0 ? t('Done {{n}}', { n: completedCount }) : '',
                        droppedCount > 0 ? t('{{n}} dropped', { n: droppedCount }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </button>
                    <ul id={doneListId} className="session-goal-task-list" hidden={!doneOpen}>
                      {doneTasks.map((task, index) => (
                        <GoalTaskRow key={String(task.id || index)} task={task} kind={kind} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            {/* One row under the hairline: the stop confirmation takes the
                controls' place, so nothing below the list moves or hides. */}
            <div className="session-goal-controls">
              {confirming ? (
                // biome-ignore lint/a11y/useSemanticElements: tag must stay a div; a fieldset would change layout and styling
                <div className="session-goal-confirm" role="group" aria-label={t('Stop goal')}>
                  <p className="session-goal-confirm-msg">
                    {t('Stop this goal? Progress is kept, but it will not resume automatically.')}
                  </p>
                  <div className="session-goal-actions">
                    <button
                      type="button"
                      className="session-goal-control"
                      data-quiet="true"
                      ref={cancelRef}
                      disabled={pending}
                      onClick={() => setConfirmStop(false)}
                    >
                      {t('Cancel')}
                    </button>
                    <button
                      type="button"
                      className="session-goal-control"
                      data-danger="true"
                      disabled={pending}
                      onClick={async () => {
                        if (await control('stop')) setConfirmStop(false);
                      }}
                    >
                      {t('Confirm stop')}
                    </button>
                  </div>
                </div>
              ) : terminal ? (
                <button
                  type="button"
                  className="session-goal-control"
                  data-primary="true"
                  disabled={pending}
                  onClick={() => void control('dismiss')}
                >
                  {t('Dismiss goal')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="session-goal-control"
                    data-quiet="true"
                    disabled={pending}
                    aria-label={t('Stop goal')}
                    title={t('Stop goal')}
                    ref={stopRef}
                    onClick={() => setConfirmStop(true)}
                  >
                    {t('Stop')}
                  </button>
                  <button
                    type="button"
                    ref={editRef}
                    className="session-goal-control"
                    data-quiet="true"
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
                    data-primary="true"
                    disabled={pending}
                    aria-label={t(active ? 'Pause' : 'Resume')}
                    title={t(active ? 'Pause' : 'Resume')}
                    onClick={() => {
                      if (!active && exhausted) setEditing({ ...goal });
                      else void control(primary);
                    }}
                  >
                    {t(active ? 'Pause' : 'Resume')}
                  </button>
                </>
              )}
            </div>
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
            let target: HTMLButtonElement | null;
            if (root.dataset.open !== 'true') target = root.querySelector<HTMLButtonElement>('.session-goal-trigger');
            else if (editRef.current && !editRef.current.disabled) target = editRef.current;
            else target = root.querySelector<HTMLButtonElement>('.session-goal-panel .composer-island-close');
            target?.focus();
          }}
        />
      )}
    </div>
  );
}
