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
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
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
  const replay = newReplay(wantMessages);
  replayBytes(replay, bytes, 0);
  return replayResult(replay, bytes.length);
}

// A replay in progress: what the records read so far amount to.
function newReplay(wantMessages) {
  return {
    base: null,
    count: 0,
    length: 0,
    lastCompacted: -1,
    messages: wantMessages ? [] : undefined,
    skipped: [],
    damage: null,
    tornTail: null,
  };
}

// Applies the whole lines of `bytes` (the file's bytes from offset `at`) to
// `replay`; returns the file offset it stopped at: after the last whole line,
// or at the line the replay stops for good on (`damage`).
function replayBytes(replay, bytes, at) {
  // Records are applied as they are read and then dropped: a log of hundreds
  // of megabytes is replayed holding its base, its header and (full replay)
  // the transcript as it stands, never every record it ever held. Kept whole,
  // a 205 MB log took a listing's rebuild worker past its heap and the daemon
  // with it (2026-11-10).
  replay.tornTail = null;
  let pos = 0;
  while (pos < bytes.length) {
    const nl = bytes.indexOf(NEWLINE, pos);
    if (nl < 0) {
      replay.tornTail = { offset: at + pos, length: bytes.length - pos };
      break;
    }
    let record = null;
    try {
      record = decodeRecord(JSON.parse(bytes.toString('utf8', pos, nl)));
    } catch {
      record = null;
    }
    if (!record) {
      replay.skipped.push({ offset: at + pos, length: nl + 1 - pos });
      pos = nl + 1;
      continue;
    }
    const expected = replay.count;
    // The base is written whole (one atomic file), so its second record is
    // always the history: anything else there is not a log of ours.
    const misplaced =
      record.s !== expected ||
      (expected === 0 && record.t !== RECORD.SESSION) ||
      (expected === 1 && record.t !== RECORD.COMPACTED) ||
      (expected > 0 && record.t === RECORD.SESSION);
    const nextLength = misplaced ? -1 : lengthAfter(replay.length, record);
    if (nextLength < 0) {
      replay.damage = {
        offset: at + pos,
        expectedSeq: expected,
        foundSeq: record.s,
        reason: misplaced ? 'sequence' : 'length',
      };
      break;
    }
    replay.length = nextLength;
    if (record.t === RECORD.COMPACTED) replay.lastCompacted = replay.count;
    // The first record is the base; the second is always the history (a
    // `compacted` record, which empties the transcript before it fills it),
    // so a patch or a message record only ever follows a valid opening.
    if (replay.count === 0) replay.base = record;
    else if (record.t === RECORD.PATCH) applyPatch(replay.base.header, record);
    else if (replay.messages && isMessageRecord(record)) applyMessageRecord(replay.messages, record);
    replay.count += 1;
    pos = nl + 1;
  }
  return at + pos;
}

// What `replay` describes of a log `size` bytes long. `kept`: the replay goes
// on being applied to (a resumed header scan), so the result shares nothing
// with it.
function replayResult(replay, size, kept = false) {
  const { base, count } = replay;
  const result = {
    valid: false,
    logId: null,
    sessionId: null,
    prev: null,
    legacy: null,
    seq: -1,
    header: null,
    messages: replay.messages,
    messageCount: 0,
    size,
    tornTail: replay.tornTail,
    skipped: kept ? replay.skipped.slice() : replay.skipped,
    damage: replay.damage,
    replayFrom: -1,
  };
  if (count < 2) {
    if (!result.damage && count) {
      result.damage = { offset: size, expectedSeq: 1, foundSeq: null, reason: 'no-history' };
    }
    return result;
  }
  result.valid = true;
  result.logId = base.logId;
  result.sessionId = base.id;
  result.prev = kept ? structuredClone(base.prev) : base.prev;
  result.legacy = kept ? structuredClone(base.legacy) : base.legacy;
  result.seq = count - 1;
  result.messageCount = replay.length;
  result.replayFrom = replay.lastCompacted;
  result.header = kept ? structuredClone(base.header) : base.header;
  return result;
}

/** The session object a replay describes. */
export function sessionFromLog(log) {
  return { ...log.header, id: log.sessionId, messages: log.messages };
}

function absent(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

// Header scans (no transcript kept) resume where the last scan of the same
// file stopped, so a scan costs what was appended since, not what the log has
// grown to: a live log is scanned after each of its appends (a record stamp
// changes with every one), and at 250 MB each of those scans read and parsed
// the whole file (683 MB read and 44 s of CPU per 20 s, 2026-11-11).
//
// A log only grows within one file; a rewrite is a new file (a new inode).
// So a scan is resumed only on the same inode, at an offset the file still
// reaches, when the bytes just before that offset are the ones the last scan
// ended on; anything else is scanned from the start. What a resume does not
// see is bytes changed in place further back than that, which nothing of
// ours does; a full replay (a load, an open for writing) reads everything.
const SCAN_RESUME_LIMIT = 256;
const SCAN_GUARD_BYTES = 1024;
const _scans = new Map(); // path → { ino, offset, guard, replay }

// The scan of `path` to resume on a file whose bigint stat is `st`, taken out
// of the table for as long as it is being applied to (a scan of the same path
// started meanwhile starts over); null to scan from the start.
function takeScan(path, st) {
  const held = _scans.get(path);
  _scans.delete(path);
  return held && held.ino === st.ino && st.size >= BigInt(held.offset) ? held : null;
}

function keepScan(path, st, replay, offset, guard) {
  // A damaged log is replayed whole each time: its end is not a place to go on from.
  if (replay.damage) return;
  _scans.set(path, { ino: st.ino, offset, guard, replay });
  while (_scans.size > SCAN_RESUME_LIMIT) _scans.delete(_scans.keys().next().value);
}

// The last bytes before `offset`, of `before` (the guard of the offset the
// read started at) followed by the `read` bytes that were applied.
function guardAt(before, read, applied) {
  const all = applied >= SCAN_GUARD_BYTES ? read.subarray(0, applied) : Buffer.concat([before, read.subarray(0, applied)]);
  return Buffer.from(all.subarray(Math.max(0, all.length - SCAN_GUARD_BYTES)));
}

const NO_BYTES = Buffer.alloc(0);

function readAtSync(fd, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, bytes, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? bytes : bytes.subarray(0, got);
}

async function readAt(handle, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(bytes, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? bytes : bytes.subarray(0, got);
}

function scanned(path, st, held, bytes) {
  const replay = held ? held.replay : newReplay(false);
  const from = held ? held.offset : 0;
  const offset = replayBytes(replay, bytes, from);
  keepScan(path, st, replay, offset, guardAt(held ? held.guard : NO_BYTES, bytes, offset - from));
  return replayResult(replay, from + bytes.length, true);
}

function scanSessionLogSync(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    _scans.delete(path);
    if (absent(err)) return null;
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    let held = takeScan(path, st);
    if (held && !readAtSync(fd, held.guard.length, held.offset - held.guard.length).equals(held.guard)) held = null;
    const from = held ? held.offset : 0;
    return scanned(path, st, held, readAtSync(fd, Number(st.size) - from, from));
  } finally {
    closeSync(fd);
  }
}

async function scanSessionLog(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    _scans.delete(path);
    if (absent(err)) return null;
    throw err;
  }
  try {
    const st = await handle.stat({ bigint: true });
    let held = takeScan(path, st);
    if (held && !(await readAt(handle, held.guard.length, held.offset - held.guard.length)).equals(held.guard)) {
      held = null;
    }
    const from = held ? held.offset : 0;
    return scanned(path, st, held, await readAt(handle, Number(st.size) - from, from));
  } finally {
    await handle.close();
  }
}

/** Replay `path`; null when the log does not exist. */
export async function readSessionLog(path, options) {
  if (options?.messages === false) return scanSessionLog(path);
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
  if (options?.messages === false) return scanSessionLogSync(path);
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

/** One file's part of a record stamp, from its bigint stat (null: absent). */
export function recordStampPart(st) {
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
  return `log:${recordStampPart(log)}|json:${recordStampPart(json)}`;
}

export function sessionRecordStampSync({ jsonPath, logPath }) {
  return `log:${recordStampPart(statOrNullSync(logPath, true))}|json:${recordStampPart(statOrNullSync(jsonPath, true))}`;
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

/**
 * What the json beside a log (`file`: { bytes } read, or null) is to that log,
 * whose base names `logLegacy`: 'none' (absent or holding no data: the log
 * speaks), 'anchor' (the json the log was built from), 'redaction-pending'
 * (the json a redaction rewrite replaced, its own swap cut short: the log
 * speaks, the json still waits for that redaction) or 'diverged' (any other
 * json — an older build wrote it after a downgrade: the json is the record).
 */
export function legacyStanding(logLegacy, file) {
  if (!holdsData(file)) return 'none';
  const sha1 = sha1Hex(file.bytes);
  if (logLegacy && sha1 === logLegacy.sha1) return 'anchor';
  if (logLegacy?.redactedFrom && sha1 === logLegacy.redactedFrom) return 'redaction-pending';
  return 'diverged';
}

// Sync and async callers share it: `readJson` returns the file or a promise of it.
function resolveWithLog(log, jsonStat, readJson, loadLegacy) {
  const fromLog = () => ({ kind: 'log', log, session: log.messages ? sessionFromLog(log) : null });
  if (!jsonStat) return log.legacy ? { kind: 'orphan', log, session: fromLog().session } : fromLog();
  if (log.legacy && sameFingerprint(log.legacy, fileFingerprint(jsonStat))) return fromLog();
  const settle = (file) => {
    const standing = legacyStanding(log.legacy, file);
    if (standing === 'none') return log.legacy ? { kind: 'orphan', log, session: fromLog().session } : fromLog();
    if (standing === 'anchor') return fromLog();
    if (standing === 'redaction-pending') return { ...fromLog(), redactionPending: true };
    const session = loadLegacy(file.bytes.toString('utf8'), log.sessionId);
    return { kind: 'diverged', log, legacy: legacyIdentity(file), session };
  };
  const file = readJson();
  return typeof file?.then === 'function' ? file.then(settle) : settle(file);
}
