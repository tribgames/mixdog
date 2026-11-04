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
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withFileLock, withFileLockSync, writeJsonAtomicAsync, writeJsonAtomicSync } from '../shared/atomic-file.mjs';
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

function parseIndex(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.filter((entry) => REF_RE.test(String(entry?.ref)) && Number(entry.size) > 0)
    : [];
}

// The send path's claim is synchronous by contract (claimStagedOriginals).
function readIndexSync() {
  try {
    return parseIndex(readFileSync(indexPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function readIndex() {
  try {
    return parseIndex(await readFile(indexPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function blobExists(ref) {
  try {
    await access(attachmentFilePath(ref));
    return true;
  } catch {
    return false;
  }
}

async function writeIndex(entries) {
  await writeJsonAtomicAsync(indexPath(), entries);
  armPruneDeadline(entries);
}

async function transaction(fn, lockTimeoutMs) {
  await mkdir(root(), { recursive: true });
  return withFileLock(stagedOriginalsLockPath(), fn, {
    timeoutMs: lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
  });
}

// The entries still worth keeping, oldest first: an entry whose blob is gone
// (a crash between recording and publishing, or a sweep) is dropped, an
// expired one is deleted with its blob. Runs inside a transaction.
async function pruned(entries, now, ttlMs, keepRef = '') {
  const kept = [];
  for (const entry of entries) {
    if (!(await blobExists(entry.ref))) continue;
    if (entry.ref !== keepRef && now - Number(entry.at) > ttlMs) await removeAttachmentBlob(entry.ref);
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
  return transaction(async () => {
    const index = await readIndex();
    const tracked = index.some((entry) => entry.ref === ref);
    // An entry whose blob never got published is not "tracked" (see pruned).
    let entries = await pruned(index, now, ttlMs, ref);
    const wasTracked = tracked && entries.some((entry) => entry.ref === ref);
    // Bytes already stored for a message (or an earlier attach) are theirs, not
    // staged by this call: never tracked here, so never evicted here.
    if ((await blobExists(ref)) && !wasTracked) {
      await writeIndex(entries);
      return { attachmentRef: ref };
    }
    entries = entries.filter((entry) => entry.ref !== ref);
    let total = entries.reduce((sum, entry) => sum + Number(entry.size), 0);
    while (total + buffer.length > maxBytes && entries.length > 0) {
      const [oldest] = entries.splice(0, 1);
      total -= Number(oldest.size);
      await removeAttachmentBlob(oldest.ref);
    }
    // Intent first: the entry is durable before the blob exists.
    entries.push({ ref, size: buffer.length, at: now });
    await writeIndex(entries);
    try {
      storeAttachmentBuffer(buffer);
    } catch (error) {
      await writeIndex(entries.filter((entry) => entry.ref !== ref));
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
        const entries = readIndexSync();
        const claimed = new Set(wanted.filter((ref) => existsSync(attachmentFilePath(ref))));
        const rest = entries.filter((entry) => !claimed.has(entry.ref));
        if (rest.length !== entries.length) {
          writeJsonAtomicSync(indexPath(), rest);
          armPruneDeadline(rest);
        }
        return claimed;
      },
      { timeoutMs: 0, staleMs: LOCK_STALE_MS }
    );
  } catch {
    return new Set();
  }
}

let pruneStarted = false;
let pruneTimer = null;
let deadlinePrune = null;
// Bumped by every arm. Arms from index writes run inside the lock, so they
// come in write order; the startup read runs outside it and must not replace
// an arm made from a newer index while it was reading.
let armGeneration = 0;

/** Test seam: the prune the last deadline started (settled once it is done). */
export function _deadlinePruneForTest() {
  return deadlinePrune;
}

// One timer, at the earliest staged entry's expiry; none while nothing is
// staged. Every transaction of this process that writes the index re-arms it
// from the entries it wrote. Only the daemon (the sole writer) arms it.
function armPruneDeadline(entries) {
  if (!pruneStarted) return;
  armGeneration += 1;
  clearTimeout(pruneTimer);
  pruneTimer = null;
  if (entries.length === 0) return;
  const earliest = Math.min(...entries.map((entry) => Number(entry.at)));
  // An entry expires once strictly past the TTL (see pruned).
  const delayMs = Math.max(0, earliest + STAGED_ORIGINALS_TTL_MS + 1 - Date.now());
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    // A failed pass (lock contention, disk) leaves the entries for the next
    // stage, claim or daemon start, each of which prunes and re-arms.
    deadlinePrune = pruneStagedOriginals().catch(() => {});
  }, delayMs);
  pruneTimer.unref?.();
}

/** Expire staged originals on their own deadline, for the daemon (the sole
 *  writer): without it an abandoned original would wait for the next stage.
 *  Idempotent; reads the index once to arm the first deadline. */
export function startStagedOriginalsPrune() {
  if (pruneStarted) return;
  pruneStarted = true;
  const generation = armGeneration;
  void readIndex().then((entries) => {
    if (armGeneration === generation) armPruneDeadline(entries);
  });
}

/** Reconcile the staged set now (expiry, entries without a blob); every
 *  stage does the same. Returns the entries kept. */
export async function pruneStagedOriginals({ now = Date.now(), ttlMs = STAGED_ORIGINALS_TTL_MS } = {}) {
  return transaction(async () => {
    const entries = await pruned(await readIndex(), now, ttlMs);
    await writeIndex(entries);
    return entries;
  });
}
