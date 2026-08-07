/**
 * Queue restore RPCs may settle after the user has continued editing. The
 * session service is asked for queued text only; prepend it to the latest local draft
 * so a delayed response can never replace newer typing.
 */
export function mergeQueuedRestoreText(queuedText = '', currentText = '') {
  return [String(queuedText ?? ''), String(currentText ?? '')]
    .filter((text) => text.trim())
    .join('\n');
}
