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
 * The commit only selects the dropped messages and allocates the segment
 * number (`session.compaction.archive.nextSeq`, saved with the commit); the
 * projection and the write run on a later event-loop turn, serialized per
 * session and fenced against a delete. Nothing here touches
 * `session.messages`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { renameWithRetrySync } from '../../../shared/atomic-file.mjs';
import { writeStderrBestEffort } from '../../../shared/best-effort-stderr.mjs';

import { sanitizeContentForStoredHistory } from '../providers/media-normalization.mjs';
import { getStoreDir } from './store/session-paths.mjs';
import { forgetSessionSaveBaseline } from './store/save-worker.mjs';
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

function storedHistoryMessage(message) {
  const content = sanitizeContentForStoredHistory(message.content);
  return content === message.content ? message : { ...message, content };
}

/** The display items of one segment: what left the context
 *  (compactionArchiveProjection messages) as stored history restores it,
 *  namespaced and marked archived, then the divider. Empty when nothing
 *  visible left. */
export function compactionSegmentItems(messages, { sessionId, seq, at, divider = true }) {
  const restored = restoreTranscriptItems(messages.map(storedHistoryMessage), { sessionId });
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

let syncFile = (handle) => handle.sync();
/** Test seam: replaces the temp file's fsync (null restores it). */
export function _setCompactionArchiveFsync(sync) {
  syncFile = typeof sync === 'function' ? sync : (handle) => handle.sync();
}

const recordExists = (dir, sessionId) => existsSync(join(dir, `${sessionId}.json`));

/** Write `text` to a private temp file and fsync it — a failed write or
 *  fsync fails the publication — then publish it with a synchronous fence
 *  check + rename: a delete that bumped the epoch (or removed the record)
 *  since `epoch` was captured wins. Any outcome but a rename removes the temp
 *  file. */
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
  if (compactionArchiveDeleteEpoch(sessionId) !== epoch || !recordExists(dir, sessionId)) {
    removeTmp();
    return false;
  }
  try {
    renameWithRetrySync(tmp, path);
  } catch (error) {
    removeTmp();
    throw error;
  }
  return true;
}

async function appendSegment({ sessionId, seq, at, items, clearedThrough, maxBytes, epoch }) {
  const dir = getStoreDir();
  const path = compactionArchivePath(dir, sessionId);
  // A deleted session must not regrow its archive.
  if (!path || compactionArchiveDeleteEpoch(sessionId) !== epoch || !recordExists(dir, sessionId)) return null;
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
  if (!(await publishArchive({ dir, path, sessionId, text: `${lines.join('\n')}\n`, epoch }))) return null;
  return lines.map((line) => compactionSegmentHead(line)).filter(Boolean);
}

/**
 * Archive what a committed compaction dropped. Synchronous part: select the
 * dropped messages, capture the delete fence and allocate the segment number
 * on `session.compaction.archive`; the rest runs later. Returns
 * `{ dropped, identities, written }` — the dropped message count, their
 * identities for a live view (droppedIdentitySummary) and the pending write
 * (resolves to the retained segment list) — or null when nothing visible was
 * dropped (a rewrite-only compaction).
 */
export function scheduleCompactionArchive({
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
  // Short-circuits on the first visible message.
  if (!projection.messages.some((message) => restoreTranscriptItems([message], { sessionId: id }).length > 0)) {
    return null;
  }
  const dropped = droppedByCompaction(before, after);
  if (!session.compaction || typeof session.compaction !== 'object') session.compaction = {};
  const previous =
    session.compaction.archive && typeof session.compaction.archive === 'object' ? session.compaction.archive : {};
  const seq = Math.max(1, Math.floor(Number(previous.nextSeq) || 1));
  const clearedThrough = Math.max(0, Math.floor(Number(previous.clearedThrough) || 0));
  const epoch = compactionArchiveDeleteEpoch(id);
  session.compaction.archive = { ...previous, nextSeq: seq + 1 };
  const divider = !isAgentModeSession(session);
  const run = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const items = compactionSegmentItems(projection.messages, { sessionId: id, seq, at, divider });
    if (!items.length) return null;
    const segments = await appendSegment({ sessionId: id, seq, at, items, clearedThrough, maxBytes, epoch });
    const archive = session.compaction?.archive;
    // Small metadata only; a later clear may have hidden this segment.
    if (segments && archive && typeof archive === 'object' && !(Number(archive.clearedThrough) >= seq)) {
      archive.segments = segments;
    }
    return segments;
  };
  const task = (pendingWrites.get(id) || Promise.resolve()).then(run).catch((error) => {
    writeStderrBestEffort(`[session] compaction archive write failed (sess=${id}): ${error?.message || error}\n`);
    return null;
  });
  pendingWrites.set(id, task);
  void task.finally(() => {
    if (pendingWrites.get(id) === task) pendingWrites.delete(id);
  });
  return { dropped: dropped.length, identities: droppedIdentitySummary(projection), written: task };
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
