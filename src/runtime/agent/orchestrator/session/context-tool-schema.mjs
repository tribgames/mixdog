// Tool/function schema fingerprint and token cost: the request-side half of the
// context estimate (schemas travel beside `messages`, not inside them).
import { createHash } from 'node:crypto';
import { estimateTokens } from './token-estimate.mjs';
import {
  isFinalizedProviderRequestTools,
  providerNativeToolPrefixCount,
} from '../runtime-core/provider-request-tools.mjs';

const toolSchemaAnalysisMemo = new WeakMap();
// Token cost by schema signature. Every new session builds its own tools array
// with the same schemas; re-estimating the whole serialization (tens of ms,
// synchronous) per first turn blocked the event loop during session creation.
// The signature hashes the full serialization, deferred flags included, so it
// determines the metered text exactly.
const toolSchemaTokensBySignature = new Map();
const TOOL_SCHEMA_TOKENS_LIMIT = 32;

function isDeferredToolSchema(tool) {
  return tool?.deferLoading === true || tool?.defer_loading === true;
}

function serializeToolSchemas(tools, { excludeDeferred = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const nativePrefixCount = providerNativeToolPrefixCount(list);
  try {
    const wire = [];
    list.forEach((tool, index) => {
      const deferred = isDeferredToolSchema(tool);
      if (excludeDeferred && deferred) return;
      if (index < nativePrefixCount) {
        wire.push(tool);
        return;
      }
      const wireTool = {
        name: tool?.name,
        description: tool?.description,
        input_schema: tool?.inputSchema ?? tool?.input_schema ?? tool?.parameters ?? tool?.schema,
      };
      if (deferred) wireTool.defer_loading = true;
      wire.push(wireTool);
    });
    return JSON.stringify(wire);
  } catch {
    return list
      .filter((tool) => !(excludeDeferred && isDeferredToolSchema(tool)))
      .map((t) => String(t?.name ?? ''))
      .join('');
  }
}

export function toolSchemaSignature(tools) {
  return analyzeToolSchemas(tools).signature;
}

function analyzeToolSchemas(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const cached = Array.isArray(tools) ? toolSchemaAnalysisMemo.get(tools) : null;
  if (cached && isFinalizedProviderRequestTools(tools)) return cached;
  const text = serializeToolSchemas(list);
  const signature = createHash('sha256').update(text).digest('hex');
  if (cached && cached.signature === signature) return cached;
  // defer_loading schemas ride the wire but the API excludes them from
  // context-token calculation and prompt-cache keys, so metering them at
  // full weight inflated the request reserve. The SIGNATURE keeps hashing
  // the full serialization (a deferred tool joining/leaving must still
  // re-fingerprint the surface); only the token cost drops deferred entries.
  let tokens = toolSchemaTokensBySignature.get(signature);
  if (tokens === undefined) {
    const meterText = list.some(isDeferredToolSchema) ? serializeToolSchemas(list, { excludeDeferred: true }) : text;
    tokens = estimateTokens(meterText);
    if (toolSchemaTokensBySignature.size >= TOOL_SCHEMA_TOKENS_LIMIT) {
      toolSchemaTokensBySignature.delete(toolSchemaTokensBySignature.keys().next().value);
    }
    toolSchemaTokensBySignature.set(signature, tokens);
  }
  const analysis = { signature, tokens };
  if (Array.isArray(tools)) toolSchemaAnalysisMemo.set(tools, analysis);
  return analysis;
}

/**
 * Estimate the token cost of the tool/function schemas a provider appends to
 * the request body. These are NOT part of `messages` (they're a separate
 * argument to provider.send), so estimateMessagesTokens() ignores them
 * entirely — a transcript that "fits" by message tokens can still overflow
 * once N tool schemas are serialized into the same request. Best-effort
 * chars/4 over the JSON-serialized definitions.
 */
export function estimateToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return analyzeToolSchemas(tools).tokens;
}

/**
 * Total request-side bytes the caller should reserve out of the context window
 * before compaction. Only serialized tool schemas are counted; providers do
 * not expose a stable framing cost, so no synthetic fixed allowance is added.
 */
export function estimateRequestReserveTokens(tools) {
  return estimateToolSchemaTokens(tools);
}
