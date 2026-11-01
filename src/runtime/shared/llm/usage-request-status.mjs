/**
 * A request's one-word outcome in the request log. Precedence: failed >
 * substituted > retried > completed.
 */

// These providers echo the requested id instead of reporting the model that
// served, so a difference there would only be our own id mapping.
const NEVER_REPORTS_SERVED_MODEL = /^(?:gemini|vertex|antigravity)/;

/**
 * The model id with only what provably names the same model removed: a
 * `vendor/` route prefix (OpenRouter and gateways report `openai/gpt-5`), a
 * `[…]` context-window tag (`[1m]`), a release-date snapshot and `-latest`.
 * Anthropic reports the dated snapshot it served (`message_start.message.model`,
 * anthropic-request-utils.mjs normalizeAnthropicNonStreamingResponse and the
 * SSE turn), OpenAI and compatible providers the dated id in the response
 * `model` (openai-compat-chat-stream/chunk-events.mjs). Dots, other digits
 * and provider tags such as `:free` are kept: `gpt-5.1` is not `gpt-5-1`.
 */
export function normalizeServedModelId(model) {
  let id = String(model || '').trim();
  id = id.replace(/\[[^\]]*\]$/, '');
  id = id.slice(id.lastIndexOf('/') + 1);
  let previous;
  do {
    previous = id;
    id = id.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8}|-latest)$/, '');
  } while (id !== previous);
  return id;
}

/** Whether the model that answered is not the model asked for. */
export function servedModelSubstituted({ provider, requestedModel, servedModel, fallback = false }) {
  if (NEVER_REPORTS_SERVED_MODEL.test(String(provider || ''))) return false;
  if (fallback) return true;
  if (!requestedModel || !servedModel) return false;
  const requested = normalizeServedModelId(requestedModel);
  const served = normalizeServedModelId(servedModel);
  // A router alias names no model: whatever it picks is what was asked for.
  if (requested === 'auto' || served === requested) return false;
  return true;
}

export function usageRequestStatus({ failed = false, substituted = false, attempts = 1 }) {
  if (failed) return 'failed';
  if (substituted) return 'substituted';
  return attempts > 1 ? 'retried' : 'completed';
}
