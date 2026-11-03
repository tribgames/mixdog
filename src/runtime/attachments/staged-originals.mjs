/**
 * Originals staged ahead of a message.
 *
 * A composer that resized an image for the model hands the file as picked to
 * the engine first (media.mjs), and the message that follows claims it
 * (`claimStagedOriginals`). Until claimed, a staged original belongs to no
 * message, and a paired device can stage as fast as it can call, so the
 * unclaimed ones are bounded here: a short retention, and an aggregate quota
 * with oldest-first eviction. Staging that cannot fit fails, and the composer
 * keeps the resized copy.
 *
 * The index of staged entries is shared by every process on this data dir, so
 * stage, claim and prune each run as ONE transaction under a file lock
 * (reconciled against the disk inside it). An entry is recorded BEFORE its
 * blob is published, so a crash leaves either an entry with no blob (dropped
 * by the next transaction) or both; never a staged blob the index does not
 * know. The lock is short-lived and reclaimed when stale. It is taken
 * asynchronously by staging and prune: a caller that has to wait yields the
 * event loop meanwhile (the engine serves every session on it) and fails after
 * a short timeout. The send path's claim never waits at all (see
 * `claimStagedOriginals`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withFileLock, withFileLockSync, writeJsonAtomicSync } from '../shared/atomic-file.mjs';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { attachmentFilePath, attachmentRefForBuffer, removeAttachmentBlob, storeAttachmentBuffer } from './store.mjs';

export const STAGED_ORIGINALS_MAX_BYTES = 256 * 1024 * 1024;
export const STAGED_ORIGINALS_TTL_MS = 2 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 5_000;
const REF_RE = /^[a-f0-9]{64}$/;

function root() {
  return join(resolvePluginData(), 'prompt-attachments');
}

export function stagedOriginalsLockPath() {
  return join(root(), 'staged-originals.lock');
}

function indexPath() {
  return join(root(), 'staged-originals.json');
}

function readIndex() {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((entry) => REF_RE.test(String(entry?.ref)) && Number(entry.size) > 0)
      : [];
  } catch {
    return [];
  }
}

async function transaction(fn, lockTimeoutMs) {
  mkdirSync(root(), { recursive: true });
  return withFileLock(stagedOriginalsLockPath(), fn, {
    timeoutMs: lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
  });
}

// The entries still worth keeping, oldest first: an entry whose blob is gone
// (a crash between recording and publishing, or a sweep) is dropped, an
// expired one is deleted with its blob. Runs inside a transaction.
function pruned(entries, now, ttlMs, keepRef = '') {
  const kept = [];
  for (const entry of entries) {
    if (!existsSync(attachmentFilePath(entry.ref))) continue;
    if (entry.ref !== keepRef && now - Number(entry.at) > ttlMs) removeAttachmentBlob(entry.ref);
    else kept.push(entry);
  }
  return kept;
}

/** Store `buffer` as a staged original: `{ attachmentRef }`. Throws when it
 *  alone is over the quota or the lock cannot be had in time. */
export async function stageOriginalAttachment(
  buffer,
  {
    now = Date.now(),
    maxBytes = STAGED_ORIGINALS_MAX_BYTES,
    ttlMs = STAGED_ORIGINALS_TTL_MS,
    lockTimeoutMs = undefined,
  } = {}
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TypeError('staged original is empty');
  if (buffer.length > maxBytes) throw new RangeError('staged original exceeds the staging quota');
  const ref = attachmentRefForBuffer(buffer);
  return transaction(() => {
    const tracked = readIndex().some((entry) => entry.ref === ref);
    // An entry whose blob never got published is not "tracked" (see pruned).
    let entries = pruned(readIndex(), now, ttlMs, ref);
    const wasTracked = tracked && entries.some((entry) => entry.ref === ref);
    // Bytes already stored for a message (or an earlier attach) are theirs, not
    // staged by this call: never tracked here, so never evicted here.
    if (existsSync(attachmentFilePath(ref)) && !wasTracked) {
      writeJsonAtomicSync(indexPath(), entries);
      return { attachmentRef: ref };
    }
    entries = entries.filter((entry) => entry.ref !== ref);
    let total = entries.reduce((sum, entry) => sum + Number(entry.size), 0);
    while (total + buffer.length > maxBytes && entries.length > 0) {
      const [oldest] = entries.splice(0, 1);
      total -= Number(oldest.size);
      removeAttachmentBlob(oldest.ref);
    }
    // Intent first: the entry is durable before the blob exists.
    entries.push({ ref, size: buffer.length, at: now });
    writeJsonAtomicSync(indexPath(), entries);
    try {
      storeAttachmentBuffer(buffer);
    } catch (error) {
      writeJsonAtomicSync(
        indexPath(),
        entries.filter((entry) => entry.ref !== ref)
      );
      throw error;
    }
    return { attachmentRef: ref };
  }, lockTimeoutMs);
}

/**
 * A message is about to name these originals: those still stored leave the
 * staged set, so no eviction or expiry can take them, and are returned. A ref
 * already evicted is not (the message then keeps only the resized copy).
 *
 * Synchronous with ZERO wait: this runs inside the send path, which must stay
 * synchronous between its cancellation check and the enqueue (an await there
 * would let a cancel miss the send and a later send overtake it). The lock is
 * tried once; if someone holds it nothing is claimed. A stale lock is still
 * reclaimed by that one attempt, so a leftover never blocks claims for good.
 */
export function claimStagedOriginals(refs) {
  const wanted = [...new Set(refs)].filter((ref) => REF_RE.test(String(ref)));
  if (wanted.length === 0) return new Set();
  try {
    mkdirSync(root(), { recursive: true });
    return withFileLockSync(
      stagedOriginalsLockPath(),
      () => {
        const entries = readIndex();
        const claimed = new Set(wanted.filter((ref) => existsSync(attachmentFilePath(ref))));
        const rest = entries.filter((entry) => !claimed.has(entry.ref));
        if (rest.length !== entries.length) writeJsonAtomicSync(indexPath(), rest);
        return claimed;
      },
      { timeoutMs: 0, staleMs: LOCK_STALE_MS }
    );
  } catch {
    return new Set();
  }
}

/** Reconcile the staged set now (expiry, entries without a blob); every
 *  stage does the same. Returns the entries kept. */
export async function pruneStagedOriginals({ now = Date.now(), ttlMs = STAGED_ORIGINALS_TTL_MS } = {}) {
  return transaction(() => {
    const entries = pruned(readIndex(), now, ttlMs);
    writeJsonAtomicSync(indexPath(), entries);
    return entries;
  });
}
