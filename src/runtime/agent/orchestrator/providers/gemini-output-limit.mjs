/**
 * gemini-output-limit.mjs — the `generationConfig.maxOutputTokens` a Gemini
 * request carries, shared by the API-key and Antigravity builders.
 *
 * Thought tokens count against this cap, so a request that names none leaves
 * the server on a small default and long answers (or long thinking) are cut
 * off mid-turn. A request therefore carries the model's declared output limit
 * when one is known; an explicit caller value wins but never passes a known
 * ceiling. With no known ceiling nothing is imposed: no guessed value is sent
 * (an oversized one is refused by models with a smaller limit).
 */
import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * The per-model ceiling: the declared catalog limit (`outputLimit` from a
 * provider roster first, then the shared catalog), clamped to `gatewayLimit` —
 * the limit a relay gateway declared for the model — when both exist; else
 * whichever is known, else null (nothing known, nothing imposed).
 */
function geminiOutputCeiling(model, outputLimit = null, gatewayLimit = null) {
  const id = String(model || '').replace(/^models\//, '');
  const declared = positiveInt(outputLimit) ?? positiveInt(getModelMetadataSync(id, 'gemini')?.outputTokens);
  const gateway = positiveInt(gatewayLimit);
  if (declared == null) return gateway;
  return gateway == null ? declared : Math.min(declared, gateway);
}

/**
 * maxOutputTokens for one request: the explicit `opts` value (validated, then
 * clamped to the ceiling) or the ceiling itself; undefined when neither exists.
 */
export function geminiMaxOutputTokens(model, opts, outputLimit = null, gatewayLimit = null) {
  const ceiling = geminiOutputCeiling(model, outputLimit, gatewayLimit);
  const requested = opts?.maxOutputTokens ?? opts?.max_output_tokens;
  if (requested === undefined || requested === null) return ceiling ?? undefined;
  const max = Number(requested);
  if (!Number.isInteger(max) || max <= 0) {
    throw new TypeError('maxOutputTokens must be a positive integer (it includes thinking tokens).');
  }
  return ceiling == null ? max : Math.min(max, ceiling);
}
