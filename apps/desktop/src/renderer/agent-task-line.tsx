// An agent task session a bot created (session create): its faint
// started / waiting / result lines in the agent's chat. "Open" shows the
// task session.
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import { useApprovalDockedFor } from './approval-prompt';
import { t } from './i18n';
import './agent-chat.css';

function openTaskSession(sessionId: string) {
  if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));
}

/** One report row (routine-result.mjs agentTaskMessage, `routine.kind: 'task'`);
 *  `routine.target: 'session'` reports a session the agent did not create. */
export function AgentTaskLine({ routine }: { routine: Record<string, unknown> }) {
  const status = String(routine.status || '');
  // The same request's card is docked above the composer: it says this already.
  const docked = useApprovalDockedFor(status === 'blocked' ? String(routine.sessionId || '') : '');
  if (docked) return null;
  const name = String(routine.name || '');
  const result = { failed: t('Failed'), cancelled: t('Cancelled') }[status] ?? t('Completed');
  const session = routine.target === 'session';
  let text = `${session ? t('Session') : t('Agent task session')} · ${name} — ${result}`;
  if (status === 'started') text = t('Agent task session started');
  else if (status === 'blocked') {
    text = session
      ? `${t('Session')} · ${name} — ${t('Waiting for approval')}`
      : t('Agent task session is waiting for confirmation');
  }
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
