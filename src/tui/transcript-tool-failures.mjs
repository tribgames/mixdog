/**
 * Transcript visibility rules for fully-failed tool batches.
 * Hook / approval denials are user-actionable and must stay visible in the TUI.
 */

const HOOK_DENIAL_RE = /denied by hook/i;
const APPROVAL_UNAVAILABLE_RE = /approval required but no approval UI is available/i;

export function toolItemResultText(item) {
  if (!item) return '';
  const chunks = [];
  if (item.result != null) chunks.push(String(item.result));
  if (item.rawResult != null && item.rawResult !== item.result) chunks.push(String(item.rawResult));
  return chunks.join('\n').trim();
}

export function isHookApprovalDenialToolResult(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (HOOK_DENIAL_RE.test(value)) return true;
  if (APPROVAL_UNAVAILABLE_RE.test(value)) return true;
  return false;
}

export function isHookApprovalDenialToolItem(item) {
  if (!item || item.kind !== 'tool') return false;
  return isHookApprovalDenialToolResult(toolItemResultText(item));
}

/** Strip the orchestrator's `Error: tool "name"` prefix for a compact TUI line. */
export function formatHookDenialDetail(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const stripped = raw.replace(/^Error:\s*tool\s*"[^"]*"\s*/i, '').trim();
  return stripped || raw;
}

export function isFullyFailedToolBatch(item) {
  if (!item || item.kind !== 'tool') return false;
  const args = item.args && typeof item.args === 'object' ? item.args : {};
  const hasTaskId = Boolean(args.task_id || args.taskId);
  const status = String(args.status || '').toLowerCase();
  if (hasTaskId && /^(failed|error|timeout|cancelled|canceled|killed)$/.test(status)) {
    return false;
  }
  const count = Math.max(1, Number(item.count || 1));
  const done = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
  const explicit = Number(item.errorCount);
  const failed = Number.isFinite(explicit)
    ? Math.max(0, Math.min(count, Math.floor(explicit)))
    : item.isError ? count : 0;
  return done >= count && failed >= count;
}

/** Hide noisy all-failed internal tool cards, except hook/approval denials. */
export function shouldSuppressFullyFailedToolItem(item) {
  if (!isFullyFailedToolBatch(item)) return false;
  if (isHookApprovalDenialToolItem(item)) return false;
  return true;
}
