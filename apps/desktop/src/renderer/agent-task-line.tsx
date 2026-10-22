// An agent task session a bot created (session create), in the agent's chat:
// nothing while it starts or works, a faint line while it waits for the user
// there, and one card once its turn ends. Its details (reply, files) stay in
// the task session, which the card opens.
import { ArrowUpRight, SquareTerminal } from 'lucide-react';
import { taskReportIsQuiet } from './agent-chat-place';
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
  const sessionId = String(routine.sessionId || '');
  // The same request's card is docked above the composer: it says this already.
  const docked = useApprovalDockedFor(status === 'blocked' ? sessionId : '');
  if (docked || taskReportIsQuiet(routine)) return null;
  const name = String(routine.name || '');
  const session = routine.target === 'session';
  if (status === 'blocked') {
    return (
      <div className="mx-chat-routine-failed" role="status">
        <span>
          {session
            ? `${t('Session')} · ${name} — ${t('Waiting for approval')}`
            : t('Agent task session is waiting for confirmation')}
        </span>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => openTaskSession(sessionId)}>
          {t('Open')}
        </button>
      </div>
    );
  }
  const result = { failed: t('Failed'), cancelled: t('Cancelled') }[status] ?? t('Completed');
  const files = Array.isArray(routine.files) ? routine.files.length : 0;
  const meta = [
    session ? t('Session') : t('Task session'),
    result,
    ...(files ? [t('Turn changes: {{count}} files changed', { count: files })] : []),
  ].join(' · ');
  // The changed-files card's frame, head, icon tile and ghost button.
  return (
    <section className="turn-changes-card mx-task-card" data-status={status} aria-label={t('Task session')}>
      <div className="turn-changes-head">
        <span className="turn-changes-icon" aria-hidden="true">
          <SquareTerminal size={14} />
        </span>
        <span className="turn-changes-title">
          <strong>{name}</strong>
          <span className="mx-task-card-meta">
            <span className="mx-task-card-dot" aria-hidden="true" />
            <span>{meta}</span>
          </span>
        </span>
        <button
          type="button"
          className="turn-changes-view"
          aria-label={t('Open session')}
          onClick={() => openTaskSession(sessionId)}
        >
          <span className="turn-changes-label">{t('Open session')}</span>
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
