/** The one status a session surface (a tab, a sidebar row, a collapsed
 *  project group) shows. Strongest first: a session blocked on the user
 *  outranks a failure, a failure outranks live work, and live work outranks
 *  an unseen finished turn. */
export type SessionAttention = 'needs-you' | 'failed' | 'running' | 'unread';

export const SESSION_ATTENTION_ORDER: readonly SessionAttention[] = ['needs-you', 'failed', 'running', 'unread'];

export interface SessionAttentionSignals {
  /** A turn of the session (or of an agent it owns) waits on the user's approval. */
  needsUser?: boolean;
  /** The session or an agent it owns ended in a failure not yet cleared. */
  failed?: boolean;
  /** A turn of the session or of its agents is in flight. */
  running?: boolean;
  /** A finished turn the user has not seen. */
  unread?: boolean;
}

export function sessionAttention({
  needsUser,
  failed,
  running,
  unread,
}: SessionAttentionSignals): SessionAttention | '' {
  if (needsUser) return 'needs-you';
  if (failed) return 'failed';
  if (running) return 'running';
  if (unread) return 'unread';
  return '';
}

/** The strongest status of a group of sessions ('' when none has one). */
export function strongestSessionAttention(values: Iterable<SessionAttention | ''>): SessionAttention | '' {
  let best = SESSION_ATTENTION_ORDER.length;
  for (const value of values) {
    const rank = value ? SESSION_ATTENTION_ORDER.indexOf(value) : -1;
    if (rank >= 0 && rank < best) best = rank;
  }
  return SESSION_ATTENTION_ORDER[best] ?? '';
}
