/**
 * Display-only archive of the conversation a compaction dropped.
 *
 * One JSONL sidecar per session next to its record
 * (`<id>.compaction-archive.jsonl`), one line per compaction segment, oldest
 * first. A segment holds the transcript ITEMS (the pane's display shape, never
 * model messages) its compaction removed from the model context, followed by
 * the "Conversation compacted" divider. Each line opens with a fixed header
 * (`{"v":1,"seq":N,"id":"segN","prev":…,"at":…,"count":…,"bytes":…,"items":[…]}`)
 * so a reader can pick segments by number without parsing their items.
 *
 * Nothing here ever reaches `session.messages` or a provider payload: the
 * archive is read only by the stored-transcript projection and the paged
 * history loader. Leaf module (no store.mjs, no config) so the cold catalog
 * path can read it; the writer lives in compaction-archive-capture.mjs.
 */
import { unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const COMPACTION_ARCHIVE_SUFFIX = '.compaction-archive.jsonl';
/** The one label every compaction boundary row carries (persisted and live),
 *  translated by the desktop as the app's compaction wording. */
export const COMPACTION_DIVIDER_LABEL = 'Conversation compacted';
/** Per-session cap; the oldest segments are dropped past it. */
export const COMPACTION_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SEGMENT_HEAD = /^\{"v":1,"seq":(\d+),"id":"[^"]*","prev":(null|"[^"]*"),"at":(\d+),"count":(\d+),"bytes":(\d+),/;

/** The archive sidecar of `sessionId` inside a sessions directory, or null
 *  for an id that is not a stored session id. */
export function compactionArchivePath(storeDir, sessionId) {
  const id = String(sessionId || '');
  if (!SESSION_ID.test(id)) return null;
  return join(storeDir, `${id}${COMPACTION_ARCHIVE_SUFFIX}`);
}

/** The visible archive a session record names: segments numbered in
 *  (after, before). A clear hides everything archived before it. Null when
 *  nothing is visible. */
export function compactionArchiveRange(session) {
  const archive = session?.compaction?.archive;
  if (!archive || typeof archive !== 'object') return null;
  const before = Number(archive.nextSeq);
  const after = Math.max(0, Math.floor(Number(archive.clearedThrough) || 0));
  if (!Number.isInteger(before) || before - 1 <= after) return null;
  return { after, before };
}

/** A segment line's header fields, or null for a line that is not one. */
export function compactionSegmentHead(line) {
  const match = SEGMENT_HEAD.exec(String(line || ''));
  if (!match) return null;
  return {
    seq: Number(match[1]),
    id: `seg${match[1]}`,
    prev: match[2] === 'null' ? null : match[2].slice(1, -1),
    at: Number(match[3]),
    count: Number(match[4]),
    bytes: Number(match[5]),
  };
}

/** One segment as its JSONL line (no trailing newline). */
export function compactionSegmentLine({ seq, prev, at, items }) {
  const body = JSON.stringify(items);
  return `{"v":1,"seq":${seq},"id":"seg${seq}","prev":${prev == null ? 'null' : JSON.stringify(`seg${prev}`)},"at":${Math.max(0, Math.floor(Number(at) || 0))},"count":${items.length},"bytes":${Buffer.byteLength(body)},"items":${body}}`;
}

function segmentItems(text) {
  try {
    const items = JSON.parse(text)?.items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * One page from a segment list (oldest → newest heads; `load(entry)` yields a
 * segment's items): segments numbered in (after, before), newest first,
 * skipping the `skip` newest items a reader already holds and returning at
 * most `limit` items above them, in display order. Item counts come from
 * the segment headers: a segment wholly inside the skipped rows or past the
 * page is never read or parsed. `hasOlder` says whether older items remain.
 */
async function pageFromSegments(
  entries,
  load,
  { after = 0, before = Number.POSITIVE_INFINITY, skip = 0, limit = 0 } = {}
) {
  const held = Math.max(0, Math.floor(Number(skip) || 0));
  const wanted = Math.max(0, Math.floor(Number(limit) || 0));
  const parts = [];
  // Items newer than this entry, counted from the newest.
  let newer = 0;
  let more = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { head } = entries[index];
    if (head.seq <= after || head.seq >= before || head.count < 1) continue;
    if (newer >= held + wanted) {
      more = true;
      break;
    }
    const count = head.count;
    if (newer + count > held) {
      // This segment holds rows of the page: newest-first offsets
      // [max(held, newer), min(held + wanted, newer + count)) of it.
      const items = await load(entries[index]);
      const fromEnd = Math.max(0, held - newer);
      const take = Math.min(held + wanted, newer + count) - Math.max(held, newer);
      const end = items.length - fromEnd;
      parts.push(items.slice(Math.max(0, end - take), Math.max(0, end)));
      if (newer + count > held + wanted) more = true;
    }
    newer += count;
  }
  return { items: parts.reverse().flat(), hasOlder: more };
}

/** pageFromSegments over archive text (tests and in-memory callers). */
export function compactionArchivePageFromText(text, range = {}) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const head = compactionSegmentHead(line);
    if (head) entries.push({ head, line });
  }
  return pageFromSegments(entries, (entry) => segmentItems(entry.line), range);
}

// Per-sidecar segment index (byte offsets + headers), keyed by the file
// identity it was built from: a page reads only the segments it reaches, and
// the headers are indexed once per change rather than once per page.
const INDEX_CACHE_LIMIT = 16;
const archiveIndexes = new Map();

const HEAD_PROBE_BYTES = 512;
const ITEMS_KEY = '"items":';
const SCAN_CHUNK_BYTES = 64 * 1024;

/** Offset of the first newline at or after `from` (or `size`), scanning. */
async function nextNewline(handle, from, size) {
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
  for (let at = from; at < size; at += SCAN_CHUNK_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(SCAN_CHUNK_BYTES, size - at), at);
    const hit = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (hit >= 0) return at + hit;
  }
  return size;
}

/** Segment offsets of an archive file. Each header names its items' byte
 *  length, so the index reads only the headers and jumps over the bodies; a
 *  line whose header does not account for its length is scanned past. */
async function indexArchive(handle, size) {
  const entries = [];
  const probe = Buffer.alloc(HEAD_PROBE_BYTES);
  let start = 0;
  while (start < size) {
    const { bytesRead } = await handle.read(probe, 0, Math.min(HEAD_PROBE_BYTES, size - start), start);
    const text = probe.toString('latin1', 0, bytesRead);
    const match = SEGMENT_HEAD.exec(text);
    let end = -1;
    if (match && text.startsWith(ITEMS_KEY, match[0].length)) {
      // `…"items":<body>}` — the header is ASCII, so chars are bytes.
      const candidate = start + match[0].length + ITEMS_KEY.length + Number(match[5]) + 1;
      if (candidate === size) end = candidate;
      else if (candidate < size) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, candidate);
        if (tail[0] === 0x0a) end = candidate;
      }
    }
    if (end >= 0) entries.push({ head: compactionSegmentHead(text), start, length: end - start });
    else end = await nextNewline(handle, start, size);
    start = end + 1;
  }
  return entries;
}

async function archiveIndexFor(path, handle) {
  const info = await handle.stat();
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  const cached = archiveIndexes.get(path);
  if (cached?.stamp === stamp) {
    archiveIndexes.delete(path);
    archiveIndexes.set(path, cached);
    return cached.entries;
  }
  const entries = await indexArchive(handle, info.size);
  archiveIndexes.set(path, { stamp, entries });
  while (archiveIndexes.size > INDEX_CACHE_LIMIT) archiveIndexes.delete(archiveIndexes.keys().next().value);
  return entries;
}

/** Runs `use(entries, load)` over a session's archive sidecar: its segment
 *  index and a loader of one segment's items. The open handle pins the file
 *  a concurrent atomic replace may swap out, so the index and the segment
 *  reads describe the same bytes. `fallback` when the archive is absent or
 *  unreadable (display-only history: it shows nothing then). */
async function withArchive(storeDir, sessionId, fallback, use) {
  const path = compactionArchivePath(storeDir, sessionId);
  if (!path) return fallback;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    archiveIndexes.delete(path);
    return fallback;
  }
  try {
    const entries = await archiveIndexFor(path, handle);
    return await use(entries, async (entry) => {
      const buffer = Buffer.alloc(entry.length);
      await handle.read(buffer, 0, entry.length, entry.start);
      return segmentItems(buffer.toString('utf8'));
    });
  } catch {
    return fallback;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** One page of a session's archive sidecar (see pageFromSegments). */
export function readCompactionArchivePage(storeDir, sessionId, range = {}) {
  return withArchive(storeDir, sessionId, { items: [], hasOlder: false }, (entries, load) =>
    pageFromSegments(entries, load, range)
  );
}

/** Hands every visible segment of the archive (numbered in (after, before),
 *  oldest first) to `visit` as its items, one segment at a time, so a whole
 *  walk never holds more than one segment. True when the walk completed;
 *  false when the archive was absent or unreadable (the visits made so far
 *  are then incomplete). */
export function visitCompactionArchive(storeDir, sessionId, { after = 0, before = Number.POSITIVE_INFINITY } = {}, visit) {
  return withArchive(storeDir, sessionId, false, async (entries, load) => {
    for (const entry of entries) {
      const { seq, count } = entry.head;
      if (seq <= after || seq >= before || count < 1) continue;
      visit(await load(entry));
    }
    return true;
  });
}

// Delete fence: every deletion bumps the session's epoch. A writer captures
// the epoch before it starts and publishes only if it is unchanged at the
// (synchronous) rename, so a delete that lands while a segment is being
// written is never undone by that write.
const deleteEpochs = new Map();

export function compactionArchiveDeleteEpoch(sessionId) {
  return deleteEpochs.get(String(sessionId || '')) || 0;
}

/** Remove a session's archive (session delete) and fence every write that
 *  started before it. Best-effort: true when the sidecar is gone afterwards. */
export function deleteCompactionArchive(storeDir, sessionId) {
  const path = compactionArchivePath(storeDir, sessionId);
  if (!path) return false;
  const id = String(sessionId);
  deleteEpochs.set(id, compactionArchiveDeleteEpoch(id) + 1);
  archiveIndexes.delete(path);
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}
