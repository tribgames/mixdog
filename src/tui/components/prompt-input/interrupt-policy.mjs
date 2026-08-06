/**
 * Claude Code restores the submitted prompt only when Esc cancelled before a
 * meaningful response and the user has not typed a replacement meanwhile.
 * The engine owns the response-progress guard; the prompt owns the draft guard.
 */
export function promptInterruptRestoreText(result, currentText = '') {
  if (!result || result?.aborted === false) return '';
  if (String(currentText ?? '') !== '') return '';
  return String(result?.restoreText || '').trim();
}
