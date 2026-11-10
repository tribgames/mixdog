import { statSync } from 'node:fs';
import { fileVersion, sameFileVersion } from './file-version.mjs';
import { hashText } from './hash-utils.mjs';
import { normaliseRangeHashEntry, rangeTextOf, statMatchesSnapshot } from './snapshot-helpers.mjs';

function snapshotRangeHashRows(snapshot) {
  if (Array.isArray(snapshot?.rangeHashes)) return snapshot.rangeHashes;
  if (snapshot?.rangeHash && Array.isArray(snapshot.ranges) && snapshot.ranges.length > 0) {
    return [{ ...snapshot.ranges[0], hash: snapshot.rangeHash }];
  }
  return [];
}

export function isSnapshotStale(stat, snapshot, { fullPath = '', readCache = null, readTextForSnapshotCheck } = {}) {
  // Exact complete versions share the raw cache / final writer policy.
  // Missing legacy fields or any observed drift require content evidence.
  // Metadata-indistinguishable changes remain outside this fast-path check.
  if (statMatchesSnapshot(stat, snapshot)) return false;
  // Stat drifted (or incomplete snapshot) → content hash is the gate.
  const rangeHashRows = snapshotRangeHashRows(snapshot);
  const hasHashMaterial = !!snapshot?.contentHash || rangeHashRows.length > 0;
  // Fail-closed: no integrity material AND stat already drifted ⇒ cannot
  // verify against current bytes, treat as stale (force re-read).
  if (!hasHashMaterial) return true;
  const canReadContent = fullPath && typeof readTextForSnapshotCheck === 'function';
  if (!canReadContent) return true;
  const version = fileVersion(stat);
  if (!version) return true;
  // Hash equality allows harmless metadata churn and legacy snapshots to
  // recover, but only for the version actually verified. A failed/changed
  // post-read stat cannot promote the snapshot to a later metadata fast path.
  const refreshSnapshotStat = () => {
    if (!sameFileVersion(version, statSync(fullPath))) return false;
    Object.assign(snapshot, version);
    return true;
  };
  if (snapshot.contentHash) {
    try {
      const cur = readTextForSnapshotCheck(fullPath, readCache, stat);
      if (hashText(cur) !== snapshot.contentHash) return true;
      return !refreshSnapshotStat();
    } catch {
      // Unreadable / stat race — cannot verify, treat as stale.
      return true;
    }
  }
  // rangeHashes-only path (paged reads).
  try {
    const raw = readTextForSnapshotCheck(fullPath, readCache, stat);
    const lines = raw.split(/\r?\n/);
    let verified = 0;
    for (const row of rangeHashRows) {
      const r = normaliseRangeHashEntry(row);
      if (!r) continue;
      if (hashText(rangeTextOf(lines, r)) !== r.hash) return true;
      verified++;
    }
    // Fail-closed: rangeHashes present but no row could be verified
    // (all malformed) ⇒ cannot prove identity, treat as stale.
    if (verified === 0) return true;
    return !refreshSnapshotStat();
  } catch {
    return true;
  }
}

export function readContentIfSnapshotHashMatches(
  fullPath,
  snapshot,
  { readCache = null, st = null, readTextForSnapshotCheck } = {}
) {
  if (!snapshot || typeof readTextForSnapshotCheck !== 'function') return null;
  try {
    const content = readTextForSnapshotCheck(fullPath, readCache, st);
    if (snapshot.contentHash) {
      return hashText(content) === snapshot.contentHash ? content : null;
    }
    const rangeHashRows = snapshotRangeHashRows(snapshot);
    if (rangeHashRows.length === 0) return null;
    const lines = content.split(/\r?\n/);
    for (const row of rangeHashRows) {
      const r = normaliseRangeHashEntry(row);
      if (!r) return null;
      if (hashText(rangeTextOf(lines, r)) !== r.hash) return null;
    }
    return content;
  } catch {
    return null;
  }
}
