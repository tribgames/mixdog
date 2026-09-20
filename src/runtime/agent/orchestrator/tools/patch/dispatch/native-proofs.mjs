// What the native apply must be able to prove afterwards: the encoding gate,
// the pre-write identity of every target, and the predicted post-apply hash
// for files this session had fully read.
import { lstatSync, readFileSync } from 'node:fs';
import { getReadSnapshot } from '../../builtin/read-snapshot-runtime.mjs';
import { snapshotCoversFullFile } from '../../builtin/snapshot-helpers.mjs';
import { hashText } from '../../builtin/hash-utils.mjs';
import { decodePatchTargetBuffer, patchTargetEncodingError } from '../matcher.mjs';

const isWrite = (entry) => entry.kind !== 'create' && entry.kind !== 'delete';

// Encoding gate, same rule as the JS writer: the native engine rewrites files
// as UTF-8, so a target that is not valid UTF-8 must be refused rather than
// silently transcoded. (UTF-16 targets are routed away before this point.)
export function nativeEncodingError(entries) {
  for (const entry of entries || []) {
    if (!isWrite(entry)) continue;
    const encodingError = patchTargetEncodingError(entry.fullPath, entry.displayPath);
    if (encodingError) return encodingError;
  }
  return null;
}

// Pre-write identity of every target. The read-snapshot recorder needs it to
// decide whether the session's earlier full read still described this file
// when the patch landed — otherwise an external change made before the patch
// would stay hidden behind "[file unchanged]".
export function capturePreMutationStats(entries) {
  const preMutationStats = new Map();
  for (const entry of entries || []) {
    try {
      preMutationStats.set(entry.fullPath, lstatSync(entry.fullPath));
    } catch {
      /* absent target */
    }
  }
  return preMutationStats;
}

// Body-knowledge proof for the "[file unchanged]" fast path. A stat captured
// before the engine runs cannot vouch for the bytes it actually patched, so
// predict the post-apply content from bytes we verify against the session's
// read snapshot; after the apply, the engine's own content hash must equal
// that prediction. Only computed where the fast path could be inherited.
// `predictAppliedHash(entry, text)` returns the hash the JS engine would
// produce for the same hunks, or throws when it cannot.
export function predictBodyProofs(entries, readStateScope, predictAppliedHash) {
  const bodyProofs = new Map();
  if (!readStateScope) return bodyProofs;
  for (const entry of entries || []) {
    if (!isWrite(entry)) continue;
    const prior = getReadSnapshot(entry.fullPath, readStateScope);
    if (!prior?.contentHash) continue;
    if (prior.bodyDelivered !== true && !snapshotCoversFullFile(prior)) continue;
    try {
      const { text } = decodePatchTargetBuffer(readFileSync(entry.fullPath), entry.displayPath);
      if (hashText(text) !== prior.contentHash) continue; // already stale — claim nothing
      const proof = predictAppliedHash(entry, text);
      if (proof) bodyProofs.set(entry.fullPath, proof);
    } catch {
      /* no proof — the fast path stays off for this file */
    }
  }
  return bodyProofs;
}
