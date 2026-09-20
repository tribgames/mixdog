/**
 * src/tui/session/session-flow/queue.mjs - pending queue entries: entry shape,
 * priority-bucket dequeue, front requeue, reclaim/prioritize, and the
 * idempotent submission-id memory shared by intake and disk restore.
 */
import {
  queuePriorityValue,
  defaultQueuePriority,
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isSlashQueuedEntry,
  notificationDisplayText,
  promptDisplayText,
  promptContentImageMeta,
  mergePastedImages,
  mergePastedTexts,
} from '../queue-helpers.mjs';
import { hydratePastedAttachments } from '../../../runtime/attachments/store.mjs';

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

  function makeQueueEntry(text, options = {}) {
    const mode = options.mode || 'prompt';
    const priority = options.priority || defaultQueuePriority(mode);
    const displayText = promptDisplayText(text, options);
    const submittedAt = Number(options.submittedAt);
    return {
      id: options.id || nextId(),
      submittedAt: Number.isFinite(submittedAt) && submittedAt > 0 ? Math.round(submittedAt) : Date.now(),
      text: displayText,
      content: text,
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
      images: promptContentImageMeta(text, options.pastedImages),
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
      onSettled: typeof options.onSettled === 'function' ? options.onSettled : null,
      onToolResult: typeof options.onToolResult === 'function' ? options.onToolResult : null,
      transcriptMeta:
        options.transcriptMeta && typeof options.transcriptMeta === 'object' ? { ...options.transcriptMeta } : null,
      context: options.context || null,
      mode,
      ...(options.execution && typeof options.execution === 'object' ? { execution: { ...options.execution } } : {}),
      priority,
      key: options.key || null,
      skipSlashCommands: options.skipSlashCommands === true,
      displayText: mode === 'task-notification' ? notificationDisplayText(displayText) : String(displayText || ''),
      suppressDisplay: options.suppressDisplay === true,
      // Completion resumes are consumed exactly once: Esc abandons their
      // uncommitted body instead of putting it back at the queue front.
      abortDiscardOnAbort: options.abortDiscardOnAbort === true,
      resumeCompletionKeys: Array.isArray(options.resumeCompletionKeys)
        ? options.resumeCompletionKeys.filter((key) => key != null && String(key).trim())
        : [],
      steeringPersistId: options.steeringPersistId || null,
      steeringPersistRestored: options.steeringPersistRestored === true,
      isMeta: options.isMeta === true,
      goalId: options.goalId || null,
      // Retry of a failed turn: the transcript and the session rewind the
      // failed turn's unanswered prompt before this entry runs.
      retryFailedTurn: options.retryFailedTurn === true,
    };
  }

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
        if (!pendingNotificationKeys.has(next.key)) pendingNotificationKeys.add(next.key);
      }
      restored.push(next);
    }
    if (restored.length === 0) return false;
    pending.unshift(...restored);
    const visible = restored.filter(isQueuedEntryVisible);
    if (visible.length > 0) set({ queued: [...visible, ...getState().queued] });
    return true;
  }

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
