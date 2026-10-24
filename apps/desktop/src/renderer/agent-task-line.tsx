// Work an agent handed to a session (session create, or a send to an ordinary
// session or another bot's chat), in a chat or a coding transcript: one faint
// line per piece while that session owes its report (AgentHandoffLine, under
// the handing turn's reply), its state read live from the session — working,
// or waiting for the user's approval there — and one card once its turn ends
// (AgentTaskLine, at the report row). Its details (reply, files) stay in the
// session, which the line and the card open.
import { ArrowUpRight, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import type { Handoff } from './agent-chat-place';
import { taskReportIsQuiet } from './agent-chat-place';
import { RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import { t } from './i18n';
import MarkdownBody from './MarkdownBody';
import { CopyControl } from './transcript-primitives';
import { useSessionAttentionIndex } from './session-attention-index';
import { useSessionTitle } from './session-glance-store';
import './agent-chat.css';

function openTaskSession(sessionId: string) {
  if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));
}

/** The session a line names: another bot's chat by that bot's face and name,
 *  any other session by its current title (`fallback` until the catalog
 *  holds it); and whether it waits for the user's approval now. */
function useHandoffTarget(sessionId: string, agentId: string, fallback: string) {
  const { label } = useRoomContacts(Boolean(agentId));
  const title = useSessionTitle(sessionId, fallback || t('Session'));
  const waiting = useSessionAttentionIndex().needsUser.has(sessionId);
  const member = agentId ? label(agentId) : null;
  return { member, name: member?.name ?? title, waiting };
}

/** One faint line: the dot (accent while the session works, amber while it
 *  waits for approval), the target and what it was handed, its state, Open. */
function HandoffLineView({
  sessionId,
  member,
  what,
  waiting,
}: {
  sessionId: string;
  member: ReturnType<typeof useHandoffTarget>['member'];
  what: string;
  waiting: boolean;
}) {
  return (
    <div className="mx-chat-routine-failed mx-handoff-line" role="status" data-state={waiting ? 'approval' : 'working'}>
      <span className="mx-bot-sent-dot" aria-hidden="true" />
      {member && <RoomMemberFace member={member} className="mx-bot-sent-face" />}
      <span>{`${what} · ${waiting ? t('Approval needed') : t('Working')}`}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={() => openTaskSession(sessionId)}>
        {t('Open')}
      </button>
    </div>
  );
}

/** A piece of work handed to a session that still owes its report
 *  (agent-chat-place.ts handoffLinesAt): "{name}에 보냄" for a send, the
 *  created task session's name alone. The state flips with the session's
 *  live approval wait, without a row of its own. */
export function AgentHandoffLine({ handoff }: { handoff: Omit<Handoff, 'id' | 'sendId'> }) {
  const { member, name, waiting } = useHandoffTarget(handoff.sessionId, handoff.agentId, handoff.name);
  let what = name;
  if (!handoff.created) {
    what = handoff.agentId ? t('Sent to {{name}}', { name }) : t('Session send: Sent to {{name}}', { name });
  }
  return <HandoffLineView sessionId={handoff.sessionId} member={member} what={what} waiting={waiting} />;
}

/** A turn's hand-off lines, one block in call order. */
export function AgentHandoffBlock({ handoffs }: { handoffs: readonly Handoff[] }) {
  return (
    <div className="mx-handoff-block">
      {handoffs.map((handoff) => (
        <AgentHandoffLine key={handoff.id} handoff={handoff} />
      ))}
    </div>
  );
}

/** A session's wait for the user with no hand-off line in this transcript
 *  (older history, work handed elsewhere): its name and the wait, only while
 *  that session still waits — the attention index's `needsUser`, the same
 *  decision the row renderer and the height estimates take
 *  (agent-chat-place.ts taskReportHidden). */
function AgentTaskWait({ routine }: { routine: Record<string, unknown> }) {
  const sessionId = String(routine.sessionId || '');
  const agentId = typeof routine.agentId === 'string' ? routine.agentId : '';
  const { member, name, waiting } = useHandoffTarget(sessionId, agentId, String(routine.name || ''));
  if (!waiting) return null;
  return <HandoffLineView sessionId={sessionId} member={member} what={name} waiting />;
}

/** A session's ended turn: one card in the changed-files card's frame, head
 *  and ghost button — the session's icon tile and title, or for another
 *  bot's chat that bot's face and name, with "View message" opening its
 *  answer in place (the answer stays readable without leaving the chat). */
function AgentTaskCard({ routine, status }: { routine: Record<string, unknown>; status: string }) {
  const [open, setOpen] = useState(false);
  const sessionId = String(routine.sessionId || '');
  const agentId = typeof routine.agentId === 'string' ? routine.agentId : '';
  const { label } = useRoomContacts(Boolean(agentId));
  const member = agentId ? label(agentId) : null;
  const answer = member && typeof routine.summary === 'string' ? routine.summary.trim() : '';
  const session = routine.target === 'session';
  const result = { failed: t('Failed'), cancelled: t('Cancelled') }[status] ?? t('Completed');
  const files = Array.isArray(routine.files) ? routine.files.length : 0;
  const meta = [
    session ? t('Session') : t('Task session'),
    result,
    ...(files ? [t('Turn changes: {{count}} files changed', { count: files })] : []),
  ].join(' · ');
  return (
    <section className="turn-changes-card mx-task-card" data-status={status} aria-label={t('Task session')}>
      <div className="turn-changes-head">
        {member ? (
          <RoomMemberFace member={member} className="turn-changes-icon mx-task-card-face" />
        ) : (
          <span className="turn-changes-icon" aria-hidden="true">
            <SquareTerminal size={14} />
          </span>
        )}
        <span className="turn-changes-title">
          <strong>{member?.name ?? String(routine.name || '')}</strong>
          <span className="mx-task-card-meta">
            <span className="mx-task-card-dot" aria-hidden="true" />
            <span>{meta}</span>
          </span>
        </span>
        {answer && (
          <button type="button" className="mx-routine-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('Show less') : t('View message')}
          </button>
        )}
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
      {open && answer && (
        <div className="mx-task-card-answer">
          <MarkdownBody text={answer} copyControl={CopyControl} />
        </div>
      )}
    </section>
  );
}

/** One report row (routine-result.mjs agentTaskMessage, `routine.kind: 'task'`);
 *  `routine.target: 'session'` reports a session the agent did not create,
 *  `routine.agentId` one that is another bot's chat. */
export function AgentTaskLine({ routine }: { routine: Record<string, unknown> }) {
  const status = String(routine.status || '');
  if (taskReportIsQuiet(routine)) return null;
  if (status === 'blocked') return <AgentTaskWait routine={routine} />;
  return <AgentTaskCard routine={routine} status={status} />;
}
