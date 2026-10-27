// Work an agent handed to a session (session create, or a send to an ordinary
// session or another bot's chat), in a chat or a coding transcript: one faint
// line per piece while that session owes its report (AgentHandoffLine, under
// the handing turn's reply), its state read live from the session — working,
// or waiting for the user's approval there — and one card once its turn ends
// (AgentTaskLine, at the report row). Its details (reply, files) stay in the
// session, which the line and the card open.
import { ArrowUpRight, SquareTerminal } from 'lucide-react';
import { type ReactNode, createContext, useContext, useState } from 'react';
import type { ToolApprovalDecision } from '../shared/contract';
import type { Handoff } from './agent-chat-place';
import { collapseHandoffs, taskReportIsQuiet } from './agent-chat-place';
import { RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import { handoffProgressText } from './handoff-progress-text';
import type { Approval } from './desktop-types';
import { t } from './i18n';
import MarkdownBody from './MarkdownBody';
import { QuestionCard } from './QuestionCard';
import { approvalQuestions } from './question-card-logic';
import { approvalInstanceKey } from './renderer-logic.mjs';
import { CopyControl } from './transcript-primitives';
import { useSessionAttentionIndex } from './session-attention-index';
import { useSessionTitle } from './session-glance-store';
import './agent-chat.css';

function openTaskSession(sessionId: string) {
  if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));
}

/** The chat a conversation renders and its snapshot's `handoffQuestions`:
 *  the pending ask_user questions of the sessions it handed work to
 *  (tui/session/tool-approval.mjs). Null in a read-only view. */
export const HandoffQuestionsContext = createContext<{
  chatSessionId: string;
  questions: readonly Approval[];
  agentMode: boolean;
} | null>(null);

/** A handed-off session's pending question, as the same card that session
 *  shows: answered through this chat's copy, which hands the answer to the
 *  asking session (one request, settled once wherever it is answered). The
 *  card leaves once the copy does (answered anywhere, dismissed, aborted).
 *  For the user alone: nothing of it enters this chat's transcript. */
function HandoffQuestion({ sessionId }: { sessionId: string }) {
  const context = useContext(HandoffQuestionsContext);
  const pending = context?.questions.find((question) => String(question.sessionId || '') === sessionId);
  return pending ? <HandoffQuestionCard pending={pending} /> : null;
}

/** The card of one handed-off question (`line` above it while it shows). */
function HandoffQuestionCard({ pending, line }: { pending: Approval; line?: ReactNode }) {
  const context = useContext(HandoffQuestionsContext);
  // The id this view's accepted answer settled, until the copy leaves.
  const [answered, setAnswered] = useState('');
  const id = String(pending.id ?? '');
  const questions = approvalQuestions(pending.args);
  if (!context || !id || !questions || answered === id) return null;
  const { chatSessionId } = context;
  const resolve = async (decision: ToolApprovalDecision) => {
    const accepted = await window.mixdogDesktop.resolveToolApprovalForSession(chatSessionId, id, decision);
    if (accepted === true) setAnswered(id);
    return accepted;
  };
  return (
    <>
      {line}
      <QuestionCard
        key={approvalInstanceKey(id)}
        questions={questions}
        resolve={resolve}
        agentMode={context.agentMode}
      />
    </>
  );
}

/** A group room has no hand-off lines (its log holds the members' words):
 *  the questions of sessions member `speaker` handed work to show under its
 *  words, each under the line of the session that asks, as a bot chat shows
 *  them. Answered through the room, which hands the answer to that member's
 *  copy (agent-rooms.ts approve). */
export function RoomHandoffQuestions({ speaker }: { speaker: string }) {
  const context = useContext(HandoffQuestionsContext);
  const asked = context?.questions.filter((question) => String(question.roomMember || '') === speaker) ?? [];
  if (!asked.length) return null;
  return (
    <div className="mx-handoff-block">
      {asked.map((question) => (
        <RoomHandoffQuestion key={String(question.id)} pending={question} />
      ))}
    </div>
  );
}

function RoomHandoffQuestion({ pending }: { pending: Approval }) {
  const sessionId = String(pending.sessionId || '');
  const handoff = (pending.handoff ?? {}) as { title?: unknown; agentId?: unknown };
  const { member, name } = useHandoffTarget(sessionId, String(handoff.agentId || ''), String(handoff.title || ''));
  return (
    <HandoffQuestionCard
      pending={pending}
      line={<HandoffLineView sessionId={sessionId} member={member} what={name} waiting asking />}
    />
  );
}

/** The session a line names: another bot's chat by that bot's face and name,
 *  any other session by its current title (`fallback` until the catalog
 *  holds it); and whether it waits for the user's approval now. */
function useHandoffTarget(sessionId: string, agentId: string, fallback: string) {
  const { label } = useRoomContacts(Boolean(agentId));
  const title = useSessionTitle(sessionId, fallback || t('Session'));
  const attention = useSessionAttentionIndex();
  const waiting = attention.needsUser.has(sessionId);
  // The wait is a question for the user, not an approval (as the list says).
  const asking = waiting && attention.asking.has(sessionId);
  const member = agentId ? label(agentId) : null;
  return { member, name: member?.name ?? title, waiting, asking };
}

/** One faint line: the dot (accent while the session works, amber while it
 *  waits for approval), the target and what it was handed, its state, Open. */
function HandoffLineView({
  sessionId,
  member,
  what,
  count = 1,
  waiting,
  asking = false,
  progress = '',
}: {
  sessionId: string;
  member: ReturnType<typeof useHandoffTarget>['member'];
  what: string;
  count?: number;
  waiting: boolean;
  asking?: boolean;
  progress?: string;
}) {
  let state: 'working' | 'approval' | 'question' = 'working';
  if (waiting) state = asking ? 'question' : 'approval';
  const label = { working: t('Working'), approval: t('Approval needed'), question: t('Answer needed') }[state];
  // While it works, the session's latest progress update stands for "Working",
  // one line that ellipsizes like the name.
  const update = state === 'working' ? handoffProgressText(progress) : '';
  return (
    <div className="mx-chat-routine-failed mx-handoff-line" role="status" data-state={state}>
      <span className="mx-bot-sent-dot" aria-hidden="true" />
      {member && <RoomMemberFace member={member} className="mx-bot-sent-face" />}
      <span className="mx-handoff-what">
        <span className="mx-handoff-name">{what}</span>
        {count > 1 && <span className="mx-handoff-state">{` ${t('×{{n}}', { n: count })}`}</span>}
        <span className="mx-handoff-state">{update ? ' · ' : ` · ${label}`}</span>
        {update && (
          <span className="mx-handoff-name mx-handoff-update" title={update}>
            {update}
          </span>
        )}
      </span>
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
export function AgentHandoffLine({ handoff, count = 1 }: { handoff: Omit<Handoff, 'id' | 'sendId'>; count?: number }) {
  const { member, name, waiting, asking } = useHandoffTarget(handoff.sessionId, handoff.agentId, handoff.name);
  let what = name;
  if (!handoff.created) {
    what = handoff.agentId ? t('Sent to {{name}}', { name }) : t('Session send: Sent to {{name}}', { name });
  }
  return (
    <>
      <HandoffLineView
        sessionId={handoff.sessionId}
        member={member}
        what={what}
        count={count}
        waiting={waiting}
        asking={asking}
        progress={handoff.progress}
      />
      {handoff.prompt && <HandoffQuestion sessionId={handoff.sessionId} />}
    </>
  );
}

/** A turn's hand-off lines, one block in call order. With the reply's `time`,
 *  the time and the first line share one row (time, a dot, the line); the
 *  rest stand below, aligned with the first line's start. */
export function AgentHandoffBlock({ handoffs, time }: { handoffs: readonly Handoff[]; time?: string }) {
  return (
    <div className="mx-handoff-block" data-timed={time ? 'true' : undefined}>
      {time && (
        <span className="mx-handoff-when">
          <time className="mx-chat-time">{time}</time>
          <span aria-hidden="true">·</span>
        </span>
      )}
      {collapseHandoffs(handoffs).map(({ key, handoff, count }) => (
        <AgentHandoffLine key={key} handoff={handoff} count={count} />
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
  const { member, name, waiting, asking } = useHandoffTarget(sessionId, agentId, String(routine.name || ''));
  if (!waiting) return null;
  return (
    <>
      <HandoffLineView sessionId={sessionId} member={member} what={name} waiting asking={asking} />
      <HandoffQuestion sessionId={sessionId} />
    </>
  );
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
