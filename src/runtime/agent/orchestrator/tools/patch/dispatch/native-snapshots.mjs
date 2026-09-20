// After a native apply: which targets were written, and the read-snapshot
// record for each — with the body-knowledge fast path inherited only when the
// engine's content hash matches the prediction and one consistent
// stat-then-read observation confirms it.
import { lstatSync, readFileSync } from 'node:fs';
import {
  normalizeOutputPath,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
} from '../../builtin.mjs';
import { hashText } from '../../builtin/hash-utils.mjs';
import { markCodeGraphDirtyPaths } from '../../code-graph-state.mjs';
import { stripDiffPrefix } from '../paths.mjs';
import { decodePatchTargetBuffer } from '../matcher.mjs';

export function writtenNativeEntries(entries, stats) {
  const failedDisplaySet = new Set();
  for (const f of stats.failures || []) {
    if (!f?.path) continue;
    failedDisplaySet.add(normalizeOutputPath(f.path));
    failedDisplaySet.add(normalizeOutputPath(stripDiffPrefix(f.path)));
  }
  return entries.filter((entry) => !failedDisplaySet.has(entry.displayPath));
}

export function invalidateNativeCaches(fullPaths) {
  const start = performance.now();
  invalidateBuiltinResultCache(fullPaths);
  const afterInvalidate = performance.now();
  markCodeGraphDirtyPaths(fullPaths);
  return { invalidateMs: afterInvalidate - start, dirtyMs: performance.now() - afterInvalidate };
}

function consistentObservation(entry, contentHash) {
  try {
    const st = lstatSync(entry.fullPath);
    const observed = decodePatchTargetBuffer(readFileSync(entry.fullPath), entry.displayPath);
    return hashText(observed.text) === contentHash ? st : null;
  } catch {
    return null;
  }
}

export function recordNativeSnapshots(writtenEntries, stats, { readStateScope, preMutationStats, bodyProofs }) {
  for (let i = 0; i < writtenEntries.length; i++) {
    const entry = writtenEntries[i];
    if (entry.kind === 'delete') {
      clearReadSnapshotForPath(entry.fullPath, readStateScope);
      continue;
    }
    const contentHash = stats.contentHashes?.[i] || null;
    // Only a matching prediction proves the engine patched the bytes this
    // session had read; otherwise the pre-mutation stat is not evidence.
    const proof = bodyProofs.get(entry.fullPath);
    const provenSameBytes = !!proof && !!contentHash && proof === contentHash;
    // ONE consistent observation of the result, stat FIRST: a write that
    // lands after the stat breaks the hash (claim dropped); one that lands
    // after the read leaves the recorded stat older than the file, so the
    // fast path fails closed at read time. Without that pairing an external
    // write between the apply and this record could inherit bodyDelivered.
    const observedStat = provenSameBytes ? consistentObservation(entry, contentHash) : null;
    const snapshotMeta = {
      source: 'apply_patch_native',
      isPartialView: false,
      preMutationStat: observedStat ? preMutationStats.get(entry.fullPath) || null : null,
    };
    if (observedStat) snapshotMeta.st = observedStat;
    if (contentHash) snapshotMeta.contentHash = contentHash;
    recordReadSnapshotForPath(entry.fullPath, readStateScope, snapshotMeta);
  }
}
