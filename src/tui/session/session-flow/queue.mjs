/**
 * src/tui/session/session-flow/queue.mjs - pending queue entries: entry shape,
 * priority-bucket dequeue, front requeue, reclaim/prioritize, and the
 * idempotent submission-id memory shared by intake and disk restore.
 */
import {
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isSlashQueuedEntry,
  notificationDisplayText,
} from '../queue-helpers.mjs';
import { makeQueueEntry as buildQueueEntry } from './queue/entry-shape.mjs';
import { createTakeEntriesOps } from './queue/take-entries.mjs';

// Submission-id memory for idempotent re-delivery. A prompt can legitimately
// reach this queue TWICE when its transport retries across a failed response
// (daemon view retry, live-share spool fallback after a missing ack). The id
// the surface minted is the identity of the message, so a repeat of an id we
// already queued is dropped instead of posting the prompt twice.
const SUBMISSION_ID_MEMORY = 256;

export function createSubmissionMemory(limit = SUBMISSION_ID_MEMORY) {
  const accepted = new Set();
  return {
    has: (id) => accepted.has(id),
    forget: (id) => accepted.delete(id),
    remember(id) {
      if (!id) return;
      accepted.add(id);
      while (accepted.size > limit) {
        const oldest = accepted.values().next().value;
        accepted.delete(oldest);
      }
    },
  };
}

export function createQueueOps(bag, { kickDrain }) {
  const { nextId, pending, pendingNotificationKeys, getState, set, flushEmitImmediate } = bag;

  // Entry shape: queue/entry-shape.mjs.
  const makeQueueEntry = (text, options = {}) => buildQueueEntry(text, options, nextId);

  function removeQueuedEntries(entries) {
    const ids = new Set(entries.map((entry) => entry.id));
    const queued = getState().queued.filter((q) => !ids.has(q.id));
    if (queued.length !== getState().queued.length) set({ queued });
  }

  function requeueEntriesFront(entries) {
    const restored = [];
    for (const entry of entries || []) {
      if (!entry || !String(entry.text || '').trim()) continue;
      const next = {
        ...entry,
        displayText:
          entry.displayText ||
          (entry.mode === 'task-notification' ? notificationDisplayText(entry.text) : String(entry.text || '')),
      };
      if (next.mode === 'task-notification' && next.key) {
        const duplicateQueued = pending.some((entry) => entry?.mode === 'task-notification' && entry?.key === next.key);
        if (duplicateQueued) continue;
        pendingNotificationKeys.add(next.key);
      }
      restored.push(next);
    }
    if (restored.length === 0) return false;
    pending.unshift(...restored);
    const visible = restored.filter(isQueuedEntryVisible);
    if (visible.length > 0) set({ queued: [...visible, ...getState().queued] });
    return true;
  }

  // The two takers (drain batch, restore-to-draft): queue/take-entries.mjs.
  const { dequeueQueueBatch, restoreQueued } = createTakeEntriesOps({
    pending,
    pendingNotificationKeys,
    removeQueuedEntries,
  });

  // `now` promotes one visible queued prompt ahead of its
  // siblings. The desktop follows this configure call with the normal abort
  // lane, so interruption keeps the existing recovery/requeue guarantees.
  function prioritizeQueued(selectedId = '') {
    const targetId = String(selectedId || '').trim();
    if (!targetId) return { count: 0, ids: [], priority: 'now' };
    const index = pending.findIndex(
      (entry) => isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry) && String(entry.id || '') === targetId
    );
    if (index < 0) return { count: 0, ids: [], priority: 'now' };
    const [entry] = pending.splice(index, 1);
    entry.priority = 'now';
    pending.unshift(entry);
    const visible = getState().queued.map((queuedEntry) =>
      String(queuedEntry?.id || '') === targetId ? { ...queuedEntry, priority: 'now' } : queuedEntry
    );
    set({ queued: visible });
    flushEmitImmediate?.();
    kickDrain();
    return { count: 1, ids: [targetId], priority: 'now' };
  }

  return {
    makeQueueEntry,
    removeQueuedEntries,
    requeueEntriesFront,
    dequeueQueueBatch,
    restoreQueued,
    prioritizeQueued,
  };
}
