/**
 * Anthropic OAuth provider — uses Mixdog-owned local OAuth credentials
 * for Claude Max subscription access.
 *
 * Raw HTTP + SSE streaming, reuses message/tool conversion patterns
 * from anthropic.mjs. agent-trace instrumented.
 */
import { randomBytes } from 'crypto';
import {
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
} from '../agent-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import {
    _loadModelCache,
    _setInMemoryCatalog,
    _catalogHas,
    _displayModel,
    _catalogOutputTokens,
    normalizeAndSaveCatalog,
    resolveLatestAnthropicModel,
    resolveAnthropicModelAfter404,
    ensureLatestAnthropicModel,
} from './anthropic-model-resolve.mjs';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs, foldUserTextIntoToolResultTail } from '../session/context-utils.mjs';
import {
    TOKEN_REFRESH_SKEW_MS,
    resolveCliVersion,
    loadCredentials,
    hasAnthropicOAuthCredentials,
    describeAnthropicOAuthCredentials,
    forgetAnthropicOAuthCredentials,
    _scrubTokens,
    _credentialsMaxMtime,
    refreshOAuthCredentials,
    beginOAuthLogin,
    loginOAuth,
} from './anthropic-oauth-credentials.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    PROVIDER_RETRY_BACKOFF_MS,
    PROVIDER_RETRY_MAX_ATTEMPTS,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import {
    classifyError,
    midstreamBackoffFor,
    retryAfterMsFromError,
    withRetry,
} from './retry-classifier.mjs';
import {
    ANTHROPIC_MAX_MIDSTREAM_RETRIES,
    parseSSEStream,
    _classifyMidstreamError,
    _midstreamSleepWithAbort,
} from './anthropic-sse.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import {
    applyAnthropicEffortToBody,
    effortValuesForModel,
    shouldIncludeEffortBeta,
} from './anthropic-effort.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { normalizeContentForAnthropic } from './media-normalization.mjs';

// --- Model catalog cache helpers: extracted to anthropic-model-resolve.mjs ---
// SSE progress emits (per-request "Response …" and "Done:" lines). Off by default.
const SSE_VERBOSE = process.env.MIXDOG_SSE_VERBOSE === '1';

function formatRetryAfter(ms) {
    if (ms == null) return '';
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n >= 60_000 && n % 60_000 === 0) return `${Math.round(n / 60_000)}m`;
    if (n >= 1000) return `${Math.ceil(n / 1000)}s`;
    return `${Math.ceil(n)}ms`;
}

function anthropicQuotaError(status, headers, bodyText = '') {
    const retryAfterMs = retryAfterMsFromError({ headers, response: { headers } });
    const retryAfter = formatRetryAfter(retryAfterMs);
    const detail = bodyText ? `: ${String(bodyText).slice(0, 200)}` : '';
    const retry = retryAfter ? ` retryAfter=${retryAfter}` : '';
    const err = new Error(`Anthropic OAuth API ${status} quota/rate limit${retry}${detail}`);
    err.name = 'ProviderQuotaError';
    err.code = 'PROVIDER_QUOTA';
    err.httpStatus = status;
    err.status = status;
    err.headers = headers;
    err.response = { status, headers };
    err.retryAfterMs = retryAfterMs;
    err.providerQuota = true;
    err.quotaExceeded = true;
    err.unsafeToRetry = true;
    return err;
}

let _modelRefreshInFlight = null;
let _oauthRefreshInFlight = null;
// No in-memory credential cache: the canonical credentials file is the
// single source of truth. Cross-process refresh_token rotation by another
// concurrent reader would invalidate any cached copy here and produce
// invalid_grant on the next refresh. Reading from
// disk on demand is cheap (one stat + one small JSON parse) and removes
// the cache-vs-disk skew entirely.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Anthropic OAuth contract for first-party OAuth clients: Opus/Sonnet
// requests are gated on this exact system-prompt prefix. Haiku is not
// gated and ignores this prefix.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADERS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11';

function requiresSystemPrefix(model) {
    // High-tier Claude OAuth models require the first-party system prefix for
    // OAuth pool routing. Haiku does not; keep every other Claude family (Opus,
    // Sonnet, Fable, and future non-Haiku families) on the prefixed path.
    const id = String(model || '').toLowerCase();
    return /^claude-/.test(id) && !/^claude-haiku(?:-|$)/.test(id);
}

// OAuth rate-limit pool routing is gated by the server inspecting the first
// system block. When it reads exactly the OAuth system prefix string it routes
// into the first-party OAuth pool; any other
// content (even the prefix concatenated with extra text in the same block)
// falls into the standard pool and Opus/Sonnet return 429. Splitting into
// two blocks — [prefix, rest] — keeps both routing and user instructions.
function buildSystemBlocks(systemMsgs, model, systemTtl, tier3Ttl) {
    // systemMsgs is an array of { content, cacheTier } — each non-empty element
    // becomes its own Anthropic content block with its own cache_control
    // breakpoint. Blocks tagged cacheTier:'tier3' (BP3 sessionMarker) take the
    // tier3 TTL; every other block (BP1 baseRules / BP2 stableSystem) takes the
    // system TTL. Invariant: callers must pass an array.
    const items = Array.isArray(systemMsgs)
        ? systemMsgs
            .map(m => ({
                text: typeof m?.content === 'string' ? m.content.trim() : '',
                tier: m?.cacheTier === 'tier3' ? 'tier3' : 'system',
            }))
            .filter(it => it.text)
        : [];
    const gated = requiresSystemPrefix(model);

    const blocks = [];
    if (gated) {
        blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX });
    }
    for (let i = 0; i < items.length; i++) {
        let body = items[i].text;
        // Strip a duplicated OAuth system prefix from the first block if present.
        if (gated && i === 0 && body.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
            body = body.slice(CLAUDE_CODE_SYSTEM_PREFIX.length).trim();
            if (!body) continue;
        }
        blocks.push({ type: 'text', text: body, _tier: items[i].tier });
    }
    // Apply per-tier cache_control. BP1/BP2 -> systemTtl, BP3 -> tier3Ttl. The
    // gating prefix block is never cached (Anthropic routes on its exact bytes).
    // tier3Ttl === null leaves the 3rd block uncached (e.g. maintenance roles).
    // Anthropic caps cache_control breakpoints at 4 per request; defensively
    // cap it here too so an unexpectedly large systemMsgs array can never
    // mark more than 4 blocks (extras keep their text, just lose the
    // cache_control breakpoint, not the block itself).
    const MAX_SYSTEM_BREAKPOINTS = 4;
    let bpCount = 0;
    for (const b of blocks) {
        const tier = b._tier;
        delete b._tier;
        if (b.text === CLAUDE_CODE_SYSTEM_PREFIX) continue;
        const ttl = tier === 'tier3' ? tier3Ttl : systemTtl;
        if (ttl && bpCount < MAX_SYSTEM_BREAKPOINTS) {
            b.cache_control = ttl;
            bpCount++;
        }
    }
    return blocks;
}

// resolveMaxTokens: catalog-driven max_tokens for a model id. Thin wrapper
// around the shared anthropic-max-tokens helper (also used by the API-key
// twin in anthropic.mjs) — this provider supplies its own in-memory-mirror-
// first catalog lookup strategy (see anthropic-model-resolve.mjs).
//   1. MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS env override, if set, wins outright.
//   2. Catalog outputTokens (trusted over hardcoded heuristics when present),
//      clamped to [MAX_TOKENS_FLOOR, safetyCap].
//   3. Static MAX_TOKENS table / family heuristic fallback when the catalog
//      has no entry for this model, also clamped to the safety cap.
function resolveMaxTokens(model) {
    return resolveAnthropicMaxTokens(model, { catalogLookup: _catalogOutputTokens });
}

const MIN_THINKING_BUDGET = 1024;
const THINKING_OUTPUT_RESERVE = 1024;

function clampThinkingBudgetTokens(value, maxTokens) {
    const desired = Math.floor(Number(value));
    const max = Math.floor(Number(maxTokens));
    if (!Number.isFinite(desired) || desired <= 0 || !Number.isFinite(max)) return null;
    const ceiling = max - THINKING_OUTPUT_RESERVE;
    if (ceiling < MIN_THINKING_BUDGET) return null;
    return Math.max(MIN_THINKING_BUDGET, Math.min(desired, ceiling));
}

// Layered cache TTLs — stable layers get 1h, volatile layers get 5m.
// Anthropic requires 1h entries to appear before 5m entries in the request.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };   // tools, system, tier3, messages
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };             // explicit 5m override

// --- Message conversion ---

function withCacheControl(block, ttl = CACHE_TTL_VOLATILE) {
    if (!block || typeof block !== 'object' || block.cache_control) return block;
    return { ...block, cache_control: ttl };
}

function appendCacheControl(content, ttl = CACHE_TTL_VOLATILE) {
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1], ttl);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content }, ttl)];
    }
    return content;
}

// Anthropic's tool spec forbids oneOf / allOf / anyOf at the TOP level of
// input_schema (nested usage inside properties is allowed). External MCP
// servers sometimes emit such schemas.
// Convert them to a flat object schema so the API never sees a 400.
function _sanitizeInputSchema(schema, toolName) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    const compound = schema.oneOf || schema.anyOf || schema.allOf;
    if (!compound) return structuredClone(schema);
    // Merge all branch properties into one permissive object schema.
    // None of the branches' required lists are hoisted — callers that relied
    // on discriminated-union semantics will still function; the model simply
    // receives a union of the property surface with no hard-required constraint.
    const mergedProps = {};
    const branchDescs = [];
    for (const branch of Array.isArray(compound) ? compound : []) {
        if (branch && typeof branch === 'object' && branch.properties) {
            Object.assign(mergedProps, branch.properties);
        }
        if (branch && typeof branch === 'object') {
            const parts = [];
            if (branch.description) parts.push(branch.description);
            else if (branch.type) parts.push(`type:${branch.type}`);
            if (parts.length) branchDescs.push(parts.join(' '));
        }
    }
    const compoundKey = schema.oneOf ? 'oneOf' : schema.anyOf ? 'anyOf' : 'allOf';
    let description = schema.description || '';
    if (branchDescs.length) {
        const parts = [];
        let used = 0;
        for (let i = 0; i < branchDescs.length; i++) {
            const v = `(variant ${i + 1}: ${branchDescs[i]})`;
            if (used + v.length + (parts.length ? 1 : 0) > 500) break;
            parts.push(v);
            used += v.length + (parts.length > 1 ? 1 : 0);
        }
        const addition = parts.join(' ');
        if (addition) description = description ? `${description} ${addition}` : addition;
    }
    const mergedPropsCount = Object.keys(mergedProps).length;
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(
            `[anthropic-oauth-sanitizer] tool="${toolName ?? ''}" compound="${compoundKey}" branches=${Array.isArray(compound) ? compound.length : 0} mergedProps=${mergedPropsCount}\n`
        );
    }
    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: mergedProps,
    };
}

function toAnthropicTools(tools) {
    return tools.map(t => {
        const out = {
            name: t.name,
            description: t.description,
            input_schema: _sanitizeInputSchema(t.inputSchema, t.name),
        };
        if (t.deferLoading === true || t.defer_loading === true) out.defer_loading = true;
        return out;
    });
}
function nativeAnthropicTools(opts) {
    return Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
}
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
// only when the request actually carries tools (see buildRequestBody).
function toAnthropicToolChoice(toolChoice) {
    return toolChoice === 'none' ? { type: 'none' } : undefined;
}
function deferredAnthropicTools(activeTools, opts) {
    if (opts?.session?.deferredNativeTools !== true) return [];
    // A request whose ONLY tools are deferred is rejected by the API with
    // `400: At least one tool must have defer_loading=false` — happens on the
    // iteration-cap final turn (loop sends tools: [] to force a text answer).
    // No active tools ⇒ send no deferred catalog either.
    if (!Array.isArray(activeTools) || activeTools.length === 0) return [];
    const active = new Set((activeTools || []).map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const catalog = Array.isArray(opts.session.deferredToolCatalog) ? opts.session.deferredToolCatalog : [];
    return catalog
        .filter((tool) => tool?.name && !active.has(String(tool.name)))
        .map((tool) => ({ ...tool, deferLoading: true }));
}

function toAnthropicMessages(messages) {
    // Marker-free lowering. cache_control is applied AFTER sanitization by
    // applyAnthropicCacheMarkers() so that block drops/inserts/reorders
    // performed by sanitizeAnthropicContentPairs cannot move or delete a
    // marked block (the root cause of the sporadic COLD-turn cache miss:
    // pre-sanitize markers landed on blocks the sanitizer then rewrote, so
    // the provider-visible breakpoint diverged from the cached one).
    const result = [];
    for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (m.role === 'system') continue;

        if (m.role === 'assistant' && (m.toolCalls?.length || m.assistantBlocks?.length)) {
            let content;
            if (m.assistantBlocks?.length) {
                content = m.assistantBlocks.slice();
            } else {
                content = [];
                // Adaptive-thinking round-trip: prior-turn thinking blocks are
                // REQUIRED back, unmodified (signature intact; empty thinking
                // field allowed), and MUST precede tool_use blocks. Emit them
                // first, verbatim as received from the SSE parser.
                if (Array.isArray(m.thinkingBlocks)) {
                    for (const tb of m.thinkingBlocks) {
                        if (tb && typeof tb === 'object') content.push(tb);
                    }
                }
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const tc of m.toolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments,
                    });
                }
            }
            result.push({ role: 'assistant', content });
            continue;
        }

        if (m.role === 'tool') {
            const last = result[result.length - 1];
            const refs = Array.isArray(m.nativeToolSearch?.toolReferences)
                ? m.nativeToolSearch.toolReferences.map((name) => String(name || '').trim()).filter(Boolean)
                : [];
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: refs.length
                    ? refs.map((name) => ({ type: 'tool_reference', tool_name: name }))
                    : normalizeContentForAnthropic(m.content),
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                result.push({ role: 'user', content: [block] });
            }
            continue;
        }

        // First-party client parity: fold a user text turn that directly follows a
        // tool_result turn into that tool_result's content. A sibling text
        // turn after tool_result renders as `</function_results>\n\nHuman:`
        // on the wire and trains the model toward 3-token empty end_turn
        // completions (see foldUserTextIntoToolResultTail).
        if (m.role === 'user' && foldUserTextIntoToolResultTail(result, normalizeContentForAnthropic(m.content))) {
            continue;
        }
        result.push({ role: m.role, content: normalizeContentForAnthropic(m.content) });
    }
    return sanitizeAnthropicContentPairs(result);
}

// Applies cache_control markers to the FINAL, already-sanitized Anthropic
// message array — by INVARIANT, never by pre-sanitize index. Because
// sanitizeAnthropicContentPairs has already run (and must NOT run again
// after this), the blocks we mark here are exactly the blocks the provider
// sees, so the cache breakpoint is stable across turns.
//   message-anchor: prefer a safe tool_result tail, then a previous real user
//                   text turn if another slot remains. Synthetic
//                   <system-reminder> messages and current pure-text prompts
//                   are excluded so first-turn prompts do not create a fresh
//                   BP4 write on every new session.
// messageTtl === null disables the tail. BP3 (tier3) now rides a system block,
// so it is no longer marked here.
// ANTHROPIC_MSG_SLOTS=0 is honoured upstream by passing messageTtl = null.
function applyAnthropicCacheMarkers(sanitizedMessages, { messageTtl = CACHE_TTL_VOLATILE, messageSlots = 1 } = {}) {
    if (!Array.isArray(sanitizedMessages) || sanitizedMessages.length === 0) {
        return sanitizedMessages;
    }

    const firstText = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const first = content.find((b) => b?.type === 'text');
            return first && typeof first.text === 'string' ? first.text : '';
        }
        return '';
    };
    const isSystemReminder = (content) => firstText(content).startsWith('<system-reminder>');

    const markLast = (msg, ttl) => {
        if (!msg) return;
        msg.content = appendCacheControl(msg.content, ttl);
    };
    const ttlRank = (ttl) => ttl?.ttl === '1h' ? 2 : 1;
    const canMarkMessageIdx = (idx) => {
        // System-reminder messages (volatileTail / roleSpecific BP4) vary
        // per-call, so never pin them with a 1h marker. The 1h system blocks
        // (BP1/BP2/BP3) already satisfy Anthropic's "1h before 5m" ordering.
        if (idx < 0) return false;
        const msg = sanitizedMessages[idx];
        if (ttlRank(messageTtl) > ttlRank(CACHE_TTL_VOLATILE)
            && isSystemReminder(msg?.content)) {
            return false;
        }
        return true;
    };
    const hasUserText = (msg) => {
        if (msg?.role !== 'user') return false;
        if (isSystemReminder(msg.content)) return false;
        if (typeof msg.content === 'string') return msg.content.trim().length > 0;
        if (!Array.isArray(msg.content)) return false;
        return msg.content.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
    };
    const previousUserTextAnchorIdx = () => {
        // Prefer the user text turn before the current tail. In a normal
        // user->assistant->tool loop this is the last prompt that was already
        // present in the previous API request, so its prefix can overlap.
        const tailIdx = sanitizedMessages.length - 1;
        for (let i = tailIdx - 1; i >= 0; i--) {
            if (hasUserText(sanitizedMessages[i])) return i;
        }
        return -1;
    };
    const latestToolResultTailIdx = () => {
        // Claude/pi refs allow cache_control on tool_result blocks. Keep this
        // narrower than "last message" so a fresh user prompt or steering text
        // never becomes a 1h breakpoint.
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const msg = sanitizedMessages[i];
            if (msg?.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) continue;
            const lastBlock = msg.content[msg.content.length - 1];
            if (lastBlock?.type === 'tool_result') return i;
        }
        return -1;
    };

    const firstRequestUserPromptIdx = () => {
        // Iteration-1 fallback: on the very first request a session has only the
        // current user prompt — no tool_result tail and no earlier user turn, so
        // both anchors above return -1 and NO message breakpoint is placed. That
        // left the whole tools+system prefix (~4.2k) uncached on iter1: nothing
        // was written, so iter2 re-sent it as a fresh full write instead of a
        // read hit. Anchor the current prompt's tail so the stable prefix is
        // cache-written on the first ask and read back on the next. Only used
        // when neither real anchor exists, so later turns still prefer the
        // tool_result / previous-user-text anchors (never the volatile new
        // prompt). Synthetic <system-reminder> turns are excluded by hasUserText.
        if (latestToolResultTailIdx() !== -1 || previousUserTextAnchorIdx() !== -1) return -1;
        const tailIdx = sanitizedMessages.length - 1;
        return hasUserText(sanitizedMessages[tailIdx]) ? tailIdx : -1;
    };
    if (messageTtl !== null) {
        const slots = Math.max(0, Math.min(4, Number(messageSlots) || 0));
        const marked = new Set();
        const candidates = [latestToolResultTailIdx(), previousUserTextAnchorIdx(), firstRequestUserPromptIdx()];
        for (const idx of candidates) {
            if (slots <= 0) break;
            if (idx < 0 || marked.has(idx) || !canMarkMessageIdx(idx)) continue;
            markLast(sanitizedMessages[idx], messageTtl);
            marked.add(idx);
            if (marked.size >= slots) break;
        }
    }

    return sanitizedMessages;
}

// --- SSE parser + midstream retry policy: extracted to anthropic-sse.mjs ---

// --- Build request body ---

function resolveCacheTtls(opts) {
    // Layered cache strategy — caller may override per-layer via opts.cacheStrategy.
    // Anthropic enforces: 1h entries must appear before 5m entries in the request.
    const strategy = opts.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    // BP budget (4 total):
    //   BP1 baseRules    — 1h (shared tool policy + compact skill manifest)
    //   BP2 stableSystem — 1h (role/system rules)
    //   BP3 tier3        — 1h (sessionMarker: stable memory/meta body)
    //   BP4 messages     — 1h sliding tail (tool_result cache across iter)
    // tools BP is dropped — system BP covers the tools prefix via
    // Anthropic's prompt cache prefix semantics (order: tools → system
    // → messages).
    // tier3 defaults to 1h (stable) — sessionMarker content is stable per
    // memory/meta tuple and the BP slot is only spent when a 3rd
    // (cacheTier:'tier3') system block is actually present, so this default is
    // free for sessions that don't carry one. Previously null here meant any
    // caller that skipped agent runtime resolve (CLI, raw agent spawn)
    // silently lost the tier3 cache layer even though it supported one.
    const resolved = {
        tools: pick('tools', null),
        system: pick('system', CACHE_TTL_STABLE),
        tier3: pick('tier3', CACHE_TTL_STABLE),
        messages: pick('messages', CACHE_TTL_STABLE),
    };
    // A partial cacheStrategy override (e.g. {system:'5m'} while tier3/
    // messages default to '1h') can put a longer TTL after a shorter one in
    // request order, which Anthropic rejects: 1h breakpoints must all appear
    // before any 5m breakpoint. Normalize left-to-right in wire order
    // (system -> tier3 -> messages; tools is emitted before system and is
    // excluded from the run) so a later layer is downgraded to the earliest
    // shorter TTL seen so far — never re-promoted. Layers set to null ('none')
    // emit no breakpoint at all, so they neither violate nor constrain
    // ordering and are skipped.
    const ttlRank = (ttl) => (ttl === CACHE_TTL_STABLE ? 2 : 1); // 1h=2, 5m=1
    let minRank = Infinity;
    for (const layer of ['system', 'tier3', 'messages']) {
        if (!resolved[layer]) continue;
        const rank = ttlRank(resolved[layer]);
        if (rank > minRank) resolved[layer] = CACHE_TTL_VOLATILE;
        else minRank = rank;
    }
    return resolved;
}

// BP3 (tier3) is injected by session/manager as its own `system` role block —
// the 3rd system block, tagged `cacheTier:'tier3'`. buildSystemBlocks applies
// the tier3 1h cache_control to that block; BP1/BP2 take the system TTL. No
// `<system-reminder>` user message / sentinel scan is involved anymore.

function buildRequestBody(messages, model, tools, sendOpts) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const maxTokens = resolveMaxTokens(model);
    const opts = sendOpts || {};
    const ttls = resolveCacheTtls(opts);
    // Each system message becomes its own Anthropic content block with its own
    // breakpoint: BP1 baseRules + BP2 stableSystem at ttls.system, BP3
    // sessionMarker (cacheTier:'tier3') at ttls.tier3.
    const systemBlocks = buildSystemBlocks(systemMsgs, model, ttls?.system, ttls?.tier3);

    // 4-BP budget layout. tools BP is dropped — system BP covers the
    // tools prefix via Anthropic's prompt cache prefix semantics
    // (order: tools → system → messages). That frees slots for the
    // messages-tail. The system blocks now hold BP1/BP2/BP3 (tier3), so the
    // tier3 breakpoint is accounted for inside systemBpUsed.
    const systemBpUsed = systemBlocks.filter(b => b.cache_control).length;
    const toolsBpUsed = 0;
    const usedSlots = toolsBpUsed + systemBpUsed;
    // Env override for BP strategy. ANTHROPIC_MSG_SLOTS=0 disables message
    // caching entirely. Any value >=1 first marks the previous user text turn
    // so consecutive requests share a breakpoint; a second free slot marks the
    // tail for the newest delta.
    const msgSlotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
    const defaultMsgSlots = Math.max(0, 4 - usedSlots);
    const msgSlots = ttls.messages
        ? (Number.isFinite(msgSlotsCap) && msgSlotsCap >= 0 ? Math.min(msgSlotsCap, defaultMsgSlots) : defaultMsgSlots)
        : 0;
    // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers are
    // applied to the FINAL sanitized array by invariant, so block drops /
    // inserts / reorders performed by the sanitizer can never move or delete a
    // marked block. NEVER sanitize again after this (see send path).
    // msgSlots === 0 (ANTHROPIC_MSG_SLOTS=0, or no free slot) → tail disabled.
    const tailTtl = msgSlots > 0 ? ttls.messages : null;
    const anthropicMessages = applyAnthropicCacheMarkers(
        toAnthropicMessages(chatMsgs),
        { messageTtl: tailTtl, messageSlots: msgSlots },
    );

    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true,
    };

    if (systemBlocks.length) body.system = systemBlocks;

    const nativeTools = nativeAnthropicTools(opts);
    const deferredTools = deferredAnthropicTools(tools || [], opts);
    if (tools?.length || nativeTools.length || deferredTools.length) {
        // No cache_control on tools — the systemBase BP already covers the
        // tools prefix via Anthropic's prompt cache prefix semantics (order:
        // tools → system → messages). Placing a separate BP here would waste
        // a slot that's better spent on messages tail.
        body.tools = [...nativeTools, ...toAnthropicTools([...(tools || []), ...deferredTools])];
    }
    // tool_choice only when tools are actually present (Anthropic rejects
    // tool_choice without tools). 'none' rides the hard-cap final turn to
    // forbid tool USE while keeping the tools prefix stable for cache reuse.
    if (body.tools) {
        const toolChoice = toAnthropicToolChoice(opts.toolChoice);
        if (toolChoice) body.tool_choice = toolChoice;
    }

    applyAnthropicEffortToBody(body, {
        model,
        opts,
        maxTokens,
        clampThinkingBudgetTokens,
        logTag: 'anthropic-oauth',
    });

    if (opts.fast === true && supportsAnthropicFastMode(model)) {
        body.speed = 'fast';
    }

    return body;
}

export function _buildRequestBodyForCacheSmoke(messages, model, tools = [], sendOpts = {}) {
    return buildRequestBody(messages, model, tools, sendOpts);
}

// --- Provider ---

export class AnthropicOAuthProvider {
    // input_tokens EXCLUDES cache_read_input_tokens (separate field) — add the
    // cache back for the real context footprint. See registry.mjs.
    static inputExcludesCache = true;
    name = 'anthropic-oauth';
    credentials = null;
    config;
    fastModeBetaHeaderLatched = false;

    constructor(config) {
        this.config = config || {};
        this.credentials = loadCredentials();
        // Warm a kept-alive socket to the messages API so the first request
        // skips the cold TLS handshake. Best-effort; never throws.
        preconnect('https://api.anthropic.com');
    }

    async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
        if (!this.credentials) {
            this.credentials = loadCredentials();
        }
        if (!this.credentials) {
            throw new Error('Anthropic OAuth credentials not found. Open /providers in mixdog to sign in.');
        }

        // Pick up Mixdog-updated tokens the moment the credentials file is
        // rewritten — without this, a fresh /auth login in another process is
        // ignored until the in-memory token's expiry skew triggers a refresh.
        const diskMtime = _credentialsMaxMtime();
        if (diskMtime > 0 && diskMtime > (this.credentials.mtimeMs || 0)) {
            const fresh = loadCredentials();
            if (fresh?.accessToken) {
                this.credentials = fresh;
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk (mtime change)\n`);
            }
        }

        const expiring = this.credentials.expiresAt
            && this.credentials.expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
        if (forceRefresh || expiring) {
            this.credentials = await this._refreshCredentials({ force: forceRefresh, reason });
        }

        return this.credentials;
    }

    async _refreshCredentials({ force = false, reason = 'preemptive' } = {}) {
        const currentToken = this.credentials?.accessToken || null;
        const disk = loadCredentials();
        const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
        if (disk?.accessToken && disk.accessToken !== currentToken
            && (!disk.expiresAt || disk.expiresAt >= validAfter)) {
            this.credentials = disk;
            process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
            return disk;
        }
        if (!this.credentials && disk) this.credentials = disk;

        if (_oauthRefreshInFlight) {
            const shared = await _oauthRefreshInFlight;
            this.credentials = shared;
            if (!force || shared?.accessToken !== currentToken) return this.credentials;
        }

        const startingCreds = this.credentials || disk;
        _oauthRefreshInFlight = (async () => {
            const latest = loadCredentials() || startingCreds;
            const latestValidAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
            if (latest?.accessToken && latest.accessToken !== currentToken
                && (!latest.expiresAt || latest.expiresAt >= latestValidAfter)) {
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
                return latest;
            }

            if (!latest?.refreshToken) {
                if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
                    process.stderr.write(`[anthropic-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`);
                    return latest;
                }
                throw new Error('Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.');
            }

            try {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] Token ${reason}, refreshing...\n`);
                const refreshed = await refreshOAuthCredentials(latest);
                process.stderr.write(`[anthropic-oauth] Token refreshed, expires in ${Math.round(((refreshed.expiresAt || Date.now()) - Date.now()) / 1000)}s\n`);
                return refreshed;
            } catch (err) {
                if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
                    const msg = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`[anthropic-oauth] Refresh failed (${msg}); using still-valid current token\n`);
                    return latest;
                }
                throw err;
            }
        })().finally(() => { _oauthRefreshInFlight = null; });

        this.credentials = await _oauthRefreshInFlight;
        return this.credentials;
    }

    scrubTokens(text) {
        return _scrubTokens(text);
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm the kept-alive socket before the turn. preconnect() is a
        // best-effort no-op while a socket is still hot (TTL gate), but after an
        // idle gap longer than the keep-alive window it re-opens one in parallel
        // with auth/body build so the POST below skips the cold TLS handshake.
        preconnect('https://api.anthropic.com');
        // Defense-in-depth: enforce tool_use / tool_result pairing before
        // the Anthropic API call. The trim.mjs sanitize pass is normally
        // invoked by the budget trimmer in loop.mjs, but dispatches under
        // budget skip it — a tool that aborted mid-flight then leaves an
        // unmatched tool_use in messages, which the provider rejects with
        // a hard 400. Pairing here closes the gap regardless of caller.
        messages = sanitizeToolPairs(messages);
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const externalSignal = opts.signal || null;
        // Test seam: lets the retry harness drive stream outcomes without a
        // live OAuth session.
        const parseSSEFn = typeof opts._parseSSEFn === 'function' ? opts._parseSSEFn : parseSSEStream;

        let creds = await this.ensureAuth();
        // Default when the caller doesn't pin a model: newest high-tier chat
        // model from the live catalog (one warmup round-trip if cache is cold).
        const useModel = model || await ensureLatestAnthropicModel(this);
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        if (body.speed === 'fast') {
            this.fastModeBetaHeaderLatched = true;
        }
        // advanced-tool-use-2025-11-20 beta is only needed when this request
        // actually carries deferred (defer_loading) tools — gate the header on
        // that instead of sending it unconditionally on every request.
        const hasDeferredTools = Array.isArray(body.tools)
            && body.tools.some((t) => t && t.defer_loading === true);
        // Known tool names for the leaked-tool-call guard in parseSSEStream:
        // recovered leaked calls are only synthesized when they name a tool
        // actually offered to this request (native + lowered). Derived from the
        // final request body so it matches exactly what the model was given.
        const knownToolNames = new Set(
            (Array.isArray(body.tools) ? body.tools : [])
                .map((t) => (t && typeof t.name === 'string' ? t.name : null))
                .filter(Boolean),
        );
        const sessionId = opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        // Option A: no absolute wall-clock cap on streaming generation. A stream
        // that keeps emitting SSE deltas must NOT be killed by a fixed total-lifetime
        // timer — the old PROVIDER_GENERATE_TOTAL_TIMEOUT_MS (~285s, derived from the
        // stall WARN threshold) false-aborted live high-reasoning turns that were
        // still alive and producing tokens. The streaming phase is bounded instead by:
        //   (a) the per-attempt initial-response timeout in requestWithRetry
        //       (PROVIDER_HTTP_RESPONSE_TIMEOUT_MS) for a socket that never sends a
        //       first byte (truly wedged),
        //   (b) externalSignal (client disconnect / replaced-by-newer-request), and
        //   (c) the agent stall watchdog (STALL_ABORT_S, 600s, progress-based) plus
        //       the optional SSE idle watchdog for a stream that goes dead mid-flight.
        // totalSignal is therefore a pure pass-through of externalSignal with no timer.
        const totalTimeout = createPassthroughSignal(externalSignal);
        const totalSignal = totalTimeout.signal;

        const cleanupCancelHandler = (handler) => {
            if (!handler) return;
            try { totalSignal.removeEventListener('abort', handler); } catch {}
        };

        const doRequest = async (accessToken, requestSignal = null) => {
            const controller = createAbortController();
            const fetchStartedAt = Date.now();

            let cancelHandler = null;
            let attemptCancelHandler = null;
            if (totalSignal) {
                if (totalSignal.aborted) {
                    controller.abort(totalSignal.reason);
                    throw totalSignal.reason instanceof Error
                        ? totalSignal.reason
                        : new Error('Anthropic OAuth request aborted by session close');
                }
                cancelHandler = () => { try { controller.abort(totalSignal.reason); } catch {} };
                totalSignal.addEventListener('abort', cancelHandler, { once: true });
            }
            if (requestSignal && requestSignal !== totalSignal) {
                if (requestSignal.aborted) {
                    cleanupCancelHandler(cancelHandler);
                    controller.abort(requestSignal.reason);
                    throw requestSignal.reason instanceof Error
                        ? requestSignal.reason
                        : new Error('Anthropic OAuth request attempt aborted');
                }
                attemptCancelHandler = () => { try { controller.abort(requestSignal.reason); } catch {} };
                requestSignal.addEventListener('abort', attemptCancelHandler, { once: true });
            }

            try {
                try { onStageChange?.('requesting'); } catch {}
                // NOTE: do NOT sanitize here. body.messages was already
                // sanitized once inside toAnthropicMessages and then had cache
                // markers applied by applyAnthropicCacheMarkers. Re-sanitizing
                // after marking could drop/reorder a marked block and move the
                // provider-visible cache breakpoint off the cached one — the
                // exact COLD-turn bug this change fixes. Order is fixed:
                // build → sanitize (once) → mark → JSON.stringify.
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': buildAnthropicBetaHeaders({
                            base: OAUTH_BETA_HEADERS,
                            fastMode: this.fastModeBetaHeaderLatched,
                            toolSearch: hasDeferredTools,
                            effort: shouldIncludeEffortBeta(useModel, opts),
                        }),
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                    dispatcher: getLlmDispatcher(),
                });

                traceAgentFetch({
                    sessionId,
                    headersMs: Date.now() - fetchStartedAt,
                    httpStatus: response.status,
                    provider: 'anthropic-oauth',
                    model: useModel,
                    transport: 'sse',
                });

                if (attemptCancelHandler) {
                    try { requestSignal.removeEventListener('abort', attemptCancelHandler); } catch {}
                }
                return { response, controller, cancelHandler };
            } catch (err) {
                if (attemptCancelHandler) {
                    try { requestSignal.removeEventListener('abort', attemptCancelHandler); } catch {}
                }
                cleanupCancelHandler(cancelHandler);
                if (requestSignal?.aborted) {
                    const reason = requestSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request attempt aborted');
                }
                if (totalSignal?.aborted) {
                    const reason = totalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
                if (err?.name === 'AbortError') {
                    const timeoutErr = new Error(`Anthropic OAuth API initial response timed out after ${PROVIDER_HTTP_RESPONSE_TIMEOUT_MS}ms`);
                    timeoutErr.code = 'EPROVIDERTIMEOUT';
                    throw timeoutErr;
                }
                throw err;
            }
        };
        // Test seam: injectable request factory for retry-path tests.
        const doRequestImpl = typeof opts._doRequestFn === 'function' ? opts._doRequestFn : doRequest;

        const requestWithRetry = async (accessToken) => withRetry(async ({ signal: attemptSignal }) => {
            const result = await doRequestImpl(accessToken, attemptSignal);
            const status = Number(result?.response?.status || 0);
            const transientStatus = classifyError({ httpStatus: status }) === 'transient';
            if (transientStatus || status === 429) {
                if (status === 429) {
                    const quotaText = await result.response.text().catch(() => '');
                    cleanupCancelHandler(result.cancelHandler);
                    try { result.controller?.abort?.(); } catch {}
                    throw anthropicQuotaError(status, result?.response?.headers, this.scrubTokens(quotaText));
                }
                const err = new Error(`Anthropic OAuth API ${status}`);
                err.httpStatus = status;
                err.status = status;
                err.headers = result?.response?.headers;
                err.response = { status, headers: result?.response?.headers };
                const retryAfterMs = retryAfterMsFromError(err);
                if (transientStatus || retryAfterMs != null) {
                    try { await result.response.text(); } catch {}
                    cleanupCancelHandler(result.cancelHandler);
                    try { result.controller?.abort?.(); } catch {}
                    throw err;
                }
            }
            return result;
        }, {
            signal: totalSignal,
            maxAttempts: PROVIDER_RETRY_MAX_ATTEMPTS,
            backoffMs: PROVIDER_RETRY_BACKOFF_MS,
            perAttemptTimeoutMs: PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
            perAttemptLabel: 'Anthropic OAuth initial response',
            onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0) || null;
                const reason = status || lastErr?.code || lastErr?.message || 'network error';
                const suffix = delayReason ? ` (${delayReason})` : '';
                try {
                    process.stderr.write(
                        `[anthropic-oauth] retry attempt ${attempt + 1}/${PROVIDER_RETRY_MAX_ATTEMPTS} after ${reason}, backoff ${delayMs}ms${suffix}\n`,
                    );
                } catch {}
            },
        });
        // Bounded mid-stream retries for transient stream loss; jittered backoff
        // between attempts (see catch branches).
        const MAX_MIDSTREAM_RETRIES = ANTHROPIC_MAX_MIDSTREAM_RETRIES;
        let firstAttemptError = null;
        let firstAttemptClassifier = null;

        try {
        for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
            let response, controller, cancelHandler;
            ({ response, controller, cancelHandler } = await requestWithRetry(creds.accessToken));

            // 401: token expired/revoked. 403: organization permission flipped
            // (e.g. relogin into a different org). Both: force a shared refresh
            // and retry once with the new token.
            if (response.status === 401 || response.status === 403) {
                process.stderr.write(`[anthropic-oauth] ${response.status} — forcing refresh and retrying once\n`);
                cleanupCancelHandler(cancelHandler);
                creds = await this.ensureAuth({ forceRefresh: true, reason: String(response.status) });
                ({ response, controller, cancelHandler } = await requestWithRetry(creds.accessToken));
            }

            if (!response.ok) {
                cleanupCancelHandler(cancelHandler);
                const text = await response.text().catch(() => '');
                const safeText = this.scrubTokens(text).slice(0, 200);
                process.stderr.write(`[anthropic-oauth] API error ${response.status}: ${safeText}\n`);

                if (response.status === 429) {
                    throw anthropicQuotaError(response.status, response.headers, safeText);
                }

                // Phase I: on unknown/404 model errors, force a catalog refresh and
                // retry once. Protects against a silently-rotated model id.
                const isUnknownModel = response.status === 404
                    || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(safeText);
                if (isUnknownModel && !opts._modelRetry) {
                    process.stderr.write(`[anthropic-oauth] unknown model — refreshing catalog + 1 retry\n`);
                    await this._refreshModelCache();
                    const fallbackModel = resolveAnthropicModelAfter404(useModel);
                    if (fallbackModel) {
                        process.stderr.write(`[anthropic-oauth] model fallback ${useModel} -> ${fallbackModel}\n`);
                    }
                    return this.send(messages, fallbackModel || model, tools, { ...opts, _modelRetry: true });
                }
                throw new Error(`Anthropic OAuth API ${response.status}: ${safeText}`);
            }

            if (SSE_VERBOSE) process.stderr.write(`[anthropic-oauth] Response ${response.status}, parsing SSE...\n`);
            try { onStageChange?.('streaming'); } catch {}

            const midState = {
                attemptIndex,
                sawMessageStart: false,
                sawCompleted: false,
                emittedToolCall: false,
                // Gateway live-text relay invariant: set by parseSSEStream once
                // a non-empty text chunk has been forwarded to the client. A
                // later failure is non-retryable (rendered text cannot be
                // withdrawn; a retry would concatenate attempts).
                emittedText: false,
                userAbort: false,
                watchdogAbort: null,
                ttftAt: null,
            };

            try {
                const sseStartedAt = Date.now();
                const result = await parseSSEFn(
                    response,
                    controller.signal,
                    (reason) => controller.abort(reason),
                    onStreamDelta,
                    onToolCall,
                    midState,
                    onTextDelta,
                    knownToolNames,
                );

                const ttftMs = midState.ttftAt ? midState.ttftAt - sseStartedAt : null;
                const liveModel = result.model || useModel;
                traceAgentSse({
                    sessionId,
                    sseParseMs: Date.now() - sseStartedAt,
                    ttftMs,
                    provider: 'anthropic-oauth',
                    model: liveModel,
                    transport: 'sse',
                });

                traceAgentUsage({
                    sessionId,
                    iteration,
                    inputTokens: result.usage?.inputTokens || 0,
                    outputTokens: result.usage?.outputTokens || 0,
                    cachedTokens: result.usage?.cachedTokens || 0,
                    cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
                    promptTokens: result.usage?.promptTokens || 0,
                    model: liveModel,
                    modelDisplay: _displayModel(liveModel),
                    rawUsage: result.usage?.raw || null,
                    provider: 'anthropic-oauth',
                    requestKind: opts.requestKind || null,
                });

                // Phase I: if the live response surfaced a model id we don't know
                // about yet, kick off a background catalog refresh. Fire-and-forget
                // — do not await, do not surface errors.
                if (result.model && !_catalogHas(result.model)) {
                    void this._refreshModelCache();
                }

                if (SSE_VERBOSE) process.stderr.write(`[anthropic-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
                // Empty-stream guard. Invariant: a valid Anthropic SSE response
                // ALWAYS opens with message_start (which carries usage.input_tokens).
                // A 200 whose body produced no message_start delivered nothing —
                // no usage, no content, no tool calls — i.e. a dropped/empty stream
                // (transient, often rate-limit-adjacent under concurrent load), NOT
                // a valid terminal turn. Returning it surfaces upstream as a silent
                // empty turn (0 tokens, no content) that masks the cause. Throw a
                // marked error: retry is provably safe here (no message_start ⇒
                // nothing was emitted ⇒ no duplicate-tool risk), and once retries
                // are exhausted the error is surfaced instead of swallowed.
                if (!midState.sawMessageStart
                    && !midState.userAbort
                    && !midState.watchdogAbort
                    && !result.content
                    && !(result.toolCalls && result.toolCalls.length)
                    && !(result.usage && result.usage.inputTokens > 0)) {
                    const emptyErr = new Error('Anthropic OAuth SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)');
                    emptyErr.code = 'EEMPTYSTREAM';
                    emptyErr.isEmptyStream = true;
                    throw emptyErr;
                }
                try {
                    Object.defineProperty(result, '__midstreamRetries', { value: attemptIndex, enumerable: false });
                } catch { /* ignore non-extensible result */ }
                return result;
            } catch (err) {
                // Live-text invariant: once a non-empty text chunk has been
                // relayed to the client (gateway live mode), the rendered output
                // cannot be withdrawn and re-issuing would concatenate a second
                // attempt. Surface the failure immediately — never retry — and
                // tag the error so upstream layers refuse to retry as well.
                if (midState.emittedText) {
                    try { err.liveTextEmitted = true; err.unsafeToRetry = true; } catch {}
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    if (attemptIndex > 0 && firstAttemptError) {
                        try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                        try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                        // firstAttemptError is what actually propagates here when
                        // live text was emitted this attempt — stamp the unsafe
                        // flags onto IT too, else upstream sees an unmarked error
                        // and retries, duplicating already-streamed output.
                        try {
                            firstAttemptError.liveTextEmitted = true;
                            firstAttemptError.unsafeToRetry = true;
                        } catch {}
                        throw firstAttemptError;
                    }
                    throw err;
                }
                // Empty/dropped stream (no message_start): safe to retry once —
                // nothing was emitted, so there is no duplicate-tool risk. This
                // is intentionally NOT routed through _classifyMidstreamError,
                // which requires sawMessageStart and would reject it.
                if (err?.isEmptyStream && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = 'empty_stream';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try { process.stderr.write(`[anthropic-oauth] empty stream (no message_start) — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`); } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                if (classifyError(err) === 'transient'
                    && !midState.sawMessageStart
                    && !midState.emittedToolCall
                    && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = err?.providerErrorType || 'sse_transient';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try {
                        process.stderr.write(`[anthropic-oauth] transient SSE error — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (${err?.providerErrorType || err?.message || 'unknown'})\n`);
                    } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                // Truncated stream (message_start without message_stop): the
                // partial result is discarded and re-requesting is safe (a
                // pendingToolUse means the tool_use input JSON never completed).
                // _classifyMidstreamError does not cover this; route it through
                // the shared classifier so it inherits the cross-provider
                // transient policy instead of escaping and killing the worker.
                // Guard: parseSSEStream eagerly fires onToolCall and sets
                // emittedToolCall=true at content_block_stop, BEFORE message_stop.
                // If the stream truncates after that, retrying would
                // double-execute the tool. Only retry when nothing was emitted
                // yet; otherwise let the error surface.
                if ((err?.truncatedStream === true || err?.code === 'TRUNCATED_STREAM')
                    && classifyError(err) === 'transient'
                    && !midState.emittedToolCall
                    && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = 'truncated_stream';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try { process.stderr.write(`[anthropic-oauth] truncated stream — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`); } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                const classifier = _classifyMidstreamError(err, midState);
                if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = classifier;
                    try { controller?.abort?.(err); } catch (abortErr) {
                        /* best-effort stream teardown */
                        try { process.stderr.write(`[anthropic-oauth] abort on stream error failed: ${abortErr?.message ?? String(abortErr)}\n`); } catch {}
                    }
                    try {
                        process.stderr.write(`[anthropic-oauth] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`);
                    } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                if (attemptIndex > 0 && firstAttemptError) {
                    try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                    try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                    throw firstAttemptError;
                }
                throw err;
            } finally {
                cleanupCancelHandler(cancelHandler);
            }
        }
        throw firstAttemptError || new Error('Anthropic OAuth mid-stream retry: unreachable');
        } finally {
            totalTimeout.cleanup();
        }
    }

    async listModels() {
        // Dynamic lookup via /v1/models — returns whatever Anthropic currently
        // exposes for this OAuth account. Cached on disk with 24h TTL; falls
        // back to the static MODELS list on any failure so the plugin still
        // works offline or when Anthropic's /v1/models is momentarily down.
        const cached = await _loadModelCache();
        if (cached) {
            _setInMemoryCatalog(cached);
            return cached;
        }
        try {
            const creds = await this.ensureAuth();
            const res = await fetch('https://api.anthropic.com/v1/models', {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'anthropic-beta': OAUTH_BETA_HEADERS,
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                    'x-app': 'cli',
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            // Normalize + mark-latest + LiteLLM-enrich + persist (shared helper).
            const enriched = await normalizeAndSaveCatalog(items);
            return enriched;
        } catch (err) {
            if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\n`);
            // Fallback with full API model IDs. Short family tokens leaked
            // through here would be accepted by setup and reintroduce the
            // legacy shape. Env var override keeps this tracking defaults.
            const opusId   = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL   || 'claude-opus-4-8';
            const sonnetId = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
            const haikuId  = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5-20251001';
            return [
                { id: opusId,   display: 'Opus (auto)',   family: 'opus',   provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 1000000 },
                { id: sonnetId, display: 'Sonnet (auto)', family: 'sonnet', provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 1000000 },
                { id: haikuId,  display: 'Haiku (auto)',  family: 'haiku',  provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
            ];
        }
    }

    // Force a catalog refresh (ignores the 24h TTL). De-duped via
    // _modelRefreshInFlight so concurrent callers share one HTTP round-trip.
    // Returns the new catalog on success, null on failure.
    async _refreshModelCache() {
        if (_modelRefreshInFlight) return _modelRefreshInFlight;
        _modelRefreshInFlight = (async () => {
            try {
                const creds = await this.ensureAuth();
                const res = await fetch('https://api.anthropic.com/v1/models', {
                    signal: AbortSignal.timeout(10_000),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${creds.accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': OAUTH_BETA_HEADERS,
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                    },
                    dispatcher: getLlmDispatcher(),
                });
                if (!res.ok) throw new Error(`list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data : [];
                const enriched = await normalizeAndSaveCatalog(items);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _modelRefreshInFlight = null;
            }
        })();
        return _modelRefreshInFlight;
    }

    async isAvailable() {
        return this.credentials !== null || loadCredentials() !== null;
    }
}

// Re-exports so external callers of anthropic-oauth.mjs keep their existing
// import path after the credential/login-flow extraction into
// anthropic-oauth-credentials.mjs.
export {
    hasAnthropicOAuthCredentials,
    describeAnthropicOAuthCredentials,
    forgetAnthropicOAuthCredentials,
    beginOAuthLogin,
    loginOAuth,
};

// Re-exports so anthropic.mjs and the test harnesses keep their existing
// import path after the SSE-parser extraction into anthropic-sse.mjs.
export { parseSSEStream, _classifyMidstreamError, ANTHROPIC_MAX_MIDSTREAM_RETRIES };

// Test-only escape hatch for scripts/tool-smoke.mjs to verify the
// catalog-driven max-tokens resolution without duplicating its logic.
export const _test = { resolveMaxTokens };
