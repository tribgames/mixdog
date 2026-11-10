/**
 * src/tui/session/tool-approval-request.mjs — the request record a tool-approval
 * queue (tool-approval.mjs) holds and presents: name, args, reason, and its
 * own wait limit.
 */
import { humanRequestFields } from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';

/** The queue's default wait limit from its `timeoutMs` option: a positive
 *  number, else null (no limit). */
export function defaultApprovalTimeoutMs(timeoutMs) {
  return Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
}

export function normalizeToolApprovalRequest(input, id, defaultTimeoutMs) {
  const now = Date.now();
  // An explicit `timeoutMs: null` means no wait limit (no timer, no expiry);
  // any other missing/invalid value falls back to the session default,
  // which is itself no limit unless the runtime configures one.
  let requestTimeoutMs = defaultTimeoutMs;
  if (input?.timeoutMs === null) requestTimeoutMs = null;
  else if (Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0) {
    requestTimeoutMs = Number(input.timeoutMs);
  }
  return {
    id,
    name: String(input?.name || input?.tool_name || 'tool'),
    kind: typeof input?.kind === 'string' ? input.kind : '',
    args: input?.args ?? input?.tool_input ?? null,
    cwd: input?.cwd || null,
    sessionId: input?.sessionId || input?.session_id || null,
    toolCallId: input?.toolCallId || input?.tool_use_id || null,
    reason: String(input?.reason || input?.message || 'approval requested by hook').trim(),
    requestedAt: now,
    timeoutMs: requestTimeoutMs,
    expiresAt: requestTimeoutMs === null ? null : now + requestTimeoutMs,
    // outbound / secret / takeover / permission fields (human-gate/requests.mjs).
    ...humanRequestFields(input),
  };
}
