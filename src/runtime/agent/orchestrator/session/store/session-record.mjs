/**
 * A session's record as every reader sees it: the log `<id>.log.jsonl` and
 * the legacy `<id>.json` beside it, resolved by the one legacy seam
 * (session-log-reader.mjs `resolveSessionRecord`). A store dir names the
 * union of both files' ids, and no reader parses either file itself: a
 * reader that needs the legacy document decoded its own way (a partial strict
 * scan) passes that decoder as the seam's `loadLegacy`.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isLifecycleUnreadable, lifecycleRecordOf } from '../lifecycle-scan.mjs';
import { PROBE_ABSENT, PROBE_PRESENT, PROBE_UNREADABLE } from './fs-probe.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { SESSION_LOG_SUFFIX } from './session-log-format.mjs';
import {
  parseSessionRecordStamp,
  resolveSessionRecord,
  resolveSessionRecordSync,
  sessionRecordStamp,
  sessionRecordStampSync,
} from './session-log-reader.mjs';

export { loadLegacySession, parseSessionRecordStamp };

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const JSON_SUFFIX = '.json';
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** The stamp of a session with neither file. */
export const ABSENT_RECORD_STAMP = 'log:-|json:-';

export function isSessionRecordId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** `{ jsonPath, logPath }` of session `id` in store dir `dir`. */
export function sessionRecordFiles(dir, id) {
  return { jsonPath: join(dir, `${id}${JSON_SUFFIX}`), logPath: join(dir, `${id}${SESSION_LOG_SUFFIX}`) };
}

/** `{ jsonPath, logPath }` of the session whose legacy record is `jsonPath`. */
export function sessionRecordFilesOf(jsonPath) {
  return { jsonPath, logPath: `${jsonPath.slice(0, -JSON_SUFFIX.length)}${SESSION_LOG_SUFFIX}` };
}

/** The session id a store dir entry names (`<id>.json` or `<id>.log.jsonl`), or null. */
export function sessionIdOfRecordName(name) {
  let id = null;
  if (name.endsWith(SESSION_LOG_SUFFIX)) id = name.slice(0, -SESSION_LOG_SUFFIX.length);
  else if (name.endsWith(JSON_SUFFIX)) id = name.slice(0, -JSON_SUFFIX.length);
  return id && SESSION_ID_RE.test(id) ? id : null;
}

/** The session ids of a store dir listing: every id with a json or a log, once, in listing order. */
export function sessionIdsOfNames(names) {
  return [...sessionRecordPresenceOfNames(names).keys()];
}

/** id → `{ log, json }` (which of its files the listing names), in listing order. */
export function sessionRecordPresenceOfNames(names) {
  const presence = new Map();
  for (const name of names) {
    const id = sessionIdOfRecordName(name);
    if (!id) continue;
    const files = presence.get(id) ?? { log: false, json: false };
    files[name.endsWith(SESSION_LOG_SUFFIX) ? 'log' : 'json'] = true;
    presence.set(id, files);
  }
  return presence;
}

/** Whether record `stamp` shows exactly the files `presence` ({ log, json }) names. */
export function stampMatchesPresence(stamp, presence) {
  const { log, json } = parseSessionRecordStamp(stamp);
  return Boolean(log) === presence.log && Boolean(json) === presence.json;
}

/**
 * Whether the files record `stamp` shows present at `files` ({ jsonPath,
 * logPath }) still have its full stats. Only those files are stat-ed: a file
 * the stamp shows absent can only appear by a create, which changes the
 * directory's stamp (the listing's own check, stampMatchesPresence).
 */
export async function presentFilesKeepStamp(files, stamp) {
  const parts = parseSessionRecordStamp(stamp);
  const kept = await Promise.all(
    [
      [parts.log, files.logPath],
      [parts.json, files.jsonPath],
    ].map(async ([part, path]) => {
      if (!part) return true;
      const st = await stat(path, { bigint: true });
      return st.ino === part.ino && st.size === part.size && st.mtimeNs === part.mtimeNs && st.ctimeNs === part.ctimeNs;
    })
  );
  return kept.every(Boolean);
}

/**
 * Resolve session `id` of `dir` through the seam (throws a failed read).
 * `stamp`, the record stamp just taken, stands in for the seam's own stats.
 */
export function readSessionRecordSync(dir, id, { loadLegacy = loadLegacySession, messages = true, stamp = null } = {}) {
  return resolveSessionRecordSync({ ...sessionRecordFiles(dir, id), loadLegacy, messages, stamp });
}

export function readSessionRecord(dir, id, { loadLegacy = loadLegacySession, messages = true, stamp = null } = {}) {
  return resolveSessionRecord({ ...sessionRecordFiles(dir, id), loadLegacy, messages, stamp });
}

/** readSessionRecord as a store-read step (store/fs-steps.mjs). */
export function* readSessionRecordStep(
  dir,
  id,
  { loadLegacy = loadLegacySession, messages = true, stamp = null } = {}
) {
  return yield ['sessionRecord', { ...sessionRecordFiles(dir, id), loadLegacy, messages, stamp }];
}

export function sessionRecordStampOfSync(dir, id) {
  return sessionRecordStampSync(sessionRecordFiles(dir, id));
}

export function sessionRecordStampOf(dir, id) {
  return sessionRecordStamp(sessionRecordFiles(dir, id));
}

/** The record stamp as a store-read step. */
export function* sessionRecordStampStep(dir, id) {
  return yield ['sessionRecordStamp', sessionRecordFiles(dir, id)];
}

/**
 * The session a resolved record speaks for, or null (absent, unreadable,
 * invalid, or a log of another session). A log resolved without messages
 * gives its header with the id and no `messages`.
 */
export function recordSession(outcome, sessionId) {
  switch (outcome?.kind) {
    case 'legacy':
    case 'diverged':
      return outcome.session ?? null;
    case 'log':
    case 'orphan':
      if (outcome.log.sessionId !== sessionId) return null;
      return outcome.session ?? { ...outcome.log.header, id: outcome.log.sessionId };
    default:
      return null;
  }
}

/** Whether the session's record came from its log (no legacy document). */
export function isLogRecord(outcome) {
  return outcome?.kind === 'log' || outcome?.kind === 'orphan';
}

/** Transcript length of a resolved session (a header-only log keeps only the count). */
export function recordMessageCount(outcome, session) {
  if (isLogRecord(outcome)) return outcome.log.messageCount;
  return Array.isArray(session?.messages) ? session.messages.length : 0;
}

/** The lifecycle verdict (`lifecycleRecordOf`) of a resolved record, or null. */
export function recordLifecycle(outcome, sessionId) {
  const session = recordSession(outcome, sessionId);
  if (!session) return null;
  const record = lifecycleRecordOf(session);
  return isLifecycleUnreadable(record) || record.id !== sessionId ? null : record;
}

/** A failed seam read: true when it proves the record absent. */
export function isAbsentReadError(err) {
  return ABSENT_CODES.has(err?.code);
}

/** `{ mtimeMs, size }` of the file that holds the record (the log, else the
 *  json), as `stat().mtimeMs` reports it; null when neither exists. */
export function recordStampFingerprint(stamp) {
  const { log, json } = parseSessionRecordStamp(stamp);
  const file = log ?? json;
  if (!file) return null;
  const mtimeMs = Number(file.mtimeNs / 1_000_000_000n) * 1e3 + Number(file.mtimeNs % 1_000_000_000n) / 1e6;
  return { mtimeMs, size: Number(file.size) };
}

// The text readers of a whole record digest and project (transcripts): the
// legacy json's own text — its strict parse is the projection's own — or
// the log's session as one JSON document.
const deferLegacy = (text) => ({ text });

function recordTextOf(outcome, sessionId) {
  switch (outcome.kind) {
    case 'absent':
      return { state: PROBE_ABSENT, text: null, legacy: false };
    case 'legacy':
    case 'diverged':
      return { state: PROBE_PRESENT, text: outcome.session.text, legacy: true };
    case 'log':
    case 'orphan': {
      const session = recordSession(outcome, sessionId);
      return { state: PROBE_PRESENT, text: session ? JSON.stringify(session) : null, legacy: false };
    }
    default:
      // An invalid log: there, and no session.
      return { state: PROBE_PRESENT, text: null, legacy: false };
  }
}

const failedText = (err) => ({
  state: isAbsentReadError(err) ? PROBE_ABSENT : PROBE_UNREADABLE,
  text: null,
  legacy: false,
});

/**
 * `{ state, text, legacy }` of session `sessionId` at `files` ({ jsonPath,
 * logPath }): `state` absent / unreadable / present; `text` null for a
 * record that holds no session; `legacy` when `text` is the json's own bytes.
 */
export function readSessionRecordTextSync(files, sessionId) {
  try {
    return recordTextOf(resolveSessionRecordSync({ ...files, loadLegacy: deferLegacy }), sessionId);
  } catch (err) {
    return failedText(err);
  }
}

export async function readSessionRecordText(files, sessionId) {
  try {
    return recordTextOf(await resolveSessionRecord({ ...files, loadLegacy: deferLegacy }), sessionId);
  } catch (err) {
    return failedText(err);
  }
}

// A json rewritten in place within one coarse filesystem tick can keep its
// size and mtime (canonical-reader.mjs RACY_STAMP_WINDOW_NS). A log cannot:
// every record it gains grows it, and every rewrite is a new file.
const RACY_STAMP_WINDOW_NS = 2_000_000_000n;

/** Whether a verdict read under record `stamp` may be cached under it. */
export function isSettledRecordStamp(stamp, nowNs = BigInt(Date.now()) * 1_000_000n) {
  if (!stamp) return false;
  const { json } = parseSessionRecordStamp(stamp);
  return !json || nowNs - json.mtimeNs > RACY_STAMP_WINDOW_NS;
}
