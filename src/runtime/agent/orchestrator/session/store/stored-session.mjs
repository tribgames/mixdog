/**
 * A whole stored session by id, through the session record seam
 * (session-record.mjs), with `_storedSessionFromFile`'s answers: the session,
 * null for no record or one that is not this session's (corrupt, foreign,
 * an invalid log), or STORED_SESSION_UNREADABLE for a record that is there
 * and could not be read.
 */
import { STORED_SESSION_UNREADABLE, _ensureLifecycleFields, _storedSessionFromText } from './serialize.mjs';
import {
  isAbsentReadError,
  isLogRecord,
  isSessionRecordId,
  readSessionRecord,
  readSessionRecordSync,
  recordSession,
} from './session-record.mjs';

// The store's own strict legacy loader (serialize.mjs).
const legacyLoader = (ensureLifecycle) => (text, id) => _storedSessionFromText(id, text, ensureLifecycle);

function storedOf(outcome, id, ensureLifecycle) {
  const session = recordSession(outcome, id);
  if (!session) return null;
  return ensureLifecycle && isLogRecord(outcome) ? _ensureLifecycleFields(session) : session;
}

export function storedSessionSync(dir, id, ensureLifecycle = true) {
  if (!isSessionRecordId(id)) return null;
  let outcome;
  try {
    outcome = readSessionRecordSync(dir, id, { loadLegacy: legacyLoader(ensureLifecycle) });
  } catch (err) {
    return isAbsentReadError(err) ? null : STORED_SESSION_UNREADABLE;
  }
  return storedOf(outcome, id, ensureLifecycle);
}

export async function storedSessionAsync(dir, id, ensureLifecycle = true) {
  return (await storedSessionRecordAsync(dir, id, ensureLifecycle)).session;
}

/** storedSessionAsync as `{ session, logLegacy }`: `logLegacy` the base
 *  `legacy` of the log the session was read from (null for a log built from
 *  no json), undefined when the record is not a log. `facts`, `checkpoints`:
 *  see readSessionRecord. */
export async function storedSessionRecordAsync(dir, id, ensureLifecycle = true, { facts = null, checkpoints = null } = {}) {
  if (!isSessionRecordId(id)) return { session: null, logLegacy: undefined };
  let outcome;
  try {
    outcome = await readSessionRecord(dir, id, { loadLegacy: legacyLoader(ensureLifecycle), facts, checkpoints });
  } catch (err) {
    return { session: isAbsentReadError(err) ? null : STORED_SESSION_UNREADABLE, logLegacy: undefined };
  }
  const session = storedOf(outcome, id, ensureLifecycle);
  return {
    session,
    logLegacy: session && isLogRecord(outcome) ? outcome.log.legacy : undefined,
    // `facts` asked for and the record is a log: its session has no messages,
    // the facts of its messages are here (messageFacts, store-summary-index.mjs).
    ...(session && isLogRecord(outcome) && outcome.log.facts ? { facts: outcome.log.facts } : {}),
  };
}
