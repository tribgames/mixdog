import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.mjs';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs } from '../session/context-utils.mjs';
import { classifyError, withRetry } from './retry-classifier.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { parseSSEStream, _classifyMidstreamError } from './anthropic-oauth.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { normalizeContentForAnthropic } from './media-normalization.mjs';
import { enrichModels } from './model-catalog.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';

// 4-BP cache policy aligned with anthropic-oauth — tools + system + tier3
// + messages-tail. 1h TTL requires the extended-cache-ttl beta header,
// which we set on the client via defaultHeaders below.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };

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

// Mirrors anthropic-oauth.mjs gate: only the explicitly-tagged sessionMarker
// claims a 1h BP3 slot. composeSystemPrompt prefixes sessionMarker with
// `<!-- bp3-sentinel -->`; volatileTail (also a `<system-reminder>` user
// message) deliberately omits the sentinel so it stays on the message tail.
const BP3_SENTINEL = '<!-- bp3-sentinel -->';

function findTier3Index(chatMsgs) {
    for (let i = 0; i < chatMsgs.length; i++) {
        const m = chatMsgs[i];
        if (m?.role === 'user' && typeof m.content === 'string'
            && m.content.startsWith('<system-reminder>')
            && m.content.includes(BP3_SENTINEL)) {
            return i;
        }
    }
    return -1;
}

function resolveCacheTtls(opts) {
    const strategy = opts?.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    return {
        tools: pick('tools', CACHE_TTL_STABLE),
        system: pick('system', CACHE_TTL_STABLE),
        tier3: pick('tier3', CACHE_TTL_STABLE),
        messages: pick('messages', CACHE_TTL_STABLE),
    };
}

const MODELS = [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', family: 'sonnet', contextWindow: 1000000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', family: 'haiku', contextWindow: 200000 },
];
const ANTHROPIC_VERSION = '2023-06-01';

function _prettyName(id, family) {
    const v = String(id || '').match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    const base = family ? family[0].toUpperCase() + family.slice(1) : 'Claude';
    return v ? `${base} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : base;
}

function _defaultContextForModel(id, family) {
    const text = String(id || '');
    const version = text.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    if (Number(version?.[1] || 0) >= 5) return 1000000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/i.test(text)) return 1000000;
    if (family && family !== 'other') return 200000;
    return 200000;
}

function _normalizeAnthropicModel(raw, provider = 'anthropic') {
    const id = raw?.id || raw?.name || raw?.model;
    if (!id) return null;
    const familyMatch = String(id).match(/^claude-([a-z]+)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    const dated = /-\d{8}$/.test(String(id));
    const versioned = !dated && /^claude-[a-z]+-\d+(?:-\d+)?$/i.test(String(id));
    return {
        id,
        display: raw?.display_name || raw?.displayName || raw?.display || _prettyName(id, family),
        family,
        provider,
        contextWindow: raw?.context_window || raw?.max_context_window || raw?.input_token_limit || raw?.inputTokenLimit || _defaultContextForModel(id, family),
        outputTokens: raw?.max_output_tokens || raw?.output_token_limit || raw?.outputTokenLimit || null,
        tier: dated ? 'dated' : versioned ? 'version' : 'family',
        latest: false,
    };
}
// Family-based heuristic so new model ids (including custom user-configured
// ones) resolve a sensible max_tokens without requiring a code change.
function resolveMaxTokens(model) {
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 32768;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
}

// Effort → thinking budget tokens (Anthropic extended thinking)
const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    max: 32768,
};

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
// Anthropic forbids oneOf / allOf / anyOf at the TOP level of input_schema.
// Mirror the same sanitizer as anthropic-oauth.mjs so both providers are safe.
function _sanitizeInputSchema(schema, toolName) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    const compound = schema.oneOf || schema.anyOf || schema.allOf;
    if (!compound) return structuredClone(schema);
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
            `[anthropic-sanitizer] tool="${toolName ?? ''}" compound="${compoundKey}" branches=${Array.isArray(compound) ? compound.length : 0} mergedProps=${mergedPropsCount}\n`
        );
    }
    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: mergedProps,
    };
}

function toAnthropicTools(tools) {
    return tools.map((t) => {
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
function deferredAnthropicTools(activeTools, opts) {
    if (opts?.session?.deferredNativeTools !== true) return [];
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
            }
            else {
                result.push({ role: 'user', content: [block] });
            }
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
//   tier3:        the user message whose first text block / string content
//                 startsWith '<system-reminder>' AND includes BP3_SENTINEL —
//                 mark its last content block with tier3Ttl.
//   message-anchor: prefer a safe tool_result tail, then a previous real user
//                   text turn if another slot remains. Synthetic
//                   <system-reminder> messages and current pure-text prompts
//                   are excluded so per-call volatileTail/current prompt
//                   content never becomes a 1h prefix key.
// messageTtl === null disables the tail; tier3Ttl === null disables tier3.
// ANTHROPIC_MSG_SLOTS=0 is honoured upstream by passing messageTtl = null.
function applyAnthropicCacheMarkers(sanitizedMessages, { messageTtl = CACHE_TTL_VOLATILE, messageSlots = 1, tier3Ttl = null } = {}) {
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
    const isTier3SystemReminder = (content) => {
        const text = firstText(content);
        return text.startsWith('<system-reminder>') && text.includes(BP3_SENTINEL);
    };

    const markLast = (msg, ttl) => {
        if (!msg) return;
        msg.content = appendCacheControl(msg.content, ttl);
    };
    const ttlRank = (ttl) => ttl?.ttl === '1h' ? 2 : 1;
    const canMarkMessageIdx = (idx, tier3Idx) => {
        if (idx < 0) return false;
        const msg = sanitizedMessages[idx];
        if (ttlRank(messageTtl) > ttlRank(CACHE_TTL_VOLATILE)
            && isSystemReminder(msg?.content)
            && !isTier3SystemReminder(msg?.content)) {
            return false;
        }
        if (tier3Idx >= 0 && idx < tier3Idx && ttlRank(messageTtl) < ttlRank(tier3Ttl)) {
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
        const tailIdx = sanitizedMessages.length - 1;
        for (let i = tailIdx - 1; i >= 0; i--) {
            if (hasUserText(sanitizedMessages[i])) return i;
        }
        return -1;
    };
    const latestToolResultTailIdx = () => {
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const msg = sanitizedMessages[i];
            if (msg?.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) continue;
            const lastBlock = msg.content[msg.content.length - 1];
            if (lastBlock?.type === 'tool_result') return i;
        }
        return -1;
    };

    // tier3 — locate the sentinel-tagged system-reminder user message.
    let tier3MsgIdx = -1;
    if (tier3Ttl !== null) {
        for (let i = 0; i < sanitizedMessages.length; i++) {
            const m = sanitizedMessages[i];
            if (m?.role === 'user' && isTier3SystemReminder(m.content)) {
                tier3MsgIdx = i;
                break;
            }
        }
        if (tier3MsgIdx >= 0) markLast(sanitizedMessages[tier3MsgIdx], tier3Ttl);
    }

    if (messageTtl !== null) {
        const slots = Math.max(0, Math.min(4, Number(messageSlots) || 0));
        const marked = new Set(tier3MsgIdx >= 0 ? [tier3MsgIdx] : []);
        const candidates = [latestToolResultTailIdx(), previousUserTextAnchorIdx()];
        for (const idx of candidates) {
            if (slots <= 0) break;
            if (idx < 0 || marked.has(idx) || !canMarkMessageIdx(idx, tier3MsgIdx)) continue;
            markLast(sanitizedMessages[idx], messageTtl);
            marked.add(idx);
            if (marked.size - (tier3MsgIdx >= 0 ? 1 : 0) >= slots) break;
        }
    }

    return sanitizedMessages;
}
export class AnthropicProvider {
    // Anthropic reports usage.input_tokens EXCLUDING cache_read/cache_creation
    // (those are separate fields), so the live context-window footprint must
    // add cache_read back. See providerInputExcludesCache() in registry.mjs.
    static inputExcludesCache = true;
    name = 'anthropic';
    client;
    config;
    fastModeBetaHeaderLatched = false;
    constructor(config) {
        this.config = config;
        this.name = config.name || 'anthropic';
        const betaHeaders = config.disableBetaHeaders ? null : buildAnthropicBetaHeaders({ toolSearch: true });
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
            defaultHeaders: { ...(betaHeaders ? { 'anthropic-beta': betaHeaders } : {}), ...(config.extraHeaders || {}) },
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.[this.name] || freshConfig.providers?.anthropic;
            const newKey = cfg?.apiKey || this.config.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
            if (newKey) {
                this.config = { ...(this.config || {}), ...(cfg || {}), apiKey: newKey };
                const betaHeaders = this.config.disableBetaHeaders ? null : buildAnthropicBetaHeaders({ toolSearch: true });
                this.client = new Anthropic({
                    apiKey: newKey,
                    ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
                    defaultHeaders: { ...(betaHeaders ? { 'anthropic-beta': betaHeaders } : {}), ...(this.config.extraHeaders || {}) },
                });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
        // Defense-in-depth: enforce tool_use / tool_result pairing before
        // the Anthropic API call. Mirror of the OAuth path; loop.mjs only
        // runs sanitizeToolPairs when budget is exceeded, so an under-budget
        // dispatch with an aborted-mid-flight tool_use would otherwise hit
        // the provider as a hard 400 (`tool_use ids ... without tool_result`).
        messages = sanitizeToolPairs(messages);
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools, sendOpts) {
        if (!model) throw new Error(`[${this.name}] model is required — pass it from the caller preset`);
        const useModel = model;
        const maxTokens = resolveMaxTokens(useModel);
        const opts = sendOpts || {};
        const ttls = resolveCacheTtls(opts);

        const systemMsgs = messages.filter(m => m.role === 'system');
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const systemText = systemMsgs.map(m => m.content).join('\n\n') || undefined;

        // 4-BP budget: aligned with anthropic-oauth. tools BP is dropped —
        // system BP covers the tools prefix via Anthropic prefix semantics
        // (order: tools → system → messages). That frees 1 slot for
        // messages-tail.
        const toolsBpUsed = 0;
        const systemBpUsed = ttls.system && systemText ? 1 : 0;
        const tier3Idx = ttls.tier3 ? findTier3Index(chatMsgs) : -1;
        const tier3BpUsed = tier3Idx >= 0 ? 1 : 0;
        const usedSlots = toolsBpUsed + systemBpUsed + tier3BpUsed;
        // Env override for BP strategy. ANTHROPIC_MSG_SLOTS=0 disables
        // message caching entirely. Any value >=1 first marks the previous
        // user text turn; a second free slot marks the tail. Mirrors
        // anthropic-oauth.mjs for twin parity.
        const msgSlotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
        const defaultMsgSlots = Math.max(0, 4 - usedSlots);
        const msgSlots = ttls.messages
            ? (Number.isFinite(msgSlotsCap) && msgSlotsCap >= 0 ? Math.min(msgSlotsCap, defaultMsgSlots) : defaultMsgSlots)
            : 0;
        // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers
        // are applied to the FINAL sanitized array by invariant, so block
        // drops / inserts / reorders performed by the sanitizer can never move
        // or delete a marked block. NEVER sanitize again after this.
        // msgSlots === 0 → message-tail disabled.
        const tailTtl = msgSlots > 0 ? ttls.messages : null;
        const tier3Ttl = tier3Idx >= 0 ? ttls.tier3 : null;
        const anthropicMessages = applyAnthropicCacheMarkers(
            toAnthropicMessages(chatMsgs),
            { messageTtl: tailTtl, messageSlots: msgSlots, tier3Ttl },
        );

        const params = {
            model: useModel,
            max_tokens: maxTokens,
            system: systemText
                ? [ttls.system
                    ? { type: 'text', text: systemText, cache_control: ttls.system }
                    : { type: 'text', text: systemText }]
                : undefined,
            messages: anthropicMessages,
        };
        const nativeTools = nativeAnthropicTools(opts);
        if (tools?.length || nativeTools.length) {
            // No cache_control on tools — the system BP covers tools via
            // Anthropic prefix semantics (order: tools → system → messages).
            params.tools = [...nativeTools, ...toAnthropicTools([...(tools || []), ...deferredAnthropicTools(tools || [], opts)])];
        }
        // Effort → extended thinking budget. Gateway inherit mode may pass the
        // exact Claude Code budget from the incoming Anthropic request.
        const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
        const requestedThinkingBudget = Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0
            ? thinkingBudgetTokens
            : (opts.effort && EFFORT_BUDGET[opts.effort] ? EFFORT_BUDGET[opts.effort] : null);
        const budgetTokens = clampThinkingBudgetTokens(requestedThinkingBudget, maxTokens);
        if (budgetTokens) {
            params.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }
        // Fast mode → speed: "fast" on models Anthropic marks as speed-capable.
        if (opts.fast === true && supportsAnthropicFastMode(useModel)) {
            params.speed = 'fast';
            this.fastModeBetaHeaderLatched = true;
        }
        // NOTE: do NOT sanitize here. params.messages was already sanitized
        // once inside toAnthropicMessages and then had cache markers applied.
        // Re-sanitizing after marking could drop/reorder a marked block and
        // move the provider-visible cache breakpoint off the cached one — the
        // exact COLD-turn bug this change fixes. Order: build → sanitize
        // (once) → mark → send.
        params.stream = true;

        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;

        // No absolute wall-clock cap on streaming generation: a stream still
        // emitting SSE deltas must not be killed by a fixed total-lifetime timer.
        // Mirrors the OAuth provider (Option A). Bounded instead by the
        // per-attempt first-byte/HTTP-response timeout, the SSE idle watchdog,
        // the agent stall watchdog, and externalSignal (client disconnect /
        // replaced-by-newer-request). totalSignal is a pure pass-through.
        const externalSignal = opts.signal || null;
        const totalTimeout = createPassthroughSignal(externalSignal);
        const totalSignal = totalTimeout.signal;

        const cleanupCancelHandler = (handler) => {
            if (!handler) return;
            try { totalSignal.removeEventListener('abort', handler); } catch {}
        };

        const betaHeaders = {
            'anthropic-beta': buildAnthropicBetaHeaders({
                fastMode: this.fastModeBetaHeaderLatched,
                toolSearch: true,
            }),
        };

        const MAX_MIDSTREAM_RETRIES = 1;
        let firstAttemptError = null;
        let firstAttemptClassifier = null;

        const buildReturnFromParse = (parseResult) => {
            const usageRaw = parseResult.usage?.raw || null;
            const input = parseResult.usage?.inputTokens || 0;
            const cacheRead = parseResult.usage?.cachedTokens || 0;
            const cacheWrite = parseResult.usage?.cacheWriteTokens || 0;
            const output = parseResult.usage?.outputTokens || 0;
            const promptTokens = parseResult.usage?.promptTokens ?? (input + cacheRead + cacheWrite);
            const liveModel = parseResult.model || useModel;

            if (usageRaw || input || output || cacheRead || cacheWrite) {
                traceAgentUsage({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                    inputTokens: input,
                    outputTokens: output,
                    cachedTokens: cacheRead,
                    cacheWriteTokens: cacheWrite,
                    promptTokens,
                    model: liveModel,
                    modelDisplay: liveModel,
                    responseId: null,
                    rawUsage: usageRaw,
                    provider: this.name,
                    requestKind: opts.requestKind || null,
                });
            }

            return {
                content: parseResult.content || '',
                model: liveModel,
                toolCalls: parseResult.toolCalls,
                stopReason: parseResult.stopReason || null,
                hasThinkingContent: !!parseResult.hasThinkingContent,
                contentBlockTypes: Array.isArray(parseResult.contentBlockTypes)
                    ? parseResult.contentBlockTypes
                    : [],
                usage: {
                    inputTokens: input,
                    outputTokens: output,
                    cachedTokens: cacheRead,
                    cacheWriteTokens: cacheWrite,
                    promptTokens,
                },
            };
        };

        try {
            for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
                const streamController = createAbortController();
                let cancelHandler = null;

                if (totalSignal) {
                    if (totalSignal.aborted) {
                        const reason = totalSignal.reason;
                        throw reason instanceof Error
                            ? reason
                            : new Error('Anthropic request aborted');
                    }
                    cancelHandler = () => {
                        try { streamController.abort(totalSignal.reason); } catch {}
                    };
                    totalSignal.addEventListener('abort', cancelHandler, { once: true });
                }

                const midState = {
                    attemptIndex,
                    sawMessageStart: false,
                    sawCompleted: false,
                    emittedToolCall: false,
                    // Gateway live-text relay invariant: set by parseSSEStream
                    // once a non-empty text chunk has been forwarded. A later
                    // failure is non-retryable (rendered text cannot be
                    // withdrawn; a retry would concatenate attempts).
                    emittedText: false,
                    userAbort: false,
                    watchdogAbort: null,
                };

                let firstBytePoll = null;
                let firstByteTimeout = null;

                try {
                    try { onStageChange?.('requesting'); } catch {}

                    const response = await withRetry(
                        async ({ signal: attemptSignal }) => {
                            const res = await this.client.messages.create(params, {
                                signal: attemptSignal,
                                headers: betaHeaders,
                            }).asResponse();
                            if (!res.ok) {
                                const text = await res.text().catch(() => '');
                                const err = new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
                                err.status = res.status;
                                err.httpStatus = res.status;
                                throw err;
                            }
                            if (!res.body) {
                                throw new Error('Anthropic streaming response has no body');
                            }
                            return res;
                        },
                        {
                            signal: totalSignal,
                            perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                            perAttemptLabel: `${this.name} Anthropic streaming response`,
                            onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                                const delayLabel = Number.isFinite(Number(delayMs))
                                    ? `, delay ${delayMs}ms${delayReason ? ` (${delayReason})` : ''}`
                                    : '';
                                process.stderr.write(
                                    `[${this.name}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`,
                                );
                            },
                        },
                    );

                    try { onStageChange?.('streaming'); } catch {}

                    firstByteTimeout = createTimeoutSignal(
                        streamController.signal,
                        PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                        'Anthropic SSE first byte',
                    );
                    firstByteTimeout.signal.addEventListener('abort', () => {
                        if (!midState.sawMessageStart) {
                            try { streamController.abort(firstByteTimeout.signal.reason); } catch {}
                        }
                    }, { once: true });

                    firstBytePoll = setInterval(() => {
                        if (midState.sawMessageStart) {
                            firstByteTimeout?.cleanup();
                            clearInterval(firstBytePoll);
                            firstBytePoll = null;
                        }
                    }, 25);

                    const parseResult = await parseSSEStream(
                        response,
                        streamController.signal,
                        () => streamController.abort(),
                        onStreamDelta,
                        onToolCall,
                        midState,
                        onTextDelta,
                    );

                    if (firstBytePoll) {
                        clearInterval(firstBytePoll);
                        firstBytePoll = null;
                    }
                    firstByteTimeout?.cleanup();

                    if (!midState.sawMessageStart
                        && !midState.userAbort
                        && !midState.watchdogAbort
                        && !parseResult.content
                        && !(parseResult.toolCalls && parseResult.toolCalls.length)
                        && !(parseResult.usage && parseResult.usage.inputTokens > 0)) {
                        const emptyErr = new Error(
                            'Anthropic SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)',
                        );
                        emptyErr.code = 'EEMPTYSTREAM';
                        emptyErr.isEmptyStream = true;
                        throw emptyErr;
                    }

                    return buildReturnFromParse(parseResult);
                } catch (err) {
                    // Live-text invariant: once a non-empty text chunk has been
                    // relayed to the client (gateway live mode), the rendered
                    // output cannot be withdrawn and re-issuing would concatenate
                    // a second attempt. Surface immediately — never retry — and
                    // tag the error so upstream layers refuse to retry as well.
                    if (midState.emittedText) {
                        try { err.liveTextEmitted = true; err.unsafeToRetry = true; } catch {}
                        try { streamController.abort?.(err); } catch {}
                        if (attemptIndex > 0 && firstAttemptError) {
                            try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                            try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                            throw firstAttemptError;
                        }
                        throw err;
                    }
                    if (err?.isEmptyStream && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = 'empty_stream';
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] empty stream (no message_start) — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`,
                            );
                        } catch {}
                        continue;
                    }
                    if ((err?.truncatedStream === true || err?.code === 'TRUNCATED_STREAM')
                        && classifyError(err) === 'transient'
                        && !midState.emittedToolCall
                        && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = 'truncated_stream';
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] truncated stream — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`,
                            );
                        } catch {}
                        continue;
                    }
                    const classifier = _classifyMidstreamError(err, midState);
                    if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = classifier;
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`,
                            );
                        } catch {}
                        continue;
                    }
                    if (attemptIndex > 0 && firstAttemptError) {
                        try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                        try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                        throw firstAttemptError;
                    }
                    throw err;
                } finally {
                    if (firstBytePoll) clearInterval(firstBytePoll);
                    firstByteTimeout?.cleanup();
                    cleanupCancelHandler(cancelHandler);
                }
            }
            throw firstAttemptError || new Error('Anthropic mid-stream retry: unreachable');
        } finally {
            totalTimeout.cleanup();
        }
    }
    async listModels() {
        const apiKey = this.config?.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
        if (!apiKey) return MODELS;
        try {
            const base = String(this.config?.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
            const res = await fetch(`${base}/v1/models`, {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    ...(this.config?.extraHeaders || {}),
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            const normalized = items
                .map((m) => _normalizeAnthropicModel(m, this.name))
                .filter(Boolean);
            const enriched = await enrichModels(normalized);
            return enriched.length ? enriched : MODELS;
        }
        catch (err) {
            if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[${this.name}] listModels fetch failed (${err.message})\n`);
            return MODELS;
        }
    }
    async isAvailable() {
        try {
            await this.client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
            });
            return true;
        }
        catch {
            return false;
        }
    }
}
