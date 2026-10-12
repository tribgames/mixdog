import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileVersion, sameFileVersion } from './file-version.mjs';
import { hashText as sha256Hex } from './hash-utils.mjs';
import { join, normalize, resolve } from 'node:path';
import { getPluginData } from '../../config.mjs';
import { writeJsonAtomicAsync, writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';

const READ_RANGE_INDEX_STRIDE_LINES = 4096;
const READ_RANGE_INDEX_MAX_ENTRIES = 64;
const READ_RANGE_INDEX_DISK_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const READ_RANGE_INDEX_MAX_PERSISTED_ANCHORS = 8192;
const READ_RANGE_INDEX_PERSIST_DEBOUNCE_MS = 750;
const READ_RANGE_INDEX_SWEEP_CONCURRENCY = 8;

// Slots own publication rights; readers only mutate private drafts. Deleting
// or replacing a slot detaches outstanding lookups/scans without a tombstone log.
const READ_RANGE_INDEX_CACHE = new Map();
const READ_RANGE_INDEX_DRAFTS = new WeakMap();
const READ_RANGE_INDEX_PERSIST_PENDING = new Map();
let readRangeIndexDiskSwept = false;

let traceReadRangeIndex = () => {};
let hashTextForTrace = sha256Hex;

export function configureReadRangeIndexTelemetry({ trace, hashText } = {}) {
  if (typeof trace === 'function') traceReadRangeIndex = trace;
  if (typeof hashText === 'function') hashTextForTrace = hashText;
}

export function canonicalCachePath(p) {
  const full = normalize(resolve(String(p || '')));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

const READ_RANGE_INDEX_DISK_DIR = (() => {
  try {
    return join(getPluginData(), 'read-range-index');
  } catch {
    return null;
  }
})();

function readRangeIndexFilePath(fullPath) {
  if (!READ_RANGE_INDEX_DISK_DIR || !fullPath) return null;
  const key = sha256Hex(canonicalCachePath(fullPath));
  return join(READ_RANGE_INDEX_DISK_DIR, `${key}.json`);
}

function serialiseReadRangeIndex(index) {
  if (!index?.published || !sameFileVersion(index.fileVersion, index.fileVersion)) return null;
  const anchors = [...index.anchors.entries()]
    .filter(
      ([line, byteOffset]) => Number.isFinite(line) && Number.isFinite(byteOffset) && line >= 0 && byteOffset >= 0
    )
    .sort((a, b) => a[0] - b[0])
    .slice(-READ_RANGE_INDEX_MAX_PERSISTED_ANCHORS);
  if (!anchors.some(([line]) => line === 0)) anchors.unshift([0, 0]);
  return {
    version: 2,
    path: index.fullPath,
    fileVersion: index.fileVersion,
    prefixHash: index.prefixHash || '',
    totalLines: Number.isFinite(index.totalLines) ? index.totalLines : undefined,
    anchors,
  };
}

function readRangeIndexMatches(row, fullPath, version) {
  // Version-1 rows lack replacement identity. Never upgrade their anchors by
  // attaching today's metadata; rebuild them from current bytes instead.
  return (
    row?.version === 2 &&
    row.path === fullPath &&
    sameFileVersion(row.fileVersion, version) &&
    Array.isArray(row.anchors)
  );
}

// Hash the first up to 64KiB of the file using the same sha256-of-bytes
// convention as the streaming readers (read-streaming.mjs / read-windows.mjs)
// so a value computed here can be compared byte-for-byte against the
// `prefixHash` they persist into the anchor index.
async function computePrefixHashForIndex(fullPath, st, handle = null, prefixBuffer = null) {
  try {
    const cap = Math.min(Number(st?.size) || 0, 65536);
    if (cap <= 0) return '';
    if (Buffer.isBuffer(prefixBuffer) && prefixBuffer.length === cap) {
      return sha256Hex(prefixBuffer);
    }
    const fh = handle || (await open(fullPath, 'r'));
    try {
      const buf = Buffer.allocUnsafe(cap);
      const { bytesRead } = await fh.read(buf, 0, cap, 0);
      if (bytesRead <= 0) return '';
      return sha256Hex(buf.subarray(0, bytesRead));
    } finally {
      if (!handle) {
        try {
          await fh.close();
        } catch {}
      }
    }
  } catch {
    return '';
  }
}

function ensureReadRangeIndexDiskSwept() {
  if (readRangeIndexDiskSwept) return;
  readRangeIndexDiskSwept = true;
  // Maintenance must not delay the first ranged read or hold the process open.
  const pending = setImmediate(() => {
    void sweepStaleReadRangeIndexes().catch(() => {});
  });
  pending.unref();
}

async function loadReadRangeIndexFromDisk(fullPath, st, handle, prefixBuffer) {
  ensureReadRangeIndexDiskSwept();
  const file = readRangeIndexFilePath(fullPath);
  // No existsSync preflight: a missing file surfaces as an ENOENT from
  // readFile below, caught by the same try/catch — one FS pass, not two.
  if (!file || !st) return null;
  try {
    const row = JSON.parse(await readFile(file, 'utf-8'));
    if (!readRangeIndexMatches(row, fullPath, st)) return null;
    // The prefix is an extra check, not proof that later byte offsets survived.
    if (typeof row.prefixHash === 'string' && row.prefixHash) {
      const cur = await computePrefixHashForIndex(fullPath, st, handle, prefixBuffer);
      if (!cur || cur !== row.prefixHash) return null;
    }
    const anchors = new Map([[0, 0]]);
    for (const entry of row.anchors) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const line = Number(entry[0]);
      const byteOffset = Number(entry[1]);
      if (!Number.isFinite(line) || !Number.isFinite(byteOffset) || line < 0 || byteOffset < 0) continue;
      anchors.set(line, byteOffset);
    }
    const loaded = {
      fullPath,
      fileVersion: fileVersion(st),
      prefixHash: typeof row.prefixHash === 'string' ? row.prefixHash : '',
      anchors,
    };
    if (Number.isFinite(row.totalLines)) loaded.totalLines = row.totalLines;
    traceReadRangeIndex('read_range_index_load', {
      pathHash: hashTextForTrace(fullPath).slice(0, 12),
      anchors: anchors.size,
      bytes: st.size,
    });
    return loaded;
  } catch {
    return null;
  }
}

function currentReadRangeIndex(index) {
  return !!index?.published && READ_RANGE_INDEX_CACHE.get(canonicalCachePath(index.fullPath)) === index;
}

function persistReadRangeIndexSync(index) {
  const file = readRangeIndexFilePath(index?.fullPath);
  if (!file || !currentReadRangeIndex(index)) return;
  try {
    if (!sameFileVersion(index.fileVersion, statSync(index.fullPath))) return;
    const row = serialiseReadRangeIndex(index);
    if (row) writeJsonAtomicSync(file, row, { compact: true, lock: true, fsync: false });
  } catch {}
}

async function persistReadRangeIndex(index, evictedRow = null) {
  const file = readRangeIndexFilePath(index?.fullPath);
  if (!file || (!evictedRow && !currentReadRangeIndex(index))) return;
  try {
    if (!sameFileVersion(evictedRow?.fileVersion || index.fileVersion, await stat(index.fullPath))) return;
    await mkdir(READ_RANGE_INDEX_DISK_DIR, { recursive: true });
    if (!evictedRow && !currentReadRangeIndex(index)) return;
    const row = evictedRow || serialiseReadRangeIndex(index);
    if (row) await writeJsonAtomicAsync(file, row, { compact: true, lock: true, fsync: false });
  } catch {}
}

export function scheduleReadRangeIndexPersist(index) {
  if (!READ_RANGE_INDEX_DISK_DIR || !currentReadRangeIndex(index)) return;
  const key = canonicalCachePath(index.fullPath);
  if (READ_RANGE_INDEX_PERSIST_PENDING.has(key)) return;
  const t = setTimeout(() => {
    READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
    void persistReadRangeIndex(index);
  }, READ_RANGE_INDEX_PERSIST_DEBOUNCE_MS);
  t.unref();
  READ_RANGE_INDEX_PERSIST_PENDING.set(key, t);
}

export function flushReadRangeIndexesSync() {
  for (const [key, timer] of READ_RANGE_INDEX_PERSIST_PENDING) {
    try {
      clearTimeout(timer);
    } catch {}
    READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
    const index = READ_RANGE_INDEX_CACHE.get(key);
    if (index) persistReadRangeIndexSync(index);
  }
}

function dropReadRangeIndexSlot(key) {
  READ_RANGE_INDEX_CACHE.delete(key);
  clearTimeout(READ_RANGE_INDEX_PERSIST_PENDING.get(key));
  READ_RANGE_INDEX_PERSIST_PENDING.delete(key);
}

export function deleteReadRangeIndexForPath(fullPath) {
  dropReadRangeIndexSlot(canonicalCachePath(fullPath));
  const file = readRangeIndexFilePath(fullPath);
  if (file) void unlink(file).catch(() => {});
}

export async function sweepStaleReadRangeIndexes(directory = READ_RANGE_INDEX_DISK_DIR) {
  if (!directory) return;
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const now = Date.now();
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const name = entries[next++];
      if (!name.endsWith('.json')) continue;
      const full = join(directory, name);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs > READ_RANGE_INDEX_DISK_STALE_MS) await unlink(full);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_RANGE_INDEX_SWEEP_CONCURRENCY, entries.length) }, worker));
}

// Re-insert so the entry moves to the LRU tail. All insertion paths obey the
// same cap, including disk hits. Eviction also revokes unfinished readers.
function refreshReadRangeIndexSlot(key, index) {
  READ_RANGE_INDEX_CACHE.delete(key);
  READ_RANGE_INDEX_CACHE.set(key, index);
  while (READ_RANGE_INDEX_CACHE.size > READ_RANGE_INDEX_MAX_ENTRIES) {
    const oldest = READ_RANGE_INDEX_CACHE.keys().next().value;
    const evicted = READ_RANGE_INDEX_CACHE.get(oldest);
    // Preserve only committed anchors before cancelling the debounce. The
    // owned row may finish saving after eviction, but outstanding drafts lose
    // their slot immediately. Disk IO must not delay the foreground lookup.
    const row = serialiseReadRangeIndex(evicted);
    dropReadRangeIndexSlot(oldest);
    if (row) void persistReadRangeIndex(evicted, row);
  }
  return index;
}

function freshReadRangeIndex(fullPath, version = null) {
  return { fullPath, fileVersion: version, prefixHash: '', anchors: new Map([[0, 0]]), published: false };
}

// A supplied handle is borrowed; validation uses positional IO and never closes
// it. The stat argument is only a hint for a previously read prefix, not proof
// of the current handle/path version. A cache miss always starts at byte zero.
export async function getReadRangeIndex(fullPath, st, handle = null, prefixBuffer = null) {
  const key = canonicalCachePath(fullPath);
  let slot = READ_RANGE_INDEX_CACHE.get(key);
  if (!slot) slot = refreshReadRangeIndexSlot(key, freshReadRangeIndex(fullPath));
  const hint = fileVersion(st);
  const readStat = () => (handle ? handle.stat() : stat(fullPath));
  let version;
  try {
    const observed = await readStat();
    if (!observed.isFile()) return null;
    version = fileVersion(observed);
  } catch {
    return null;
  }
  if (!version || READ_RANGE_INDEX_CACHE.get(key) !== slot) return null;
  version = Object.freeze(version);
  if (!slot.fileVersion) slot.fileVersion = version;
  if (!sameFileVersion(slot.fileVersion, version)) {
    dropReadRangeIndexSlot(key);
    slot = refreshReadRangeIndexSlot(key, freshReadRangeIndex(fullPath, version));
  }
  const prefix = sameFileVersion(hint, version) ? prefixBuffer : null;
  let source = slot;
  if (slot.published && slot.prefixHash) {
    const cur = await computePrefixHashForIndex(fullPath, version, handle, prefix);
    if (READ_RANGE_INDEX_CACHE.get(key) !== slot) return null;
    if (!cur || cur !== slot.prefixHash) {
      dropReadRangeIndexSlot(key);
      slot = refreshReadRangeIndexSlot(key, freshReadRangeIndex(fullPath, version));
      source = slot;
    }
  }
  if (!slot.published) source = (await loadReadRangeIndexFromDisk(fullPath, version, handle, prefix)) || slot;
  // Neither a delayed disk lookup nor a changed source can authorize offsets.
  try {
    if (!sameFileVersion(version, await readStat())) return null;
  } catch {
    return null;
  }
  if (READ_RANGE_INDEX_CACHE.get(key) !== slot) return null;
  refreshReadRangeIndexSlot(key, slot);
  const draft = {
    fullPath,
    fileVersion: version,
    prefixHash: source.prefixHash,
    anchors: new Map(source.anchors),
    ...(Number.isFinite(source.totalLines) ? { totalLines: source.totalLines } : {}),
  };
  READ_RANGE_INDEX_DRAFTS.set(draft, { slot, version });
  return draft;
}

// Successful readers publish once, before closing their handle. A failed,
// cancelled or detached scan keeps its observation private. Post-stat failures
// are cache misses, not reasons to retry the operation or relabel its anchors.
export async function publishReadRangeIndex(index, handle, signal = null, beforePublish = null) {
  const owned = READ_RANGE_INDEX_DRAFTS.get(index);
  if (!owned) return false;
  READ_RANGE_INDEX_DRAFTS.delete(index);
  const { slot, version } = owned;
  const key = canonicalCachePath(slot.fullPath);
  if (signal?.aborted || READ_RANGE_INDEX_CACHE.get(key) !== slot) return false;
  try {
    if (!sameFileVersion(version, await handle.stat()) || !sameFileVersion(version, await stat(slot.fullPath)))
      return false;
  } catch {
    return false;
  }
  if (signal?.aborted || READ_RANGE_INDEX_CACHE.get(key) !== slot) return false;
  if (slot.prefixHash && index.prefixHash && slot.prefixHash !== index.prefixHash) return false;
  // The reader's synchronous deadline/cancellation decision belongs after all
  // awaited validation and outside its best-effort stat catch. Once committed,
  // the caller must not make a second deadline decision for this scan.
  beforePublish?.();
  // Same-version concurrent windows may contribute disjoint anchors. No draft
  // shares this map, including the one whose successful read is being committed.
  slot.anchors = new Map([...slot.anchors, ...index.anchors]);
  slot.prefixHash = index.prefixHash || slot.prefixHash;
  if (Number.isFinite(index.totalLines)) slot.totalLines = index.totalLines;
  slot.published = true;
  refreshReadRangeIndexSlot(key, slot);
  scheduleReadRangeIndexPersist(slot);
  return true;
}

export function nearestReadRangeAnchor(index, offset) {
  let bestLine = 0;
  let bestByteOffset = 0;
  if (!index?.anchors) return { line: bestLine, byteOffset: bestByteOffset };
  for (const [line, byteOffset] of index.anchors) {
    if (line <= offset && line >= bestLine) {
      bestLine = line;
      bestByteOffset = byteOffset;
    }
  }
  return { line: bestLine, byteOffset: bestByteOffset };
}

export function maybeRecordReadRangeAnchor(index, line, byteOffset) {
  if (!index || !Number.isFinite(line) || !Number.isFinite(byteOffset)) return;
  if (line < 0 || byteOffset < 0) return;
  if (line === 0 || line % READ_RANGE_INDEX_STRIDE_LINES === 0) {
    if (index.anchors.get(line) === byteOffset) return;
    index.anchors.set(line, byteOffset);
  }
}
