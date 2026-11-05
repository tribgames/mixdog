/**
 * Session log writer: one recorder per session, the only writer of its
 * `<id>.log.jsonl`, and only while the session's writer claim is held here.
 *
 * `record(session)` turns the difference from the last recorded state into
 * records (messages by reference, header keys by their JSON) and queues them
 * synchronously; queued records leave as one batch per write, and a batch is
 * acknowledged after its fsync. A batch that fails keeps its bytes and is
 * written again, at the same offset, with the next one.
 *
 * Opening, creating, converting, repairing and rewriting a log are
 * synchronous: each is a whole-file step done once per tenure (or on a rare
 * repair), and the exit drain must be able to open a log it has to flush.
 * A batch's bytes are written on the thread (into the page cache); only its
 * fsync, and a rewrite's waits between refused renames, run off it.
 *
 * A new log (a new session, a legacy conversion, a redaction rewrite, a
 * repair) is written whole to a temp file, read back and proven, then
 * published by an exclusive link (new) or a rename over the log (rewrite).
 *
 * The legacy `<id>.json` is only ever read, with one exception: a redaction
 * rewrite (sensitive values that must leave the disk) also rewrites the json
 * and the damaged / diverged / torn copies beside the log when their
 * messages hold a value — each through a temp file, a proof, then a rename.
 */
import {
  closeSync,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isFileFsyncUnsupported, renameAttempt, renameWithRetrySync } from '../../../../shared/atomic-file.mjs';
import {
  encodeAppend,
  encodeCompacted,
  encodeEdit,
  encodePatch,
  encodeRollback,
  encodeSessionRecord,
  fileFingerprint,
  jsonEqual,
  messageJson,
  newLogId,
  sha1Hex,
} from './session-log-format.mjs';
import { legacySessionId, parseSessionLog, sessionFromLog } from './session-log-reader.mjs';

export const SESSION_LOG_ERRORS = Object.freeze({
  /** The log is not the one this copy was recorded on, or the claim is gone. */
  CHANGED: 'ESESSIONCHANGED',
  /** A legacy base did not prove equal to the legacy load. */
  LEGACY_BASE: 'ELEGACYBASE',
  /** The legacy json does not load. */
  LEGACY_UNREADABLE: 'ELEGACYUNREADABLE',
  /** The legacy json changed while its base was being built. */
  LEGACY_CHANGED: 'ELEGACYCHANGED',
  /** A log already exists where a new one was to be created. */
  EXISTS: 'EEXIST',
  /** The log on disk has no valid base. */
  INVALID: 'ESESSIONLOGINVALID',
  /** A written log did not read back as written. */
  VERIFY: 'ESESSIONLOGVERIFY',
  CLOSED: 'ESESSIONLOGCLOSED',
  /** The session was deleted: what was queued never lands. */
  DISCARDED: 'ESESSIONLOGDISCARDED',
  // A copy issued before this process closed or detached the session (session-writers.mjs).
  RELEASED: 'ESESSIONRELEASED',
});

function logError(code, message, extra) {
  const err = new Error(`[session-log] ${message}`);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// The batch write and fsync calls, as one object so a test can fail them (no
// production path replaces them).
const io = { fsyncSync, fsync, writeSync };
export function _sessionLogIoForTest() {
  return io;
}

function syncFdSync(fd) {
  try {
    io.fsyncSync(fd);
  } catch (err) {
    if (!isFileFsyncUnsupported(err)) throw err;
  }
}

function syncFd(fd) {
  return new Promise((resolve, reject) => {
    io.fsync(fd, (err) => (err && !isFileFsyncUnsupported(err) ? reject(err) : resolve()));
  });
}

const DIR_FSYNC_TOLERATED = new Set(['EPERM', 'ENOTSUP', 'EINVAL', 'EACCES', 'EISDIR']);

// POSIX durability of a link or rename; Windows refuses a directory handle.
function syncDir(dir) {
  let fd = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (err) {
    if (!DIR_FSYNC_TOLERATED.has(err?.code)) throw err;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeAllSync(fd, buffer, position) {
  for (let done = 0; done < buffer.length; ) {
    done += writeSync(fd, buffer, done, buffer.length - done, position + done);
  }
}

function writeBatchSync(fd, buffer, position) {
  for (let done = 0; done < buffer.length; ) {
    done += io.writeSync(fd, buffer, done, buffer.length - done, position + done);
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

const asideName = (path, kind) => `${path}.${kind}-${Date.now()}-${randomBytes(4).toString('hex')}`;

/** Moves `path` to `<path>.<kind>-<ms>-<hex>` (never over another file);
 *  returns the new path. Every byte of it is kept. */
export function setAsideSessionLog(path, kind) {
  const aside = asideName(path, kind);
  renameWithRetrySync(path, aside);
  syncDir(dirname(path));
  return aside;
}

// Swaps a proven temp file in as the log while the old one stays reachable:
// the old log gets a second name first (a hard link, so its bytes are kept and
// it never leaves its place), then the temp file is renamed over it. A crash
// in between leaves the old log in place. `asideKind` null drops the old bytes
// (redaction). The claim is checked right before each step.
//
// Renames: a refused one is retried on the shared schedule (atomic-file.mjs).
// The sync helper sleeps on the thread between attempts, so it is used only
// where the code must stay synchronous — opening a log (torn-tail cut, the
// damaged-log repair, the set-aside of a log that is not ours), the legacy
// conversion of a first write, and a rewrite the exit drain completes; a
// rewrite that runs async waits on timers (SessionLogRecorder._renamesOnTimers).
function swapInProvenLog(tmpPath, logPath, claim, asideKind) {
  let aside = null;
  try {
    if (asideKind) aside = linkAside(logPath, claim, asideKind);
    claim.assertHeld();
    renameWithRetrySync(tmpPath, logPath);
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
  syncDir(dirname(logPath));
  return aside;
}

function linkAside(logPath, claim, asideKind) {
  const aside = asideName(logPath, asideKind);
  claim.assertHeld();
  linkSync(logPath, aside);
  return aside;
}

function writeTempCopy(path, data) {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmpPath, 'wx', 0o600);
    try {
      writeAllSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, 0);
      syncFdSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
  return tmpPath;
}

// A tail without its newline was never acknowledged (each batch ends in a
// newline and is acknowledged after its fsync): its bytes are kept in
// `<log>.torn-…` and cut from the log, so the state written next is exactly
// the state replayed.
function cutTornTail(fd, logPath, bytes, offset) {
  const aside = asideName(logPath, 'torn');
  const out = openSync(aside, 'wx', 0o600);
  try {
    writeAllSync(out, bytes.subarray(offset), 0);
    syncFdSync(out);
  } finally {
    closeSync(out);
  }
  syncDir(dirname(logPath));
  ftruncateSync(fd, offset);
  syncFdSync(fd);
  return aside;
}

/** Plain JSON-valued header of `header`: no messages, no transient keys. */
function diskHeaderEntries(header, transientKeys) {
  const entries = [];
  for (const key of Object.keys(header)) {
    if (key === 'messages' || transientKeys.has(key)) continue;
    const json = JSON.stringify(header[key]);
    if (json !== undefined) entries.push([key, json]);
  }
  return entries;
}

// Writes `<logPath>.<hex>.tmp` with a whole base, reads it back and proves
// it is `expected()` (a session object) before anyone may publish it.
function writeProvenBase(logPath, base, messageJsons, expected, failCode = SESSION_LOG_ERRORS.VERIFY) {
  const data = Buffer.from(encodeSessionRecord(base) + encodeCompacted(1, messageJsons), 'utf8');
  const tmpPath = writeTempCopy(logPath, data);
  try {
    const replay = parseSessionLog(readFileSync(tmpPath));
    const clean = replay.valid && replay.seq === 1 && !replay.skipped.length && !replay.tornTail && !replay.damage;
    if (!clean || !jsonEqual(sessionFromLog(replay), expected())) {
      throw logError(failCode, `base for ${base.id} does not read back as its source`, { sessionId: base.id });
    }
    return { tmpPath, size: data.length, replay };
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
}

// Exclusive publish of a proven temp file: a log never replaces another here.
// The claim is checked right before the link.
function publishNew(tmpPath, logPath, claim) {
  try {
    claim.assertHeld();
    linkSync(tmpPath, logPath);
  } catch (err) {
    removeQuietly(tmpPath);
    if (err?.code === 'EEXIST') throw logError(SESSION_LOG_ERRORS.EXISTS, `log already exists: ${logPath}`);
    throw err;
  }
  removeQuietly(tmpPath);
  syncDir(dirname(logPath));
}

function readJsonIdentity(jsonPath) {
  const before = statSync(jsonPath);
  const bytes = readFileSync(jsonPath);
  const after = statSync(jsonPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw logError(SESSION_LOG_ERRORS.LEGACY_CHANGED, `legacy json changed while read: ${jsonPath}`);
  }
  return { bytes, legacy: { sha1: sha1Hex(bytes), ...fileFingerprint(after) } };
}

/**
 * Half one of the legacy conversion (no claim needed: it writes only its own
 * temp file). Loads `<id>.json` with `loadLegacy(text, id)`, writes the base
 * (`session` + `compacted`) to a temp file, and proves it: the temp file is
 * read back and replayed, the json is read again and must have the same sha1,
 * and the replay must equal a fresh legacy load of it. Returns the prepared
 * base for publishLegacyBase; the temp file is removed on any failure.
 */
export function prepareLegacyBase({ jsonPath, logPath, loadLegacy }) {
  const sessionId = legacySessionId(jsonPath);
  const { bytes, legacy } = readJsonIdentity(jsonPath);
  const doc = loadLegacy(bytes.toString('utf8'), sessionId);
  if (!doc || typeof doc !== 'object' || doc.id !== sessionId || !Array.isArray(doc.messages)) {
    throw logError(SESSION_LOG_ERRORS.LEGACY_UNREADABLE, `legacy json does not load: ${jsonPath}`);
  }
  const { messages, ...header } = doc;
  const base = { logId: newLogId(), id: doc.id, prev: null, legacy, header };
  const proven = writeProvenBase(
    logPath,
    base,
    messages.map(messageJson),
    () => {
      const again = readFileSync(jsonPath);
      if (sha1Hex(again) !== legacy.sha1) {
        throw logError(SESSION_LOG_ERRORS.LEGACY_CHANGED, `legacy json changed during conversion: ${jsonPath}`);
      }
      return loadLegacy(again.toString('utf8'), sessionId);
    },
    SESSION_LOG_ERRORS.LEGACY_BASE
  );
  return {
    sessionId: doc.id,
    jsonPath,
    logPath,
    tmpPath: proven.tmpPath,
    logId: base.logId,
    legacy,
    size: proven.size,
    messageCount: messages.length,
  };
}

/**
 * Half two, under the claim: the json must still have the sha1 the base was
 * proven on; then the base is published exclusively, or — replacing a
 * diverged log (`divergedLogId`) — swapped in while that log keeps its bytes
 * under `<log>.diverged-…`. The claim is re-checked right before the link or
 * rename. Returns { logId, legacy, aside }.
 */
export function publishLegacyBase(prepared, { claim, divergedLogId = null }) {
  try {
    claim.assertHeld();
    const { legacy } = readJsonIdentity(prepared.jsonPath);
    if (legacy.sha1 !== prepared.legacy.sha1) {
      throw logError(SESSION_LOG_ERRORS.LEGACY_CHANGED, `legacy json changed before publish: ${prepared.jsonPath}`);
    }
    if (!divergedLogId) {
      publishNew(prepared.tmpPath, prepared.logPath, claim);
      return { logId: prepared.logId, legacy: prepared.legacy, aside: null };
    }
    const current = parseSessionLog(readFileSync(prepared.logPath), { messages: false });
    if (current.logId !== divergedLogId) {
      throw logError(SESSION_LOG_ERRORS.CHANGED, `log ${prepared.logPath} is not the diverged one`);
    }
    const aside = swapInProvenLog(prepared.tmpPath, prepared.logPath, claim, 'diverged');
    return { logId: prepared.logId, legacy: prepared.legacy, aside };
  } catch (err) {
    removeQuietly(prepared.tmpPath);
    throw err;
  }
}

/**
 * The legacy conversion: the one function that turns `<id>.json` into the
 * verified base of `<id>.log.jsonl`, for the first write of a session and
 * for the startup migration alike. The json is only read.
 */
export function convertLegacySession({ jsonPath, logPath, loadLegacy, claim, divergedLogId = null }) {
  claim.assertHeld();
  const prepared = prepareLegacyBase({ jsonPath, logPath, loadLegacy });
  return publishLegacyBase(prepared, { claim, divergedLogId });
}

const ASIDE_KINDS = /\.(damaged|diverged|torn)-\d+-[0-9a-f]+$/;

// `redaction` = { jsonPath, redactMessage(message), redactText(text) }. The
// stored copies are redacted in exactly the fields the log is: each message
// through `redactMessage` — the sensitive projection the log's own messages
// go through (sensitive-projection.mjs: its text and tool-call arguments) —
// and nothing else; header fields, ids and numbers stay as they are.

// `messages` with each one redacted; the same array when none changes.
function redactedMessages(messages, redactMessage) {
  let changed = false;
  const out = messages.map((message) => {
    const next = redactMessage(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? out : messages;
}

// Writes `text` to a temp copy of `path` and proves it reads back as written;
// whatever fails on the way removes the temp copy.
function writeProvenText(path, text, what) {
  const tmpPath = writeTempCopy(path, text);
  try {
    const written = readFileSync(tmpPath);
    if (written.toString('utf8') !== text) {
      throw logError(SESSION_LOG_ERRORS.VERIFY, `redacted ${what} does not read back`);
    }
    return { tmpPath, written };
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
}

// The legacy json with its messages redacted, written to a temp file and
// proven before anything moves; null when no message changes.
function prepareRedactedJson(redaction, sessionId) {
  let bytes;
  try {
    bytes = readFileSync(redaction.jsonPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  let doc = null;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'object' || doc.id !== sessionId) {
    throw logError(SESSION_LOG_ERRORS.VERIFY, `legacy json of ${sessionId} does not parse as its record`);
  }
  if (!Array.isArray(doc.messages)) return null;
  const messages = redactedMessages(doc.messages, redaction.redactMessage);
  if (messages === doc.messages) return null;
  const { tmpPath, written } = writeProvenText(
    redaction.jsonPath,
    JSON.stringify({ ...doc, messages }),
    `json of ${sessionId}`
  );
  try {
    // A rename keeps the file's mtime, so this is the json's identity once in place.
    return {
      tmpPath,
      legacy: { sha1: sha1Hex(written), ...fileFingerprint(statSync(tmpPath)), redactedFrom: sha1Hex(bytes) },
    };
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
}

// A copy kept aside, line by line: a line that parses as a record has its
// messages redacted as the log's are, every other field kept; a line that does
// not parse as one (the damage itself, a torn tail) has no fields to keep and
// is redacted as text.
function redactedAsideText(text, redaction) {
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (!line) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      record = undefined;
    }
    let next = line;
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      if (Array.isArray(record.messages)) {
        const messages = redactedMessages(record.messages, redaction.redactMessage);
        if (messages !== record.messages) next = JSON.stringify({ ...record, messages });
      }
    } else {
      next = redaction.redactText(line);
    }
    if (next !== line) changed = true;
    return next;
  });
  return changed ? lines.join('\n') : null;
}

// The damaged / diverged / torn copies kept beside the log, redacted, each
// written to a temp file and proven; returns the renames that swap them in.
function prepareRedactedAsides(logPath, redaction) {
  const dir = dirname(logPath);
  const prefix = `${basename(logPath)}.`;
  const renames = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !ASIDE_KINDS.test(name)) continue;
      const path = join(dir, name);
      const next = redactedAsideText(readFileSync(path, 'utf8'), redaction);
      if (next !== null) renames.push({ tmpPath: writeProvenText(path, next, name).tmpPath, path });
    }
  } catch (err) {
    for (const { tmpPath } of renames) removeQuietly(tmpPath);
    throw err;
  }
  return renames;
}

// Freezes a recorded message and everything it holds (typed arrays and
// buffers excepted: they cannot be frozen and are never edited in place).
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
}

function recorderOptions(options = {}) {
  return {
    claim: options.claim,
    transientKeys: new Set(options.transientKeys || []),
    immutableKeys: new Set(options.immutableKeys || []),
    projectHeader: options.projectHeader || ((session) => session),
    projectMessage: options.projectMessage || ((message) => message),
    // Test runs (node --test sets NODE_TEST_CONTEXT) freeze what is recorded.
    freezeRecorded: options.freezeRecorded ?? process.env.NODE_TEST_CONTEXT !== undefined,
  };
}

function assertClaim(claim) {
  if (!claim || typeof claim.assertHeld !== 'function') {
    throw new TypeError('[session-log] a writer claim ({ assertHeld }) is required');
  }
}

// The message references of `session` as they are now: recorded messages are
// replaced, never mutated (_settle), so the list is the transcript then.
function messagesOf(session) {
  return Array.isArray(session.messages) ? session.messages.slice() : [];
}

function diskHeaderOf(session, opts) {
  return Object.fromEntries(
    diskHeaderEntries(opts.projectHeader(session), opts.transientKeys).map(([key, json]) => [key, JSON.parse(json)])
  );
}

/** Creates the log of a session that has none (and no legacy json). */
export function createSessionLog({ logPath, session, ...options }) {
  assertClaim(options.claim);
  options.claim.assertHeld();
  const opts = recorderOptions(options);
  const header = diskHeaderOf(session, opts);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const messageJsons = messages.map((message) => messageJson(opts.projectMessage(message)));
  const base = { logId: newLogId(), id: session.id, prev: null, legacy: null, header };
  // `header` is plain JSON already (diskHeaderOf) and every message is parsed
  // from its stored line: no whole-record stringify on this thread.
  const proven = writeProvenBase(logPath, base, messageJsons, () => ({
    ...header,
    id: session.id,
    messages: messageJsons.map((j) => JSON.parse(j)),
  }));
  publishNew(proven.tmpPath, logPath, options.claim);
  return openSessionLog({ logPath, expect: { logId: base.logId, seq: 1 }, messages, ...options });
}

/**
 * Opens a session's existing log for writing. Requires the claim.
 *  - `expect: {logId, seq}` with `messages` (the live array that copy was
 *    loaded with): the log must still be exactly that, else ESESSIONCHANGED;
 *    the recorder diffs against those message references.
 *  - without `expect`: the recorder diffs against the replay
 *    (`recorder.loaded`), which the caller may adopt.
 * A torn tail (bytes after the last newline: never acknowledged) is set aside
 * and cut; a log damaged mid-file is replaced by a fresh base of its replayed
 * state, the damaged file kept whole beside it. Either way the recorder starts
 * from exactly the replayed state. An invalid log throws ESESSIONLOGINVALID.
 */
export function openSessionLog({ logPath, expect = null, messages = null, ...options }) {
  assertClaim(options.claim);
  options.claim.assertHeld();
  let fd = openSync(logPath, 'r+');
  let log;
  try {
    const bytes = readFileSync(fd);
    log = parseSessionLog(bytes);
    if (!log.valid) throw logError(SESSION_LOG_ERRORS.INVALID, `log has no valid base: ${logPath}`);
    if (log.damage) {
      closeSync(fd);
      fd = null;
      log = repairDamagedLog(logPath, log, options.claim);
      fd = openSync(logPath, 'r+');
    } else if (log.tornTail) {
      cutTornTail(fd, logPath, bytes, log.tornTail.offset);
      log.size = log.tornTail.offset;
      log.tornTail = null;
    }
  } catch (err) {
    if (fd !== null) closeSync(fd);
    throw err;
  }
  const recorder = new SessionLogRecorder({ logPath, fd, log, refs: log.messages, options: recorderOptions(options) });
  if (expect) {
    try {
      recorder.adopt(expect, messages);
    } catch (err) {
      recorder.closeUnused();
      throw err;
    }
  }
  return recorder;
}

// The replacement is written and proven before anything moves; then it is
// swapped in with the damaged log kept under `<log>.damaged-…`.
function repairDamagedLog(logPath, log, claim) {
  const session = sessionFromLog(log);
  const { messages, id, ...header } = session;
  const base = {
    logId: newLogId(),
    id,
    prev: { logId: log.logId, seq: log.seq, reason: 'damaged' },
    legacy: log.legacy,
    header: { ...header, id },
  };
  const proven = writeProvenBase(logPath, base, messages.map(messageJson), () => session);
  swapInProvenLog(proven.tmpPath, logPath, claim, 'damaged');
  return proven.replay;
}

export class SessionLogRecorder {
  constructor({ logPath, fd, log, refs, options }) {
    this.logPath = logPath;
    this.sessionId = log.sessionId;
    this.legacy = log.legacy;
    this.loaded = log.messages ? sessionFromLog(log) : null;
    this._options = options;
    this._fd = fd;
    this._draining = false;
    this._waiters = [];
    this._idleWaiters = [];
    // Every accepted operation not yet applied, in acceptance order (_accept);
    // a rewrite at its head is under way, the ones behind it wait for it.
    this._ops = [];
    // The async course of the rewrite under way (close() waits it out).
    this._rewriting = null;
    this._stale = null;
    this._closed = false;
    this._closedHard = false;
    this._reset(log.logId, log.seq, log.size, log.header, refs);
  }

  _reset(logId, seq, size, header, refs) {
    this.logId = logId;
    this._seq = seq;
    this._ackedSeq = seq;
    this._end = size;
    this._queue = [];
    this._unacked = null;
    this._strings = new Map();
    this._values = new Map();
    for (const [key, json] of diskHeaderEntries(header, this._options.transientKeys)) this._strings.set(key, json);
    this._refs = refs.slice();
    this._settle(this._refs);
  }

  /**
   * The live copy `messages` was loaded from this log at `expect` ({ logId,
   * seq }): the recorder then diffs against those references (index for
   * index the replayed ones) instead of the replay's own objects. A log that
   * is no longer exactly there throws ESESSIONCHANGED. `messages` null: the
   * copy's references are not known to be the recorded ones, so the
   * recorder keeps diffing against the replay. Only before the first record.
   */
  adopt(expect, messages) {
    const list = messages === null ? this._refs : Array.isArray(messages) ? messages : [];
    if (
      expect?.logId !== this.logId ||
      expect?.seq !== this._seq ||
      this._seq !== this._ackedSeq ||
      list.length !== this._refs.length
    ) {
      throw logError(SESSION_LOG_ERRORS.CHANGED, `log ${this.logPath} moved on since this copy was loaded`, {
        expected: expect,
        found: { logId: this.logId, seq: this._seq },
      });
    }
    this._refs = list.slice();
    this._settle(this._refs);
  }

  /** The message references the log holds as recorded, in order. */
  recordedMessages() {
    return this._refs.slice();
  }

  /** Drops everything not yet written (a deleted session, or a barrier that
   *  did not land: `reason`): nothing queued lands, and every waiting caller
   *  is told. */
  discard(reason = null) {
    this._goStale(
      this._stale ?? reason ?? logError(SESSION_LOG_ERRORS.DISCARDED, `recorder discarded: ${this.logPath}`)
    );
  }

  /** Closes a recorder that recorded nothing (an open that is not used). */
  closeUnused() {
    this._closed = true;
    if (this._fd !== null) closeSync(this._fd);
    this._fd = null;
  }

  /**
   * Record only header fields `fields` (a key whose value is undefined is
   * removed), leaving the transcript and every other key as recorded: a
   * lifecycle barrier over a record already closed changes nothing else.
   */
  recordFields(fields) {
    return this._accept(() => {
      const accepted = [];
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'messages' && key !== 'id') accepted.push([key, JSON.stringify(value)]);
      }
      return { kind: 'apply', apply: () => this._applyFields(accepted) };
    });
  }

  _applyFields(accepted) {
    const set = [];
    const unset = [];
    for (const [key, json] of accepted) {
      if (json === undefined) {
        if (this._strings.has(key)) unset.push(key);
      } else if (this._strings.get(key) !== json) {
        set.push([key, json]);
      }
    }
    for (const [key] of accepted) this._values.delete(key);
    for (const key of unset) this._strings.delete(key);
    for (const [key, json] of set) this._strings.set(key, json);
    if (set.length || unset.length) {
      this._seq += 1;
      this._queue.push(encodePatch(this._seq, set, unset));
    }
  }

  // The one way work enters the recorder: `build()` takes what the operation
  // needs from the caller's objects now (a throw rejects it, nothing queued),
  // and the operation joins the queue behind everything accepted before it.
  // Its promise is settled by its own entry: an applied record or fields
  // operation with the batch holding its records (_drain, _writePendingSync),
  // a rewrite when its files are in place or did not land.
  _accept(build) {
    let op;
    try {
      this._assertWritable();
      op = build();
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this._push(op).waiters.push({ resolve, reject });
      this._advance();
    });
  }

  // Queues `op` last and returns the entry that owns it. A rewrite right
  // behind a queued rewrite that has not started, nothing between them, joins
  // it: replacing the log by one state and at once by a later one is
  // replacing it by the later one, and a redaction projects with the
  // sensitive values as they are when it is made, which is the same moment
  // for both. The later session and reason stand; a redaction if either asks.
  _push(op) {
    const tail = this._ops.at(-1);
    if (op.kind === 'rewrite' && tail?.kind === 'rewrite' && !tail.started) {
      tail.header = op.header;
      tail.messages = op.messages;
      tail.reason = op.reason;
      tail.redaction = op.redaction ?? tail.redaction;
      return tail;
    }
    op.waiters = [];
    this._ops.push(op);
    return op;
  }

  // The async course through the queue: from its head, each record or fields
  // operation is applied (its records join the batch, its callers wait for
  // it) until a rewrite heads the queue; the batch is started first, so the
  // rewrite finds it written on the log it replaces (_runRewrite).
  _advance() {
    while (this._ops.length && this._ops[0].kind !== 'rewrite') this._applyOp(this._ops.shift());
    if (this._waiters.length) this._kick();
    const head = this._ops[0];
    if (head && !head.started) this._startRewrite(head);
  }

  // Encodes `op` against the state recorded so far; a throw (a message that
  // does not serialize) rejects only its callers and leaves the recorder as
  // it was.
  _applyOp(op) {
    try {
      op.apply();
    } catch (err) {
      for (const waiter of op.waiters) waiter.reject(err);
      return;
    }
    this._waiters.push(...op.waiters);
  }

  /** Last acknowledged (fsynced) position: { logId, seq, end }. */
  get acked() {
    return { logId: this.logId, seq: this._ackedSeq, end: this._end };
  }

  get seq() {
    return this._seq;
  }

  get messageCount() {
    return this._refs.length;
  }

  /** The recorded value of header key `key` (what the log holds), or undefined. */
  recordedHeader(key) {
    const json = this._strings.get(key);
    return json === undefined ? undefined : JSON.parse(json);
  }

  /** True once the claim was lost or the recorder closed: nothing it holds lands any more. */
  get finished() {
    return Boolean(this._stale || this._closed || this._closedHard);
  }

  /**
   * False once the log moved on outside this recorder: another writer
   * appended to it, cut it or renamed another file over it. Exact while no
   * batch of this recorder is being written; during one (or a rewrite) true —
   * every batch checks again right before it writes.
   */
  get atLogEnd() {
    if (this._draining || this._ops.length || this._fd === null) return true;
    return this._atLogEnd(this._end, this._unacked?.buffer ?? null);
  }

  // Every writer of a log appends at its end or renames a new file over its
  // path, so the log is still exactly what this recorder wrote when the path
  // names the open file and the file ends where this recorder's bytes end:
  // at `start`, or inside `pending` — bytes of a failed write that reached
  // the file, the very bytes the retry writes again at the same offset.
  _atLogEnd(start, pending) {
    const open = fstatSync(this._fd, { bigint: true });
    const named = statSync(this.logPath, { bigint: true, throwIfNoEntry: false });
    if (!named || named.ino !== open.ino || named.dev !== open.dev) return false;
    const size = Number(open.size);
    if (size === start) return true;
    if (!pending || size < start || size > start + pending.length) return false;
    const onDisk = Buffer.alloc(size - start);
    for (let done = 0; done < onDisk.length; ) {
      const read = readSync(this._fd, onDisk, done, onDisk.length - done, start + done);
      if (read === 0) return false;
      done += read;
    }
    return onDisk.equals(pending.subarray(0, onDisk.length));
  }

  _movedOnError() {
    return logError(SESSION_LOG_ERRORS.CHANGED, `log ${this.logPath} has records this recorder did not write`, {
      found: { logId: this.logId, seq: this._ackedSeq, end: this._end },
    });
  }

  _assertWritable() {
    if (this._stale) throw this._stale;
    if (this._closed || this._closedHard) {
      throw logError(SESSION_LOG_ERRORS.CLOSED, `recorder closed: ${this.logPath}`);
    }
    try {
      this._options.claim.assertHeld();
    } catch (err) {
      this._goStale(err);
      throw err;
    }
  }

  // The claim is gone: nothing queued may land, now or later. A rewrite under
  // way stops at its next step (_assertWritable) and removes its files.
  _goStale(err) {
    this._stale = err;
    this._queue = [];
    this._unacked = null;
    const waiters = [...this._waiters, ...this._ops.flatMap((op) => op.waiters)];
    this._waiters = [];
    this._ops = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  _messageJson(message) {
    return messageJson(this._options.projectMessage(message));
  }

  // Recorded messages are settled: replaced, never mutated. Under test they
  // are frozen, so an in-place edit throws where it would otherwise be lost.
  _settle(messages, from = 0, to = messages.length) {
    if (!this._options.freezeRecorded) return;
    for (let i = from; i < to; i += 1) deepFreeze(messages[i]);
  }

  // Messages are compared by reference with the last recorded array: an
  // unchanged prefix and suffix are kept, the rest becomes one record. The
  // comparison walks the references (pointer compares, no serialization);
  // the kept copy is updated by the record's own extent: an append pushes
  // only the new references. Returns { line, commit } (null: no change): the
  // record is built here, the kept copy moves only in commit().
  _messageRecord(next, compacted, seq) {
    const refs = this._refs;
    const m = refs.length;
    const n = next.length;
    let p = 0;
    while (p < m && p < n && refs[p] === next[p]) p += 1;
    if (compacted) {
      const line = encodeCompacted(
        seq,
        next.map((msg) => this._messageJson(msg))
      );
      return {
        line,
        commit: () => {
          this._refs = next.slice();
          this._settle(next);
        },
      };
    }
    if (p === m && p === n) return null;
    if (p === m) {
      const added = [];
      for (let i = m; i < n; i += 1) added.push(this._messageJson(next[i]));
      return {
        line: encodeAppend(seq, n, added),
        commit: () => {
          for (let i = m; i < n; i += 1) refs.push(next[i]);
          this._settle(next, m, n);
        },
      };
    }
    if (p === n) {
      return {
        line: encodeRollback(seq, n),
        commit: () => {
          refs.length = n;
        },
      };
    }
    let q = 0;
    while (q < m - p && q < n - p && refs[m - 1 - q] === next[n - 1 - q]) q += 1;
    const inserted = next.slice(p, n - q);
    const jsons = inserted.map((msg) => this._messageJson(msg));
    return {
      // Nothing shared: the record is the whole history, so it is one.
      line: p === 0 && q === 0 ? encodeCompacted(seq, jsons) : encodeEdit(seq, n, p, m - p - q, jsons),
      commit: () => {
        refs.splice(p, m - p - q, ...inserted);
        this._settle(next, p, n - q);
      },
    };
  }

  // The header of a save as accepted: each key's JSON, taken now — except a
  // key the caller declared immutable (deep-frozen, replaced on change), kept
  // by reference (`json` null) and compared so when applied.
  _acceptedHeader(header) {
    const { transientKeys, immutableKeys } = this._options;
    const fields = [];
    for (const key of Object.keys(header)) {
      if (key === 'messages' || key === 'id' || transientKeys.has(key)) continue;
      const value = header[key];
      fields.push(immutableKeys.has(key) ? { key, value, json: null } : { key, json: JSON.stringify(value) });
    }
    return fields;
  }

  // Header keys (as accepted: _acceptedHeader) are compared by their JSON; an
  // immutable key by reference. Returns { line (null: no change), commit },
  // like _messageRecord.
  _patchRecord(fields, seq) {
    const set = [];
    const values = [];
    const seen = new Set(['id']);
    for (const { key, value, json: accepted } of fields) {
      const immutable = accepted === null;
      if (immutable && this._strings.has(key) && this._values.get(key) === value) {
        seen.add(key);
        continue;
      }
      const json = immutable ? JSON.stringify(value) : accepted;
      if (json === undefined) continue;
      seen.add(key);
      if (immutable) values.push([key, value]);
      if (this._strings.get(key) !== json) set.push([key, json]);
    }
    const unset = [];
    for (const key of this._strings.keys()) if (!seen.has(key)) unset.push(key);
    return {
      line: set.length || unset.length ? encodePatch(seq, set, unset) : null,
      commit: () => {
        for (const [key, value] of values) this._values.set(key, value);
        for (const [key, json] of set) this._strings.set(key, json);
        for (const key of unset) {
          this._strings.delete(key);
          this._values.delete(key);
        }
      },
    };
  }

  /**
   * Record `session`'s changes: `session` as it is now is accepted, and its
   * records are queued (the recorder's state advanced) before this returns —
   * or, behind a rewrite under way, once that rewrite ended, against the log
   * it left. `compacted: true` writes the transcript as a replacement history
   * (a compaction), where replay starts. Resolves with the acknowledgement
   * `{logId, seq, end}` once the batch holding these records is fsynced;
   * rejects when that write fails (the bytes stay queued and ride the next
   * batch) or the claim is gone (ESESSIONCHANGED, nothing of this recorder
   * lands any more).
   */
  record(session, { compacted = false } = {}) {
    return this._accept(() => {
      const header = this._options.projectHeader(session);
      if (Object.hasOwn(header, 'id') && header.id !== this.sessionId) {
        throw logError(SESSION_LOG_ERRORS.CHANGED, `session id changed: ${this.sessionId} → ${header.id}`);
      }
      const messages = messagesOf(session);
      const fields = this._acceptedHeader(header);
      return { kind: 'apply', apply: () => this._applyRecord(messages, compacted, fields) };
    });
  }

  _applyRecord(messages, compacted, fields) {
    const message = this._messageRecord(messages, compacted, this._seq + 1);
    const patch = this._patchRecord(fields, this._seq + (message ? 2 : 1));
    // Every record of the batch is built (serialized included) before any
    // state moves: a throw above leaves the recorder exactly as it was.
    if (message) {
      message.commit();
      this._queue.push(message.line);
      this._seq += 1;
    }
    patch.commit();
    if (patch.line) {
      this._queue.push(patch.line);
      this._seq += 1;
    }
  }

  /** Resolves when everything accepted so far is applied and fsynced. */
  flush() {
    if (this._stale) return Promise.reject(this._stale);
    if (!this.pending) return Promise.resolve(this.acked);
    return new Promise((resolve, reject) => {
      this._push({ kind: 'apply', apply: () => {} }).waiters.push({ resolve, reject });
      this._advance();
    });
  }

  _kick() {
    if (this._draining) return;
    this._draining = true;
    // Records of the same tick join one batch.
    queueMicrotask(() => void this._drain());
  }

  async _drain() {
    try {
      for (;;) {
        if (this._stale || this._closedHard) return;
        if (!this._queue.length && !this._unacked) {
          const waiters = this._waiters;
          this._waiters = [];
          for (const waiter of waiters) waiter.resolve(this.acked);
          return;
        }
        const fresh = Buffer.from(this._queue.join(''), 'utf8');
        this._queue = [];
        const failed = this._unacked;
        const start = failed ? failed.start : this._end;
        const buffer = failed ? Buffer.concat([failed.buffer, fresh]) : fresh;
        const lastSeq = this._seq;
        const waiters = this._waiters;
        this._waiters = [];
        this._unacked = { buffer, start, lastSeq, waiters };
        try {
          this._options.claim.assertHeld();
          // Records diffed against a state the log no longer ends in would
          // land over (or after) another writer's: none of them is written.
          if (!this._atLogEnd(start, failed?.buffer ?? null)) throw this._movedOnError();
        } catch (err) {
          for (const waiter of waiters) waiter.reject(err);
          this._goStale(err);
          return;
        }
        try {
          // Written on the thread (into the page cache), fsynced off it: a
          // write never outlives the descriptor it was issued on (see
          // _releaseForRename).
          writeBatchSync(this._fd, buffer, start);
          await syncFd(this._fd);
        } catch (err) {
          if (this._closedHard) return;
          // Kept for the next batch, at the same offset; every waiting caller
          // learns this write failed.
          for (const waiter of [...waiters, ...this._waiters]) waiter.reject(err);
          this._waiters = [];
          return;
        }
        if (this._closedHard) return;
        this._unacked = null;
        this._end = start + buffer.length;
        this._ackedSeq = lastSeq;
        for (const waiter of waiters) waiter.resolve(this.acked);
      }
    } finally {
      this._draining = false;
      const idle = this._idleWaiters;
      this._idleWaiters = [];
      for (const resolve of idle) resolve();
    }
  }

  _idle() {
    if (!this._draining) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  /** Whether anything recorded is not yet acknowledged. */
  get pending() {
    return this._draining || this._queue.length > 0 || this._unacked !== null || this._ops.length > 0;
  }

  /**
   * Process exit: the queue is drained synchronously, in order, from where
   * the async course stands (_drainSync) — a rewrite under way completed
   * where it is, every operation behind it applied after it — and everything
   * not yet acknowledged (an in-flight batch included, same bytes at the same
   * offset) is written and fsynced. The recorder is finished afterwards.
   * Throws when a rewrite failed — after everything else was written.
   */
  flushSync() {
    if (this._stale || this._closed || this._closedHard) return false;
    let failure = null;
    try {
      this._drainSync();
    } catch (err) {
      failure = err;
    }
    if (this._stale) {
      if (failure) throw failure;
      return false;
    }
    this._closedHard = true;
    this._writePendingSync();
    if (failure) throw failure;
    return true;
  }

  // Writes the queue (and an in-flight batch: same bytes, same offset) on the
  // log, synchronously, and fsyncs it; every waiting caller resolves.
  _writePendingSync() {
    if (this._queue.length || this._unacked) {
      this._options.claim.assertHeld();
      const fresh = Buffer.from(this._queue.join(''), 'utf8');
      const start = this._unacked ? this._unacked.start : this._end;
      const buffer = this._unacked ? Buffer.concat([this._unacked.buffer, fresh]) : fresh;
      if (!this._atLogEnd(start, this._unacked?.buffer ?? null)) {
        const err = this._movedOnError();
        for (const waiter of this._unacked?.waiters ?? []) waiter.reject(err);
        this._goStale(err);
        throw err;
      }
      if (buffer.length) {
        writeAllSync(this._fd, buffer, start);
        syncFdSync(this._fd);
        this._end = start + buffer.length;
        this._ackedSeq = this._seq;
      }
    }
    // The in-flight batch's callers too: its bytes were written here.
    const waiters = [...(this._unacked?.waiters ?? []), ...this._waiters];
    this._queue = [];
    this._unacked = null;
    this._waiters = [];
    for (const waiter of waiters) waiter.resolve(this.acked);
  }

  /**
   * Replaces the log by a fresh one holding only `session`'s current state
   * (a base with a new logId, `prev` naming the old log), proven by reading
   * it back, then renamed over the log: the old file's bytes leave the
   * directory. Used when stored bytes must go (sensitive-value redaction):
   * every message is projected again, and `redaction` ({ jsonPath,
   * redactMessage, redactText }) also rewrites the legacy json and the copies
   * kept aside, redacted in the fields the log's projection redacts.
   *
   * An operation of the queue like a save: `session` is taken as it is now,
   * and the rewrite is made once everything accepted before it is applied
   * and written — on the log it replaces — while everything accepted after
   * it is applied to the new log once that is in place (or, when it did not
   * land, to the log as it is). An exit drain that comes first completes it
   * where it is (flushSync).
   */
  rewrite(session, { reason = 'redaction', redaction = null } = {}) {
    return this._accept(() => this._rewriteOp(session, reason, redaction));
  }

  /** rewrite(), synchronously — the exit drain's redaction: the queue is
   *  drained up to it (and with it) here. */
  rewriteSync(session, { reason = 'redaction', redaction = null } = {}) {
    this._assertWritable();
    this._push(this._rewriteOp(session, reason, redaction));
    this._drainSync();
    return this.acked;
  }

  _rewriteOp(session, reason, redaction) {
    return {
      kind: 'rewrite',
      header: diskHeaderOf(session, this._options),
      messages: messagesOf(session),
      reason,
      redaction,
      // The async course began it (_startRewrite); the exit drain took it over.
      started: false,
      overtaken: false,
      plan: null,
      next: 0,
    };
  }

  _startRewrite(op) {
    op.started = true;
    const running = this._runRewrite(op).finally(() => {
      if (this._rewriting === running) this._rewriting = null;
    });
    this._rewriting = running;
  }

  // The async course of the rewrite `op` heading the queue: it waits for the
  // batch of what was applied before it, makes its files, swaps them in, and
  // settles its callers; then the queue moves on. Taken over by the exit
  // drain (`overtaken`), or dropped from the queue by a lost claim, it leaves
  // its callers to that.
  async _runRewrite(op) {
    let failure = null;
    try {
      await this._idle();
      if (op.overtaken) return;
      this._assertWritable();
      op.plan = this._planRewrite(op);
      await this._renamesOnTimers(op);
    } catch (err) {
      failure = err;
    }
    if (op.overtaken || this._ops[0] !== op) return;
    this._ops.shift();
    this._settleRewrite(op, failure);
    this._advance();
  }

  _settleRewrite(op, failure) {
    for (const waiter of op.waiters) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(this.acked);
    }
  }

  // The exit drain's course through the queue: the same operations in the
  // same order as the async course, each completed here synchronously — a
  // rewrite the async course began is taken over at the step it reached.
  // Every operation is applied (records join the batch _writePendingSync
  // writes) before the first rewrite failure, if any, is thrown.
  _drainSync() {
    let failure = null;
    while (this._ops.length && !this._stale) {
      const op = this._ops.shift();
      if (op.kind !== 'rewrite') {
        this._applyOp(op);
        continue;
      }
      op.overtaken = true;
      try {
        this._finishRewriteSync(op);
        this._settleRewrite(op, null);
      } catch (err) {
        this._settleRewrite(op, err);
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  // Completes rewrite `op` synchronously. Not yet planned, it still waited
  // for the batch in flight: that batch and the queue (what was applied
  // before it) are written on the old log first, then its files are made.
  _finishRewriteSync(job) {
    if (!job.plan) {
      this._writePendingSync();
      job.plan = this._planRewrite(job);
    }
    const { renames } = job.plan;
    try {
      while (job.next < renames.length) {
        const step = renames[job.next];
        this._options.claim.assertHeld();
        this._releaseForRename(step);
        renameWithRetrySync(step.tmpPath, step.path);
        job.next += 1;
        this._renamed(job, step);
      }
    } catch (err) {
      this._renamesFailed(job);
      throw err;
    }
  }

  // The renames of `job`, each attempt one synchronous rename on the shared
  // schedule (renameAttempt) with the waits on timers: no rename is ever in
  // flight while other code runs, so an exit drain finds each step either
  // done or not begun, and takes over from there (this course then stops).
  async _renamesOnTimers(job) {
    const { renames } = job.plan;
    try {
      while (job.next < renames.length) {
        const step = renames[job.next];
        for (let attempt = 0; ; attempt += 1) {
          if (job.overtaken) return;
          this._assertWritable();
          this._releaseForRename(step);
          const delayMs = renameAttempt(step.tmpPath, step.path, attempt);
          if (delayMs === null) break;
          await sleep(delayMs);
        }
        job.next += 1;
        this._renamed(job, step);
      }
    } catch (err) {
      // An exit drain that took over owns what is left.
      if (!job.overtaken) this._renamesFailed(job);
      throw err;
    }
  }

  // Builds every file of the rewrite (the new base, the redacted json and
  // copies aside), each proven, before anything moves; returns the renames
  // that swap them in, the log's first. The state is the session as the
  // rewrite was accepted with; its messages are projected now, with the
  // sensitive values as they are.
  _planRewrite({ header: accepted, messages, reason, redaction }) {
    const header = { ...accepted, id: this.sessionId };
    const messageJsons = messages.map((message) => this._messageJson(message));
    const temps = [];
    try {
      // The legacy json is redacted beside the log (the one case it is ever
      // written): its new identity is the new base's, and `redactedFrom`
      // names the old one so a crash between the two swaps is no divergence.
      const json = redaction?.jsonPath ? prepareRedactedJson(redaction, this.sessionId) : null;
      if (json) temps.push(json.tmpPath);
      const asides = redaction ? prepareRedactedAsides(this.logPath, redaction) : [];
      for (const aside of asides) temps.push(aside.tmpPath);
      const legacy = json ? json.legacy : this.legacy;
      const base = {
        logId: newLogId(),
        id: this.sessionId,
        prev: { logId: this.logId, seq: this._seq, reason },
        legacy,
        header,
      };
      const expected = () => ({ ...header, messages: messageJsons.map((text) => JSON.parse(text)) });
      const proven = writeProvenBase(this.logPath, base, messageJsons, expected);
      return {
        base,
        proven,
        legacy,
        messages,
        renames: [
          { tmpPath: proven.tmpPath, path: this.logPath, log: true },
          ...(json ? [{ tmpPath: json.tmpPath, path: redaction.jsonPath }] : []),
          ...asides,
        ],
      };
    } catch (err) {
      for (const tmpPath of temps) removeQuietly(tmpPath);
      throw err;
    }
  }

  // Windows refuses a rename over an open file: the recorder lets go of the
  // old log before the log's rename. No write of it is in flight then — a
  // batch's bytes are written synchronously (_drain), only fsyncs run off
  // the thread — so no write can land in a file that reuses the descriptor.
  _releaseForRename(step) {
    if (!step.log || this._fd === null) return;
    closeSync(this._fd);
    this._fd = null;
  }

  // The new log is the log from the step its rename landed in: the recorder
  // takes its state before the json and the copies aside are swapped, so a
  // failure of those leaves it recording on the log as it is. Nothing of the
  // old log is waiting then: what was applied before the rewrite was written
  // before its files were made, and the operations behind it are not applied.
  _renamed(job, step) {
    syncDir(dirname(step.path));
    if (!step.log) return;
    const { base, proven, legacy, messages } = job.plan;
    this._fd = openSync(this.logPath, 'r+');
    this.legacy = legacy;
    this._reset(base.logId, 1, proven.size, proven.replay.header, messages);
  }

  // A rename that did not land: the files not yet swapped in go, and before
  // the log's own rename the old log stays the log.
  _renamesFailed(job) {
    for (const step of job.plan.renames.slice(job.next)) removeQuietly(step.tmpPath);
    if (this._fd === null) this._fd = openSync(this.logPath, 'r+');
  }

  /** Waits for the queue, then closes the file. Pending failures reject. */
  async close() {
    if (this._closed) return;
    // A rewrite in flight swaps the file under the recorder: it (and any
    // queued behind it) ends first.
    while (this._rewriting) await this._rewriting;
    if (this._closed) return;
    let failure = null;
    if (!this._stale && !this._closedHard) await this.flush().catch((err) => (failure = err));
    await this._idle();
    this._closed = true;
    if (this._fd !== null) closeSync(this._fd);
    this._fd = null;
    if (failure) throw failure;
  }
}
