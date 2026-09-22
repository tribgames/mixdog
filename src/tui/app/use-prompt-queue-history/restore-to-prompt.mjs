// use-prompt-queue-history/restore-to-prompt.mjs
// The queued-messages → draft restore. Two halves: the publisher, which owns
// the draft the prompt is currently showing (optimistic projection first,
// daemon-authoritative text reconciled onto it), and the flow that asks the
// store to retire the queue and applies the answer.
import {
  mergeQueuedRestoreDraft,
  queuedRestorePrefix,
  queuedRestoreProjection,
  replaceQueuedRestorePrefix,
} from '../../components/prompt-input/restore-policy.mjs';

/**
 * Publishes drafts into the prompt and reconciles the optimistic prefix with
 * the authoritative one. `before` is the draft the restore started from, and
 * every publication also updates the value ref + layout rows the prompt reads.
 */
function createRestoreDraftPublisher({
  before,
  restoreDraft,
  optimisticPrefix,
  getCurrentDraft,
  promptValueRef,
  syncPromptLayoutRows,
  setPromptDraftOverride,
}) {
  let lastPublishedDraft = before;
  const publishDraft = (next) => {
    lastPublishedDraft = next;
    promptValueRef.current = next.value;
    syncPromptLayoutRows(next.value);
    setPromptDraftOverride({ id: Date.now(), ...next });
  };
  const currentDraft = () => {
    const latest = getCurrentDraft?.();
    const refValue = String(promptValueRef.current ?? '');
    if (latest && typeof latest === 'object' && String(latest.value ?? '') === refValue) return latest;
    if (String(lastPublishedDraft.value ?? '') === refValue) return lastPublishedDraft;
    return { value: refValue, cursor: refValue.length, selectionAnchor: null };
  };
  const reconcile = (authoritativeText = '') => {
    if (!restoreDraft) return true;
    const authoritativePrefix = queuedRestorePrefix(authoritativeText, before.value);
    const next = replaceQueuedRestorePrefix(optimisticPrefix, authoritativePrefix, currentDraft());
    if (!next.replaced) return false;
    if (
      next.value !== promptValueRef.current ||
      next.cursor !== currentDraft().cursor ||
      next.selectionAnchor !== currentDraft().selectionAnchor
    ) {
      publishDraft(next);
    }
    return true;
  };
  return { publishDraft, reconcile };
}

export function runRestoreQueuedToPrompt(options, deps) {
  const {
    store,
    queued,
    promptDraft,
    promptValueRef,
    inFlightRef,
    showPromptHint,
    clearPromptHint,
    installPastedImages,
    installPastedTexts,
    syncPromptLayoutRows,
    setPromptDraftOverride,
  } = deps;
  const restoreDraft = options.restoreDraft !== false;
  const showHint = options.showHint !== false;
  const currentText = options.currentText ?? promptValueRef.current ?? promptDraft;
  const projection = queuedRestoreProjection(queued);
  const queuedCount = projection.count;
  if (inFlightRef.current) return queuedCount > 0;
  if (queuedCount === 0) return false;
  const initialDraft = options.getCurrentDraft?.();
  const before =
    initialDraft && typeof initialDraft === 'object'
      ? initialDraft
      : {
          value: String(currentText ?? ''),
          cursor: String(currentText ?? '').length,
          selectionAnchor: null,
        };
  const optimisticDraft = mergeQueuedRestoreDraft(projection.text, before);
  const optimisticPrefix = queuedRestorePrefix(projection.text, before.value);
  const { publishDraft, reconcile } = createRestoreDraftPublisher({
    before,
    restoreDraft,
    optimisticPrefix,
    getCurrentDraft: options.getCurrentDraft,
    promptValueRef,
    syncPromptLayoutRows,
    setPromptDraftOverride,
  });
  if (restoreDraft && optimisticPrefix) publishDraft(optimisticDraft);
  const apply = (restored) => {
    if (!restored || restored.count === 0) {
      reconcile('');
      if (showHint) showPromptHint('No queued messages to restore.', 'info');
      return false;
    }
    if (restoreDraft) {
      if (restored.pastedImages) installPastedImages(restored.pastedImages, { merge: true });
      if (restored.pastedTexts) installPastedTexts(restored.pastedTexts, { merge: true });
      reconcile(restored.text);
    }
    if (showHint) {
      showPromptHint(`restored ${restored.count} queued message${restored.count === 1 ? '' : 's'}`, 'info');
    } else {
      clearPromptHint();
    }
    return true;
  };
  // Paint the published local-queue projection before
  // asking the daemon to retire it, then reconcile attachments/text on ack.
  let restored;
  try {
    restored = store.restoreQueued?.('');
  } catch {
    reconcile('');
    if (showHint) showPromptHint('Could not restore queued messages.', 'error');
    return true;
  }
  // A daemon-backed store answers this as an ASYNC remote call, so the
  // payload (and with it the queued text) only exists a tick later. Reading
  // `.count`/`.text` off the promise dropped the popped entries on the floor —
  // the queued message vanished instead of returning to the draft. Decide the
  // synchronous verdict from the published queue and fill the draft on settle.
  if (restored && typeof restored.then === 'function') {
    inFlightRef.current = true;
    void Promise.resolve(restored)
      .then(apply)
      .catch(() => {
        reconcile('');
        if (showHint) showPromptHint('Could not restore queued messages.', 'error');
      })
      .finally(() => {
        inFlightRef.current = false;
      });
    return queuedCount > 0;
  }
  return apply(restored);
}
