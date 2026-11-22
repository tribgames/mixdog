// The session panel's Goal and To-do categories, on the island's goal model.
import { ChevronDown, ChevronRight, Pause, Pencil, Play, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import type { GoalSnapshot } from './desktop-types';
import { t } from './i18n';
import type { useSessionRailFolds } from './session-rail-folds';
import { RailSection } from './session-rail-parts';
import { GoalRing, phaseName, TodoGlyph, type TodoItem, todoTaskGroups, type useSessionGoal } from './SessionGoalIsland';

type GoalModel = ReturnType<typeof useSessionGoal>;
type Folds = ReturnType<typeof useSessionRailFolds>;

function GoalState({ model }: { model: GoalModel }) {
  return (
    <>
      <GoalRing kind={model.kind} progress={model.progress} />
      <span className="session-rail-goal-state" data-state={model.kind}>
        {model.stateLabel}
      </span>
      {model.elapsedLabel && (
        <>
          <span aria-hidden="true">·</span>
          <span>{model.elapsedLabel}</span>
        </>
      )}
    </>
  );
}

export function GoalSection({ model, open, onToggle }: { model: GoalModel; open: boolean; onToggle(): void }) {
  const { goal, pending, error, terminal, active, exhausted, title, objective } = model;
  const [detail, setDetail] = useState(false);
  const [editing, setEditing] = useState<GoalSnapshot | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const cancelStop = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement | null>(null);
  // The control that opened the edit dialog (Edit, or Resume past the time budget) takes focus back.
  const editOpener = useRef<HTMLButtonElement | null>(null);
  const goalId = goal?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the goal's id is the reset trigger
  useEffect(() => {
    setDetail(false);
    setEditing(null);
    setConfirmStop(false);
  }, [goalId]);
  // As the island's stop confirmation: Cancel takes focus, and leaving it hands
  // focus back to Stop (or, once stopped, to what the line offers instead).
  const confirming = confirmStop && !terminal;
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) cancelStop.current?.focus();
    else if (wasConfirming.current) {
      (stopButton.current ?? line.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  if (!goal) return null;
  // Without a distinct short title the objective is the title itself.
  const showObjective = Boolean(objective) && Boolean(goal.title) && title !== objective;
  const iconButton = (
    label: string,
    Icon: typeof Pause,
    onClick: (button: HTMLButtonElement) => void,
    { danger = false, ref }: { danger?: boolean; ref?: (button: HTMLButtonElement | null) => void } = {}
  ) => (
    <button
      ref={ref}
      type="button"
      className="session-rail-icon"
      data-danger={danger || undefined}
      aria-label={label}
      title={label}
      disabled={pending}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
  const edit = (opener: HTMLButtonElement) => {
    editOpener.current = opener;
    setEditing({ ...goal });
  };
  return (
    <RailSection
      category="goal"
      title={t('Goal')}
      open={open}
      onToggle={onToggle}
      summary={<GoalState model={model} />}
    >
      <div ref={root} className="session-rail-goal">
        {showObjective ? (
          <button
            type="button"
            className="session-rail-row session-rail-goal-title"
            aria-expanded={detail}
            onClick={() => setDetail(!detail)}
          >
            <span className="session-rail-cut">{title}</span>
            {detail ? (
              <ChevronDown size={12} className="session-rail-cv" aria-hidden="true" />
            ) : (
              <ChevronRight size={12} className="session-rail-cv" aria-hidden="true" />
            )}
          </button>
        ) : (
          <p className="session-rail-goal-text">{title}</p>
        )}
        {showObjective && detail && <p className="session-rail-goal-text session-rail-muted">{objective}</p>}
        <div ref={line} className="session-rail-goal-line" role="status">
          <GoalState model={model} />
          <span className="session-rail-grow" />
          {terminal ? (
            <button
              type="button"
              className="session-rail-text-button"
              disabled={pending}
              onClick={() => void model.control('dismiss')}
            >
              {t('Dismiss goal')}
            </button>
          ) : (
            !confirming && (
              <>
                {iconButton(t('Edit goal'), Pencil, edit)}
                {active
                  ? iconButton(t('Pause'), Pause, () => void model.control('pause'))
                  : iconButton(t('Resume'), Play, (button) => {
                      if (exhausted) edit(button);
                      else void model.control('resume');
                    })}
                {iconButton(t('Stop goal'), Square, () => setConfirmStop(true), {
                  danger: true,
                  ref: (button) => {
                    stopButton.current = button;
                  },
                })}
                {/* A stalled Goal (paused, blocked, out of time) waits for the user: it can be let go, as on the island. */}
                {model.dismissible &&
                  iconButton(t('Dismiss goal'), X, () => void model.control('dismiss'))}
              </>
            )
          )}
        </div>
        {confirming && (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset's border and padding would change the panel.
          <div className="session-rail-goal-confirm" role="group" aria-label={t('Stop goal')}>
            <p>{t('Stop this goal? Progress is kept, but it will not resume automatically.')}</p>
            <button
              ref={cancelStop}
              type="button"
              className="session-rail-text-button"
              disabled={pending}
              onClick={() => setConfirmStop(false)}
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="session-rail-text-button"
              data-danger="true"
              disabled={pending}
              onClick={async () => {
                if (await model.control('stop')) setConfirmStop(false);
              }}
            >
              {t('Confirm stop')}
            </button>
          </div>
        )}
        {error ? (
          <p className="session-rail-note" data-tone="error" role="alert">
            {error}
          </p>
        ) : goal.blocker ? (
          <p className="session-rail-note" data-tone={model.noteTone === 'blocked' ? 'warning' : undefined}>
            {String(goal.blocker)}
          </p>
        ) : null}
      </div>
      {editing && (
        <ComposerGoalDialog
          anchor={root}
          disabled={pending}
          initialGoal={editing}
          onSave={(value) =>
            model.control('edit', { objective: value.objective, time_limit_minutes: value.timeLimitMinutes })
          }
          onClose={() => setEditing(null)}
          returnFocus={() => {
            const opener = editOpener.current;
            (opener?.isConnected ? opener : line.current?.querySelector<HTMLButtonElement>('button'))?.focus();
          }}
        />
      )}
    </RailSection>
  );
}

type TodoGroup = { key: string; name: string; items: TodoItem[] };

/** The steps grouped as the island groups them: what remains (by phase when
 *  there are two or more), then the done ones. */
export function railTodoGroups(todo: NonNullable<GoalModel['todo']>): TodoGroup[] {
  const { remaining, done, headings } = todoTaskGroups(todo);
  const groups: TodoGroup[] = [];
  if (headings) {
    for (const item of remaining) {
      const key = `phase:${item.phase}`;
      const group = groups.find((entry) => entry.key === key);
      if (group) group.items.push(item);
      else groups.push({ key, name: phaseName(todo.phases[item.phase]?.name), items: [item] });
    }
  } else if (remaining.length) {
    groups.push({ key: 'remaining', name: t('Remaining'), items: remaining });
  }
  if (done.length) groups.push({ key: 'done', name: t('Done'), items: done });
  return groups;
}

export function TodoSection({
  model,
  open,
  onToggle,
  folds,
}: {
  model: GoalModel;
  open: boolean;
  onToggle(): void;
  folds: Folds;
}) {
  const { todo, progress } = model;
  if (!todo) return null;
  const groups = railTodoGroups(todo);
  const groupOpen = (group: TodoGroup) => folds.groupOpen(group.key);
  const setAll = (value: boolean) => folds.setGroups(Object.fromEntries(groups.map((group) => [group.key, value])));
  const current = groups.flatMap((group) => group.items).find(({ task }) => task.status === 'in_progress');
  return (
    <RailSection
      category="todo"
      title={t('To-do')}
      count={`${progress.completed}/${progress.total}`}
      open={open}
      onToggle={onToggle}
      summary={current ? <span className="session-rail-cut">{String(current.task.content || '')}</span> : undefined}
      menu={[
        { id: 'unfold', label: t('Expand all'), disabled: groups.every(groupOpen), onSelect: () => setAll(true) },
        {
          id: 'fold',
          label: t('Collapse all'),
          disabled: groups.every((group) => !groupOpen(group)),
          onSelect: () => setAll(false),
        },
      ]}
    >
      {groups.map((group) => {
        const shown = groupOpen(group);
        return (
          <div key={group.key} className="session-rail-group" data-group={group.key}>
            <button
              type="button"
              className="session-rail-gh"
              aria-expanded={shown}
              onClick={() => folds.setGroups({ [group.key]: !shown })}
            >
              <span>{group.name}</span>
              {shown ? (
                <ChevronDown size={10} className="session-rail-cv" aria-hidden="true" />
              ) : (
                <ChevronRight size={10} className="session-rail-cv" aria-hidden="true" />
              )}
              <span>{group.items.length}</span>
            </button>
            {shown &&
              group.items.map(({ task }, index) => {
                const status = task.status || 'pending';
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps carry no id and stay in plan order
                    key={`${index}:${task.content}`}
                    className="session-rail-row"
                    data-status={status}
                    title={String(task.note || task.content || '')}
                  >
                    <TodoGlyph status={status} />
                    <span className="session-rail-cut">{String(task.content || '')}</span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </RailSection>
  );
}
