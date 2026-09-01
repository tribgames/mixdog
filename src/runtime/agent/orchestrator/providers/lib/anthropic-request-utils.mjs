import { providerNativeToolPrefixCount } from '../../../../../session-runtime/provider-request-tools.mjs';
import { isNativeServerToolBlockType } from './anthropic-native-blocks.mjs';
import {
    isAnthropicThinkingBlock,
    sanitizeAnthropicReplayBlocks,
} from './anthropic-replay-blocks.mjs';
import { sanitizeAnthropicContentPairs, foldUserTextIntoToolResultTail } from '../../session/context-utils.mjs';
import { normalizeContentForAnthropic } from '../media-normalization.mjs';
import { createProviderReplay, providerReplayItems } from './provider-replay.mjs';
import {
    anthropicFallbackProviderMetadata,
    parseAnthropicFallbackBlock,
} from '../anthropic-server-fallback.mjs';
import { SUMMARY_PREFIX_ANCHOR } from '../../session/compact/constants.mjs';

export const ANTHROPIC_CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };
export const ANTHROPIC_CACHE_TTL_VOLATILE = { type: 'ephemeral' };

function appendAnthropicCacheControl(content, ttl = ANTHROPIC_CACHE_TTL_VOLATILE) {
    const withCacheControl = (block) => {
        if (!block || typeof block !== 'object' || block.cache_control) return block;
        return { ...block, cache_control: ttl };
    };
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1]);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content })];
    }
    return content;
}

export function resolveAnthropicCacheTtls(opts) {
    const strategy = opts?.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const value = strategy[layer];
        if (value === '1h') return ANTHROPIC_CACHE_TTL_STABLE;
        if (value === '5m') return ANTHROPIC_CACHE_TTL_VOLATILE;
        if (value === 'none') return null;
        return fallback;
    };
    const resolved = {
        tools: pick('tools', null),
        system: pick('system', ANTHROPIC_CACHE_TTL_STABLE),
        tier3: pick('tier3', ANTHROPIC_CACHE_TTL_STABLE),
        messages: pick('messages', ANTHROPIC_CACHE_TTL_VOLATILE),
    };
    const ttlRank = (ttl) => (ttl === ANTHROPIC_CACHE_TTL_STABLE ? 2 : 1);
    let minRank = Infinity;
    for (const layer of ['system', 'tier3', 'messages']) {
        if (!resolved[layer]) continue;
        const rank = ttlRank(resolved[layer]);
        if (rank > minRank) resolved[layer] = ANTHROPIC_CACHE_TTL_VOLATILE;
        else minRank = rank;
    }
    return resolved;
}

// Message-tail cache budget, shared by both Anthropic providers.
//
// 4-BP layout: the tools breakpoint is dropped — the system BP covers the tools
// prefix via Anthropic's prompt-cache prefix semantics (order: tools → system →
// messages), which frees its slot for the messages tail. The system blocks hold
// BP1/BP2/BP3 (tier3), so every consumed slot is already counted there.
//
// Env override: ANTHROPIC_MSG_SLOTS=0 disables message caching entirely; any
// value >=1 first marks the previous user text turn so consecutive requests
// share a breakpoint, and a second free slot marks the tail for the newest
// delta. messageTtl === null (no slot, or ttls.messages disabled) turns the
// tail off.
export function resolveAnthropicMessageCacheSlots(systemBlocks, ttls) {
    const usedSlots = systemBlocks.filter(b => b.cache_control).length;
    const slotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
    const defaultSlots = Math.max(0, 4 - usedSlots);
    const messageSlots = ttls.messages
        ? (Number.isFinite(slotsCap) && slotsCap >= 0 ? Math.min(slotsCap, defaultSlots) : defaultSlots)
        : 0;
    // Key order matches the object both call sites built inline: messageTtl
    // first, then messageSlots.
    return { messageTtl: messageSlots > 0 ? ttls.messages : null, messageSlots };
}

// Single lowering of orchestrator messages to the Anthropic wire shape. The
// API-key provider (anthropic.mjs, via anthropic-messages.mjs) and the OAuth
// provider (anthropic-oauth.mjs) both used to carry byte-identical copies;
// they now share this one.
//
// Marker-free lowering. cache_control is applied AFTER sanitization by
// applyAnthropicCacheMarkers() so that block drops/inserts/reorders performed
// by sanitizeAnthropicContentPairs cannot move or delete a marked block (the
// root cause of the sporadic COLD-turn cache miss: pre-sanitize markers landed
// on blocks the sanitizer then rewrote, so the provider-visible breakpoint
// diverged from the cached one).
// Optional `availableTools`: the exact tool list this request will ship. A
// tool_reference whose tool is absent from that list makes the API reject the
// WHOLE request ("Tool reference '<name>' not found in available tools"), and
// the dangling block lives in the transcript — so once a loaded tool leaves
// the deferred catalog (feature toggle, provider/model rebuild, disconnected
// MCP server) every later turn of that session fails identically. Passing the
// list lets the lowering drop unresolvable references instead. Omitted =>
// every reference is kept verbatim.
function anthropicToolNameSet(availableTools) {
    if (!Array.isArray(availableTools)) return null;
    const names = new Set();
    for (const tool of availableTools) {
        const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
        if (name) names.add(name);
    }
    return names;
}

// Replacement content for a tool_result whose references were all dropped.
// The stored text result (the deferred-load summary) is the natural fallback;
// an EMPTY tool_result is itself a 400, so a blank result gets a placeholder.
function toolResultContentWithoutReferences(message, droppedNames) {
    const normalized = normalizeContentForAnthropic(message.content);
    if (typeof normalized === 'string' && normalized.trim()) return normalized;
    if (Array.isArray(normalized) && normalized.length > 0) return normalized;
    return [{
        type: 'text',
        text: `[tool references dropped - no longer available: ${droppedNames.join(', ')}]`,
    }];
}

export function toAnthropicMessages(messages, availableTools) {
    const availableNames = anthropicToolNameSet(availableTools);
    const result = [];
    for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (m.role === 'system') continue;
        const orderedReplay = m.role === 'assistant'
            ? providerReplayItems(m, 'anthropic')
            : undefined;
        if (m.role === 'assistant' && (orderedReplay?.length || m.toolCalls?.length || m.assistantBlocks?.length || m.thinkingBlocks?.length)) {
            let content;
            if (orderedReplay?.length) {
                content = orderedReplay;
            } else if (m.assistantBlocks?.length) {
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
                for (const tc of m.toolCalls || []) {
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
            const native = m.nativeToolSearch;
            const nativeProvider = String(native?.provider || '').toLowerCase();
            const anthropicNative = new Set(['anthropic', 'anthropic-oauth']);
            const references = (!nativeProvider || anthropicNative.has(nativeProvider))
                && Array.isArray(native?.toolReferences)
                ? native.toolReferences.map((name) => String(name || '').trim()).filter(Boolean)
                : [];
            // Keep only references this request can actually back with a
            // definition; a reference without one is a hard 400 on every turn
            // that replays it (see anthropicToolNameSet).
            const usableReferences = availableNames
                ? references.filter((name) => availableNames.has(name))
                : references;
            const droppedReferences = usableReferences.length === references.length
                ? []
                : references.filter((name) => !usableReferences.includes(name));
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: usableReferences.length
                    ? usableReferences.map((tool_name) => ({ type: 'tool_reference', tool_name }))
                    : (droppedReferences.length
                        ? toolResultContentWithoutReferences(m, droppedReferences)
                        : normalizeContentForAnthropic(m.content)),
                ...((m.toolKind === 'error' || m.isError === true) ? { is_error: true } : {}),
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                result.push({ role: 'user', content: [block] });
            }
            continue;
        }
        // First-party client parity: fold a user text turn that directly follows a
        // tool_result turn into that tool_result's content. A sibling text turn
        // after tool_result renders as `</function_results>\n\nHuman:` on the wire
        // and trains the model toward 3-token empty end_turn completions (empty
        // end_turn livelock prevention; see foldUserTextIntoToolResultTail).
        //   EXCEPTION: steering-origin user messages (human/TUI interjections)
        //   keep their own user turn so provenance survives — folding them would
        //   disguise user input as tool output. Anthropic accepts a user text
        //   message after a tool_result message, so the turn stays request-valid.
        const isSteering = m.role === 'user' && m.meta?.source === 'steering';
        if (m.role === 'user' && !isSteering
            && foldUserTextIntoToolResultTail(result, normalizeContentForAnthropic(m.content))) {
            continue;
        }
        result.push({ role: m.role, content: normalizeContentForAnthropic(m.content) });
    }
    return sanitizeAnthropicContentPairs(result);
}

export function clampAnthropicThinkingBudget(value, maxTokens) {
    const desired = Math.floor(Number(value));
    const max = Math.floor(Number(maxTokens));
    if (!Number.isFinite(desired) || desired <= 0 || !Number.isFinite(max)) return null;
    const ceiling = max - 1024;
    if (ceiling < 1024) return null;
    return Math.max(1024, Math.min(desired, ceiling));
}

// Assistant blocks that are replayable verbatim alongside native server-tool
// blocks. `text` is handled separately (empty text blocks are dropped, exactly
// like parseSSEStream's assistantBlocks list).
const REPLAYABLE_ASSISTANT_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'tool_use']);

export function normalizeAnthropicNonStreamingResponse(message, fallbackModel = '') {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const fallbackEvents = blocks.map(parseAnthropicFallbackBlock).filter(Boolean);
    const text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text || ''))
        .join('');
    const toolCalls = blocks
        .filter((block) => block?.type === 'tool_use')
        .map((block) => ({
            id: block.id,
            name: block.name,
            arguments: block.input && typeof block.input === 'object' ? block.input : {},
        }));
    // Replay-safe projection of the turn: empty text blocks removed (the API
    // rejects them) without letting that removal fuse two separate thinking
    // runs into one, which the API rejects just as hard and permanently
    // (anthropic-replay-blocks.mjs).
    const replayableBlocks = sanitizeAnthropicReplayBlocks(blocks);
    const thinkingBlocks = replayableBlocks.filter(isAnthropicThinkingBlock);
    const modelEmittedThinking = blocks.some(isAnthropicThinkingBlock);
    // Anthropic NATIVE server-tool turns (web search / web fetch / code
    // execution / native MCP) cannot be rebuilt from the flattened
    // text/toolCalls/thinking projections above: `server_tool_use` and its
    // `*_tool_result` are opaque and order-bound (a result block is valid ONLY
    // right after its call block). Keep the ordered raw list so the loop can
    // replay the paused turn verbatim on the `pause_turn` continuation —
    // mirror of parseSSEStream's assistantBlocks, including its
    // absent-for-ordinary-turns rule, so plain text/thinking/tool_use
    // responses keep the existing lowering and never double-replay.
    const nativeAssistantBlocks = blocks.some((block) => isNativeServerToolBlockType(block?.type))
        ? replayableBlocks.filter((block) => (
            isNativeServerToolBlockType(block.type)
            || REPLAYABLE_ASSISTANT_BLOCK_TYPES.has(block.type)
            || block.type === 'text'
        ))
        : [];
    const usage = message?.usage || {};
    const input = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    return {
        content: text,
        model: fallbackEvents.at(-1)?.fallbackModel || message?.model || fallbackModel,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        stopReason: message?.stop_reason || null,
        hasThinkingContent: modelEmittedThinking,
        contentBlockTypes: blocks.map((block) => block?.type).filter(Boolean),
        thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
        assistantBlocks: nativeAssistantBlocks.length ? nativeAssistantBlocks : undefined,
        providerReplay: createProviderReplay('anthropic', replayableBlocks),
        providerMetadata: anthropicFallbackProviderMetadata(fallbackEvents),
        usage: {
            inputTokens: input,
            outputTokens: Number(usage.output_tokens) || 0,
            cachedTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            promptTokens: input + cacheRead + cacheWrite,
            raw: usage,
        },
    };
}

function mergeAnthropicFlatProperty(current, incoming) {
    if (!current || typeof current !== 'object') return structuredClone(incoming);
    if (!incoming || typeof incoming !== 'object') return structuredClone(current);
    const merged = { ...structuredClone(incoming), ...structuredClone(current) };
    if (Array.isArray(current.enum) || Array.isArray(incoming.enum)) {
        merged.enum = [...new Set([
            ...(Array.isArray(current.enum) ? current.enum : []),
            ...(Array.isArray(incoming.enum) ? incoming.enum : []),
        ])];
    }
    if (current.properties || incoming.properties) {
        merged.properties = {};
        for (const [name, property] of Object.entries(current.properties || {})) {
            merged.properties[name] = structuredClone(property);
        }
        for (const [name, property] of Object.entries(incoming.properties || {})) {
            merged.properties[name] = mergeAnthropicFlatProperty(
                merged.properties[name],
                property,
            );
        }
    }
    if (Array.isArray(current.required) && Array.isArray(incoming.required)) {
        const incomingRequired = new Set(incoming.required);
        const sharedRequired = current.required.filter((name) => incomingRequired.has(name));
        if (sharedRequired.length) merged.required = sharedRequired;
        else delete merged.required;
    } else {
        delete merged.required;
    }
    return merged;
}

export function sanitizeAnthropicInputSchema(schema, toolName, logTag) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    const compound = schema.oneOf || schema.anyOf || schema.allOf;
    if (!compound) return structuredClone(schema);
    const mergedProps = { ...(schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) };
    const branchDescs = [];
    for (const branch of Array.isArray(compound) ? compound : []) {
        if (branch && typeof branch === 'object' && branch.properties) {
            for (const [name, property] of Object.entries(branch.properties)) {
                mergedProps[name] = mergeAnthropicFlatProperty(mergedProps[name], property);
            }
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
            const value = `(variant ${i + 1}: ${branchDescs[i]})`;
            if (used + value.length + (parts.length ? 1 : 0) > 500) break;
            parts.push(value);
            used += value.length + (parts.length > 1 ? 1 : 0);
        }
        const addition = parts.join(' ');
        if (addition) description = description ? `${description} ${addition}` : addition;
    }
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(
            `[${logTag}-sanitizer] tool="${toolName ?? ''}" compound="${compoundKey}" branches=${Array.isArray(compound) ? compound.length : 0} mergedProps=${Object.keys(mergedProps).length}\n`
        );
    }
    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: mergedProps,
        ...(Array.isArray(schema.required) && schema.required.length
            ? { required: [...schema.required] }
            : {}),
        ...(schema.additionalProperties === false ? { additionalProperties: false } : {}),
    };
}

function toAnthropicTools(tools, logTag) {
    return tools.map((tool) => {
        const out = {
            name: tool.name,
            description: tool.description,
            input_schema: sanitizeAnthropicInputSchema(tool.inputSchema, tool.name, logTag),
        };
        if (tool.deferLoading === true || tool.defer_loading === true) out.defer_loading = true;
        return out;
    });
}

export function toAnthropicToolChoice(toolChoice) {
    return toolChoice === 'none' ? { type: 'none' } : undefined;
}

export function deferredAnthropicTools(activeTools, messages, opts, provider) {
    if (opts?.session?.deferredNativeTools !== true) return [];
    if (!Array.isArray(activeTools) || activeTools.length === 0) return [];
    const active = new Set(activeTools.map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const anthropicNative = new Set(['anthropic', 'anthropic-oauth']);
    const discovered = new Set(
        Array.isArray(opts?.session?.deferredDiscoveredTools)
            ? opts.session.deferredDiscoveredTools.map((name) => String(name || '').trim()).filter(Boolean)
            : [],
    );
    for (const message of Array.isArray(messages) ? messages : []) {
        const native = message?.nativeToolSearch;
        const source = String(native?.provider || '').toLowerCase();
        if (source && source !== provider
            && !(anthropicNative.has(source) && anthropicNative.has(provider))) continue;
        for (const name of Array.isArray(native?.toolReferences) ? native.toolReferences : []) {
            const key = String(name || '').trim();
            if (key) discovered.add(key);
        }
    }
    const catalogByName = new Map();
    for (const tool of [
        ...(Array.isArray(opts.session.deferredToolCatalog) ? opts.session.deferredToolCatalog : []),
        ...(Array.isArray(opts.session.deferredLateToolCatalog) ? opts.session.deferredLateToolCatalog : []),
    ]) {
        const name = String(tool?.name || '').trim();
        if (name) catalogByName.set(name, tool);
    }
    const catalog = [...catalogByName.values()];
    return catalog
        .filter((tool) => tool?.name && discovered.has(String(tool.name)) && !active.has(String(tool.name)))
        .map((tool) => ({ ...tool, deferLoading: true }));
}

export function requestAnthropicTools(tools, messages, opts, provider) {
    const activeTools = Array.isArray(tools) ? tools : [];
    if (opts?.providerToolSnapshotAuthoritative === true) {
        const nativePrefixCount = providerNativeToolPrefixCount(
            activeTools,
            opts.providerNativeToolPrefixCount,
        );
        return [
            ...activeTools.slice(0, nativePrefixCount),
            ...toAnthropicTools(activeTools.slice(nativePrefixCount), provider),
        ];
    }
    const deferredTools = deferredAnthropicTools(activeTools, messages, opts, provider);
    const nativeTools = Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter((tool) => tool && typeof tool === 'object')
        : [];
    return [
        ...nativeTools,
        ...toAnthropicTools([...activeTools, ...deferredTools], provider),
    ];
}

export function applyAnthropicCacheMarkers(sanitizedMessages, {
    messageTtl = ANTHROPIC_CACHE_TTL_VOLATILE,
    messageSlots = 1,
} = {}) {
    if (!Array.isArray(sanitizedMessages) || sanitizedMessages.length === 0) {
        return sanitizedMessages;
    }
    const firstText = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const first = content.find((block) => block?.type === 'text');
            return first && typeof first.text === 'string' ? first.text : '';
        }
        return '';
    };
    const isSystemReminder = (content) => firstText(content).startsWith('<system-reminder>');
    const hasUserText = (message) => {
        if (message?.role !== 'user' || isSystemReminder(message.content)) return false;
        if (typeof message.content === 'string') return message.content.trim().length > 0;
        if (!Array.isArray(message.content)) return false;
        return message.content.some((block) => block?.type === 'text'
            && typeof block.text === 'string' && block.text.trim().length > 0);
    };
    const previousUserTextAnchorIdx = () => {
        for (let i = sanitizedMessages.length - 2; i >= 0; i--) {
            if (hasUserText(sanitizedMessages[i])) return i;
        }
        return -1;
    };
    const latestToolResultTailIdx = () => {
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const message = sanitizedMessages[i];
            if (message?.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) continue;
            if (message.content[message.content.length - 1]?.type === 'tool_result') return i;
        }
        return -1;
    };
    const firstRequestUserPromptIdx = () => {
        if (latestToolResultTailIdx() !== -1 || previousUserTextAnchorIdx() !== -1) return -1;
        const tailIdx = sanitizedMessages.length - 1;
        return hasUserText(sanitizedMessages[tailIdx]) ? tailIdx : -1;
    };
    // True-tip anchor: when the request ends with a PERSISTED user text turn
    // (the current prompt — it re-appears verbatim in every later request's
    // prefix), mark it first. Without this, mid-session turn-first requests
    // (multi-turn only; single-turn sessions are already covered by
    // firstRequestUserPromptIdx) leave the fresh prompt unmarked: its tokens
    // bill once at $5/M uncached, then again as a cache write when a later
    // anchor advances past them — cost bounded by the prompt's size, so it
    // matters for large pasted prompts. (2026-08-03 A/B note: session totals'
    // totalUncachedInputTokens = input + cacheWrite by design, see
    // uncachedInputTokensForProvider; billing-uncached input measured via
    // usage.json was already ~0 on single-turn bench tasks before and after
    // this change.) Synthetic system-reminder tails are excluded by
    // hasUserText, so per-call volatile content still never keys the cache.
    const currentTailUserIdx = () => {
        const tailIdx = sanitizedMessages.length - 1;
        return hasUserText(sanitizedMessages[tailIdx]) ? tailIdx : -1;
    };
    const compactSummaryIdx = () => {
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const message = sanitizedMessages[i];
            if (message?.role === 'user' && firstText(message.content).startsWith(SUMMARY_PREFIX_ANCHOR)) return i;
        }
        return -1;
    };
    if (messageTtl !== null) {
        const slots = Math.max(0, Math.min(4, Number(messageSlots) || 0));
        const marked = new Set();
        // A post-compact summary is the largest stable session-specific prefix:
        // reserve the first available message slot for it. Additional slots
        // still advance through the normal live-tail candidates.
        const candidates = [compactSummaryIdx(), currentTailUserIdx(), latestToolResultTailIdx(), previousUserTextAnchorIdx(), firstRequestUserPromptIdx()];
        for (const idx of candidates) {
            if (slots <= 0) break;
            if (idx < 0 || marked.has(idx)) continue;
            const message = sanitizedMessages[idx];
            if (messageTtl?.ttl === '1h' && isSystemReminder(message?.content)) continue;
            message.content = appendAnthropicCacheControl(message.content, messageTtl);
            marked.add(idx);
            if (marked.size >= slots) break;
        }
    }
    return sanitizedMessages;
}
