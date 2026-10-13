/**
 * read-single-fast-paths.mjs — the answers a Read can give without rendering
 * a body: the post-mutation "[file unchanged]" stub, the validated
 * result-cache hit (with its cross-session stub gate) and the path-snapshot
 * fallback. Also the 64KiB prefix hash every cache write records for the
 * same-mtime/same-size rewrite race guard.
 */
import * as fsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { getReadSnapshot } from './read-snapshot-runtime.mjs';
import { snapshotCoversFullFile, statMatchesSnapshot } from './snapshot-helpers.mjs';
import { canCacheReadFile, READ_PREFIX_HASH_BYTES } from './read-cache-policy.mjs';
export { READ_PREFIX_HASH_BYTES } from './read-cache-policy.mjs';

// A mutation snapshot claims the full file because it knows the bytes it
// wrote; it proves the session holds the body only when bodyDelivered says so.
function snapshotBodyWasReturnedByRead(snapshot) {
  const source = String(snapshot?.source || '');
  if (source.startsWith('read')) return true;
  return (source === 'edit' || source.startsWith('apply_patch_')) && snapshot.bodyDelivered === true;
}

function unchangedStub(filePath, helpers) {
  return `[file unchanged: ${helpers.normalizeOutputPath(filePath)}]`;
}

/**
 * Bounded raw-byte hash. Content caches only admit files that fit this
 * budget, so validation covers their entire body. '' on any failure.
 */
export async function readPrefixHash(fullPath, st, hashText) {
  try {
    if (st.size <= READ_PREFIX_HASH_BYTES) return hashText(await readFile(fullPath));
    const fh = await fsPromises.open(fullPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(READ_PREFIX_HASH_BYTES);
      const { bytesRead } = await fh.read(buf, 0, READ_PREFIX_HASH_BYTES, 0);
      return hashText(buf.subarray(0, bytesRead));
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return '';
  }
}

/**
 * A successful edit/apply_patch leaves a session-scoped full-file snapshot.
 * The model already knows the resulting body from the prior body plus its
 * mutation. Keep the existing small-file stat fast path; a large file's
 * matching tuple cannot exclude a deep external rewrite, so read it again.
 * `bodyDelivered` guards that the
 * session actually received this file's body before the mutation: an
 * edit/patch on a file that was never read otherwise answered
 * "[file unchanged]" forever, with the body never delivered to the model.
 */
export function mutationUnchangedStub({ fullPath, filePath, st, readStateScope, options }, helpers) {
  if (options?.suppressReadUnchangedStub === true || !canCacheReadFile(st)) return null;
  const snapshot = readStateScope ? getReadSnapshot(fullPath, readStateScope) : null;
  const source = String(snapshot?.source || '');
  if (
    (source === 'edit' || source.startsWith('apply_patch_')) &&
    snapshot?.bodyDelivered === true &&
    statMatchesSnapshot(st, snapshot) &&
    snapshotCoversFullFile(snapshot)
  ) {
    return unchangedStub(filePath, helpers);
  }
  return null;
}

// Only whole-body bounded validation can admit a result-cache hit.
// The decoded snapshot hash remains a separate contract, never a fallback
// after a raw-byte hash mismatch.
async function cachedEntryStillValid(cachedEntry, fullPath, st, hashText) {
  const prefixHash = cachedEntry.contentPrefixHash;
  const snapHash = cachedEntry.readSnapshotMeta?.contentHash;
  if (prefixHash) {
    const curHash = await readPrefixHash(fullPath, st, hashText);
    return !!curHash && curHash === prefixHash;
  }
  if (!snapHash) return true;
  try {
    const freshHash = hashText(await readFile(fullPath, 'utf-8'));
    return !!freshHash && freshHash === snapHash;
  } catch {
    return false;
  }
}

/**
 * Validated result-cache hit.
 * @returns {Promise<{ result: unknown } | { rejected: true } | null>}
 *   A rejected entry requires fresh IO even if an older reader republishes.
 */
export async function readCachedResult({ cacheKey, fullPath, filePath, st, readStateScope, options }, helpers) {
  if (!canCacheReadFile(st)) return null;
  const { _cacheGetEntry, _hashText, _recordReadSnapshot, classifyResultKind } = helpers;
  const cachedEntry = _cacheGetEntry(cacheKey);
  if (cachedEntry === null) return null;
  if (!(await cachedEntryStillValid(cachedEntry, fullPath, st, _hashText))) {
    // The metadata no longer proves byte identity. Detach raw/in-flight
    // reuse too, or the fresh-read fallback can return the rejected body.
    invalidateBuiltinResultCache([fullPath]);
    return { rejected: true };
  }
  // Cross-session stub guard: RESULT_CACHE is process-global, so a cache hit
  // can be an entry SET BY ANOTHER SESSION whose body this conversation never
  // received. The stub assumes the full body is already in a prior
  // tool_result of THIS session — only true when a session-scoped snapshot
  // exists, matches the current stat, was itself produced by a body-returning
  // read AND covers the whole file (snapshotBodyWasReturnedByRead proves SOME
  // body was returned, not WHICH lines; a ranged read has no requested-window
  // coverage helper, so full coverage is required there too — failing the
  // gate only falls through to the full cached body, which is never
  // incorrect). Probe BEFORE recording the snapshot below, which would
  // otherwise mark the file as body-returned and mask the cross-session case.
  // A null readStateScope has no session evidence, so it always fails.
  const sessionSnap = readStateScope ? getReadSnapshot(fullPath, readStateScope) : null;
  const stubBodyAlreadySent =
    !!sessionSnap &&
    statMatchesSnapshot(st, sessionSnap) &&
    snapshotBodyWasReturnedByRead(sessionSnap) &&
    snapshotCoversFullFile(sessionSnap);
  _recordReadSnapshot(fullPath, st, readStateScope, cachedEntry.readSnapshotMeta || { source: 'read_cached' });
  // G6: file_unchanged stub. The full body is already in the prior
  // tool_result; resending it wastes cache_creation tokens (reference
  // upstream measured ~18% on Read calls). Snapshot tracking stays intact
  // (Edit validation still works) while the response payload collapses.
  // Falls back to the full body when the cached value is itself an error
  // string, or when this session has no body-returned snapshot proving it
  // saw the body (cross-session hit — emit the full cached body so the
  // recorded snapshot above is honestly body-returned here).
  const cachedVal = cachedEntry.value;
  if (
    typeof cachedVal === 'string' &&
    classifyResultKind(cachedVal) !== 'error' &&
    stubBodyAlreadySent &&
    options?.suppressReadUnchangedStub !== true
  ) {
    return { result: unchangedStub(filePath, helpers) };
  }
  return { result: cachedVal };
}

/**
 * Path-snapshot fallback: exact cache-key misses can still collapse
 * duplicate full-file reads. Size-gated so a missing cache entry never
 * hashes a large file just to emit an unchanged stub.
 */
export async function pathSnapshotUnchangedStub(
  { fullPath, filePath, st, readStateScope, hasRangeArgs, options },
  helpers
) {
  if (hasRangeArgs || st.size > READ_PREFIX_HASH_BYTES) return null;
  const snap = getReadSnapshot(fullPath, readStateScope);
  if (
    !(
      snap &&
      statMatchesSnapshot(st, snap) &&
      snapshotCoversFullFile(snap) &&
      snapshotBodyWasReturnedByRead(snap) &&
      typeof snap.contentHash === 'string' &&
      snap.contentHash
    )
  ) {
    return null;
  }
  let diskHash = '';
  try {
    diskHash = helpers._hashText(await readFile(fullPath, 'utf-8'));
  } catch {}
  if (diskHash && diskHash === snap.contentHash && options?.suppressReadUnchangedStub !== true) {
    return unchangedStub(filePath, helpers);
  }
  return null;
}
