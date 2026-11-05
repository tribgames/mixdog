/**
 * Session log replay (format: session-log-format.mjs) and the one legacy seam.
 *
 * Replay reads every line. A line that is not a complete record of ours is
 * skipped (a torn write from a crash); the records that count must carry the
 * sequence numbers 0, 1, 2, … without a gap, so a lost record is never
 * skipped over: replay stops at the gap and reports `damage`. The transcript
 * is rebuilt from the last `compacted` record in that sequence; header
 * patches apply from the start.
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { holdsNoData } from '../../../../shared/atomic-file.mjs';
import {
  RECORD,
  SESSION_LOG_SUFFIX,
  applyMessageRecord,
  applyPatch,
  decodeRecord,
  fileFingerprint,
  isMessageRecord,
  lengthAfter,
  sameFingerprint,
  sha1Hex,
} from './session-log-format.mjs';

const NEWLINE = 0x0a;

/**
 * Replay a log's bytes. `messages: false` (the header scan) keeps only the
 * message count. Returns:
 *   valid        false when no `session` + `compacted` pair opens the log
 *   logId, sessionId, prev, legacy (base fingerprint or null)
 *   seq          sequence number of the last record replayed
 *   header       session fields without messages
 *   messages     (full replay only)
 *   messageCount transcript length after replay
 *   size         byte length of the log
 *   tornTail     {offset,length} of bytes after the last newline, or null
 *   skipped      [{offset,length}] lines that held no record
 *   damage       {offset,expectedSeq,foundSeq|null,reason} where replay stopped, or null
 *   replayFrom   sequence number of the `compacted` record the transcript starts at
 */
export function parseSessionLog(bytes, { messages: wantMessages = true } = {}) {
  const result = {
    valid: false,
    logId: null,
    sessionId: null,
    prev: null,
    legacy: null,
    seq: -1,
    header: null,
    messages: wantMessages ? [] : undefined,
    messageCount: 0,
    size: bytes.length,
    tornTail: null,
    skipped: [],
    damage: null,
    replayFrom: -1,
  };
  const accepted = [];
  let length = 0;
  let lastCompacted = -1;
  for (let pos = 0; pos < bytes.length; ) {
    const nl = bytes.indexOf(NEWLINE, pos);
    if (nl < 0) {
      result.tornTail = { offset: pos, length: bytes.length - pos };
      break;
    }
    let record = null;
    try {
      record = decodeRecord(JSON.parse(bytes.toString('utf8', pos, nl)));
    } catch {
      record = null;
    }
    if (!record) {
      result.skipped.push({ offset: pos, length: nl + 1 - pos });
      pos = nl + 1;
      continue;
    }
    const expected = accepted.length;
    // The base is written whole (one atomic file), so its second record is
    // always the history: anything else there is not a log of ours.
    const misplaced =
      record.s !== expected ||
      (expected === 0 && record.t !== RECORD.SESSION) ||
      (expected === 1 && record.t !== RECORD.COMPACTED) ||
      (expected > 0 && record.t === RECORD.SESSION);
    const nextLength = misplaced ? -1 : lengthAfter(length, record);
    if (nextLength < 0) {
      result.damage = {
        offset: pos,
        expectedSeq: expected,
        foundSeq: record.s,
        reason: misplaced ? 'sequence' : 'length',
      };
      break;
    }
    length = nextLength;
    if (record.t === RECORD.COMPACTED) lastCompacted = accepted.length;
    accepted.push(record);
    pos = nl + 1;
  }
  if (accepted.length < 2) {
    if (!result.damage && accepted.length) {
      result.damage = { offset: bytes.length, expectedSeq: 1, foundSeq: null, reason: 'no-history' };
    }
    return result;
  }
  const base = accepted[0];
  result.valid = true;
  result.logId = base.logId;
  result.sessionId = base.id;
  result.prev = base.prev;
  result.legacy = base.legacy;
  result.seq = accepted.length - 1;
  result.messageCount = length;
  result.replayFrom = lastCompacted;
  const header = base.header;
  for (const record of accepted) if (record.t === RECORD.PATCH) applyPatch(header, record);
  result.header = header;
  if (wantMessages) {
    for (let i = lastCompacted; i < accepted.length; i += 1) {
      if (isMessageRecord(accepted[i])) applyMessageRecord(result.messages, accepted[i]);
    }
  }
  return result;
}

/** The session object a replay describes. */
export function sessionFromLog(log) {
  return { ...log.header, id: log.sessionId, messages: log.messages };
}

function absent(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

/** Replay `path`; null when the log does not exist. */
export async function readSessionLog(path, options) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
  return parseSessionLog(bytes, options);
}

export function readSessionLogSync(path, options) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
  return parseSessionLog(bytes, options);
}

/** Header scan: the replayed header and message count, no transcript kept. */
export function scanSessionLogHeader(path) {
  return readSessionLog(path, { messages: false });
}

export function scanSessionLogHeaderSync(path) {
  return readSessionLogSync(path, { messages: false });
}

async function statOrNull(path, bigint = false) {
  try {
    return await stat(path, { bigint });
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
}

function statOrNullSync(path, bigint = false) {
  try {
    return statSync(path, { bigint });
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
}

function part(st) {
  return st ? `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : '-';
}

/**
 * Cache stamp of a session's record:
 * `log:<ino>:<size>:<mtimeNs>:<ctimeNs>|json:<ino>:<size>:<mtimeNs>:<ctimeNs>`
 * ('-' for an absent file), from bigint stats. A log only grows within one
 * file and a rewrite is a new file (new ino); the change time catches an
 * in-place rewrite that keeps the size and restores the mtime.
 */
export async function sessionRecordStamp({ jsonPath, logPath }) {
  const [log, json] = await Promise.all([statOrNull(logPath, true), statOrNull(jsonPath, true)]);
  return `log:${part(log)}|json:${part(json)}`;
}

export function sessionRecordStampSync({ jsonPath, logPath }) {
  return `log:${part(statOrNullSync(logPath, true))}|json:${part(statOrNullSync(jsonPath, true))}`;
}

/** `{ log, json }` of a record stamp, each `{ ino, size, mtimeNs, ctimeNs }`
 *  (BigInt) or null for an absent file. */
export function parseSessionRecordStamp(stamp) {
  const parts = { log: null, json: null };
  for (const entry of String(stamp).split('|')) {
    const [name, ...fields] = entry.split(':');
    if (name !== 'log' && name !== 'json') throw new TypeError(`not a session record stamp: ${stamp}`);
    parts[name] =
      fields[0] === '-'
        ? null
        : { ino: BigInt(fields[0]), size: BigInt(fields[1]), mtimeNs: BigInt(fields[2]), ctimeNs: BigInt(fields[3]) };
  }
  return parts;
}

// `{ size, mtimeMs }` exactly as a number stat reports them (Node computes
// mtimeMs as sec * 1e3 + nsec / 1e6).
function stampedStat(file) {
  const sec = file.mtimeNs / 1_000_000_000n;
  const nsec = file.mtimeNs % 1_000_000_000n;
  return { size: Number(file.size), mtimeMs: Number(sec) * 1e3 + Number(nsec) / 1e6 };
}

/**
 * The legacy seam: which file holds the session and what it says.
 * `loadLegacy(text, sessionId)` is the strict legacy loader (the session
 * object, or null for a record that is not that session's).
 *
 *   absent      neither file
 *   legacy      no log: the `<id>.json` load; `legacy` = {sha1,size,mtimeMs}
 *   legacy-unreadable  no log and the json does not load
 *   log         the log is authoritative
 *   diverged    the json is not the one the log was based on (written by an
 *               older build after a downgrade): the json load, plus the log
 *   orphan      the log's legacy json is gone; the log replay
 *   log-invalid the log has no valid base; nothing loaded from it
 *
 * A json whose stat fingerprint still equals the base's is the base's json
 * (the fingerprint rule of the migration); a changed fingerprint is settled
 * by its sha1, so a json only touched is not a divergence. A log whose base
 * names another session than its file name is `log-invalid`.
 *
 * `stamp` (sessionRecordStamp, taken by the caller just before) stands in
 * for the seam's own stats: a file it shows absent is not read, and the
 * json's fingerprint is the stamp's. Every outcome carries that `stamp`
 * (null without one); bytes read under it are proven only by the caller's
 * stamp taken after the read being equal to it.
 */
export async function resolveSessionRecord({ jsonPath, logPath, loadLegacy, messages = true, stamp = null }) {
  const stamped = stamp === null ? null : parseSessionRecordStamp(stamp);
  const log = stamped && !stamped.log ? null : await readSessionLog(logPath, { messages });
  const readJson = () => (stamped && !stamped.json ? null : readJsonFile(jsonPath, stamped));
  let outcome;
  if (!log) outcome = resolveLegacy(jsonPath, loadLegacy, await readJson());
  else if (!ownLog(log, logPath)) outcome = { kind: 'log-invalid', log };
  else {
    const jsonStat = stamped ? stamped.json && stampedStat(stamped.json) : await statOrNull(jsonPath);
    outcome = await resolveWithLog(log, jsonStat, readJson, loadLegacy);
  }
  return { ...outcome, stamp };
}

export function resolveSessionRecordSync({ jsonPath, logPath, loadLegacy, messages = true, stamp = null }) {
  const stamped = stamp === null ? null : parseSessionRecordStamp(stamp);
  const log = stamped && !stamped.log ? null : readSessionLogSync(logPath, { messages });
  const readJson = () => (stamped && !stamped.json ? null : readJsonFileSync(jsonPath, stamped));
  let outcome;
  if (!log) outcome = resolveLegacy(jsonPath, loadLegacy, readJson());
  else if (!ownLog(log, logPath)) outcome = { kind: 'log-invalid', log };
  else {
    const jsonStat = stamped ? stamped.json && stampedStat(stamped.json) : statOrNullSync(jsonPath);
    outcome = resolveWithLog(log, jsonStat, readJson, loadLegacy);
  }
  return { ...outcome, stamp };
}

// A valid log whose base is the session its file name names.
function ownLog(log, logPath) {
  return log.valid && log.sessionId === basename(logPath, SESSION_LOG_SUFFIX);
}

async function readJsonFile(path, stamped) {
  try {
    const bytes = await readFile(path);
    return { bytes, stat: stamped ? stampedStat(stamped.json) : await stat(path) };
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
}

function readJsonFileSync(path, stamped) {
  try {
    const bytes = readFileSync(path);
    return { bytes, stat: stamped ? stampedStat(stamped.json) : statSync(path) };
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
}

// A json that holds no data (empty or NUL-filled: a crash left nothing of it)
// beside a log, or where a log is to be created, is no json at all. Alone, it
// is still handed to `loadLegacy` (a sweep tells it apart from damage).
function holdsData(file) {
  return file !== null && !holdsNoData(file.bytes);
}

/** Whether a legacy json with data is at `path` (a no-data one is none). */
export function legacyJsonPresentSync(path) {
  return holdsData(readJsonFileSync(path, null));
}

export function legacyIdentity(file) {
  return { sha1: sha1Hex(file.bytes), ...fileFingerprint(file.stat) };
}

/** The session id a legacy `<id>.json` path names. */
export function legacySessionId(jsonPath) {
  return basename(jsonPath, '.json');
}

function resolveLegacy(jsonPath, loadLegacy, file) {
  if (!file) return { kind: 'absent' };
  const session = loadLegacy(file.bytes.toString('utf8'), legacySessionId(jsonPath));
  if (!session) return { kind: 'legacy-unreadable', legacy: legacyIdentity(file) };
  return { kind: 'legacy', session, legacy: legacyIdentity(file) };
}

// Sync and async callers share it: `readJson` returns the file or a promise of it.
function resolveWithLog(log, jsonStat, readJson, loadLegacy) {
  const fromLog = () => ({ kind: 'log', log, session: log.messages ? sessionFromLog(log) : null });
  if (!jsonStat) return log.legacy ? { kind: 'orphan', log, session: fromLog().session } : fromLog();
  if (log.legacy && sameFingerprint(log.legacy, fileFingerprint(jsonStat))) return fromLog();
  const settle = (file) => {
    if (!holdsData(file)) return log.legacy ? { kind: 'orphan', log, session: fromLog().session } : fromLog();
    const legacy = legacyIdentity(file);
    if (log.legacy && legacy.sha1 === log.legacy.sha1) return fromLog();
    // The json a redaction rewrite replaced, its own swap cut short: the log
    // is authoritative and the json still waits for that redaction.
    if (log.legacy?.redactedFrom && legacy.sha1 === log.legacy.redactedFrom) {
      return { ...fromLog(), redactionPending: true };
    }
    const session = loadLegacy(file.bytes.toString('utf8'), log.sessionId);
    return { kind: 'diverged', log, legacy, session };
  };
  const file = readJson();
  return typeof file?.then === 'function' ? file.then(settle) : settle(file);
}
