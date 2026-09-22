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
import { hydratePastedAttachments } from '../../../../runtime/attachments/store.mjs';

export function createTakeEntriesOps({ pending, pendingNotificationKeys, removeQueuedEntries }) {
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
    const queued = [];
    for (let i = 0; i < pending.length; ) {
      const entry = pending[i];
      if (isQueuedEntryEditable(entry) && (!targetId || String(entry.id) === targetId)) {
        queued.push(entry);
        pending.splice(i, 1);
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(queued);
    const queuedText = queued
      .map((item) => item.text)
      .filter((text) => String(text || '').trim())
      .join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    const hydrated = hydratePastedAttachments(mergePastedImages(queued), mergePastedTexts(queued));
    return {
      count: queued.length,
      ids: queued.map((item) => String(item.id || '')).filter(Boolean),
      text: combinedText,
      pastedImages: hydrated.pastedImages,
      pastedTexts: hydrated.pastedTexts,
    };
  }

  return { dequeueQueueBatch, restoreQueued };
}
