/**
 * Queue restore RPCs may settle after the user has continued editing. The
 * session service is asked for queued text only; prepend it to the latest local draft
 * so a delayed response can never replace newer typing.
 */
export function mergeQueuedRestoreText(queuedText = '', currentText = '') {
  return mergeQueuedRestoreDraft(queuedText, { value: currentText }).value;
}

/**
 * Claude Code inserts reclaimed queued commands before the current input while
 * preserving the caret's position inside that input. Keep the same invariant
 * when a daemon-backed restore settles after further local editing.
 */
export function mergeQueuedRestoreDraft(queuedText = '', currentDraft = {}) {
  const queued = String(queuedText ?? '');
  const currentValue = typeof currentDraft === 'string'
    ? currentDraft
    : String(currentDraft?.value ?? '');
  const includeQueued = Boolean(queued.trim());
  const includeCurrent = Boolean(currentValue.trim());
  const separator = includeQueued && includeCurrent ? '\n' : '';
  const value = `${includeQueued ? queued : ''}${separator}${includeCurrent ? currentValue : ''}`;
  const prefixLength = includeQueued ? queued.length + separator.length : 0;
  const rawCursor = typeof currentDraft === 'object' && Number.isFinite(currentDraft?.cursor)
    ? currentDraft.cursor
    : currentValue.length;
  const currentCursor = includeCurrent
    ? Math.max(0, Math.min(currentValue.length, rawCursor))
    : 0;
  const rawAnchor = typeof currentDraft === 'object' && Number.isFinite(currentDraft?.selectionAnchor)
    ? currentDraft.selectionAnchor
    : null;
  const selectionAnchor = includeCurrent && rawAnchor !== null
    ? prefixLength + Math.max(0, Math.min(currentValue.length, rawAnchor))
    : null;
  return {
    value,
    cursor: prefixLength + currentCursor,
    selectionAnchor,
  };
}
