// Hiding a closed agent's session from every list is the daemon's own hidden
// set (session-hidden.mjs, which its listings honour with or without a desktop);
// a desktop, when attached, follows it with the archive flag (the one sub-agent
// retention already uses) on that session alone. The session file stays; a
// send that revives the session clears both.
import {
  applySessionSidebarChange,
  readSessionSidebarState,
} from '../../../../runtime/shared/session-sidebar-host.mjs';
import {
  daemonHiddenSessions,
  forgetHidden,
  hideInDaemon,
  unhideInDaemon,
} from '../../../../runtime/shared/session-hidden.mjs';

const HIDE = Object.freeze({ archived: true, cascade: false });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Hides the ids, yielding to the event loop between the desktop's per-session
 *  writes. Resolves `{ hidden, failed }`: `failed` is `{ sessionId, reason }`
 *  for ids that stay listed (the hidden set could not be saved). A desktop that
 *  is absent or refuses leaves the daemon's own hiding in force. */
export async function hideSessions(ids) {
  if (!ids.length) return { hidden: [], failed: [] };
  try {
    await hideInDaemon(ids);
  } catch (error) {
    const reason = `could not save the hidden sessions: ${error?.message || error}`;
    return { hidden: [], failed: ids.map((sessionId) => ({ sessionId, reason })) };
  }
  for (const id of ids) {
    try {
      await applySessionSidebarChange(id, HIDE);
    } catch {
      /* no desktop attached: it reads the daemon's set when it is */
    }
    await nextTurn();
  }
  return { hidden: [...ids], failed: [] };
}

/** Session id -> stamp of every hidden session: the daemon's, plus the desktop's archive flags. */
export async function archivedSessions() {
  return { ...(await readSessionSidebarState())?.archived, ...daemonHiddenSessions() };
}

/** Forgets the hidden ids whose session was deleted (`gone(id)` resolves true),
 *  yielding to the event loop as it goes: the hidden set stays within the
 *  stored sessions. */
export async function forgetGoneHidden(gone) {
  const deleted = [];
  for (const id of Object.keys(daemonHiddenSessions())) {
    if (await gone(id)) deleted.push(id);
    await nextTurn();
  }
  return deleted.length ? forgetHidden(deleted) : 0;
}

/** A session that is used again is listed again. */
export async function revealSession(id) {
  try {
    await unhideInDaemon(id);
    if ((await readSessionSidebarState())?.archived?.[id] === undefined) return;
    await applySessionSidebarChange(id, { archived: false });
  } catch {
    /* still hidden: the next send tries again */
  }
}
