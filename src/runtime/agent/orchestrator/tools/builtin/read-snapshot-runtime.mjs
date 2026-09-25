import { readFileSync, statSync } from 'node:fs';
import { hashText } from './hash-utils.mjs';
import { mergeReadRanges } from './read-ranges.mjs';
import {
  normaliseRangeHashEntry,
  snapshotCoversFullFile,
  snapshotRangesCoverAllLines,
  statMatchesSnapshot,
  decodeRawBufferForSnapshotCheck,
} from './snapshot-helpers.mjs';
import { rawContentCacheGet, rawContentCacheSet } from './cache-layers.mjs';
import { rememberReadSnapshot, readFilesForScope, readScopeKey, scheduleScopePersist } from './snapshot-store.mjs';
import {
  isSnapshotStale as isSnapshotStaleImpl,
  readContentIfSnapshotHashMatches as readContentIfSnapshotHashMatchesImpl,
} from './snapshot-validation.mjs';

export function readTextForSnapshotCheck(fullPath, cache = null, st = null) {
  let statForRawCache = st;
  const getCachedRaw = () => {
    try {
      if (!statForRawCache) statForRawCache = statSync(fullPath);
      return rawContentCacheGet(fullPath, statForRawCache);
    } catch {
      return null;
    }
  };
  if (cache && typeof cache.readTextSync === 'function') {
    const entry = typeof cache.getEntry === 'function' ? cache.getEntry(fullPath) : null;
    if (typeof entry?.content === 'string') return entry.content;
    if (!Buffer.isBuffer(entry?.rawBuf) && typeof cache.seedBuffer === 'function') {
      const cachedRaw = getCachedRaw();
      if (cachedRaw) cache.seedBuffer(fullPath, cachedRaw);
    }
    return cache.readTextSync(fullPath);
  }
  if (cache && typeof cache.content === 'string' && Buffer.isBuffer(cache.rawBuf)) {
    return cache.content;
  }
  const cachedRaw = getCachedRaw();
  const rawBuf = cachedRaw || readFileSync(fullPath);
  const content = decodeRawBufferForSnapshotCheck(rawBuf);
  if (cache) {
    cache.rawBuf = rawBuf;
    cache.content = content;
  }
  if (!cachedRaw && statForRawCache) rawContentCacheSet(fullPath, statForRawCache, rawBuf);
  return content;
}

// The stat identity a snapshot is keyed on: the caller's stat when it has
// one, else a fresh stat; an unstattable path gets a never-matching identity.
function snapshotStatIdentity(fullPath, st) {
  try {
    const source = st && typeof st.mtimeMs === 'number' ? st : statSync(fullPath);
    return { mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, size: source.size };
  } catch {
    const now = Date.now();
    return { mtimeMs: now, ctimeMs: now, size: 0 };
  }
}

function isMutationSource(source) {
  return source === 'edit' || String(source || '').startsWith('apply_patch_');
}

// Body-delivery provenance. An edit / apply_patch snapshot claims full-file
// coverage (it knows the bytes it wrote), which let a later Read answer
// "[file unchanged]" for a body this session had NEVER received. Full-file
// knowledge is inherited only from a prior full-file READ of the same path.
// Returns undefined when the incoming meta's own value stands.
function resolveBodyDelivered({ next, meta, priorSnapshot, identity, incomingIsGrep }) {
  if (isMutationSource(meta.source)) {
    const priorLineCount = Number(priorSnapshot?.fileLineCount);
    const priorPagedFull =
      Number.isFinite(priorLineCount) &&
      priorLineCount > 0 &&
      snapshotRangesCoverAllLines(priorSnapshot, priorLineCount);
    // The earlier read only describes THIS file if it still matched when
    // the mutation ran: the caller passes the target's pre-write identity
    // and it must equal the snapshot's. Missing evidence fails closed, so
    // an external write landing between read and edit can never hide
    // behind "[file unchanged]".
    const priorStillCurrent =
      !!priorSnapshot && !!meta.preMutationStat && statMatchesSnapshot(meta.preMutationStat, priorSnapshot);
    return (
      priorStillCurrent &&
      priorSnapshot.grepOnly !== true &&
      (priorSnapshot.bodyDelivered === true || snapshotCoversFullFile(priorSnapshot) || priorPagedFull)
    );
  }
  if (!incomingIsGrep && snapshotCoversFullFile(next)) return true;
  // A partial read cannot carry full-body delivery across file versions.
  if (priorSnapshot?.bodyDelivered === true && statMatchesSnapshot(identity, priorSnapshot)) return true;
  return undefined;
}

// Range hashes carried over from the same file version, then the incoming
// read's own; malformed rows are dropped.
function collectRangeHashRows(existing, sameFile, meta) {
  const candidates = [];
  if (sameFile && Array.isArray(existing.rangeHashes)) {
    candidates.push(...existing.rangeHashes);
  } else if (sameFile && existing.rangeHash && Array.isArray(existing.ranges) && existing.ranges.length === 1) {
    candidates.push({ ...existing.ranges[0], hash: existing.rangeHash });
  }
  if (meta.rangeHash && Array.isArray(meta.ranges) && meta.ranges.length === 1) {
    candidates.push({ ...meta.ranges[0], hash: meta.rangeHash });
  }
  if (Array.isArray(meta.rangeHashes)) candidates.push(...meta.rangeHashes);
  return candidates.map((row) => normaliseRangeHashEntry(row)).filter(Boolean);
}

export function recordReadSnapshot(fullPath, st, scope = null, meta = {}) {
  const readFiles = readFilesForScope(scope);
  const identity = snapshotStatIdentity(fullPath, st);
  const { mtimeMs, ctimeMs, size } = identity;
  const incomingRanges = Array.isArray(meta.ranges) ? meta.ranges : [{ startLine: 1, endLine: Infinity }];
  const replaceExisting = meta.replaceExisting === true;
  const existing = replaceExisting ? null : readFiles.get(fullPath);
  const sameFile = existing && statMatchesSnapshot(identity, existing) && Array.isArray(existing.ranges);
  // A mutation snapshot claims the full range because it knows the bytes it
  // wrote, not because the session received them. Merging a later partial
  // read into that synthetic range produced full coverage, which promoted
  // bodyDelivered and let the next edit hide never-delivered ranges behind
  // "[file unchanged]". Only delivered ranges take part in the merge.
  const existingIsUndeliveredMutation =
    sameFile && isMutationSource(existing.source) && existing.bodyDelivered !== true;
  const retainedRanges = sameFile && !existingIsUndeliveredMutation ? existing.ranges : [];
  const merged = mergeReadRanges([...retainedRanges, ...incomingRanges]);
  // fileLineCount is omitted here so it can ONLY be set via the explicit
  // guard below (which excludes source==='read_batch_sliced'); otherwise a
  // caller passing fileLineCount with a batch source would leak it through
  // restMeta and bypass the fail-closed batch path.
  const {
    ranges: _omitRanges,
    rangeHash: _omitRangeHash,
    rangeHashes: _omitRangeHashes,
    replaceExisting: _omitReplaceExisting,
    fileLineCount: _omitFileLineCount,
    preMutationStat: _omitPreMutationStat,
    ...restMeta
  } = meta;
  const next = { ...restMeta, mtimeMs, ctimeMs, size, ranges: merged };
  if (!next.contentHash && sameFile && existing.contentHash) {
    next.contentHash = existing.contentHash;
  }
  // Provenance: a snapshot is "grep-only" while EVERY contributing read was a
  // single-file grep (match lines only, never the whole file). Any real read
  // clears it permanently. Sticky across merges in both orders: read→grep
  // keeps it false, and grep→read rebuilds it false because a read uses
  // replaceExisting.
  const incomingIsGrep = meta.source === 'grep';
  next.grepOnly = incomingIsGrep && (sameFile ? existing.grepOnly === true : true);
  const bodyDelivered = resolveBodyDelivered({
    next,
    meta,
    priorSnapshot: readFiles.get(fullPath),
    identity,
    incomingIsGrep,
  });
  if (bodyDelivered !== undefined) next.bodyDelivered = bodyDelivered;
  const rangeHashRows = collectRangeHashRows(existing, sameFile, meta);
  if (!next.contentHash && snapshotCoversFullFile(next)) {
    try {
      // Reuse the raw-content cache (populated by the read that produced
      // this snapshot) instead of a fresh readFileSync + decode purely to
      // hash. Decodes via the same helper, so the hash is byte-identical.
      const content = readTextForSnapshotCheck(fullPath, null, st);
      next.contentHash = hashText(content);
    } catch {}
  }
  if (!next.contentHash && !snapshotCoversFullFile(next) && rangeHashRows.length > 0) {
    const seen = new Set();
    next.rangeHashes = rangeHashRows.filter((row) => {
      const key = `${row.startLine}:${row.endLine}:${row.hash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const batchSliced = meta.source === 'read_batch_sliced';
  if (!batchSliced && Number.isFinite(meta.fileLineCount) && meta.fileLineCount >= 0) {
    next.fileLineCount = Math.trunc(meta.fileLineCount);
  } else if (!batchSliced && sameFile && Number.isFinite(existing?.fileLineCount) && existing.fileLineCount >= 0) {
    next.fileLineCount = Math.trunc(existing.fileLineCount);
  }
  rememberReadSnapshot(fullPath, next, scope, readFiles);
  scheduleScopePersist(readScopeKey(scope));
}

export function getReadSnapshot(fullPath, scope = null) {
  return readFilesForScope(scope).get(fullPath);
}

export function isSnapshotStale(stat, snapshot, fullPath = '', readCache = null) {
  return isSnapshotStaleImpl(stat, snapshot, {
    fullPath,
    readCache,
    readTextForSnapshotCheck,
  });
}

export function readContentIfSnapshotHashMatches(fullPath, snapshot, readCache = null, st = null) {
  return readContentIfSnapshotHashMatchesImpl(fullPath, snapshot, {
    readCache,
    st,
    readTextForSnapshotCheck,
  });
}
