/**
 * OpenAI ChatGPT OAuth subscription provider.
 *
 * Dispatches over the WebSocket upgrade of chatgpt.com/backend-api/codex/
 * responses (responses_websockets=2026-02-06 beta). Authenticates via PKCE
 * OAuth using Mixdog-owned token storage. Streaming/framing lives in
 * openai-oauth-ws.mjs; this file owns auth, model catalog, request-body
 * shape, and HTTP/SSE fallback when WebSocket transport is unhealthy.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { makeModelCache } from './model-cache.mjs';

import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import {
    buildStableProviderPromptCacheKey,
    resolveProviderPromptCacheLane,
    resolveProviderCacheKey,
} from '../agent-runtime/cache-strategy.mjs';
import {
    appendAgentTrace,
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
} from '../agent-trace.mjs';
import {
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    streamStalledError,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { populateHttpStatusFromMessage, shouldFallbackTransport } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import {
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';
import {
    customToolCallFromResponseItem,
    customToolInputFromArguments,
    isCustomToolCallRecord,
    isResponsesFreeformTool,
    toResponsesCustomTool,
} from './custom-tool-wire.mjs';
import {
    sendViaHttpSse,
    _envFlag,
    _envPositiveInt,
    _shouldUseOpenAIHttpFallback,
} from './openai-oauth-http-sse.mjs';
import { createOpenAIOAuthLogin } from './openai-oauth-login.mjs';
import {
    _displayCodexModel,
    _codexFamily,
    _normalizeCodexModel,
    _compareVersion,
    _isMainCodexFamily,
    _markLatestCodex,
} from './openai-codex-model.mjs';
export { _displayCodexModel };

// Legacy import path for scripts/tool-smoke.mjs (single-emit SSE smoke).
export { sendViaHttpSse };
// --- Constants ---
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Exported for openai-oauth-http-sse.mjs (fallback transport headers/URL).
export const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// Version string baked into the models endpoint query — the OAuth backend
// rejects the request without it, and gates new model exposures (e.g.
// gpt-5.5 only on >= 0.130.0) on this client_version header; older versions
// trigger a visibility-filtered catalog (e.g. only rollout models). Resolved
// dynamically from npm so newly-shipped models surface within a day instead
// of waiting on a hardcoded bump here. Cached 24h in-process; npm failure
// falls back to the floor below.
// Offline fallback only — _resolveCodexClientVersion() fetches the live
// @openai/codex latest from npm first. Bumped to the current release
// (0.142.5, verified 2026-07-03) so the offline path stays close to what the
// backend expects for client-version gating.
const CODEX_CLIENT_VERSION_FLOOR = '0.142.5';
const CODEX_VERSION_CACHE_TTL_MS = 24 * 60 * 60_000;
let _codexVersionCache = { value: null, fetchedAt: 0 };

async function _resolveCodexClientVersion() {
    const now = Date.now();
    if (_codexVersionCache.value && now - _codexVersionCache.fetchedAt < CODEX_VERSION_CACHE_TTL_MS) {
        return _codexVersionCache.value;
    }
    try {
        const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
            signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
            const j = await res.json();
            const v = String(j?.version || '').trim();
            if (/^\d+\.\d+\.\d+/.test(v)) {
                _codexVersionCache = { value: v, fetchedAt: now };
                return v;
            }
        }
    } catch { /* network down / npm rejects — use floor */ }
    _codexVersionCache = { value: CODEX_CLIENT_VERSION_FLOOR, fetchedAt: now };
    return CODEX_CLIENT_VERSION_FLOOR;
}
const CODEX_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const CODEX_MODEL_CACHE_SCHEMA_VERSION = 3;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

const _codexModelCache = makeModelCache({
    fileName: 'openai-oauth-models.json',
    ttlMs: CODEX_MODEL_CACHE_TTL_MS,
    version: CODEX_MODEL_CACHE_SCHEMA_VERSION,
    onSave: (m) => { _inMemoryCodexCatalog = Array.isArray(m) ? m.slice() : null; },
});

function _loadCodexModelCacheSync() {
    return _codexModelCache.loadSync();
}

async function _loadCodexModelCache() {
    return _codexModelCache.loadSync();
}

async function _saveCodexModelCache(models) {
    _codexModelCache.save(models);
}

// In-memory mirror of the on-disk catalog, same pattern as anthropic-oauth.
// Populated on first listModels() and after every _saveCodexModelCache.
let _inMemoryCodexCatalog = null;
let _codexRefreshInFlight = null;
let _oauthRefreshInFlight = null;
let _lastCodexListModelsError = '';

function _codexCatalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCodexCatalog)) return false;
    return _inMemoryCodexCatalog.some(m => m.id === id);
}

function _findCachedCodexModel(id) {
    if (!id) return null;
    if (!Array.isArray(_inMemoryCodexCatalog)) {
        _inMemoryCodexCatalog = _loadCodexModelCacheSync();
    }
    if (!Array.isArray(_inMemoryCodexCatalog)) return null;
    return _inMemoryCodexCatalog.find(m => m?.id === id) || null;
}

function _codexServiceTiers(modelInfo) {
    return Array.isArray(modelInfo?.serviceTiers) ? modelInfo.serviceTiers : [];
}

function _codexModelBlocksServiceTier(id, serviceTier) {
    if (serviceTier !== 'priority') return false;
    const family = _codexFamily(id);
    return family === 'gpt-mini' || family === 'gpt-nano' || family === 'gpt-codex';
}

export function codexModelSupportsServiceTier(id, serviceTier) {
    if (_codexModelBlocksServiceTier(id, serviceTier)) return false;
    const info = _findCachedCodexModel(id);
    if (!info) return true;
    const tiers = _codexServiceTiers(info);
    if (!tiers.length) return false;
    return tiers.some(t => t?.id === serviceTier);
}

// Newest MAIN gpt-5 chat model by version, read from the SYNC in-memory
// catalog mirror. Returns null until populated; callers warm via
// ensureLatestCodexModel when null.
export function resolveLatestCodexModel() {
    if (!Array.isArray(_inMemoryCodexCatalog)) return null;
    let best = null;
    for (const m of _inMemoryCodexCatalog) {
        if (!m?.id || !_isMainCodexFamily(m.family)) continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    return best?.id || null;
}

export async function ensureLatestCodexModel(provider) {
    let m = resolveLatestCodexModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestCodexModel();
    if (m) return m;
    throw new Error('[openai-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'openai-oauth.json');
}

// Public predicate used by config.buildDefaultConfig — provider is enabled
// when own Mixdog tokens exist. Single truth:
// same loader the runtime uses (loadTokens), no parallel hard-coded path probe.
export function hasOpenAIOAuthCredentials() {
    try {
        const tokens = loadTokens();
        return !!(tokens?.access_token && tokens?.refresh_token);
    } catch { return false; }
}

export function describeOpenAIOAuthCredentials() {
    try {
        const tokens = loadTokens();
        if (!tokens?.access_token) {
            return { authenticated: false, status: 'Not Set', detail: 'Mixdog token store' };
        }
        const hasRefresh = Boolean(tokens.refresh_token);
        const expiresAt = _normalizeExpiresAt(tokens.expires_at ?? tokens.expiresAt);
        const expiring = expiresAt > 0 && expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
        const expired = expiresAt > 0 && expiresAt <= Date.now();
        const source = tokens.source || 'oauth';
        if (!hasRefresh) {
            return {
                authenticated: expiresAt === 0 || !expired,
                status: expired ? 'Reauth Required' : 'Access Only',
                detail: `${source}; no refresh token`,
                expiresAt,
            };
        }
        if (expired) return { authenticated: true, status: 'Refresh Required', detail: source, expiresAt };
        if (expiring) return { authenticated: true, status: 'Refresh Soon', detail: source, expiresAt };
        return { authenticated: true, status: 'Valid', detail: source, expiresAt };
    } catch (err) {
        return { authenticated: false, status: 'Error', detail: String(err?.message || err).slice(0, 200) };
    }
}
function _normalizeExpiresAt(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}
function _tokensMaxMtime() {
    let max = 0;
    const paths = [getOwnTokenPath()];
    for (const p of paths) {
        try {
            const s = statSync(p);
            if (s.mtimeMs > max) max = s.mtimeMs;
        } catch { /* not present — skip */ }
    }
    return max;
}
function _loadOwnCodexTokens() {
    const ownPath = getOwnTokenPath();
    if (!existsSync(ownPath)) return null;
    try {
        const stat = statSync(ownPath);
        const own = JSON.parse(readFileSync(ownPath, 'utf-8'));
        if (own.access_token && own.refresh_token) {
            return {
                ...own,
                expires_at: _normalizeExpiresAt(own.expires_at ?? own.expiresAt) || _expiryFromAccessToken(own.access_token),
                account_id: own.account_id || extractAccountId(own.access_token),
                source: 'Mixdog token store',
                _mtimeMs: stat.mtimeMs,
            };
        }
    }
    catch { /* fall through */ }
    return null;
}
function loadTokens() {
    return _loadOwnCodexTokens();
}
function saveTokens(tokens) {
    const target = getOwnTokenPath();
    writeJsonAtomicSync(target, tokens, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

export function forgetOpenAIOAuthCredentials() {
    let removed = false;
    const ownPath = getOwnTokenPath();
    if (existsSync(ownPath)) {
        unlinkSync(ownPath);
        removed = true;
    }
    return { removed };
}
function extractAccountId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    }
    catch {
        return undefined;
    }
}
// Derive token expiry from the access_token's JWT `exp` claim (epoch ms), as a
// fallback when the Mixdog token store carries no explicit expires_at. Returns
// 0 for opaque (non-JWT) tokens. JWT `exp` is epoch SECONDS (RFC 7519).
function _expiryFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const exp = Number(payload?.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    }
    catch { return 0; }
}
// --- Token refresh ---
async function refreshTokens(refreshToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
            // Never follow a redirect on a secret-bearing request: a token
            // endpoint that 307/308-redirects would replay the refresh_token to
            // the redirect target. Fail loud instead.
            redirect: 'error',
            signal: controller.signal,
            dispatcher: getLlmDispatcher(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            // Distinguish a terminally-dead refresh token (consumed by the official
            // CLI's single-use lineage) from transient failures, so the caller can
            // re-read disk and retry once with a newer token instead of
            // collapsing every failure to a generic null.
            if (res.status === 400 || res.status === 401 || /invalid_grant|revoked|reused/i.test(text)) {
                throw Object.assign(new Error(`OpenAI OAuth token refresh ${res.status} (invalid_grant)`), { isInvalidGrant: true });
            }
            return null;
        }
        const json = await res.json();
        if (!json.access_token) return null;
        const expiresAt = _normalizeExpiresAt(json.expires_at ?? json.expiresAt)
            || (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0);
        const tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token || refreshToken,
            expires_at: expiresAt,
            account_id: extractAccountId(json.access_token),
        };
        saveTokens(tokens);
        return tokens;
    } catch (err) {
        if (err?.name === 'AbortError')
            throw new Error('OpenAI OAuth token refresh timed out after 30000ms');
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
// --- Build Responses API request ---
function _cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function _contentTextParts(content, type = 'input_text') {
    if (typeof content === 'string') return content ? [{ type, text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : JSON.stringify(content);
        return text ? [{ type, text }] : [];
    }
    const out = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') {
            out.push({ type: item.type === 'output_text' ? 'output_text' : type, text: item.text });
        } else if (typeof item.content === 'string') {
            out.push({ type, text: item.content });
        }
    }
    return out;
}

/**
 * Convert a message slice to Responses API input items.
 */
function convertMessagesToResponsesInput(messages, opts = {}) {
    const out = [];
    const pendingToolMedia = [];
    const customToolCallNameById = new Map();
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        out.push({ role: 'user', content: pendingToolMedia.splice(0) });
    };
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        if (m.role === 'tool') {
            if (Array.isArray(m.nativeToolSearch?.openaiTools)) {
                out.push({
                    type: 'tool_search_output',
                    call_id: m.toolCallId || '',
                    status: 'completed',
                    execution: 'client',
                    tools: m.nativeToolSearch.openaiTools,
                });
                continue;
            }
            const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
            if (customToolCallNameById.has(m.toolCallId || '')) {
                out.push({
                    type: 'custom_tool_call_output',
                    call_id: m.toolCallId || '',
                    name: customToolCallNameById.get(m.toolCallId || '') || undefined,
                    output,
                });
                if (mediaContent) pendingToolMedia.push(...mediaContent);
                continue;
            }
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output,
            });
            if (mediaContent) pendingToolMedia.push(...mediaContent);
            continue;
        }
        flushToolMedia();
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            // Reasoning replay deliberately omitted: openai-oauth rejects an
            // `rs_*` reasoning item with the same id across the same
            // handshake session_id (in-memory conversation state lives
            // for the WS_IDLE_MS window even after a socket close).
            // Server-side state already preserves the prefix; sending
            // reasoning in `input` triggers "Duplicate item".
            if (m.content) out.push({ role: 'assistant', content: normalizeContentForOpenAIResponses(m.content, { role: 'assistant' }) });
            for (const tc of m.toolCalls) {
                if (tc.nativeType === 'tool_search_call' || tc.name === 'load_tool' || tc.name === 'tool_search') {
                    out.push({
                        type: 'tool_search_call',
                        call_id: tc.id,
                        execution: 'client',
                        arguments: tc.arguments || {},
                    });
                } else if (isCustomToolCallRecord(tc)) {
                    if (tc.id) customToolCallNameById.set(tc.id, tc.name || '');
                    out.push({
                        type: 'custom_tool_call',
                        call_id: tc.id,
                        name: tc.name,
                        input: customToolInputFromArguments(tc.name, tc.arguments),
                    });
                } else {
                    out.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    });
                }
            }
            continue;
        }
        out.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: normalizeContentForOpenAIResponses(m.content, { role: m.role }),
        });
    }
    flushToolMedia();
    return out;
}

function toOpenAIResponsesTool(t) {
    if (t?.name === 'load_tool' || t?.name === 'tool_search') {
        return {
            type: 'tool_search',
            execution: 'client',
            description: t.description,
            parameters: t.inputSchema,
        };
    }
    if (isResponsesFreeformTool(t)) return toResponsesCustomTool(t);
    return {
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
    };
}

// codex build_reasoning() (core/src/client.rs:785-805) only attaches the
// reasoning object when model_info.supports_reasoning_summaries; models
// without summary support get NO reasoning field at all. Mirror that via the
// cached codex catalog; unknown models default to true (gpt-5 family all
// support summaries) so a cold catalog cannot strip reasoning from the wire.
function _codexModelSupportsReasoningSummaries(id) {
    const info = _findCachedCodexModel(id);
    if (!info) return true;
    const flags = [info.supportsReasoningSummaries, info.supports_reasoning_summaries, info.supportsReasoning, info.supports_reasoning];
    for (const flag of flags) {
        if (typeof flag === 'boolean') return flag;
    }
    return true;
}

// codex reasoning_effort_for_request (core/src/client.rs): `ultra` collapses to
// `max` on the wire — the openai-oauth backend does not accept `ultra`. Every
// other effort passes through unchanged; empty/unknown falls back to medium.
function _normalizeReasoningEffort(effort) {
    const e = String(effort || '').trim().toLowerCase();
    if (!e) return 'medium';
    if (e === 'ultra') return 'max';
    return e;
}

export function buildRequestBody(messages, model, tools, sendOpts) {
    // codex reasoning_effort_for_request: `ultra` collapses to `max` on the
    // wire (the only remap; every other effort passes through). Default medium.
    // Kept inline (not a module const) so buildRequestBody stays self-contained.
    // Extract system/instructions
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const opts = sendOpts || {};
    const input = convertMessagesToResponsesInput(messages, {
        providerState: opts.providerState,
        model,
    });
    // Match the request body shape the OAuth backend expects so the
    // server-side auto-cache routes correctly. text.verbosity / include /
    // tool_choice / parallel_tool_calls are all inert without side effects
    // for most callers but their presence affects how the OAuth backend classifies the
    // request (and therefore whether the prompt cache is consulted).
    const include = ['reasoning.encrypted_content'];
    for (const item of Array.isArray(opts.nativeInclude) ? opts.nativeInclude : []) {
        const value = String(item || '').trim();
        if (value && !include.includes(value)) include.push(value);
    }
    // Field order MIRRORS codex-rs ResponsesApiRequest (common.rs struct order):
    // model, instructions, input, tools, tool_choice, parallel_tool_calls,
    // reasoning, store, stream, include, service_tier, prompt_cache_key, text.
    // JSON serialization order is load-bearing for the server prompt cache
    // (exact-prefix match): matching codex's byte layout keeps our requests on
    // the same cache-routing shape codex warms. tools/service_tier/
    // prompt_cache_key are appended below in the same relative order.
    const body = {
        model,
        instructions,
        input,
        tool_choice: opts.toolChoice || 'auto',
        parallel_tool_calls: true,
        // codex build_reasoning() sends { effort, summary } — summary defaults to
        // ReasoningSummary::Auto (protocol config_types.rs), serialized lowercase
        // as "auto". Matching this keeps our reasoning object byte-identical to
        // codex so the server prompt-cache prefix hash lines up. codex also
        // normalizes `ultra` -> `max` on the wire (reasoning_effort_for_request
        // in core/src/client.rs); the openai-oauth backend does not accept
        // `ultra` as a wire value, so mirror that mapping here.
        // WIRE-VERIFIED (codex desktop logs_2.sqlite, 40 response.create
        // captures, 2026-07-03): codex sends reasoning as {"effort":"..."}
        // with NO summary field on gpt-5.5, regardless of what the repo's
        // build_reasoning() suggests. Match the observed bytes.
        reasoning: { effort: _normalizeReasoningEffort(opts.effort) },
        store: process.env.MIXDOG_OAI_STORE === 'true' ? true : false,
        stream: true,
        include,
    };
    const maxOutputTokens = Number(opts.maxOutputTokens ?? opts.outputTokens ?? opts.max_output_tokens);
    if (_envFlag('MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS', false)
        && Number.isFinite(maxOutputTokens)
        && maxOutputTokens > 0) {
        body.max_output_tokens = Math.floor(maxOutputTokens);
    }
    if (opts.fast === true) {
        // 'priority' is the only fast-class value the OpenAI OAuth backend
        // accepts on the wire: 'fast' is hard-rejected ("Unsupported
        // service_tier: fast", probed 2026-06-11). Only send the request value
        // when the model catalog advertises it.
        if (codexModelSupportsServiceTier(model, 'priority')) {
            body.service_tier = 'priority';
        }
    }
    // Add tools. `nativeTools` are server-hosted Responses tools (for
    // example web_search) and must be passed through without wrapping them as
    // function tools. codex places `tools` right after `input` (before
    // tool_choice); we insert it there via a rebuilt object so serialization
    // order matches, rather than appending it last.
    const functionTools = tools?.length ? tools.map(toOpenAIResponsesTool) : [];
    const nativeTools = Array.isArray(opts.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
    const toolsList = (functionTools.length || nativeTools.length)
        ? [...nativeTools, ...functionTools]
        : null;
    const promptCacheProvider = opts.promptCacheProvider || 'openai-oauth';
    const promptCacheLane = opts.promptCacheLane || resolveProviderPromptCacheLane(promptCacheProvider, opts);
    const promptCacheKey = buildStableProviderPromptCacheKey(promptCacheProvider, opts, {
        model,
        instructions,
        tools: toolsList || [],
        effort: body.reasoning?.effort,
        fast: opts.fast === true,
        serviceTier: body.service_tier || '',
        toolChoice: body.tool_choice,
        parallelToolCalls: body.parallel_tool_calls,
        cacheLaneSlot: promptCacheLane.slot,
        cacheLaneShards: promptCacheLane.shards,
    });
    // WIRE-VERIFIED (codex desktop logs, 2026-07-03): every live gpt-5.5
    // response.create carries text:{"verbosity":"low"} (or a schema variant);
    // none omit the field. Default to codex's observed "low", allow override.
    const verbosity = (typeof opts.verbosity === 'string' && opts.verbosity.trim()
        ? opts.verbosity.trim().toLowerCase()
        : null) || 'low';
    // Rebuild the body in codex struct order so JSON serialization is
    // byte-compatible with codex: ... input, tools, tool_choice,
    // parallel_tool_calls, reasoning, store, stream, include, service_tier,
    // prompt_cache_key, text. service_tier is only present when fast set it.
    const ordered = {
        model: body.model,
        instructions: body.instructions,
        input: body.input,
        ...(toolsList ? { tools: toolsList } : {}),
        tool_choice: body.tool_choice,
        parallel_tool_calls: body.parallel_tool_calls,
        reasoning: body.reasoning,
        store: body.store,
        stream: body.stream,
        include: body.include,
        ...(body.service_tier ? { service_tier: body.service_tier } : {}),
        prompt_cache_key: promptCacheKey,
        text: { verbosity },
        ...(body.max_output_tokens ? { max_output_tokens: body.max_output_tokens } : {}),
    };
    // NOTE: prompt_cache_retention is a public OpenAI Responses API parameter,
    // but the openai-oauth endpoint still rejects it ("Unsupported parameter:
    // prompt_cache_retention", re-probed 2026-06-22). Leave retention on the
    // openai-oauth server default; public OpenAI direct injects 24h separately.
    return ordered;
}

// --- HTTP/SSE fallback transport: extracted to openai-oauth-http-sse.mjs ---

// --- Provider ---
export class OpenAIOAuthProvider {
    // OpenAI input_tokens already INCLUDES cached_tokens (cached is a subset),
    // so input alone is the context footprint. See registry.mjs.
    static inputExcludesCache = false;
    name = 'openai-oauth';
    tokens = null;
    _refreshFallbackUntil = 0;
    _forceHttpFallback = false;
    _forceHttpFallbackUntil = 0;
    config;
    constructor(config) {
        this.config = config || {};
        this.tokens = loadTokens();
        // Warm a kept-alive socket to the OAuth responses API so the first
        // request skips the cold TLS handshake. Best-effort; never throws.
        preconnect('https://chatgpt.com');
    }
    getCachedModelInfo(model) {
        return _findCachedCodexModel(model);
    }
    async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
        if (!this.tokens) this.tokens = loadTokens();
        if (!this.tokens)
            throw new Error('OpenAI OAuth not authenticated. Open /providers in mixdog to sign in.');
        // Pick up Mixdog-owned token updates the moment the auth file is
        // rewritten — without this, a fresh login is ignored until the in-memory
        // token hits its expiry skew.
        const diskMtime = _tokensMaxMtime();
        // Watermark guards termination: if the rewritten file is temporarily
        // unreadable/partial, record the scanned mtime so this check can't
        // re-fire on every ensureAuth().
        if (diskMtime > 0 && diskMtime > (this._lastDiskScan || 0) && diskMtime > (this.tokens._mtimeMs || 0)) {
            const fresh = loadTokens();
            if (fresh?.access_token) {
                this.tokens = fresh;
                this._refreshFallbackUntil = 0;
                process.stderr.write(`[openai-oauth] Reloaded tokens from disk (mtime change)\n`);
            }
            this._lastDiskScan = diskMtime;
        }
        if (!forceRefresh && this._refreshFallbackUntil > Date.now() && this.tokens?.access_token) {
            return this.tokens;
        }
        const expiring = this.tokens.expires_at
            ? this.tokens.expires_at < Date.now() + TOKEN_REFRESH_SKEW_MS
            : false;
        if (forceRefresh || expiring) {
            this._refreshFallbackUntil = 0;
            this.tokens = await this._refreshTokens({ force: forceRefresh, reason });
        }
        return this.tokens;
    }

    async _refreshTokens({ force = false, reason = 'preemptive' } = {}) {
        const currentToken = this.tokens?.access_token || null;
        const disk = loadTokens();
        const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
        if (disk?.access_token && disk.access_token !== currentToken
            && (!disk.expires_at || disk.expires_at >= validAfter)) {
            this.tokens = disk;
            process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
            return disk;
        }
        if (!this.tokens && disk) this.tokens = disk;

        if (_oauthRefreshInFlight) {
            const shared = await _oauthRefreshInFlight;
            this.tokens = shared;
            if (!force || shared?.access_token !== currentToken) return this.tokens;
        }

        const startingTokens = this.tokens || disk;
        _oauthRefreshInFlight = (async () => {
            const latest = loadTokens() || startingTokens;
            const latestValidAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
            if (latest?.access_token && latest.access_token !== currentToken
                && (!latest.expires_at || latest.expires_at >= latestValidAfter)) {
                process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
                return latest;
            }

            if (!latest?.refresh_token) {
                if (!force && latest?.access_token && (!latest.expires_at || latest.expires_at > Date.now())) {
                    process.stderr.write(`[openai-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`);
                    this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
                    return latest;
                }
                throw new Error('OpenAI OAuth refresh token not available. Open /providers in mixdog to sign in again.');
            }

            try {
                const _refreshT0 = Date.now();
                const _expiringInMs = (latest?.expires_at ?? 0) - Date.now();
                if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] auth-refresh-needed expiringInMs=${_expiringInMs}\n`); }
                process.stderr.write(`[openai-oauth] Token ${reason}, refreshing...\n`);
                const refreshed = await refreshTokens(latest.refresh_token);
                if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] auth-refresh-done elapsed=${Date.now() - _refreshT0}ms ok=${!!refreshed}\n`); }
                if (!refreshed) throw new Error('refresh returned null');
                process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round(((refreshed.expires_at || Date.now()) - Date.now()) / 1000)}s\n`);
                return refreshed;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!force && latest?.access_token && (!latest.expires_at || latest.expires_at > Date.now())) {
                    this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
                    process.stderr.write(`[openai-oauth] Refresh failed (${msg}); using still-valid current token\n`);
                    return latest;
                }
                throw new Error(`OpenAI OAuth token refresh failed (${msg}). Re-authenticate via provider login.`);
            }
        })().finally(() => { _oauthRefreshInFlight = null; });

        this.tokens = await _oauthRefreshInFlight;
        return this.tokens;
    }
    async send(messages, model, tools, sendOpts) {
        // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
        // hot). After an idle gap it re-opens one in parallel with auth/body
        // build so the HTTP/SSE path skips the cold TLS handshake.
        preconnect('https://chatgpt.com');
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const externalSignal = opts.signal || null;
        const _sendSessionId = opts.sessionId || '(none)';
        const _sendAgent = opts.agent || '(none)';
        if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] auth-start sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} agent=${_sendAgent} expiringInMs=${this.tokens?.expires_at ? this.tokens.expires_at - Date.now() : 'unknown'}\n`); }
        // Build request body in parallel with auth resolution. ensureAuth is
        // a no-op fast-path on cached tokens, but a refresh round-trip can
        // take 300ms+; the body build (message serialisation) overlaps cleanly.
        const useModel = model || await ensureLatestCodexModel(this);
        // Escape hatch for callers (e.g. the web-search backend) that ship a
        // fully-formed request body with a server-side tool shape buildRequestBody
        // can't express. Routing through send() still gives them the 401/403
        // force-refresh retry + HTTP/SSE fallback instead of a hard fail.
        const promptCacheLane = resolveProviderPromptCacheLane('openai-oauth', opts, this.config);
        const bodyOpts = {
            ...sendOpts,
            promptCacheLane,
        };
        const _bodyP = opts._prebuiltBody
            ? Promise.resolve(opts._prebuiltBody)
            : Promise.resolve().then(() => buildRequestBody(messages, useModel, tools, bodyOpts));
        const _authP = this.ensureAuth();
        let auth = await _authP;
        const body = await _bodyP;
        // poolKey != cacheKey by design (see openai-oauth-ws.mjs header note).
        // poolKey is per-session so parallel reviewer/worker callers each get
        // their own socket bucket. cacheKey is the Codex-style prompt_cache_key:
        // by default it is the session/thread identity (clamped to 64 chars) and
        // feeds both `body.prompt_cache_key` and the OAuth WS handshake
        // `session_id`, so each long-lived thread keeps a stable cache shard.
        const poolKey  = opts.sessionId || null;
        const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai-oauth');
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const sendWs = typeof opts._sendViaWebSocketFn === 'function' ? opts._sendViaWebSocketFn : sendViaWebSocket;
        const sendHttp = typeof opts._sendViaHttpSseFn === 'function' ? opts._sendViaHttpSseFn : sendViaHttpSse;
        // Fast-fallback is only meaningful when HTTP/SSE fallback is actually
        // configured for this provider; WS-only paths keep the full handshake
        // retry budget. This mirrors _shouldUseOpenAIHttpFallback's `enabled`.
        const httpFallbackEnabled = _envFlag('MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK', true);
        const _t1 = Date.now();
        const recordLiveModel = (result) => {
            if (result?.model && !_codexCatalogHas(result.model)) {
                void this._refreshModelCache();
            }
            if (result && opts.providerState !== undefined && result.providerState === undefined) {
                result.providerState = opts.providerState;
            }
            return result;
        };
        const httpFallbackActive = () => {
            if (this._forceHttpFallbackUntil > Date.now()) return true;
            if (this._forceHttpFallback || this._forceHttpFallbackUntil) {
                this._forceHttpFallback = false;
                this._forceHttpFallbackUntil = 0;
            }
            return false;
        };
        const markStickyHttpFallback = () => {
            const ttlMs = _envPositiveInt('MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK_STICKY_MS', 60_000);
            this._forceHttpFallback = true;
            this._forceHttpFallbackUntil = Date.now() + ttlMs;
        };
        const traceWsError = (err, stage = 'primary') => {
            try {
                appendAgentTrace({
                    sessionId: poolKey,
                    iteration,
                    kind: 'transport_error',
                    provider: 'openai-oauth',
                    model: useModel,
                    transport: 'websocket',
                    payload: {
                        stage,
                        error_code: err?.code || null,
                        error_http_status: Number(err?.httpStatus || 0) || null,
                        error_classifier: err?.retryClassifier || err?.midstreamClassifier || null,
                        live_text_emitted: err?.liveTextEmitted === true || err?.unsafeToRetry === true,
                        message: String(err?.message || err || '').slice(0, 500),
                    },
                });
            } catch {}
        };
        const dispatchHttp = async (reason, originalErr = null, { sticky = false } = {}) => {
            appendAgentTrace({
                sessionId: poolKey,
                iteration,
                kind: 'transport_fallback',
                provider: 'openai-oauth',
                model: useModel,
                transport: 'http',
                payload: {
                    from: 'websocket',
                    to: 'http',
                    reason,
                    error_code: originalErr?.code || null,
                    error_http_status: Number(originalErr?.httpStatus || 0) || null,
                    error_classifier: originalErr?.retryClassifier || originalErr?.midstreamClassifier || null,
                },
            });
            if (reason === 'forced') {
                if (_envFlag('MIXDOG_OPENAI_OAUTH_LOG_FORCED_FALLBACK', false)) {
                    process.stderr.write('[openai-oauth] WebSocket bypassed (forced); using HTTP/SSE\n');
                }
            } else {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[openai-oauth] WebSocket unhealthy (${reason}); falling back to HTTP/SSE\n`);
            }
            const result = await sendHttp({
                auth,
                body,
                opts,
                onStreamDelta,
                onToolCall,
                onTextDelta,
                onStageChange,
                externalSignal,
                poolKey,
                cacheKey,
                iteration,
                useModel,
                fetchFn: opts._fetchFn,
            });
            if (sticky) markStickyHttpFallback();
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok transport=http-fallback\n`);
            }
            return recordLiveModel(result);
        };
        const dispatchWs = (forceFresh = false) => sendWs({
            auth,
            body,
            sendOpts: opts,
            onStreamDelta,
            onToolCall,
            onTextDelta,
            onStageChange,
            externalSignal,
            poolKey,
            cacheKey,
            iteration,
            useModel,
            displayModel: _displayCodexModel,
            forceFresh,
            // Fast-fallback: when HTTP/SSE fallback is enabled, cap the WS
            // handshake acquire loop at ONE attempt so a first
            // acquire/first-byte failure aborts the remaining backoff retries
            // and lets HTTP start immediately (skip-retries, no concurrent race
            // → no double token spend). WS-only paths (fallback disabled) keep
            // the full retry budget.
            fastFallback: httpFallbackEnabled,
            // codex-parity prewarm (generate:false full frame on a fresh
            // socket, wire-verified 2026-07-03). DEFAULT ON: R19(off) vs
            // R20(on) A/B shows prewarm removes ALL early-session zero-cache
            // misses (4 -> 0 at it<=3; zero-miss 3 -> 0) by writing the cache
            // and waiting for completion before the first real turn, exactly
            // like codex prewarm_websocket (client.rs:1673-1705). Cost is one
            // small (~5k tok) generate:false request per fresh socket, far
            // below the 5-12k uncached tokens each early miss burned.
            // Mid-session partial drops are server-side and unaffected.
            warmupBody: _envFlag('MIXDOG_OPENAI_OAUTH_WS_WARMUP', true)
                ? { ...body, generate: false }
                : null,
        });
        if (opts.forceHttpFallback === true
            || httpFallbackActive()
            || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)) {
            return dispatchHttp('forced');
        }

        // Prefer WebSocket for hot cache/delta transport; fall back to HTTP/SSE
        // after retry-exhausted handshake/acquire/no-first-event failures.
        try {
            if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] provider-send-start model=${useModel} agent=${_sendAgent} sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} iteration=${iteration ?? '(none)'}\n`); }
            const result = await dispatchWs(false);
            if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`); }
            return recordLiveModel(result);
        } catch (err) {
            traceWsError(err, 'primary');
            const status = err?.httpStatus;
            // Live-text invariant: if the WS attempt already relayed a
            // non-empty text chunk to the client, NO recovery path may reissue
            // the turn — an auth-refresh + dispatchWs(true) retry would
            // concatenate a second attempt onto already-rendered output. Refuse
            // the retry (and the HTTP fallback below already refuses) and
            // surface the original error.
            const liveTextEmitted = err?.liveTextEmitted === true || err?.unsafeToRetry === true;
            if ((status === 401 || status === 403) && !liveTextEmitted) {
                process.stderr.write(`[openai-oauth-ws] ${status} — forcing refresh and retrying once over WS\n`);
                if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] provider-${status}-retry attempt=1\n`); }
                this._refreshFallbackUntil = 0;
                auth = await this.ensureAuth({ forceRefresh: true, reason: String(status) });
                try {
                    const result = await dispatchWs(true);
                    if (process.env.MIXDOG_DEBUG_AGENT) { process.stderr.write(`[agent-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`); }
                    return recordLiveModel(result);
                } catch (retryErr) {
                    traceWsError(retryErr, 'auth_retry');
                    if (_shouldUseOpenAIHttpFallback(retryErr, externalSignal)) {
                        try {
                            return await dispatchHttp(
                                retryErr?.retryClassifier || retryErr?.code || retryErr?.message || 'ws_auth_retry_failed',
                                retryErr,
                                { sticky: true },
                            );
                        } catch (fallbackErr) {
                            try { retryErr.fallbackError = fallbackErr; } catch {}
                            throw retryErr;
                        }
                    }
                    throw retryErr;
                }
            }
            // Auth failure after live text already emitted: never reissue.
            if ((status === 401 || status === 403) && liveTextEmitted) {
                throw err;
            }
            const msg = err?.message || '';
            const isUnknownModel = status === 404
                || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(msg);
            if (isUnknownModel && !opts._modelRetry) {
                process.stderr.write(`[openai-oauth-ws] unknown model — refreshing catalog + 1 retry\n`);
                await this._refreshModelCache();
                return this.send(messages, model, tools, { ...opts, _modelRetry: true });
            }
            if (_shouldUseOpenAIHttpFallback(err, externalSignal)) {
                // Fast-path trace: the WS handshake acquire/first-byte failed on
                // its FIRST attempt while fast-fallback was armed, so the
                // remaining backoff retries were skipped and HTTP starts now.
                // err.attempts===1 means the capped single-attempt path fired.
                if (httpFallbackEnabled && Number(err?.attempts) === 1) {
                    appendAgentTrace({
                        sessionId: poolKey,
                        iteration,
                        kind: 'ws_fallback_fast',
                        provider: 'openai-oauth',
                        model: useModel,
                        transport: 'websocket',
                        elapsed_ms: Date.now() - _t1,
                        payload: {
                            elapsed_ms: Date.now() - _t1,
                            classifier: err?.retryClassifier || err?.midstreamClassifier || null,
                            code: err?.code || null,
                        },
                    });
                }
                try {
                    return await dispatchHttp(
                        err?.retryClassifier || err?.midstreamClassifier || err?.code || err?.message || 'ws_failed',
                        err,
                        { sticky: true },
                    );
                } catch (fallbackErr) {
                    try { err.fallbackError = fallbackErr; } catch {}
                    throw err;
                }
            }
            throw err;
        }
    }
    async listModels() {
        // Dynamic lookup via /backend-api/codex/models. Cached 24h.
        // Endpoint returns rich metadata (context_window, reasoning levels,
        // visibility) that is more detailed than /v1/models.
        const cached = await _loadCodexModelCache();
        if (cached) {
            _lastCodexListModelsError = '';
            _inMemoryCodexCatalog = cached.slice();
            return cached;
        }
        try {
            const auth = await this.ensureAuth();
            const clientVersion = await _resolveCodexClientVersion();
            const url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
            const res = await fetch(url, {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${auth.access_token}`,
                    'OpenAI-Beta': 'responses=experimental',
                    'originator': 'codex_cli_rs',
                    'chatgpt-account-id': auth.account_id || '',
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`openai-oauth list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.models) ? data.models : [];
            const normalized = items.map(m => _normalizeCodexModel(m));
            _markLatestCodex(normalized);
            const enriched = sanitizeModelList((await enrichModels(normalized)).filter(Boolean), { provider: 'openai-oauth' });
            await _saveCodexModelCache(enriched);
            _lastCodexListModelsError = '';
            return enriched;
        } catch (err) {
            _lastCodexListModelsError = err?.message || String(err);
            process.stderr.write(`[openai-oauth] listModels fetch failed (${_lastCodexListModelsError})\n`);
            // No fallback catalog — empty list signals the UI to show a
            // "catalog unavailable, retry" state. openai-oauth has no equivalent to
            // Anthropic's family tokens so there's no meaningful minimal list.
            return [];
        }
    }
    // Force a catalog refresh (ignores 24h TTL). De-duped via
    // _codexRefreshInFlight so concurrent callers share one HTTP round-trip.
    async _refreshModelCache() {
        if (_codexRefreshInFlight) return _codexRefreshInFlight;
        _codexRefreshInFlight = (async () => {
            try {
                const auth = await this.ensureAuth();
                const clientVersion = await _resolveCodexClientVersion();
                const url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
                const res = await fetch(url, {
                    signal: AbortSignal.timeout(10_000),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${auth.access_token}`,
                        'OpenAI-Beta': 'responses=experimental',
                        'originator': 'codex_cli_rs',
                        'chatgpt-account-id': auth.account_id || '',
                    },
                    dispatcher: getLlmDispatcher(),
                });
                if (!res.ok) throw new Error(`codex list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.models) ? data.models : [];
                const normalized = items.map(m => _normalizeCodexModel(m));
                _markLatestCodex(normalized);
                const enriched = sanitizeModelList((await enrichModels(normalized)).filter(Boolean), { provider: 'openai-oauth' });
                await _saveCodexModelCache(enriched);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[openai-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[openai-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _codexRefreshInFlight = null;
            }
        })();
        return _codexRefreshInFlight;
    }

    async isAvailable() {
        return this.tokens !== null;
    }
}

// --- OAuth PKCE login flow: extracted to openai-oauth-login.mjs ---
const { beginOAuthLogin, loginOAuth } = createOpenAIOAuthLogin({
    clientId: CLIENT_ID,
    originator: CODEX_OAUTH_ORIGINATOR,
    extractAccountId,
    expiryFromAccessToken: _expiryFromAccessToken,
    saveTokens,
});
export { beginOAuthLogin, loginOAuth };
