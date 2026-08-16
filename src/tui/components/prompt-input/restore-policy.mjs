/**
 * Queue restore RPCs may settle after the user has continued editing. The
 * session service is asked for queued text only; prepend it to the latest local draft
 * so a delayed response can never replace newer typing.
 */
export function mergeQueuedRestoreText(queuedText = '', currentText = '') {
  return mergeQueuedRestoreDraft(queuedText, { value: currentText }).value;
}

/**
 * Reclaimed queued commands are inserted before the current input while
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

export function queuedRestoreProjection(entries = [], selectedId = '') {
  const targetId = String(selectedId || '').trim();
  const selected = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!targetId) return true;
    return String(entry?.id ?? '') === targetId;
  });
  return {
    count: selected.length,
    ids: selected.map((entry) => String(entry?.id ?? '')).filter(Boolean),
    text: selected.map((entry) =>
      String(entry?.displayText ?? entry?.text ?? entry?.prompt ?? ''))
      .filter((text) => text.trim())
      .join('\n'),
  };
}

export function queuedRestorePrefix(queuedText = '', currentText = '') {
  const current = String(currentText ?? '');
  const merged = mergeQueuedRestoreDraft(queuedText, {
    value: current,
    cursor: 0,
    selectionAnchor: null,
  }).value;
  return merged.slice(0, Math.max(0, merged.length - (current.trim() ? current.length : 0)));
}

export function replaceQueuedRestorePrefix(
  optimisticPrefix = '',
  authoritativePrefix = '',
  currentDraft = {},
) {
  const optimistic = String(optimisticPrefix ?? '');
  const authoritative = String(authoritativePrefix ?? '');
  const value = typeof currentDraft === 'string'
    ? currentDraft
    : String(currentDraft?.value ?? '');
  if (optimistic && !value.startsWith(optimistic)) {
    return {
      value,
      cursor: typeof currentDraft === 'object' && Number.isFinite(currentDraft?.cursor)
        ? currentDraft.cursor
        : value.length,
      selectionAnchor: typeof currentDraft === 'object' && Number.isFinite(currentDraft?.selectionAnchor)
        ? currentDraft.selectionAnchor
        : null,
      replaced: false,
    };
  }
  const nextValue = `${authoritative}${value.slice(optimistic.length)}`;
  const remap = (offset) => {
    const bounded = Math.max(0, Math.min(value.length, Number(offset) || 0));
    return bounded <= optimistic.length
      ? Math.min(authoritative.length, bounded)
      : bounded + authoritative.length - optimistic.length;
  };
  const cursor = typeof currentDraft === 'object' && Number.isFinite(currentDraft?.cursor)
    ? remap(currentDraft.cursor)
    : nextValue.length;
  const selectionAnchor = typeof currentDraft === 'object'
    && Number.isFinite(currentDraft?.selectionAnchor)
    ? remap(currentDraft.selectionAnchor)
    : null;
  return { value: nextValue, cursor, selectionAnchor, replaced: true };
}

export function paletteOwnsPromptVerticalArrow(optionCount = 0) {
  return Math.max(0, Number(optionCount) || 0) > 1;
}
