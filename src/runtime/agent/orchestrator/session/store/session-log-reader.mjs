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
import {
  SCAN_GUARD_BYTES,
  bytesDigest,
  dropScanCheckpoint,
  loadScanCheckpoint,
  loadScanCheckpointSync,
  saveScanCheckpointSync,
  wantsScanCheckpoint,
} from './session-scan-checkpoint.mjs';

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
export function parseSessionLog(bytes, { messages: wantMessages = true, facts = null } = {}) {
  const replay = newReplay(wantMessages, facts);
  replayBytes(replay, bytes, 0);
  return replayResult(replay, bytes.length);
}

// A replay in progress: what the records read so far amount to. `facts`
// (`{ project(message), version }`): the transcript is kept as what `project`
// makes of each message (the result's `facts`, no `messages`), a transcript
// too large to hold as it is.
function newReplay(wantMessages, facts = null) {
  return {
    base: null,
    count: 0,
    length: 0,
    lastCompacted: -1,
    project: facts?.project ?? null,
    messages: wantMessages || facts ? [] : undefined,
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
    else if (replay.messages && isMessageRecord(record)) {
      applyMessageRecord(
        replay.messages,
        replay.project && record.messages ? { ...record, messages: record.messages.map(replay.project) } : record
      );
    }
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
    messages: replay.project ? undefined : replay.messages,
    messageCount: 0,
    size,
    tornTail: replay.tornTail,
    skipped: kept ? replay.skipped.slice() : replay.skipped,
    damage: replay.damage,
    replayFrom: -1,
  };
  // Facts are never changed once made: a copy of the list is all that is not shared.
  if (replay.project) result.facts = kept ? replay.messages.slice() : replay.messages;
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
//
// A process (or a worker thread) that has just started has no place of its
// own, and its first scan of each log read all of it. A caller that names a
// checkpoint directory (`checkpoints`) lets scans leave their place there
// (session-scan-checkpoint.mjs), every SCAN_STRIDE_BYTES of growth, and a scan
// with no place in memory takes it from there; it is held to the same proof as
// a place in memory, which includes the first bytes of the log (its base names
// the log: a new log is a new id).
const SCAN_RESUME_LIMIT = 256;
const _scans = new Map(); // path → { ino, offset, guard, first, persisted, replay }
// The scans that keep the facts of every message hold more than a header: fewer
// of them are kept (the rest go on from their checkpoint, or from the start).
const FACT_SCAN_RESUME_LIMIT = 48;
const _factScans = new Map();
const scanTable = (key) => (key.startsWith('facts-') ? _factScans : _scans);

// The scan of `path` to resume on a file whose bigint stat is `st`, taken out
// of the table for as long as it is being applied to (a scan of the same path
// started meanwhile starts over); null to scan from the start.
function takeScan(path, st) {
  const table = scanTable(path);
  const held = table.get(path);
  table.delete(path);
  return held && held.ino === st.ino && st.size >= BigInt(held.offset) ? held : null;
}

function keepScan(path, st, entry) {
  // A damaged log is replayed whole each time: its end is not a place to go on from.
  if (entry.replay.damage) return;
  const table = scanTable(path);
  table.set(path, { ino: st.ino, ...entry });
  const limit = table === _scans ? SCAN_RESUME_LIMIT : FACT_SCAN_RESUME_LIMIT;
  while (table.size > limit) table.delete(table.keys().next().value);
}

// The place a checkpoint holds, for a log whose bigint stat is `st`; null when
// the file no longer reaches it (the guards prove the rest).
function adoptCheckpoint(checkpoint, st) {
  if (!checkpoint || checkpoint.ino !== st.ino || st.size < BigInt(checkpoint.offset)) return null;
  const { ino: _ino, ...place } = checkpoint;
  return { ...place, persisted: checkpoint.offset };
}

// How many bytes of the log's start, and of its end before the offset, a place covers.
const placeLength = (held) => held.first?.length ?? held.guardLength;

// Whether the log's `first` bytes and the `guard` bytes before the place's
// offset are the ones the place was left on. A place from a checkpoint holds
// their digests only; once they prove it, the bytes are its own.
function provesPlace(held, first, guard) {
  if (held.first) return first.equals(held.first) && guard.equals(held.guard);
  if (bytesDigest(first) !== held.firstDigest || bytesDigest(guard) !== held.guardDigest) return false;
  held.first = first;
  held.guard = guard;
  return true;
}

// The first bytes of the log, of `before` (those of the offset the read
// started at) and the `applied` bytes of `read` that follow.
function firstAt(before, read, applied) {
  if (before.length >= SCAN_GUARD_BYTES) return before;
  return Buffer.concat([before, read.subarray(0, Math.min(applied, SCAN_GUARD_BYTES - before.length))]);
}

// The last bytes before `offset`, of `before` (the guard of the offset the
// read started at) followed by the `read` bytes that were applied.
function guardAt(before, read, applied) {
  const all = applied >= SCAN_GUARD_BYTES ? read.subarray(0, applied) : Buffer.concat([before, read.subarray(0, applied)]);
  return Buffer.from(all.subarray(Math.max(0, all.length - SCAN_GUARD_BYTES)));
}

const NO_BYTES = Buffer.alloc(0);

// Reads up to `length` bytes at file `position` into `target` from `at`; how many arrived.
function readIntoSync(fd, target, at, length, position) {
  let got = 0;
  while (got < length) {
    const n = readSync(fd, target, at + got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

async function readInto(handle, target, at, length, position) {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(target, at + got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

function readAtSync(fd, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  const got = readIntoSync(fd, bytes, 0, length, position);
  return got === length ? bytes : bytes.subarray(0, got);
}

async function readAt(handle, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  const got = await readInto(handle, bytes, 0, length, position);
  return got === length ? bytes : bytes.subarray(0, got);
}

const SCAN_BLOCK_BYTES = 8 * 1024 * 1024;

// A scan's table key and checkpoint kind: a scan that keeps facts is another
// scan of the same log than one that keeps its header only.
const scanKey = (path, facts) => (facts ? `facts-${facts.version}:${path}` : path);
const checkpointKind = (facts) => (facts ? `facts-${facts.version}` : '');

// A scan being applied block by block: a log of hundreds of megabytes is
// never held as one buffer.
function beginScan(held, facts) {
  const replay = held ? held.replay : newReplay(false, facts);
  // A replay taken from a checkpoint has no projection yet.
  replay.project = facts?.project ?? null;
  replay.tornTail = null;
  const from = held ? held.offset : 0;
  return {
    replay,
    offset: from,
    end: from,
    guard: held ? held.guard : NO_BYTES,
    first: held ? held.first : NO_BYTES,
  };
}

// The block `block` (the file's bytes from `scan.end`) ends in `whole` bytes of
// finished lines (all of it when `final`: its own unfinished line is a torn
// tail; none when the block holds no line end). The bytes a replay applies are
// those from `scan.offset`: the unfinished line the last blocks ended in, then
// these.
//
// An unfinished line is never kept: only how long it is (`scan.end -
// scan.offset`). Its end is looked for in the new block alone, and when it
// arrives the line is read again from the file straight into the one buffer
// that holds it (`joinedLines`), so a line of hundreds of megabytes costs that
// buffer once, never its pieces beside their join, and never a search or a
// copy per block (that was quadratic: one very long record, a large compacted
// history, took minutes).
const wholeLinesOf = (block, final) => (final ? block.length : block.lastIndexOf(NEWLINE) + 1);

// `bytes`: the finished lines from `scan.offset`, as `joinedLines` made them;
// false when the replay stopped on damage.
function applyBlock(scan, block, whole, bytes) {
  const at = scan.offset;
  scan.end += block.length;
  if (whole === 0) return true;
  scan.offset = replayBytes(scan.replay, bytes, at);
  const applied = bytes.subarray(0, scan.offset - at);
  scan.guard = guardAt(scan.guard, applied, applied.length);
  scan.first = firstAt(scan.first, applied, applied.length);
  return !scan.replay.damage;
}

// The finished lines of `block` after the unfinished one before it: `block`'s
// own bytes when nothing is carried, else one buffer filled from the file.
function joinedLines(scan, block, whole, read) {
  const carried = scan.end - scan.offset;
  if (whole === 0 || carried === 0) return block.subarray(0, whole);
  const bytes = Buffer.allocUnsafe(carried + whole);
  const got = read(bytes, carried, scan.offset);
  if (got instanceof Promise) return got.then((n) => joined(bytes, n, carried, block, whole));
  return joined(bytes, got, carried, block, whole);
}

// null: the file ended before the carried bytes did (it shrank under the scan).
function joined(bytes, got, carried, block, whole) {
  if (got < carried) return null;
  block.copy(bytes, carried, 0, whole);
  return bytes;
}
// `{ result, save }`: the scan's result, and the place to leave in the
// checkpoint directory (null: none is due). `size`: the log's length at the
// scan's stat.
function finishScan(key, st, held, scan, checkpoints) {
  const entry = {
    offset: scan.offset,
    guard: scan.guard,
    first: scan.first,
    persisted: held ? held.persisted : 0,
    replay: scan.replay,
  };
  const save = checkpoints && wantsScanCheckpoint(scan.replay, scan.offset, entry.persisted) ? { ino: st.ino, ...entry } : null;
  if (save) entry.persisted = scan.offset;
  keepScan(key, st, entry);
  const size = scan.replay.damage ? Number(st.size) : scan.end;
  return { result: replayResult(scan.replay, size, true), save };
}

function scanSessionLogSync(path, { checkpoints = null, facts = null } = {}) {
  const key = scanKey(path, facts);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    scanTable(key).delete(key);
    if (absent(err)) {
      if (checkpoints) dropScanCheckpoint(checkpoints, path, checkpointKind(facts));
      return null;
    }
    throw err;
  }
  let done;
  try {
    const st = fstatSync(fd, { bigint: true });
    let held = takeScan(key, st);
    const fromCheckpoint = !held && checkpoints;
    if (fromCheckpoint) {
      held = adoptCheckpoint(loadScanCheckpointSync(checkpoints, path, checkpointKind(facts)), st);
    }
    if (
      held &&
      !provesPlace(
        held,
        readAtSync(fd, placeLength(held), 0),
        readAtSync(fd, placeLength(held), held.offset - placeLength(held))
      )
    ) {
      held = null;
    }
    // A checkpoint of another file (or of the same file before it was
    // rewritten) holds what it kept of that one: it goes now, not when a later
    // scan of this one overwrites it.
    if (fromCheckpoint && !held) dropScanCheckpoint(checkpoints, path, checkpointKind(facts));
    const scan = beginScan(held, facts);
    const size = Number(st.size);
    while (scan.end < size) {
      const block = readAtSync(fd, Math.min(SCAN_BLOCK_BYTES, size - scan.end), scan.end);
      if (block.length === 0) break;
      const whole = wholeLinesOf(block, scan.end + block.length >= size);
      const bytes = joinedLines(scan, block, whole, (target, length, position) => readIntoSync(fd, target, 0, length, position));
      if (!bytes || !applyBlock(scan, block, whole, bytes)) break;
    }
    done = finishScan(key, st, held, scan, checkpoints);
  } finally {
    closeSync(fd);
  }
  // Published with the log closed, and only if the log is still the one read (session-scan-checkpoint.mjs).
  if (done.save) saveScanCheckpointSync(checkpoints, path, done.save, checkpointKind(facts));
  return done.result;
}

async function scanSessionLog(path, { checkpoints = null, facts = null } = {}) {
  const key = scanKey(path, facts);
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    scanTable(key).delete(key);
    if (absent(err)) {
      if (checkpoints) dropScanCheckpoint(checkpoints, path, checkpointKind(facts));
      return null;
    }
    throw err;
  }
  let done;
  try {
    const st = await handle.stat({ bigint: true });
    let held = takeScan(key, st);
    const fromCheckpoint = !held && checkpoints;
    if (fromCheckpoint) {
      held = adoptCheckpoint(await loadScanCheckpoint(checkpoints, path, checkpointKind(facts)), st);
    }
    if (
      held &&
      !provesPlace(
        held,
        await readAt(handle, placeLength(held), 0),
        await readAt(handle, placeLength(held), held.offset - placeLength(held))
      )
    ) {
      held = null;
    }
    // A checkpoint of another file (or of the same file before it was
    // rewritten) holds what it kept of that one: it goes now, not when a later
    // scan of this one overwrites it.
    if (fromCheckpoint && !held) dropScanCheckpoint(checkpoints, path, checkpointKind(facts));
    const scan = beginScan(held, facts);
    const size = Number(st.size);
    while (scan.end < size) {
      const block = await readAt(handle, Math.min(SCAN_BLOCK_BYTES, size - scan.end), scan.end);
      if (block.length === 0) break;
      const whole = wholeLinesOf(block, scan.end + block.length >= size);
      const bytes = await joinedLines(scan, block, whole, (target, length, position) => readInto(handle, target, 0, length, position));
      if (!bytes || !applyBlock(scan, block, whole, bytes)) break;
    }
    done = finishScan(key, st, held, scan, checkpoints);
  } finally {
    await handle.close();
  }
  // Published with the log closed, and only if the log is still the one read (session-scan-checkpoint.mjs).
  if (done.save) saveScanCheckpointSync(checkpoints, path, done.save, checkpointKind(facts));
  return done.result;
}

// A full replay, a block at a time like a scan, from the start: what is held
// is the transcript as it stands, one block and the line being applied, never
// the file. Read as one buffer, a 488 MB log (621 messages) took the daemon's
// memory up by its size at every load and every open for writing (2026-11-12).
const beginReplay = (facts) => ({ replay: newReplay(true, facts), offset: 0, end: 0, guard: NO_BYTES, first: NO_BYTES });
const replayed = (scan, size) => replayResult(scan.replay, scan.replay.damage ? size : scan.end);

/** Replay the log open as `fd` (parseSessionLog of its bytes, never held whole). */
export function replaySessionLogFdSync(fd, { facts = null } = {}) {
  const size = Number(fstatSync(fd, { bigint: true }).size);
  const scan = beginReplay(facts);
  while (scan.end < size) {
    const block = readAtSync(fd, Math.min(SCAN_BLOCK_BYTES, size - scan.end), scan.end);
    if (block.length === 0) break;
    const whole = wholeLinesOf(block, scan.end + block.length >= size);
    const bytes = joinedLines(scan, block, whole, (target, length, position) => readIntoSync(fd, target, 0, length, position));
    if (!bytes || !applyBlock(scan, block, whole, bytes)) break;
  }
  return replayed(scan, size);
}

async function replaySessionLogHandle(handle, { facts = null } = {}) {
  const size = Number((await handle.stat({ bigint: true })).size);
  const scan = beginReplay(facts);
  while (scan.end < size) {
    const block = await readAt(handle, Math.min(SCAN_BLOCK_BYTES, size - scan.end), scan.end);
    if (block.length === 0) break;
    const whole = wholeLinesOf(block, scan.end + block.length >= size);
    const bytes = await joinedLines(scan, block, whole, (target, length, position) => readInto(handle, target, 0, length, position));
    if (!bytes || !applyBlock(scan, block, whole, bytes)) break;
  }
  return replayed(scan, size);
}

/** Replay `path`; null when the log does not exist. */
export async function readSessionLog(path, options) {
  if (options?.messages === false) return scanSessionLog(path, options);
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
  try {
    return await replaySessionLogHandle(handle, options);
  } finally {
    await handle.close();
  }
}

export function readSessionLogSync(path, options) {
  if (options?.messages === false) return scanSessionLogSync(path, options);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (absent(err)) return null;
    throw err;
  }
  try {
    return replaySessionLogFdSync(fd, options);
  } finally {
    closeSync(fd);
  }
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
export async function resolveSessionRecord({
  jsonPath,
  logPath,
  loadLegacy,
  messages = true,
  stamp = null,
  checkpoints = null,
  facts = null,
}) {
  const stamped = stamp === null ? null : parseSessionRecordStamp(stamp);
  const log = stamped && !stamped.log ? null : await readSessionLog(logPath, { messages, checkpoints, facts });
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

export function resolveSessionRecordSync({
  jsonPath,
  logPath,
  loadLegacy,
  messages = true,
  stamp = null,
  checkpoints = null,
  facts = null,
}) {
  const stamped = stamp === null ? null : parseSessionRecordStamp(stamp);
  const log = stamped && !stamped.log ? null : readSessionLogSync(logPath, { messages, checkpoints, facts });
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
