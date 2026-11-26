import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { liveAgentRows } from './AgentActivityPane';
import type { GoalSnapshot, Snapshot, TodoSnapshot, TodoStatus, TodoTask } from './desktop-types';
import { t } from './i18n';
import { StepRing } from './AgentTodoMark';
import { MxIcon } from './MxIcon';
import { useComposerIslandTab } from './composer-island-state';
import { useMobileBack } from './mobile-back';
import { useSurfaceActive } from './surface-activity';
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
  todoPresent,
  todoProgress,
  todoStateKind,
  type GoalStateKind,
  type TodoProgress,
} from './session-goal-presentation';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { IslandPanelHead } from './IslandPanelFoot';
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

export function GoalRing({
  kind,
  progress,
  label,
}: {
  kind: GoalStateKind;
  progress: Pick<TodoProgress, 'completed' | 'total'>;
  label?: string;
}) {
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

const TODO_GLYPHS = {
  completed: 'complete',
  in_progress: 'active',
  // Abandoned work is retired, not finished: a cross separates it from a check
  // so a scoped-out row never reads as an accomplishment.
  abandoned: 'dropped',
} as const;

const REMAINING_VISIBLE = 5;

/** The runtime names a plan's unnamed phase "Tasks" (todo-list.mjs); that
 *  one is shown in the user's language, a phase the agent named as written. */
export function phaseName(name: unknown): string {
  const text = String(name || '');
  return text === 'Tasks' ? t('Tasks') : text;
}

function todoStatusText(status: TodoStatus): string {
  switch (status) {
    case 'completed':
      return t('Done');
    case 'abandoned':
      return t('Dropped');
    case 'in_progress':
      return t('In progress');
    default:
      return '';
  }
}

function TodoRow({ task }: { task: TodoTask }) {
  const status = task.status || 'pending';
  const statusText = todoStatusText(status);
  // The title takes the full row; its note sits under it as a muted line,
  // the full text on hover.
  const note = String(task.note || '');
  return (
    <li data-status={status}>
      <span>
        <TodoGlyph status={status} />
      </span>
      <div>
        <span>
          {statusText && <span className="sr-only">{statusText}: </span>}
          {String(task.content || '')}
        </span>
        {note && (
          <small className="session-goal-task-note" title={note}>
            {note}
          </small>
        )}
      </div>
    </li>
  );
}

export type TodoItem = { task: TodoTask; phase: number };

/** Rows in plan order; with headings, each phase's first row follows its name. */
function TodoRows({
  items,
  phases,
  headings,
}: {
  items: TodoItem[];
  phases: TodoSnapshot['phases'];
  headings: boolean;
}) {
  return (
    <>
      {items.map(({ task, phase }, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps carry no id and stay in plan order; the rows hold no state
        <Fragment key={`${index}:${task.content}`}>
          {headings && (index === 0 || items[index - 1].phase !== phase) && (
            <li className="session-goal-phase" role="presentation">
              {phaseName(phases[phase]?.name)}
            </li>
          )}
          <TodoRow task={task} />
        </Fragment>
      ))}
    </>
  );
}

/** A step's state mark: a quiet ring while the step waits, the ring and its dot in the state's ink while it is in
 *  hand, the check or the cross alone once it is over. */
export function TodoGlyph({ status }: { status: TodoStatus }) {
  const glyph = (status && TODO_GLYPHS[status as keyof typeof TODO_GLYPHS]) || null;
  return <StepRing fraction={1} glyph={glyph} size={12} />;
}

/** A plan's steps in plan order, split into what remains and what is done
 *  (completed or dropped); `headings` when two or more phases hold steps. */
export function todoTaskGroups(todo: TodoSnapshot): { remaining: TodoItem[]; done: TodoItem[]; headings: boolean } {
  const tasks: TodoItem[] = todo.phases.flatMap((phase, index) => phase.tasks.map((task) => ({ task, phase: index })));
  return {
    remaining: tasks.filter(({ task }) => task.status !== 'completed' && task.status !== 'abandoned'),
    done: tasks.filter(({ task }) => task.status === 'completed' || task.status === 'abandoned'),
    headings: todo.phases.filter((phase) => phase.tasks.length > 0).length >= 2,
  };
}

/** The remaining steps a list shows at once and the `rest` it folds: the
 *  first few stay, and every working step always makes the cut. */
export function todoRemainingSplit(remaining: TodoItem[]): { shown: TodoItem[]; rest: TodoItem[] } {
  const shownIndexes = new Set<number>();
  remaining.forEach(({ task }, index) => {
    if (task.status === 'in_progress') shownIndexes.add(index);
  });
  for (let index = 0; index < remaining.length && shownIndexes.size < REMAINING_VISIBLE; index += 1) {
    shownIndexes.add(index);
  }
  return {
    shown: remaining.filter((_, index) => shownIndexes.has(index)),
    rest: remaining.filter((_, index) => !shownIndexes.has(index)),
  };
}

/** The done fold's name: how many steps were completed, and how many dropped. */
export function todoDoneLabel(done: TodoItem[]): string {
  const completedCount = done.filter(({ task }) => task.status === 'completed').length;
  const abandonedCount = done.length - completedCount;
  return [
    completedCount > 0 || abandonedCount === 0 ? t('Done {{n}}', { n: completedCount }) : '',
    abandonedCount > 0 ? t('{{n}} dropped', { n: abandonedCount }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The step list: remaining rows (the first few, working ones
 *  always, the rest folded) and a fold for the finished and dropped ones. */
function TodoList({ todo, finishedOpenByDefault }: { todo: TodoSnapshot; finishedOpenByDefault: boolean }) {
  const [showDone, setShowDone] = useState<boolean | null>(null);
  const [showRest, setShowRest] = useState(false);
  const doneListId = useId();
  const restListId = useId();
  const { remaining, done, headings } = todoTaskGroups(todo);
  const { shown, rest } = todoRemainingSplit(remaining);
  // A finished list opens its done rows: they are all there is to read.
  const doneOpen = showDone ?? (finishedOpenByDefault && remaining.length === 0);
  return (
    <div className="session-goal-tasks">
      {remaining.length > 0 && (
        <div className="session-goal-group">
          <p className="session-goal-group-label">{t('Remaining {{n}}', { n: remaining.length })}</p>
          <ul className="session-goal-task-list" aria-label={t('To-do')}>
            <TodoRows items={shown} phases={todo.phases} headings={headings} />
          </ul>
          {rest.length > 0 && (
            <>
              <button
                type="button"
                className="session-goal-fold"
                data-fold="rest"
                aria-expanded={showRest}
                aria-controls={restListId}
                onClick={() => setShowRest(!showRest)}
              >
                {t('Rest {{n}}', { n: rest.length })}
                <MxIcon name="chevron-down" size={12} />
              </button>
              <ul id={restListId} className="session-goal-task-list" hidden={!showRest}>
                <TodoRows items={rest} phases={todo.phases} headings={headings} />
              </ul>
            </>
          )}
        </div>
      )}
      {done.length > 0 && (
        <div className="session-goal-group">
          <button
            type="button"
            className="session-goal-fold"
            data-fold="done"
            aria-expanded={doneOpen}
            aria-controls={doneListId}
            onClick={() => setShowDone(!doneOpen)}
          >
            {todoDoneLabel(done)}
            <MxIcon name="chevron-down" size={12} />
          </button>
          <ul id={doneListId} className="session-goal-task-list" hidden={!doneOpen}>
            <TodoRows items={done} phases={todo.phases} headings={headings} />
          </ul>
        </div>
      )}
    </div>
  );
}

/** The 24px bottom fade shows only while the content overflows and is not
 *  scrolled to its end, so a final row is never obscured when nothing scrolls.
 *  Runs after every render: folds and rows change the content's height. */
function useBottomFade(ref: { current: HTMLElement | null }) {
  useLayoutEffect(() => {
    const element = ref.current;
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
}

/** Presence diagnostics (MIXDOG_DESKTOP_PERF=1): a flip within one session
 *  names its cause — a lane frame that carried no goal, or the post-submit
 *  mask — so a "goal blinked" report is attributable. */
function useGoalPresenceDiagnostics(sessionId: string, rawGoal: GoalSnapshot | null, visible: boolean) {
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
}

/** The "More" toggle exists only while the 3-line clamp actually hides text; the drawer is display:none when closed (0 height). */
function measureOverflow(
  ref: { readonly current: HTMLElement | null },
  expanded: boolean,
  setOverflows: (overflows: boolean) => void
): (() => void) | undefined {
  const element = ref.current;
  if (!element || expanded) return undefined;
  const measure = () => {
    if (element.clientHeight > 0) setOverflows(element.scrollHeight > element.clientHeight + 1);
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
}

/** Dismiss on any interaction outside the island (or Escape) so the drawer never lingers over the transcript. Inactive
 *  (off-screen conversation) it listens to nothing: those presses and keys belong to the shown conversation. */
function useDismissOnOutsideInteraction(
  rootRef: { readonly current: HTMLElement | null },
  armed: boolean,
  dismiss: () => void
) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!armed) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current?.closest('.composer-island') ?? rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      dismissRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [armed, rootRef]);
}

/** A session's Goal and step list as the island and the session panel show
 *  them, and the goal controls (pause, resume, edit, stop, dismiss) both send. */
export function useSessionGoal(snapshot: Snapshot) {
  const goal = useGoalAfterSubmission(snapshot.goal || null, String(snapshot.sessionId || ''));
  const todo = todoPresent(snapshot.todo) ? (snapshot.todo as TodoSnapshot) : null;
  const active = goal?.status === 'active';
  const clock = useClock(active);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sessionId = String(snapshot.sessionId || '');
  const { agentWorkers, agentJobs } = snapshot;
  const agentWorking = useMemo(
    () => liveAgentRows({ agentWorkers, agentJobs }).some((agent) => !agent.queued),
    [agentWorkers, agentJobs]
  );
  const backgroundWorking = goalHasBackgroundWork(snapshot, agentWorking);
  const displayStatus = goal ? goalDisplayStatus(goal, snapshot, agentWorking) : 'active';
  const waiting =
    displayStatus === 'responding' ||
    (displayStatus === 'active' &&
      (backgroundWorking || Boolean((snapshot.busy || snapshot.commandBusy) && !snapshot.toolApproval)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and goal id are the reset triggers
  useEffect(() => {
    setError('');
  }, [sessionId, goal?.id]);
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
      return false;
    } finally {
      setPending(false);
    }
  };
  const progress = todoProgress(todo);
  const kind = goal ? goalStateKind(goal, displayStatus) : todoStateKind(progress);
  const stateLabel = goal
    ? goalStateLabel(goal, kind, displayStatus)
    : t(kind === 'complete' ? 'Complete' : 'In progress');
  const objective = String(goal?.objective || '');
  const shortTitle = String(goal?.title || '');
  return {
    // A title that is only the objective cut short ("Tidy the…") says less than the objective: surfaces read
    // the objective in its place.
    cutObjective:
      Boolean(objective) &&
      shortTitle !== objective &&
      shortTitle.endsWith('…') &&
      objective.startsWith(shortTitle.slice(0, -1).trimEnd()),
    goal,
    todo,
    sessionId,
    active,
    clock,
    pending,
    error,
    control,
    displayStatus,
    waiting,
    progress,
    kind,
    stateLabel,
    objective,
    title: String(goal?.title || objective || t('Goal')),
    elapsedLabel: goal ? goalElapsedHoursMinutesLabel(goal, clock) : '',
    terminal: goal?.status === 'complete' || goal?.status === 'stopped',
    // A stalled Goal (paused, blocked, usage limited, time budget reached)
    // waits for the user and clears like a finished one.
    dismissible: Boolean(goal) && goal?.status !== 'active',
    // The time budget ran out: Resume first asks for a new limit (the edit dialog).
    exhausted: Number(goal?.timeLimitMs) > 0 && Number(goal?.remainingMs) === 0,
    noteTone: kind === 'blocked' || kind === 'waiting' ? kind : undefined,
  };
}

export function SessionGoalIsland({ snapshot }: { snapshot: Snapshot }) {
  const {
    goal,
    todo,
    sessionId,
    active,
    clock,
    pending,
    error,
    control: sendControl,
    displayStatus,
    waiting,
    progress,
    kind,
    stateLabel,
    objective,
    cutObjective,
    title,
    elapsedLabel,
    terminal,
    dismissible,
    exhausted,
    noteTone,
  } = useSessionGoal(snapshot);
  const [open, setOpen] = useComposerIslandTab('goal');
  const [editing, setEditing] = useState<GoalSnapshot | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const [objectiveOverflows, setObjectiveOverflows] = useState(false);
  const longTextRef = useRef<HTMLParagraphElement | null>(null);
  const drawerId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wasConfirming = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and goal id are triggers that reset the local UI state, not values read in the effect
  useEffect(() => {
    setOpen(false);
    setEditing(null);
    setConfirmStop(false);
    setObjectiveExpanded(false);
  }, [sessionId, goal?.id]);

  useEffect(() => {
    if (!open) setConfirmStop(false);
  }, [open]);

  useEffect(() => {
    if (confirmStop) {
      if (open) cancelRef.current?.focus();
    } else if (wasConfirming.current && open) stopRef.current?.focus();
    wasConfirming.current = confirmStop;
  }, [confirmStop, open]);

  useBottomFade(contentRef);

  // The "More" toggle exists only while the 3-line clamp actually hides text.
  // Measured while clamped; the drawer is display:none when closed (0 height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: objective text, open and expanded are the triggers; the measured element is read through the ref
  useLayoutEffect(
    () => measureOverflow(longTextRef, objectiveExpanded, setObjectiveOverflows),
    [goal?.objective, goal?.title, open, objectiveExpanded]
  );

  useGoalPresenceDiagnostics(sessionId, snapshot.goal || null, Boolean(goal) || Boolean(todo));

  const surfaceActive = useSurfaceActive();
  useDismissOnOutsideInteraction(rootRef, open && !editing && surfaceActive, () => setOpen(false));
  useMobileBack(open, () => setOpen(false));

  // A refused control opens the tab, where its reason shows.
  const control = async (action: string, values: Record<string, unknown> = {}): Promise<boolean> => {
    const ok = await sendControl(action, values);
    if (!ok && !pending && sessionId && goal?.id) setOpen(true);
    return ok;
  };
  if (!goal && !todo) return null;
  // A Goal without a step list has no count to show; the ring stays empty.
  // A list whose steps were all dropped still shows its 0/0.
  const progressLabel = todo ? `${progress.completed}/${progress.total}` : '';
  const segmentTime = goal ? goalSegmentTimeLabel(goal, clock) : '';
  // Without a distinct short title the objective is the title itself.
  const showObjective = Boolean(objective) && Boolean(goal?.title) && title !== objective && !cutObjective;
  const budget = goal ? goalBudgetFraction(goal, clock) : null;
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
        aria-label={
          goal
            ? t('Goal: {{objective}}, {{status}}, {{completed}} of {{total}} tasks done', {
                objective,
                status: stateLabel,
                completed: progress.completed,
                total: progress.total,
              })
            : t('To-do {{completed}} of {{total}} done', { completed: progress.completed, total: progress.total })
        }
        onClick={() => setOpen(!open)}
      >
        <GoalRing kind={kind} progress={progress} label={stateLabel} />
        <span className="session-goal-meta">
          {progressLabel && <span className="session-goal-progress">{progressLabel}</span>}
          {segmentTime && <span className="session-goal-trigger-time">{segmentTime}</span>}
        </span>
      </button>
      {/* A finished or stalled Goal lets go of its segment in one click; a
          finished one also carries the action in the open tab. */}
      {dismissible && (
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
        <section
          id={drawerId}
          className="session-goal-panel"
          // biome-ignore lint/a11y/noRedundantRoles: the region role is spelled out for the drawer contract the Goal tests read.
          role="region"
          aria-label={t(goal ? 'Goal tasks' : 'To-do')}
        >
          <IslandPanelHead
            chip={
              <>
                <GoalRing kind={kind} progress={progress} />
                <span className="session-goal-meta">
                  {!goal && <span className="session-goal-tab-label">{t('To-do')}</span>}
                  {progressLabel && <span className="session-goal-progress">{progressLabel}</span>}
                  {goal && (
                    <span className="session-goal-meta-time">
                      <span aria-hidden="true">·</span>
                      <span className="session-goal-time">{elapsedLabel}</span>
                    </span>
                  )}
                </span>
              </>
            }
            onClose={() => setOpen(false)}
          />
          <div className="session-goal-body">
            <div ref={contentRef} className="session-goal-content">
              {goal && (
                <>
                  <div className="session-goal-details">
                    <p
                      ref={showObjective ? undefined : longTextRef}
                      className="session-goal-title"
                      data-clamped={!showObjective && !objectiveExpanded ? 'true' : 'false'}
                    >
                      {cutObjective ? objective : title}
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
                </>
              )}
              {todo && (
                <TodoList
                  key={`${sessionId}:${goal?.id || ''}`}
                  todo={todo}
                  finishedOpenByDefault={Boolean(goal) && kind === 'complete'}
                />
              )}
            </div>
            {/* One row under the hairline: the stop confirmation takes the
                controls' place, so nothing below the list moves or hides. */}
            {goal && (
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
            )}
          </div>
        </section>
      </div>
      {editing && (
        <ComposerGoalDialog
          anchor={rootRef}
          disabled={pending}
          initialGoal={editing}
          onSave={(value) =>
            control('edit', { objective: value.objective, time_limit_minutes: value.timeLimitMinutes })
          }
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
