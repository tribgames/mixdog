// Anthropic model catalog + message conversion helpers, extracted from anthropic.mjs.
import { createRequire } from 'node:module';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import {
    ANTHROPIC_RETRY_BACKOFF_MS,
    ANTHROPIC_RETRY_JITTER_RATIO,
    AnthropicFallbackTriggeredError,
    anthropicMaxAttempts,
    anthropicRequestTimeoutMs,
    classifyError,
    midstreamBackoffFor,
    sleepWithAbort,
    withRetry,
    retryAfterMsFromError,
} from './retry-classifier.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import {
    ANTHROPIC_MAX_MIDSTREAM_RETRIES,
    parseSSEStream,
    _classifyMidstreamError,
} from './anthropic-sse.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import {
    applyAnthropicEffortToBody,
    effortValuesForModel,
    shouldIncludeEffortBeta,
} from './anthropic-effort.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { notifyCurrentAnthropicRateLimit } from './admission-scheduler.mjs';
import {
    ANTHROPIC_CACHE_TTL_STABLE as CACHE_TTL_STABLE,
    ANTHROPIC_CACHE_TTL_VOLATILE as CACHE_TTL_VOLATILE,
    applyAnthropicCacheMarkers,
    clampAnthropicThinkingBudget as clampThinkingBudgetTokens,
    deferredAnthropicTools as sharedDeferredAnthropicTools,
    requestAnthropicTools as sharedRequestAnthropicTools,
    normalizeAnthropicNonStreamingResponse,
    resolveAnthropicCacheTtls as resolveCacheTtls,
    sanitizeAnthropicInputSchema,
    toAnthropicMessages,
    toAnthropicToolChoice,
} from './lib/anthropic-request-utils.mjs';
// Message lowering lives in the shared request-utils lib (one implementation
// for both Anthropic providers); re-exported here for existing importers.
export { toAnthropicMessages };


export const require = createRequire(import.meta.url);
let _Anthropic = null;
export function loadAnthropic() {
    if (!_Anthropic) {
        const mod = require('@anthropic-ai/sdk');
        _Anthropic = mod.default || mod.Anthropic || mod;
    }
    return _Anthropic;
}

// Abort-aware mid-stream backoff sleep → shared sleepWithAbort
// (retry-classifier.mjs). abortMessage preserves the prior fallback text.
export function _midstreamSleepWithAbort(ms, signal) {
    return sleepWithAbort(ms, signal, undefined, 'Anthropic mid-stream retry backoff aborted');
}

// 4-BP cache policy aligned with anthropic-oauth — system + tier3 +
// messages-tail. Tool schemas sit before system and are covered by the system
// breakpoint, so they do not spend a separate cache_control slot. 1h TTL
// requires the extended-cache-ttl beta header, which we set on the client via
// defaultHeaders below.

// BP3 (tier3) rides its own `system` role block (the 3rd system block, tagged
// cacheTier:'tier3'). buildSystemBlocks applies the tier3 1h cache_control to
// that block; BP1/BP2 take the system TTL. Mirrors anthropic-oauth.mjs.

export function buildSystemBlocks(systemMsgs, systemTtl, tier3Ttl) {
    // systemMsgs is an array of { content, cacheTier }. Each non-empty element
    // becomes its own content block: cacheTier:'tier3' (BP3 core) gets
    // tier3Ttl, cacheTier:'env' (volatile session/project environment) is
    // NEVER marked — it rides the messages-tail breakpoint so an environment
    // change cannot invalidate the BP3 core write — and every other block
    // (BP1/BP2) gets systemTtl. A null TTL leaves the block uncached.
    const items = Array.isArray(systemMsgs)
        ? systemMsgs
            .map(m => ({
                text: typeof m?.content === 'string' ? m.content.trim() : '',
                tier: m?.cacheTier === 'tier3' ? 'tier3'
                    : m?.cacheTier === 'env' ? 'env'
                        : 'system',
            }))
            .filter(it => it.text)
        : [];
    // Anthropic caps cache_control breakpoints at 4 per request; defensively
    // cap it here too so an unexpectedly large systemMsgs array can never
    // mark more than 4 blocks (extras keep their text, just lose the
    // cache_control breakpoint, not the block itself). Mirrors
    // anthropic-oauth.mjs.
    const MAX_SYSTEM_BREAKPOINTS = 4;
    let bpCount = 0;
    return items.map((it, index) => {
        // Anthropic joins system text blocks with no separator; open every
        // block after the first with a paragraph break so headings never glue
        // onto the previous block's last line. Mirrors anthropic-oauth.mjs.
        const block = { type: 'text', text: index ? `\n\n${it.text}` : it.text };
        const ttl = it.tier === 'tier3' ? tier3Ttl : it.tier === 'env' ? null : systemTtl;
        if (ttl && bpCount < MAX_SYSTEM_BREAKPOINTS) {
            block.cache_control = ttl;
            bpCount++;
        }
        return block;
    });
}

export const MODELS = [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', family: 'sonnet', contextWindow: 1000000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', family: 'haiku', contextWindow: 200000 },
];
export const ANTHROPIC_VERSION = '2023-06-01';

export function _prettyName(id, family) {
    const v = String(id || '').match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    const base = family ? family[0].toUpperCase() + family.slice(1) : 'Claude';
    return v ? `${base} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : base;
}

export function _defaultContextForModel(id, family) {
    const text = String(id || '');
    const version = text.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    if (Number(version?.[1] || 0) >= 5) return 1000000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/i.test(text)) return 1000000;
    if (family && family !== 'other') return 200000;
    return 200000;
}

export function _capabilitySupported(capability) {
    return capability === true || capability?.supported === true;
}

export function _normalizeAnthropicModel(raw, provider = 'anthropic') {
    const id = raw?.id || raw?.name || raw?.model;
    if (!id) return null;
    const familyMatch = String(id).match(/^claude-([a-z]+)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    const dated = /-\d{8}$/.test(String(id));
    const versioned = !dated && /^claude-[a-z]+-\d+(?:-\d+)?$/i.test(String(id));
    const effortValues = effortValuesForModel(raw?.capabilities, id);
    return {
        id,
        display: raw?.display_name || raw?.displayName || raw?.display || _prettyName(id, family),
        family,
        provider,
        contextWindow: raw?.context_window || raw?.max_context_window || raw?.max_input_tokens || raw?.input_token_limit || raw?.inputTokenLimit || _defaultContextForModel(id, family),
        outputTokens: raw?.max_tokens || raw?.max_output_tokens || raw?.output_token_limit || raw?.outputTokenLimit || null,
        tier: dated ? 'dated' : versioned ? 'version' : 'family',
        latest: false,
        supportsReasoning: effortValues.length > 0 || _capabilitySupported(raw?.capabilities?.thinking),
        reasoningOptions: effortValues.length ? [{ type: 'effort', values: effortValues }] : [],
    };
}
// Family-based heuristic so new model ids (including custom user-configured
// ones) resolve a sensible max_tokens without requiring a code change.
// The API-key provider has no catalog cache of its own — it reads the same
// anthropic-oauth-models.json disk cache (read-only) that the OAuth provider
// maintains. Both providers hit the same Anthropic /v1/models catalog, so a
// per-model outputTokens entry is valid regardless of which auth path wrote
// it. If this provider is ever run standalone without the OAuth provider
// ever having populated the cache, loadSync() simply returns null and we
// fall through to the shared static heuristic in anthropic-max-tokens.mjs.
const ANTHROPIC_OAUTH_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const _sharedOAuthModelCache = makeModelCache({
    fileName: 'anthropic-oauth-models.json',
    ttlMs: ANTHROPIC_OAUTH_MODEL_CACHE_TTL_MS,
    version: 1,
});

// In-memory mirror populated by this provider's own listModels() fetch.
// API-key-only installs never have the OAuth provider write the shared disk
// cache, so without this mirror catalog outputTokens would stay invisible to
// resolveMaxTokens until an OAuth session runs. listModels() results flow in
// here (memory only — the disk cache stays OAuth-owned/read-only for us).
let _apiKeyCatalogMirror = null;
export function _setApiKeyCatalogMirror(value) { _apiKeyCatalogMirror = value; }

function _catalogOutputTokensFromSharedCache(model) {
    if (!model) return null;
    try {
        const models = Array.isArray(_apiKeyCatalogMirror)
            ? _apiKeyCatalogMirror
            : _sharedOAuthModelCache.loadSync();
        if (!Array.isArray(models)) return null;
        const entry = models.find(m => m?.id === model);
        const out = Number(entry?.outputTokens);
        return Number.isFinite(out) && out > 0 ? out : null;
    } catch {
        return null;
    }
}

export function resolveMaxTokens(model) {
    return resolveAnthropicMaxTokens(model, { catalogLookup: _catalogOutputTokensFromSharedCache });
}

// Test-only escape hatch for scripts/anthropic-maxtokens-test.mjs.
export const _test = {
    resolveMaxTokens,
    deferredAnthropicTools,
    requestAnthropicTools,
    sanitizeInputSchema: (schema, toolName) => sanitizeAnthropicInputSchema(schema, toolName, 'anthropic'),
};

// Anthropic forbids oneOf / allOf / anyOf at the TOP level of input_schema.
// Mirror the same sanitizer as anthropic-oauth.mjs so both providers are safe.
// Map the orchestrator-level opts.toolChoice into Anthropic's tool_choice.
// Only 'none' is activated: it lets the hard-cap final turn keep the tool
// DEFINITIONS in-request (so the tools->system->messages prefix — and its
// prompt-cache prefix — stay byte-identical to prior turns) while forbidding
// tool USE, so the model can only emit text. Forced values
// ('required'->{type:'any'}, {name}->{type:'tool'}) are deliberately NOT
// mapped: Anthropic returns a 400 for any forced tool_choice while
// extended/adaptive thinking is enabled, and the only caller that sets
// opts.toolChoice='required' (the forced-first-tool turn) runs with
// effort/thinking active on reasoning models — activating it would convert a
// previously-harmless no-op into a hard 400 on exactly that turn. Attached
// only when the request actually carries tools (see _doSend). Mirrors
// anthropic-oauth.mjs.
export function deferredAnthropicTools(activeTools, messages, opts) {
    return sharedDeferredAnthropicTools(activeTools, messages, opts, 'anthropic');
}
export function requestAnthropicTools(tools, messages, opts) {
    return sharedRequestAnthropicTools(tools, messages, opts, 'anthropic');
}
// Test-only: expose the lowering so the steering-provenance test can assert
// the API-key provider keeps steering-tagged user turns distinct (mirrors
// anthropic-oauth._buildRequestBodyForCacheSmoke coverage).
export function _toAnthropicMessagesForTest(messages, availableTools) {
    return toAnthropicMessages(messages, availableTools);
}

// Applies cache_control markers to the FINAL, already-sanitized Anthropic
// message array — by INVARIANT, never by pre-sanitize index. Because
// sanitizeAnthropicContentPairs has already run (and must NOT run again
// after this), the blocks we mark here are exactly the blocks the provider
// sees, so the cache breakpoint is stable across turns.
//   message-anchor: prefer a safe tool_result tail, then a previous real user
//                   text turn if another slot remains. Synthetic
//                   synthetic reminder messages and current pure-text prompts
//                   are excluded so per-call prompt content never becomes a
//                   1h prefix key.
// messageTtl === null disables the tail. BP3 (tier3) now rides a system block,
// so it is no longer marked here.
// ANTHROPIC_MSG_SLOTS=0 is honoured upstream by passing messageTtl = null.
