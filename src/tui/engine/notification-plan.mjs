/**
 * src/tui/engine/notification-plan.mjs - pure runtime.onNotification delivery plan.
 *
 * Extracted from engine.mjs (no behavior change). These are stateless helpers
 * that decide how a runtime notification envelope should be delivered to the
 * TUI store (dedupe key + display/model routing). No closures over engine state.
 */
import {
  isStatusOnlyAgentCompletionNotification,
  parseAgentJob,
  parseAgentResultEnvelope,
  parseBackgroundTaskEnvelope,
  parseSyntheticAgentMessage,
} from './agent-envelope.mjs';
import { shortTextFingerprint } from './queue-helpers.mjs';
import { modelVisibleToolCompletionMessage } from '../../runtime/shared/tool-execution-contract.mjs';

export function notificationQueueKey(event, text, parsed) {
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  const synthetic = parseSyntheticAgentMessage(text);
  if (synthetic?.name === 'agent' && String(synthetic.args?.type || '').toLowerCase() === 'result') {
    const taskId = String(synthetic.args?.task_id || '').trim();
    const executionId = String(meta.execution_id || '').trim();
    const tag = String(synthetic.args?.tag || '').trim();
    const resultId = taskId
      ? `task:${taskId}`
      : executionId
        ? `exec:${executionId}`
        : tag
          ? `tag:${tag}:${shortTextFingerprint(synthetic.result || text)}`
          : '';
    const agent = String(synthetic.args?.agent || '').trim();
    if (resultId || agent) return ['agent-result', resultId, agent].filter(Boolean).join(':');
  }
  const id = String(meta.execution_id || parsed?.taskId || '').trim();
  if (!id) return '';
  const type = String(meta.type || '').trim();
  const status = String(meta.status || parsed?.status || '').trim();
  const fallbackKind = String(text || '').split('\n', 1)[0]?.trim() || 'notification';
  // Distinguish a body-carrying completion from a header-only preview that
  // shares the same id/type/status. An early agent preview can arrive before
  // the session is persisted (no result body); the canonical notification that
  // follows DOES carry the body. Without this dimension the bodyless preview
  // would claim the dedupe key and suppress the real result. A blank-line gap
  // separates the task header block from the result body in the envelope.
  const hasBody = /\n\s*\n[\s\S]*\S/.test(String(text || '')) ? 'b1' : 'b0';
  return [id, type || fallbackKind, status, hasBody].filter(Boolean).join(':');
}

export function isExecutionNotification(event, text, parsed) {
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  if (meta.execution_id || meta.execution_surface) return true;
  if (parseAgentResultEnvelope(text)) return true;
  if (parseBackgroundTaskEnvelope(text)) return true;
  return Boolean(parsed?.taskId && /^(?:agent task:|task_id:)/mi.test(String(text || '')));
}

/** Pure delivery plan for runtime.onNotification execution envelopes (tests + handler). */
export function resolveTuiRuntimeNotificationDelivery(event, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { action: 'ignore' };
  const parsed = parseAgentJob(trimmed);
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  // UI-only notices (e.g. boot auto-update outcome): render as a transient
  // notice, never enqueue anything model-visible or transcript-persistent.
  if (meta.kind === 'update-notice') {
    // Wording lives here (the notice surface), not in the emitting runtime:
    // the emitter only supplies meta.version; the sentence is composed here.
    const ver = String(meta.version || '').trim();
    const displayText = ver ? `mixdog v${ver} ready — restart to apply.` : trimmed;
    return { action: 'notice', displayText, tone: meta.tone === 'warn' ? 'warn' : 'info', transcript: false };
  }
  if (!isExecutionNotification(event, trimmed, parsed)) {
    return { action: 'enqueue', displayText: trimmed, modelContent: trimmed };
  }
  if (isStatusOnlyAgentCompletionNotification(trimmed)) {
    return { action: 'status-only', displayText: trimmed, modelContent: '' };
  }
  const modelContent = modelVisibleToolCompletionMessage(trimmed, meta);
  return {
    action: 'execution-ui',
    displayText: trimmed,
    modelContent,
  };
}
