/**
 * anthropic-max-tokens-recovery.mjs — the two max_tokens adjustments the
 * reference client makes (withRetry.ts / claude.ts):
 *
 *  - a 400 "input length and `max_tokens` exceed context limit: A + B > C" is
 *    answered by shrinking max_tokens to what the context still has room for
 *    (1000-token safety buffer, 3000-token floor, thinking budget + 1 minimum)
 *    and replaying; with less than the floor available the error surfaces.
 *  - the non-streaming replay caps max_tokens at 64000 (the API's long-request
 *    boundary) and keeps thinking.budget_tokens below it.
 */

export const FLOOR_OUTPUT_TOKENS = 3000;
export const CONTEXT_SAFETY_BUFFER_TOKENS = 1000;
export const MAX_NON_STREAMING_TOKENS = 64_000;

const OVERFLOW_RE = /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/;

/** `{ inputTokens, maxTokens, contextLimit }` for the exact 400, else null. */
export function parseMaxTokensContextOverflow(status, message) {
  if (Number(status) !== 400) return null;
  const match = OVERFLOW_RE.exec(String(message || ''));
  if (!match) return null;
  const [inputTokens, maxTokens, contextLimit] = match.slice(1).map((value) => Number.parseInt(value, 10));
  return [inputTokens, maxTokens, contextLimit].every(Number.isFinite)
    ? { inputTokens, maxTokens, contextLimit }
    : null;
}

const thinkingBudget = (body) =>
  body?.thinking?.type === 'enabled' && Number(body.thinking.budget_tokens) > 0
    ? Number(body.thinking.budget_tokens)
    : 0;

/**
 * Shrink `body.max_tokens` to fit the reported context. Returns true when the
 * body was adjusted and is worth replaying.
 */
export function adjustMaxTokensForContextOverflow(body, status, message) {
  const overflow = parseMaxTokensContextOverflow(status, message);
  if (!overflow || !body) return false;
  const available = Math.max(0, overflow.contextLimit - overflow.inputTokens - CONTEXT_SAFETY_BUFFER_TOKENS);
  if (available < FLOOR_OUTPUT_TOKENS) return false;
  body.max_tokens = Math.max(FLOOR_OUTPUT_TOKENS, available, thinkingBudget(body) + 1);
  return true;
}

/** Cap a non-streaming body in place (max_tokens and the thinking budget). */
export function capForNonStreaming(body) {
  if (!body || !(Number(body.max_tokens) > MAX_NON_STREAMING_TOKENS)) return body;
  body.max_tokens = MAX_NON_STREAMING_TOKENS;
  if (thinkingBudget(body)) {
    body.thinking = {
      ...body.thinking,
      budget_tokens: Math.min(body.thinking.budget_tokens, MAX_NON_STREAMING_TOKENS - 1),
    };
  }
  return body;
}
