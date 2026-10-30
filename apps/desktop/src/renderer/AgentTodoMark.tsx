import { t } from './i18n';

const RING_RADIUS = 5.2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** An agent row's step list: a small ring (finished share of the counted
 *  steps, from 12 o'clock) and n/m. Nothing when the agent has no list; a
 *  list whose steps were all dropped shows an empty ring and 0/0. */
export function AgentTodoMark({ todo }: { todo?: { completed: number; total: number; current?: string } | null }) {
  if (!todo) return null;
  const total = Math.max(0, Number(todo.total) || 0);
  const completed = Math.min(total, Math.max(0, Number(todo.completed) || 0));
  const fraction = total > 0 ? completed / total : 0;
  const label = t('To-do {{completed}} of {{total}} done', { completed, total });
  const current = String(todo.current || '');
  return (
    <span
      className="agent-todo-mark"
      role="img"
      aria-label={current ? `${label}: ${current}` : label}
      title={current ? `${label}: ${current}` : label}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle className="session-goal-ring-track" cx="6" cy="6" r={RING_RADIUS} fill="none" strokeWidth="1.6" />
        {fraction > 0 && (
          <circle
            cx="6"
            cy="6"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray={`${(RING_LENGTH * fraction).toFixed(2)} ${RING_LENGTH.toFixed(2)}`}
            transform="rotate(-90 6 6)"
          />
        )}
      </svg>
      <span aria-hidden="true">{`${completed}/${total}`}</span>
    </span>
  );
}