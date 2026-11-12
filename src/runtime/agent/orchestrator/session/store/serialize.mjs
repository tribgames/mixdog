import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { redactSensitiveMessage } from '../sensitive-projection.mjs';
import { redactSensitiveText } from '../sensitive-values.mjs';

// Inline base64 images (tool screenshots included) are written as
// content-addressed refs, like prompt media, so session JSON stays small while
// provider lowering resolves them to the same bytes across turns and reloads.
// Inline documents (PDF, Office, text) are stored the same way as `file` refs.
// Only media the store refuses (over the size cap, disk error) or that has no
// inline bytes (URL/file-id images) is replaced with a placeholder on disk.
// Per-message disk projection shared by _sessionForDisk and the session log
// (each record's messages). Returns the SAME array reference when no
// message changed. Idempotent: already-sanitized content passes through
// unchanged, so projecting a projected message is a no-op. A value session
// `sessionId` marked sensitive (sensitive-values.mjs) is stored as a marker in
// the message's text (sensitive-projection.mjs).
export function _messagesForDisk(messages, sessionId) {
  let changed = false;
  const out = messages.map((m) => {
    const projected = _messageForDisk(m, sessionId);
    if (projected !== m) changed = true;
    return projected;
  });
  return changed ? out : messages;
}

/** One message as it is stored (the session log projects each record's
 *  messages through this): the same object when nothing changes. */
export function _messageForDisk(m, sessionId) {
  if (!m || typeof m !== 'object') return m;
  const content = sanitizeContentForStoredHistory(m.content);
  return redactSensitiveMessage(sessionId, content === m.content ? m : { ...m, content });
}

/** Top-level keys of a session that are never stored (in-flight aliases). */
export const TRANSIENT_SESSION_KEYS = Object.freeze([
  'liveTurnMessages',
  'toolApprovalHook',
  '_providerPrefixGuardState',
]);

/** The session's header as it is stored, messages aside (the session log
 *  drops TRANSIENT_SESSION_KEYS and `messages` itself). */
export function _sessionHeaderForDisk(session) {
  return _withMidTurnContextAnchor(_withSensitiveHeaderRedacted(session), session);
}

/** The header fields that hold the conversation's text (the title, from the
 *  first prompt) or a tool call's arguments (the repeat-failure guards keep
 *  each failed call's signature, its arguments included): a value the session
 *  marked sensitive is stored there as the marker, as in its messages. The
 *  same object when nothing changes. */
function _withSensitiveHeaderRedacted(session) {
  const id = session?.id;
  const text = (value) => (typeof value === 'string' ? redactSensitiveText(id, value) : value);
  const guard = (value) => {
    if (!value || typeof value !== 'object' || typeof value.sig !== 'string') return value;
    const sig = text(value.sig);
    return sig === value.sig ? value : { ...value, sig };
  };
  const changes = {};
  const title = text(session?.title);
  if (title !== session?.title) changes.title = title;
  for (const key of ['_repeatFailGuard', '_repeatArgShapeFailGuard']) {
    const next = guard(session?.[key]);
    if (next !== session?.[key]) changes[key] = next;
  }
  const history = session?._repeatFailHistory;
  if (Array.isArray(history)) {
    const next = history.map(text);
    if (next.some((entry, index) => entry !== history[index])) changes._repeatFailHistory = next;
  }
  return Object.keys(changes).length ? { ...session, ...changes } : session;
}

export function _sessionForDisk(session) {
  // Strip transient in-flight aliases askSession sets for the turn duration:
  //  - liveTurnMessages: live working transcript (so contextStatus() can
  //    estimate live context growth) — a duplicate of the working transcript
  //    that must never be serialized (mid-turn saves would bloat the file and
  //    persist a non-canonical message array).
  //  - toolApprovalHook: the askOpts.onToolApproval callback wired for the
  //    turn — a function that must never be serialized.
  //  - _providerPrefixGuardState: hashes of the live provider projection.
  //    Stored history intentionally omits inline media, so these hashes are
  //    valid only for the current runtime and must not survive a reload.
  const hasTransient =
    session &&
    typeof session === 'object' &&
    (Object.hasOwn(session, 'liveTurnMessages') ||
      Object.hasOwn(session, 'toolApprovalHook') ||
      Object.hasOwn(session, '_providerPrefixGuardState'));
  const messages = Array.isArray(session?.messages) ? session.messages : null;
  const out = messages?.length ? _messagesForDisk(messages, session.id) : messages;
  if (out === messages) {
    if (!hasTransient) return session;
    return _withMidTurnContextAnchor(_withoutTransientFields(session), session);
  }
  return _withMidTurnContextAnchor({ ..._withoutTransientFields(session), messages: out }, session);
}

function _withoutTransientFields(session) {
  const {
    liveTurnMessages: _dropLTM,
    toolApprovalHook: _dropTAH,
    _providerPrefixGuardState: _dropPPGS,
    ...rest
  } = session;
  return rest;
}

/**
 * A mid-turn save persists the PRE-TURN transcript (`session.messages` is
 * rewritten only at commit) while the provider baseline was recorded against
 * the live turn array the loop mutates and compacts. The two describe different
 * transcripts, so a cold reader that trusted that anchor — or fell back to
 * estimating the pre-turn copy — reported multiples of the real prompt size
 * (measured: 599K shown against a 500K window while the provider's own prompt
 * was 112K). Persist the snapshot as unanchored instead: readers keep the last
 * actual provider reading, and no cold projection can compact from it.
 */
function _withMidTurnContextAnchor(diskSession, session) {
  const live = session?.liveTurnMessages;
  if (!Array.isArray(live) || live === session?.messages) return diskSession;
  return {
    ...diskSession,
    contextPressureUnanchoredAfterRestart: true,
    contextPressureUnanchoredReason: 'mid_turn_snapshot',
  };
}

/**
 * Ensure generation/closed defaults on every session object.
 * Older persisted sessions predate these fields; we normalise at load and save.
 */
export function _ensureLifecycleFields(session) {
  if (typeof session.generation !== 'number') session.generation = 0;
  if (typeof session.closed !== 'boolean') session.closed = false;
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.tools)) session.tools = [];
  return session;
}

/**
 * Sentinel for "the file is THERE and could not be read" (EIO/EACCES/EBUSY…),
 * as opposed to `null` = "read fine, but the record is corrupt/foreign".
 * Callers that own retention (summary scan) must never treat the former as an
 * empty/invalid row.
 */
export const STORED_SESSION_UNREADABLE = Symbol('stored-session-unreadable');

export function _storedSessionFromFile(dir, filename, ensureLifecycle = true) {
  const storageId = _storedSessionStorageId(filename);
  if (!storageId) return null;
  let text;
  try {
    text = readFileSync(join(dir, filename), 'utf-8');
  } catch (err) {
    return _storedSessionReadFailure(err);
  }
  return _storedSessionFromText(storageId, text, ensureLifecycle);
}

/** `_storedSessionFromFile` with the read awaited. */
export async function _storedSessionFromFileAsync(dir, filename, ensureLifecycle = true) {
  const storageId = _storedSessionStorageId(filename);
  if (!storageId) return null;
  let text;
  try {
    text = await readFile(join(dir, filename), 'utf-8');
  } catch (err) {
    return _storedSessionReadFailure(err);
  }
  return _storedSessionFromText(storageId, text, ensureLifecycle);
}

function _storedSessionStorageId(filename) {
  if (!filename.endsWith('.json')) return null;
  const storageId = filename.slice(0, -5);
  return storageId && /^[A-Za-z0-9_-]+$/.test(storageId) ? storageId : null;
}

function _storedSessionReadFailure(err) {
  const code = err?.code || 'EUNKNOWN';
  // Only ENOENT/ENOTDIR is absence; everything else is present-but-
  // unreadable and must fail closed for retention decisions.
  return code === 'ENOENT' || code === 'ENOTDIR' ? null : STORED_SESSION_UNREADABLE;
}

/** `<id>.json` text → that session (the strict loader, legacy-session.mjs),
 *  with its lifecycle defaults unless `ensureLifecycle` is false; or null. */
export function _storedSessionFromText(storageId, text, ensureLifecycle = true) {
  const session = loadLegacySession(text, storageId);
  return session && ensureLifecycle ? _ensureLifecycleFields(session) : session;
}
