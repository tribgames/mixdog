import type { SessionSnapshot } from '../shared/contract';

export interface SessionFinalAnswer {
  id: string | number;
  at: number;
  status: 'done' | 'failed' | 'cancelled';
  text: string;
  /** The turn answered with a reaction on the user's message alone: done, with no text. */
  reacted?: boolean;
}

/** `Error.code` of a read whose session record is gone (deleted, never
 *  persisted). It survives the service IPC, so readers need not match prose. */
export const SESSION_NOT_AVAILABLE_CODE = 'SESSION_NOT_AVAILABLE';

/** The session service's `session <id> is not available` and the desktop
 *  host's `Session is not available.`, also inside a wrapper message. Only the
 *  source of a read (and hosts that predate the code) need this wording. */
const SESSION_NOT_AVAILABLE_MESSAGE = /\bsession(?: \S+)? is not available\b/i;

/** Tags a missing-session failure with SESSION_NOT_AVAILABLE_CODE. */
export function withSessionMissingCode(error: unknown): unknown {
  if (error instanceof Error && SESSION_NOT_AVAILABLE_MESSAGE.test(error.message)) {
    (error as NodeJS.ErrnoException).code = SESSION_NOT_AVAILABLE_CODE;
  }
  return error;
}

/** No later read can produce this session's answer, so waiting is pointless.
 *  The code is authoritative; the wording covers hosts that predate it. */
export function isSessionMissingError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === SESSION_NOT_AVAILABLE_CODE) return true;
  return SESSION_NOT_AVAILABLE_MESSAGE.test(error instanceof Error ? error.message : String(error));
}

/** A completed turn owns its answer by ID. A late/incomplete projection is
 *  pending, not permission to substitute a preview or an earlier answer. */
export function sessionFinalAnswer(snapshot: SessionSnapshot, startedAt: number): SessionFinalAnswer | null {
  if (!snapshot || snapshot.busy || snapshot.streamingTail || !Number.isFinite(startedAt)) return null;
  const items = snapshot.items ?? [];
  let doneIndex = items.length - 1;
  while (doneIndex >= 0 && items[doneIndex].kind !== 'turndone') doneIndex -= 1;
  if (doneIndex < 0) return null;
  const done = items[doneIndex];
  if (done.id == null || typeof done.at !== 'number' || done.at < startedAt) return null;
  // A newer prompt can arrive before the next busy roster does.
  if (items.slice(doneIndex + 1).some((item) => item.kind === 'user' || item.kind === 'assistant')) return null;
  if (done.status === 'failed' || done.status === 'cancelled') {
    return { id: done.id, at: done.at, status: done.status, text: '' };
  }
  // A reaction alone answered the turn: nothing to read, and nothing more comes.
  if (done.status === 'done' && done.finalAssistantId == null && done.reacted === true) {
    return { id: done.id, at: done.at, status: 'done', text: '', reacted: true };
  }
  if (done.status !== 'done' || done.finalAssistantId == null) return null;
  let answerIndex = doneIndex - 1;
  while (
    answerIndex >= 0 &&
    (items[answerIndex].id !== done.finalAssistantId || items[answerIndex].kind !== 'assistant')
  )
    answerIndex -= 1;
  if (answerIndex < 0) return null;
  if (items.slice(answerIndex + 1, doneIndex).some((item) => item.kind === 'turndone')) return null;
  const answer = items[answerIndex];
  if (answer.streaming === true || typeof answer.text !== 'string' || !answer.text.trim()) return null;
  return { id: done.id, at: done.at, status: 'done', text: answer.text };
}
