/**
 * Capture side of the display-only compaction archive (compaction-archive.mjs).
 *
 * A committed compaction hands over the transcript it replaced and the one
 * that replaced it. What left the model context — the messages whose stable
 * id (message-ids.mjs) the result no longer holds, and the lost parts of kept
 * messages (compactionArchiveProjection) — is projected to transcript items
 * exactly like stored history
 * (restoreTranscriptItems over media-sanitized messages, so tool cards and
 * diffs survive), namespaced as `arch<seq>_…` with `archived: true`, and
 * appended as ONE segment to the session's sidecar, followed by the
 * compaction divider.
 *
 * The commit selects the dropped messages, restores their rows (the one
 * visibility decision: a segment number is claimed only for a non-empty row
 * set) and allocates the segment number
 * (`session.compaction.archive.nextSeq`, saved with the commit); the
 * namespacing and the write run on a later event-loop turn, serialized per
 * session and fenced against a delete. A write the fence refuses is kept
 * (retried in place in the session's queue) while the session may still come
 * back to be written; a session that is really gone releases its number.
 * Nothing here touches `session.messages`.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { quarantinePath, renameWithRetrySync } from '../../../shared/atomic-file.mjs';
import { writeStderrBestEffort } from '../../../shared/best-effort-stderr.mjs';

import { getStoreDir } from './store/session-paths.mjs';
import { forgetSessionSaveBaseline } from './store/save-worker.mjs';
import { _hasPendingPersistence } from './store/pending-saves.mjs';
import { _messagesForDisk } from './store/serialize.mjs';
import { subscribeSessionPersistence } from './store/session-persistence-events.mjs';
import { registerSessionPurgeHook } from './store/session-observers.mjs';
import { messageIdOf, stampMessageIds } from './message-ids.mjs';
import { restoreTranscriptItems } from './transcript-restore/restore.mjs';
import { isAgentModeSession } from './agent-mode.mjs';
import {
  COMPACTION_ARCHIVE_MAX_BYTES,
  COMPACTION_DIVIDER_LABEL,
  compactionArchiveDeleteEpoch,
  compactionArchivePath,
  compactionSegmentHead,
  compactionSegmentLine,
} from './compaction-archive.mjs';

export { COMPACTION_DIVIDER_LABEL };

const pendingWrites = new Map();

// ── Dropped messages: by stable id only ──────────────────────────────────────

function toolCallsOf(message) {
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : message.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function callIdOf(call) {
  return String(call?.id || '');
}

function resultCallIdOf(message) {
  return message.role === 'tool' ? String(message.tool_call_id || message.toolCallId || '') : '';
}

function hasText(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((part) => typeof part?.text === 'string' && part.text.trim());
}

/** The stable ids `messages` carries (stampMessageIds / carryMessageId). */
function idsOf(messages) {
  const ids = new Set();
  for (const message of messages) {
    const id = messageIdOf(message);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Messages of `before` whose stable id the compacted `after` no longer holds,
 * in their original order. Identity is the id alone — never an object
 * reference, a position or content. A message without an id (a string-meta
 * context marker, see message-ids.mjs) has no display identity and is never
 * reported.
 */
export function droppedByCompaction(before, after) {
  const kept = idsOf(Array.isArray(after) ? after : []);
  return (Array.isArray(before) ? before : []).filter((message) => {
    const id = messageIdOf(message);
    return id && !kept.has(id);
  });
}

/**
 * What a compaction took out of the model context, in `before` order, for the
 * display archive: every dropped message, plus — for a kept message whose
 * rewrite lost part of it — the lost part (tool calls no copy still carries,
 * text when no copy has any) as a message of the same id. The tool results of
 * those calls are dropped messages, so their cards restore whole.
 * `textIds` are the ids whose text rows left the context: the dropped
 * messages and the kept ones that lost all their text.
 */
export function compactionArchiveProjection(before, after) {
  const copiesById = new Map();
  for (const message of Array.isArray(after) ? after : []) {
    const id = messageIdOf(message);
    if (!id) continue;
    if (!copiesById.has(id)) copiesById.set(id, []);
    copiesById.get(id).push(message);
  }
  const messages = [];
  const textIds = [];
  for (const message of Array.isArray(before) ? before : []) {
    const id = messageIdOf(message);
    if (!id) continue;
    const copies = copiesById.get(id);
    if (!copies) {
      messages.push(message);
      textIds.push(id);
      continue;
    }
    const keptCalls = new Set(copies.flatMap((copy) => toolCallsOf(copy).map(callIdOf)));
    const lostCalls = toolCallsOf(message).filter((call) => callIdOf(call) && !keptCalls.has(callIdOf(call)));
    const lostText = hasText(message.content) && !copies.some((copy) => hasText(copy.content));
    if (!lostCalls.length && !lostText) continue;
    if (lostText) textIds.push(id);
    const { toolCalls: _calls, tool_calls: _wireCalls, ...rest } = message;
    messages.push({
      ...rest,
      content: lostText ? message.content : '',
      ...(lostCalls.length ? { toolCalls: lostCalls } : {}),
    });
  }
  return { messages, textIds };
}

/** What a live view needs to find the rows of what left the context: the
 *  stable ids whose text rows went (projection `textIds`) and the tool calls
 *  that went (dropped results and calls no kept copy carries). */
export function droppedIdentitySummary(projection) {
  const callIds = new Set();
  for (const message of projection.messages) {
    for (const call of toolCallsOf(message)) if (callIdOf(call)) callIds.add(callIdOf(call));
    const resultId = resultCallIdOf(message);
    if (resultId) callIds.add(resultId);
  }
  return { messageIds: [...new Set(projection.textIds)], callIds: [...callIds] };
}

/** Stamp stable ids on the transcript a compaction is about to run on (or a
 *  resumed session restores rows from) and make sure they are persisted: the
 *  next save goes out whole instead of as a delta that would leave the
 *  stamped, already-saved messages unchanged on disk. Returns the count. */
export function stampCompactionMessageIds(messages, sessionId) {
  const stamped = stampMessageIds(messages, { sessionId });
  if (stamped && sessionId) forgetSessionSaveBaseline(String(sessionId));
  return stamped;
}
// ── Segment projection and publication ───────────────────────────────────────

/** The rows what left the context (compactionArchiveProjection messages)
 *  restores to as the session store would keep them on disk — media stripped
 *  and the session's sensitive values redacted, by the store's own projection
 *  (`_messagesForDisk`, sensitive-projection.mjs) — the single visibility
 *  decision of the archive: a segment exists exactly when this is non-empty.
 *  Evaluated again at publication, so the redaction is the one in force then. */
function segmentRows(messages, sessionId) {
  return restoreTranscriptItems(_messagesForDisk(messages, sessionId), { sessionId });
}

/** The display items of one segment: what left the context as stored history
 *  restores it, namespaced and marked archived, then the divider. Empty when
 *  nothing visible left. */
export function compactionSegmentItems(messages, { sessionId, seq, at, divider = true }) {
  return namespacedSegmentItems(segmentRows(messages, sessionId), { sessionId, seq, at, divider });
}

function namespacedSegmentItems(restored, { sessionId, seq, at, divider }) {
  if (!restored.length) return [];
  const prefix = `hist_${sessionId}_`;
  const items = restored.map((item) => {
    const id = String(item?.id ?? '');
    return { ...item, id: `arch${seq}_${id.startsWith(prefix) ? id.slice(prefix.length) : id}`, archived: true };
  });
  // Agent mode compacts silently: its transcript gets no compaction notice.
  if (!divider) return items;
  items.push({
    kind: 'statusdone',
    id: `arch${seq}_divider`,
    status: 'compacted',
    label: COMPACTION_DIVIDER_LABEL,
    at,
  });
  return items;
}

function itemBytes(item) {
  return Buffer.byteLength(JSON.stringify(item));
}

/** A segment line whose bytes plus its trailing newline fit `maxBytes`: a
 *  segment that alone exceeds the cap keeps its newest items (and the
 *  divider). `bytes` includes the newline. */
function cappedSegmentLine({ seq, prev, at, items }, maxBytes) {
  let line = compactionSegmentLine({ seq, prev, at, items });
  let bytes = Buffer.byteLength(line) + 1;
  if (bytes <= maxBytes) return { line, bytes };
  const sizes = items.map(itemBytes);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= sizes[start] + 1;
    start += 1;
  }
  line = compactionSegmentLine({ seq, prev, at, items: items.slice(start) });
  return { line, bytes: Buffer.byteLength(line) + 1 };
}

let publishHook = null;
/** Test seam: runs after a segment's temp file is written, right before the
 *  fenced publication. */
export function _setCompactionArchivePublishHook(hook) {
  publishHook = typeof hook === 'function' ? hook : null;
}

let parkHook = null;
/** Test seam: runs when a refused publication parks on the session's
 *  persistence signal (its wait is already registered). */
export function _setCompactionArchiveParkHook(hook) {
  parkHook = typeof hook === 'function' ? hook : null;
}

let syncFile = (handle) => handle.sync();
/** Test seam: replaces the temp file's fsync (null restores it). */
export function _setCompactionArchiveFsync(sync) {
  syncFile = typeof sync === 'function' ? sync : (handle) => handle.sync();
}

const realFs = { readFileSync, readdir };
let fsOps = realFs;
/** Test seam: replaces the pending-sidecar read (`readFileSync`) and the store
 *  listing (`readdir`); null restores them. */
export function _setCompactionArchiveFs(ops) {
  fsOps = ops ? { ...realFs, ...ops } : realFs;
}

const recordExists = (dir, sessionId) => existsSync(join(dir, `${sessionId}.json`));

/** Why a segment cannot be published now, or null. A delete that bumped the
 *  epoch since `epoch` was captured is final. A missing record is final too
 *  unless a save of that session is still pending — that save is what creates
 *  it, so the write is kept (`retry`). */
function publicationRefusal(dir, sessionId, epoch) {
  if (compactionArchiveDeleteEpoch(sessionId) !== epoch) return { reason: 'session deleted', retry: false };
  if (recordExists(dir, sessionId)) return null;
  return _hasPendingPersistence(sessionId)
    ? { reason: 'session record missing while its save is pending', retry: true }
    : { reason: 'session record missing', retry: false };
}

/** Write `text` to a private temp file and fsync it — a failed write or
 *  fsync fails the publication — then publish it with a synchronous fence
 *  check + rename: a delete that bumped the epoch (or removed the record)
 *  since `epoch` was captured wins. Any outcome but a rename removes the temp
 *  file. Returns null once published, else the fence's refusal. */
async function publishArchive({ dir, path, sessionId, text, epoch }) {
  const tmp = join(dir, `${basename(path)}.mixdog-tmp-${randomBytes(4).toString('hex')}`);
  const removeTmp = () => {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  };
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await syncFile(handle);
    } finally {
      await handle.close();
    }
    if (publishHook) await publishHook({ sessionId, path, tmp });
  } catch (error) {
    removeTmp();
    throw error;
  }
  // No await between the fence and the rename.
  const refusal = publicationRefusal(dir, sessionId, epoch);
  if (refusal) {
    removeTmp();
    return refusal;
  }
  try {
    renameWithRetrySync(tmp, path);
  } catch (error) {
    removeTmp();
    throw error;
  }
  return null;
}

/** Appends one segment: `{ segments }` once published, else the fence's
 *  refusal `{ reason, retry }`. */
async function appendSegment({ sessionId, seq, at, items, clearedThrough, maxBytes, epoch }) {
  const dir = getStoreDir();
  const path = compactionArchivePath(dir, sessionId);
  // A deleted session must not regrow its archive.
  const early = publicationRefusal(dir, sessionId, epoch);
  if (early) return early;
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  const existing = [];
  for (const line of text.split('\n')) {
    const head = compactionSegmentHead(line);
    // Segments a clear hid are dropped on the next write.
    if (head && head.seq > clearedThrough && head.seq !== seq) existing.push({ line, head });
  }
  const prev = existing.length ? existing.at(-1).head.seq : null;
  const segment = cappedSegmentLine({ seq, prev, at, items }, maxBytes);
  let total = segment.bytes;
  for (const entry of existing) total += Buffer.byteLength(entry.line) + 1;
  while (existing.length && total > maxBytes) {
    total -= Buffer.byteLength(existing.shift().line) + 1;
  }
  const lines = [...existing.map((entry) => entry.line), segment.line];
  const refusal = await publishArchive({ dir, path, sessionId, text: `${lines.join('\n')}\n`, epoch });
  if (refusal) return refusal;
  return { segments: lines.map((line) => compactionSegmentHead(line)).filter(Boolean) };
}

function logArchiveSkip(sessionId, seq, what, reason) {
  writeStderrBestEffort(`[session] compaction archive write ${what} (sess=${sessionId}, seq=${seq}): ${reason}\n`);
}

/** The session is really gone: give the claimed number back unless something
 *  newer was claimed after it or a clear already covers it. */
function releaseClaimedSeq(session, seq) {
  const archive = session.compaction?.archive;
  if (!archive || typeof archive !== 'object') return;
  if (archive.nextSeq === seq + 1 && !(Number(archive.clearedThrough) >= seq)) archive.nextSeq = seq;
}

// ── Unpublished segments ─────────────────────────────────────────────────────
// A segment's job lives in `unpublished[id]` (ascending seq) from the moment
// its number is claimed until it is published or its session is really gone.
// A failed write, or one that cannot be published yet, leaves the job there:
// the next archive write or the next successful save of the session retries it
// first. The moment a job is parked or has failed it is also written to a
// pending sidecar `<id>.compaction-archive.pending` (removed once published or
// when the session is deleted), which survives a crash or kill; the daemon's
// startup scan (recoverPendingCompactionArchives) and the session's next
// save/compaction pick it up. The sidecar holds the rows' source messages in their stored
// (disk-projected) form.
// A sidecar is only ever rewritten or removed by a process that has loaded it
// (`recovered`): a read that fails for any reason but absence leaves the
// session unrecovered, its compaction refused, and the sidecar untouched.
const COMPACTION_PENDING_SUFFIX = '.compaction-archive.pending';
const unpublished = new Map();
const recovered = new Set();
const sidecarOnDisk = new Set();
const waiters = new Map();

const jobsOf = (id) => {
  let list = unpublished.get(id);
  if (!list) {
    list = [];
    unpublished.set(id, list);
  }
  return list;
};

const pendingSidecarPath = (dir, id) => join(dir, `${id}${COMPACTION_PENDING_SUFFIX}`);

/** Rewrites the pending sidecar to the session's unpublished jobs (removes it
 *  when none are left). Synchronous: it also runs at process exit. */
function persistPending(id) {
  // Jobs of an unrecovered sidecar are unknown here: rewriting or removing it
  // would drop them.
  if (!recovered.has(id)) {
    writeStderrBestEffort(`[session] compaction archive pending sidecar not rewritten before it was read (sess=${id})\n`);
    return false;
  }
  const path = pendingSidecarPath(getStoreDir(), id);
  // A job of a deleted incarnation (older delete epoch) is never kept.
  const epoch = compactionArchiveDeleteEpoch(id);
  const jobs = (unpublished.get(id) ?? []).filter((job) => job.epoch === epoch);
  if (!jobs.length) {
    if (sidecarOnDisk.delete(id)) {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
    return true;
  }
  const tmp = `${path}.mixdog-tmp-${randomBytes(4).toString('hex')}`;
  try {
    const text = JSON.stringify({
      v: 1,
      jobs: jobs.map(({ seq, at, divider, clearedThrough, maxBytes, messages }) => ({
        seq,
        at,
        divider,
        clearedThrough,
        maxBytes,
        messages: _messagesForDisk(messages, id),
      })),
    });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetrySync(tmp, path);
    sidecarOnDisk.add(id);
    return true;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    writeStderrBestEffort(
      `[session] compaction archive pending sidecar failed (sess=${id}): ${error?.message || error}\n`
    );
    return false;
  }
}

/** The jobs a sidecar's text holds, or null when the text is not a job list
 *  (damaged: unparseable, or not `{ jobs: [{ seq, messages }, …] }`). */
function parsePendingJobs(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const jobs = doc?.jobs;
  return Array.isArray(jobs) && jobs.every((job) => Number.isInteger(job?.seq) && Array.isArray(job.messages))
    ? jobs
    : null;
}

/** Loads the jobs a previous process left in the session's pending sidecar,
 *  once per process. The session counts as recovered only after the sidecar
 *  was loaded or is confirmed absent (ENOENT): any other read failure throws
 *  and leaves it unrecovered (see persistPending). A damaged sidecar is moved
 *  aside whole as `<file>.corrupt-<ts>`, like every damaged state file
 *  (atomic-file.mjs); its bytes are kept, and a failure to move it throws. */
function recoverPending(id) {
  if (recovered.has(id)) return;
  const path = pendingSidecarPath(getStoreDir(), id);
  let text;
  try {
    text = fsOps.readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    recovered.add(id);
    return;
  }
  const saved = parsePendingJobs(text);
  if (!saved) {
    const aside = quarantinePath(path);
    renameWithRetrySync(path, aside);
    writeStderrBestEffort(`[session] compaction archive pending sidecar damaged (sess=${id}); kept as ${aside}\n`);
    recovered.add(id);
    return;
  }
  const list = jobsOf(id);
  const epoch = compactionArchiveDeleteEpoch(id);
  for (const job of saved) {
    if (list.some((held) => held.seq === job.seq)) continue;
    list.push({ ...job, id, session: null, epoch, segments: null });
  }
  list.sort((a, b) => a.seq - b.seq);
  sidecarOnDisk.add(id);
  recovered.add(id);
}

/** recoverPending for callers that cannot refuse (a save event, the startup
 *  scan): a failure is reported and leaves the session unrecovered. Returns
 *  whether the session is recovered. */
function tryRecoverPending(id) {
  try {
    recoverPending(id);
    return true;
  } catch (error) {
    writeStderrBestEffort(
      `[session] compaction archive pending sidecar unreadable (sess=${id}): ${error?.message || error}; left untouched\n`
    );
    return false;
  }
}

/** Removes the session's pending sidecar from disk, whatever is in memory. */
function removePendingSidecar(id) {
  sidecarOnDisk.delete(id);
  try {
    unlinkSync(pendingSidecarPath(getStoreDir(), id));
  } catch {
    /* none on disk */
  }
}

/**
 * One-shot scan after daemon startup: every pending sidecar a previous process
 * left whose session record still exists is loaded and its segments are
 * published through the normal write queue (oldest first). Returns how many
 * sessions had segments to publish. A store directory that does not exist is
 * empty; any other listing failure is thrown. A session whose sidecar cannot
 * be read is reported and skipped, the others still recover.
 */
export async function recoverPendingCompactionArchives() {
  const dir = getStoreDir();
  let names;
  try {
    names = await fsOps.readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(COMPACTION_PENDING_SUFFIX)) continue;
    const id = name.slice(0, -COMPACTION_PENDING_SUFFIX.length);
    if (!compactionArchivePath('', id) || !recordExists(dir, id)) continue;
    if (!tryRecoverPending(id)) continue;
    if (!unpublished.get(id)?.length) continue;
    count += 1;
    void enqueueFlush(id);
  }
  return count;
}

/** Settles with 'landed' | 'closed' | 'deleted' at the session's next such event. */
function waitForSessionEvent(id) {
  return new Promise((resolve) => {
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(resolve);
  });
}

function wakeWaiters(id, event) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const resolve of set) resolve(event);
}

/** Gives up on one job (or all of the session's) with a logged reason. */
function dropJobs(id, reason, only = null) {
  const list = unpublished.get(id);
  if (!list) return;
  const dropped = only ? list.filter((job) => job === only) : list.splice(0);
  if (only) list.splice(list.indexOf(only), 1);
  if (!list.length) unpublished.delete(id);
  for (const job of [...dropped].reverse()) {
    logArchiveSkip(id, job.seq, 'skipped', reason);
    if (job.session) releaseClaimedSeq(job.session, job.seq);
  }
  if (sidecarOnDisk.has(id)) persistPending(id);
}

/** Appends one job's segment: `{ segments }` once published, else a refusal
 *  `{ reason, retry, single }`. Rows are projected here, at publication. */
async function publishJob(job) {
  const items = namespacedSegmentItems(segmentRows(job.messages, job.id), {
    sessionId: job.id,
    seq: job.seq,
    at: job.at,
    divider: job.divider,
  });
  if (!items.length) return { reason: 'no visible rows at publication', retry: false, single: true };
  return appendSegment({
    sessionId: job.id,
    seq: job.seq,
    at: job.at,
    items,
    clearedThrough: job.clearedThrough,
    maxBytes: job.maxBytes,
    epoch: job.epoch,
  });
}

/** Publishes the session's unpublished jobs oldest first, inside its write
 *  queue. Stops at the first job that cannot be published yet; it stays. */
async function flushUnpublished(id) {
  await new Promise((resolve) => setImmediate(resolve));
  for (;;) {
    const list = unpublished.get(id);
    const job = list?.[0];
    if (!job) {
      unpublished.delete(id);
      return;
    }
    let outcome;
    try {
      outcome = await publishJob(job);
    } catch (error) {
      if (unpublished.get(id) !== list || list[0] !== job) return;
      writeStderrBestEffort(
        `[session] compaction archive write failed (sess=${id}, seq=${job.seq}): ${error?.message || error}; kept for retry\n`
      );
      return;
    }
    if (unpublished.get(id) !== list || list[0] !== job) return;
    if (outcome.segments) {
      list.shift();
      job.segments = outcome.segments;
      const archive = job.session?.compaction?.archive;
      // Small metadata only; a later clear may have hidden this segment.
      if (archive && typeof archive === 'object' && !(Number(archive.clearedThrough) >= job.seq)) {
        archive.segments = outcome.segments;
      }
      if (sidecarOnDisk.has(id)) persistPending(id);
      continue;
    }
    if (outcome.retry) {
      // The session's own save is what creates its record: wait for that save
      // to land (no polling). A delete ends the wait; a close keeps the jobs
      // for the next process.
      if (!job.deferred) logArchiveSkip(id, job.seq, 'deferred', `${outcome.reason}; waiting for it`);
      job.deferred = true;
      const waiting = waitForSessionEvent(id);
      parkHook?.({ sessionId: id, seq: job.seq });
      const event = await waiting;
      if (event !== 'landed') return;
      continue;
    }
    dropJobs(id, outcome.reason, outcome.single ? job : null);
    if (outcome.single) continue;
    return;
  }
}

function enqueueFlush(id) {
  const task = (pendingWrites.get(id) || Promise.resolve())
    .then(() => flushUnpublished(id))
    .catch((error) => {
      writeStderrBestEffort(`[session] compaction archive write failed (sess=${id}): ${error?.message || error}\n`);
    });
  pendingWrites.set(id, task);
  void task.finally(() => {
    if (pendingWrites.get(id) === task) pendingWrites.delete(id);
  });
  return task;
}

subscribeSessionPersistence((id, event) => {
  wakeWaiters(id, event);
  if (event !== 'landed') return;
  if (!tryRecoverPending(id)) return;
  if (unpublished.get(id)?.length) void enqueueFlush(id);
});

registerSessionPurgeHook((id) => {
  wakeWaiters(id, 'deleted');
  dropJobs(id, 'session deleted');
  // A sidecar a previous process left is dropped too, in-memory jobs or not.
  removePendingSidecar(id);
  recovered.delete(id);
});

/** Test seam: forget all in-memory state (a restart); sidecars stay on disk. */
export function _resetCompactionArchiveState() {
  unpublished.clear();
  recovered.clear();
  sidecarOnDisk.clear();
  waiters.clear();
}

/**
 * Archive what a compaction drops, write-ahead. Synchronous part: select the
 * dropped messages, capture the delete fence, allocate the segment number on
 * `session.compaction.archive` and make the job durable in the pending
 * sidecar — call it BEFORE the shortened transcript is adopted (and so can be
 * saved). When the sidecar cannot be written the claim is given back and this
 * throws: the caller must keep the old transcript. Returns `{ dropped,
 * identities, start }` — `start()` queues the publication and returns the
 * pending write (resolves to the retained segment list) — or null when
 * nothing visible was dropped (a rewrite-only compaction).
 */
export function prepareCompactionArchive({
  session,
  sessionId = null,
  before,
  after,
  at = Date.now(),
  maxBytes = COMPACTION_ARCHIVE_MAX_BYTES,
}) {
  const id = String(sessionId || session?.id || '');
  if (!session || typeof session !== 'object' || !compactionArchivePath('', id)) return null;
  const projection = compactionArchiveProjection(before, after);
  // Only what the transcript shows is archived; a pass that took out nothing
  // visible (a rewrite, control rows, hidden context) leaves the view live.
  // The rows are decided here, once, as the segment will hold them, so a
  // number is claimed only for a segment that has items.
  const rows = segmentRows(projection.messages, id);
  if (!rows.length) return null;
  const dropped = droppedByCompaction(before, after);
  // Segments a previous run left unpublished (pending sidecar) hold their
  // numbers. A sidecar that cannot be read throws before anything is claimed:
  // the caller keeps the old transcript, and the sidecar is left as it is.
  recoverPending(id);
  if (!session.compaction || typeof session.compaction !== 'object') session.compaction = {};
  const previous =
    session.compaction.archive && typeof session.compaction.archive === 'object' ? session.compaction.archive : {};
  const held = unpublished.get(id)?.at(-1)?.seq ?? 0;
  const seq = Math.max(1, held + 1, Math.floor(Number(previous.nextSeq) || 1));
  const clearedThrough = Math.max(0, Math.floor(Number(previous.clearedThrough) || 0));
  const epoch = compactionArchiveDeleteEpoch(id);
  session.compaction.archive = { ...previous, nextSeq: seq + 1 };
  const divider = !isAgentModeSession(session);
  const job = {
    id,
    session,
    seq,
    at,
    divider,
    messages: projection.messages,
    clearedThrough,
    maxBytes,
    epoch,
    segments: null,
  };
  const list = jobsOf(id);
  list.push(job);
  if (!persistPending(id)) {
    list.pop();
    if (!list.length) unpublished.delete(id);
    releaseClaimedSeq(session, seq);
    logArchiveSkip(id, seq, 'aborted', 'pending sidecar not written; compaction not applied');
    throw new Error(`compaction archive: pending sidecar for ${id} could not be written`);
  }
  return {
    dropped: dropped.length,
    identities: droppedIdentitySummary(projection),
    start: () => enqueueFlush(id).then(() => job.segments),
  };
}

/** prepareCompactionArchive + start, for a caller that adopts the transcript
 *  itself first. Resolves `written` as before. */
export function scheduleCompactionArchive(args) {
  const prepared = prepareCompactionArchive(args);
  if (!prepared) return null;
  return { dropped: prepared.dropped, identities: prepared.identities, written: prepared.start() };
}

/** Hide everything archived so far (a clear): later reads and the next write
 *  skip those segments. */
export function hideCompactionArchive(session) {
  const archive = session?.compaction?.archive;
  if (!archive || typeof archive !== 'object') return;
  session.compaction.archive = {
    ...archive,
    clearedThrough: Math.max(0, Math.floor(Number(archive.nextSeq) || 1) - 1),
    segments: [],
  };
}

/** Settles once every archive write scheduled so far has finished. */
export async function flushCompactionArchiveWrites() {
  await Promise.all([...pendingWrites.values()]);
}
