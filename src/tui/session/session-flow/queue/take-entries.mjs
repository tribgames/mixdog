/**
 * src/tui/session/session-flow/queue/take-entries.mjs - the two readers that
 * take entries OUT of the pending list: the drain's priority-bucket batch and
 * the surface's restore-to-draft. Both splice `pending` in place and drop the
 * same entries from the published queue through `removeQueuedEntries`.
 */
import {
  queuePriorityValue,
  isQueuedEntryEditable,
  mergePastedImages,
  mergePastedTexts,
} from '../../queue-helpers.mjs';
import { hydratePastedAttachments, hydrateRestorableFileParts } from '../../../../runtime/attachments/store.mjs';
import { dropTuiSteeringPersist } from '../../tui-steering-persist.mjs';

export function createTakeEntriesOps({ pending, pendingNotificationKeys, removeQueuedEntries, leadSessionId }) {
  function dequeueQueueBatch(maxPriority = 'later', options = {}) {
    if (pending.length === 0) return [];
    const max = queuePriorityValue(maxPriority);
    const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    const limit = Math.max(1, Number(options.limit) || Infinity);
    let bestPriority = Infinity;
    let targetMode = null;
    for (const entry of pending) {
      if (!predicate(entry)) continue;
      const p = queuePriorityValue(entry.priority);
      if (p > max) continue;
      if (p < bestPriority) {
        bestPriority = p;
        targetMode = entry.mode || 'prompt';
      }
    }
    if (!targetMode) return [];
    const batch = [];
    for (let i = 0; i < pending.length; ) {
      const entry = pending[i];
      if (
        predicate(entry) &&
        (entry.mode || 'prompt') === targetMode &&
        queuePriorityValue(entry.priority) === bestPriority
      ) {
        batch.push(entry);
        pending.splice(i, 1);
        if (entry.mode === 'task-notification' && entry.key) pendingNotificationKeys.delete(entry.key);
        if (batch.length >= limit) break;
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(batch);
    return batch;
  }

  function restoreQueued(currentText = '', selectedId = '') {
    const targetId = String(selectedId || '').trim();
    const queued = pending.filter(
      (entry) => isQueuedEntryEditable(entry) && (!targetId || String(entry.id) === targetId)
    );
    // Hydrate before anything leaves the queue: an attachment whose blob is
    // gone is dropped alone (and reported), never the prompt that carried it.
    let unreadable = 0;
    const onUnreadable = () => {
      unreadable += 1;
    };
    const hydrated = hydratePastedAttachments(mergePastedImages(queued), mergePastedTexts(queued), { onUnreadable });
    const files = queued.flatMap((entry) => hydrateRestorableFileParts(entry.content, { onUnreadable }));
    const taken = new Set(queued);
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (taken.has(pending[i])) pending.splice(i, 1);
    }
    removeQueuedEntries(queued);
    // A reclaimed prompt goes back to the draft, so its durable steering
    // mirror goes with it; otherwise the next runtime restore re-queues a
    // prompt the user already took back.
    const mirrored = queued.filter((entry) => entry.steeringPersistId && !entry.steeringPersistRestored);
    if (mirrored.length > 0) void dropTuiSteeringPersist(leadSessionId(), mirrored);
    const queuedText = queued
      .map((item) => item.text)
      .filter((text) => String(text || '').trim())
      .join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    return {
      ...(unreadable
        ? { notice: `${unreadable} attachment${unreadable === 1 ? ' was' : 's were'} no longer available and dropped.` }
        : {}),
      count: queued.length,
      ids: queued.map((item) => String(item.id || '')).filter(Boolean),
      text: combinedText,
      pastedImages: hydrated.pastedImages,
      pastedTexts: hydrated.pastedTexts,
      // Hydrated PDF/Office parts, in the `record.content` shape the desktop
      // composer restores files from.
      ...(files.length ? { content: files } : {}),
    };
  }

  return { dequeueQueueBatch, restoreQueued };
}
