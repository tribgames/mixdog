// A coding task session an agent created (session create): its faint
// started / waiting / result lines in the agent's chat, and its "작업" rows
// under the agent's contact. "Open" shows the task session.
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import { t } from './i18n';
import './agent-chat.css';

function openTaskSession(sessionId: string) {
  if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));
}

/** One report row (routine-result.mjs agentTaskMessage, `routine.kind: 'task'`). */
export function AgentTaskLine({ routine }: { routine: Record<string, unknown> }) {
  const status = String(routine.status || '');
  const name = String(routine.name || '');
  const result = { failed: t('Failed'), cancelled: t('Cancelled') }[status] ?? t('Completed');
  const text =
    status === 'started'
      ? t('Task started')
      : status === 'blocked'
        ? t('Task is waiting for confirmation')
        : `${t('Task')} · ${name} — ${result}`;
  return (
    <div className="mx-chat-routine-failed" role="status">
      <span>{text}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={() => openTaskSession(String(routine.sessionId || ''))}>
        {t('Open')}
      </button>
    </div>
  );
}

/** The newest task sessions `agentId` created, as rows under its contact. */
export function AgentTaskRows({
  sessions,
  agentId,
  onOpenSession,
}: {
  sessions: readonly DesktopSessionSummary[];
  agentId: string;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const rows = sessions
    .filter((session) => session.taskAgent === agentId && !session.archived)
    .sort((left, right) => (right.activityAt || right.updatedAt) - (left.activityAt || left.updatedAt))
    .slice(0, 3);
  return rows.map((session) => {
    const title = sessionSummaryTitle(session, t('Untitled session'));
    return (
      <li key={session.id} className="agent-task-row" data-kind="task">
        <button
          type="button"
          className="mx-chat-routine-failed"
          onClick={() => onOpenSession?.(session.id, title, session.id)}
        >
          <span>{t('Task')}</span>
          <span aria-hidden="true">·</span>
          <span>{title}</span>
        </button>
      </li>
    );
  });
}
