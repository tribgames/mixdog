import { t } from './i18n';

const RING_RADIUS = 5.2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

type AgentTodo = { completed: number; total: number; current?: string };

function todoCounts(todo: AgentTodo) {
  const total = Math.max(0, Number(todo.total) || 0);
  return { completed: Math.min(total, Math.max(0, Number(todo.completed) || 0)), total };
}

/** An agent's step list in words, the step in hand after it ("To-do 2 of 8 done: Rewrite the fold rules"). */
export function agentTodoLabel(todo: AgentTodo): string {
  const label = t('To-do {{completed}} of {{total}} done', todoCounts(todo));
  const current = String(todo.current || '');
  return current ? `${label}: ${current}` : label;
}

/** An agent row's step list: a small ring (finished share of the counted
 *  steps, from 12 o'clock) and n/m. Nothing when the agent has no list; a
 *  list whose steps were all dropped shows an empty ring and 0/0. */
export function AgentTodoMark({
  todo,
  id,
}: {
  todo?: AgentTodo | null;
  id?: string;
}) {
  if (!todo) return null;
  const { completed, total } = todoCounts(todo);
  const label = agentTodoLabel(todo);
  return (
    <span id={id} className="agent-todo-mark" role="img" aria-label={label} title={label}>
      <AgentTodoRing todo={todo} />
      <span aria-hidden="true">{`${completed}/${total}`}</span>
    </span>
  );
}

/** What a step ring holds at its centre: the dot of a step in hand, the check of a finished one, the cross of a
 *  dropped one. */
export type StepGlyph = 'active' | 'complete' | 'dropped';

/** A step ring, `size` px: `fraction` of it drawn from 12 o'clock over its track, its glyph at the centre. A to-do's
 *  state mark, an agent row's ring and an agent's step list share it. */
export function StepRing({
  fraction,
  glyph,
  size = 12,
}: {
  fraction: number;
  glyph?: StepGlyph | null;
  size?: number;
}) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg
      className="step-ring"
      data-state={glyph ?? undefined}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="session-goal-ring-track" cx="6" cy="6" r={RING_RADIUS} fill="none" strokeWidth="1.6" />
      {fraction > 0 && (
        <circle
          cx="6"
          cy="6"
          r={RING_RADIUS}
          {...stroke}
          strokeWidth="1.6"
          // A whole ring has no seam to round off.
          strokeDasharray={fraction < 1 ? `${(RING_LENGTH * fraction).toFixed(2)} ${RING_LENGTH.toFixed(2)}` : undefined}
          transform="rotate(-90 6 6)"
        />
      )}
      {glyph === 'active' && <circle data-glyph="active" cx="6" cy="6" r="1.65" fill="currentColor" />}
      {glyph === 'complete' && <path data-glyph="complete" d="m3.9 6.2 1.4 1.4 2.8-3" {...stroke} strokeWidth="1.3" />}
      {glyph === 'dropped' && (
        <path data-glyph="dropped" d="m4.4 4.4 3.2 3.2m0-3.2-3.2 3.2" {...stroke} strokeWidth="1.3" />
      )}
    </svg>
  );
}

/** An agent's ring alone, `size` px: the finished share of its counted steps (none for an agent with no step list).
 *  `glyph` is the agent's own state on a row of the Agents list: a finished agent's ring is whole. */
export function AgentTodoRing({
  todo,
  glyph,
  size = 12,
}: {
  todo?: AgentTodo | null;
  glyph?: StepGlyph;
  size?: number;
}) {
  const { completed, total } = todo ? todoCounts(todo) : { completed: 0, total: 0 };
  const fraction = glyph === 'complete' ? 1 : total > 0 ? completed / total : 0;
  return <StepRing fraction={fraction} glyph={glyph} size={size} />;
}

/** The step list as a figure ("8/9"). */
export function agentTodoFigure(todo: AgentTodo): string {
  const { completed, total } = todoCounts(todo);
  return `${completed}/${total}`;
}
