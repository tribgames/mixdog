import { providerNativeToolPrefixCount } from '../../runtime-core/provider-request-tools.mjs';
import { actionInputContract, actionInputUnionFor } from './action-input-contract.mjs';
import { isNativeServerToolBlockType } from './anthropic-native-blocks.mjs';
import { isAnthropicThinkingBlock, sanitizeAnthropicReplayBlocks } from './anthropic-replay-blocks.mjs';
import { sanitizeAnthropicContentPairs, foldUserTextIntoToolResultTail } from '../../session/context-utils.mjs';
import { normalizeContentForAnthropic } from '../media-normalization.mjs';
import { createProviderReplay, providerReplayItems } from './provider-replay.mjs';
import { anthropicFallbackProviderMetadata, parseAnthropicFallbackBlock } from '../anthropic-server-fallback.mjs';
import { mergeFlatSchemaProperty } from './flat-schema-merge.mjs';
import { reportedCostUsd } from './usage-primitives.mjs';
import { reportInvalidTool, wireInputSchema } from './claude-bridge-schema.mjs';
import { normalizeServerToolUse } from './anthropic-server-tool-usage.mjs';
import { ANTHROPIC_TOOL_CALL_IDS, withWireToolCallIds } from './tool-call-wire-ids.mjs';
import { supportsAnthropicTurnScopedSystemMessages } from '../../../../shared/llm/anthropic-thinking-contract.mjs';
export const ANTHROPIC_CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };
const ANTHROPIC_CACHE_TTL_VOLATILE = { type: 'ephemeral' };

// Anthropic allows at most 4 cache_control breakpoints across the whole
// serialized request (tools + system + messages).
const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

// A block can carry a breakpoint unless it is thinking/redacted_thinking or an
// empty text block (both are rejected by the API).
function isCacheEligibleBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
  if (block.type === 'text') return typeof block.text === 'string' && block.text.trim() !== '';
  return true;
}

function lastEligibleBlockIndex(content) {
  if (typeof content === 'string') return content.trim() ? 0 : -1;
  if (!Array.isArray(content)) return -1;
  for (let i = content.length - 1; i >= 0; i--) if (isCacheEligibleBlock(content[i])) return i;
  return -1;
}

/** Count cache_control markers on a block / block list (incl. tool_result content). */
export function countAnthropicCacheControls(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAnthropicCacheControls(item), 0);
  if (!value || typeof value !== 'object') return 0;
  return (
    (value.cache_control ? 1 : 0) + (Array.isArray(value.content) ? countAnthropicCacheControls(value.content) : 0)
  );
}

function stripCacheControl(block, budget) {
  if (!block || typeof block !== 'object' || budget.n <= 0) return block;
  let next = block;
  if (block.cache_control) {
    budget.n--;
    const { cache_control: _dropped, ...rest } = block;
    next = rest;
  }
  if (Array.isArray(next.content) && budget.n > 0) {
    const content = next.content.map((child) => stripCacheControl(child, budget));
    if (content.some((child, i) => child !== next.content[i])) next = { ...next, content };
  }
  return next;
}

// Drop the `excess` oldest message markers (the newest breakpoints are the
// valuable ones: they cover the longest prefix).
function stripOldestMessageCacheControls(messages, excess) {
  const budget = { n: excess };
  for (const message of messages) {
    if (budget.n <= 0) break;
    if (!Array.isArray(message?.content)) continue;
    const content = message.content.map((block) => stripCacheControl(block, budget));
    if (content.some((block, i) => block !== message.content[i])) message.content = content;
  }
}

function appendAnthropicCacheControl(content, ttl = ANTHROPIC_CACHE_TTL_VOLATILE, blockIndex = null) {
  const index = blockIndex ?? lastEligibleBlockIndex(content);
  if (typeof content === 'string') {
    return index < 0 ? content : [{ type: 'text', text: content, cache_control: ttl }];
  }
  if (!Array.isArray(content) || index < 0 || !isCacheEligibleBlock(content[index])) return content;
  if (content[index].cache_control) return content;
  const next = [...content];
  next[index] = { ...content[index], cache_control: ttl };
  return next;
}

// The builders lift the tail reminder off (splitTailReminder) before lowering and
// cache marking, then append it here as the final text block, so the message
// breakpoint stays on the block before it and the cached prefix is unchanged.
export function appendAnthropicTailReminder(anthropicMessages, reminder) {
  if (!reminder) return anthropicMessages;
  const block = { type: 'text', text: reminder };
  const last = anthropicMessages[anthropicMessages.length - 1];
  if (last?.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content || [];
    last.content = [...content, block];
  } else {
    anthropicMessages.push({ role: 'user', content: [block] });
  }
  return anthropicMessages;
}

// Turn-scoped tail reminders (see tail-reminder-split.mjs). The capability:
// the first-party Messages routes (no gateway base URL, beta headers allowed)
// on a model that takes clear_at system messages. Everything else keeps the
// legacy appendAnthropicTailReminder layout.
// Server-side fallback needs no exclusion: live-checked on the OAuth route,
// a trailing clear_at message is accepted with `fallbacks: "default"` (Opus
// 5.5, Sonnet 5.5) and with explicit lists naming Sonnet 5 or Opus 4.8, and
// fallback runs only on a safety-classifier refusal.
export function anthropicTurnScopedReminders(provider, model, config = {}) {
  return anthropicFirstPartyRoute(provider, config) && supportsAnthropicTurnScopedSystemMessages(model);
}

// The first-party Messages routes: native provider, beta headers allowed, no
// gateway base URL. Request features a proxy answers with a 400 are gated here.
export function anthropicFirstPartyRoute(provider, config = {}) {
  return (
    ANTHROPIC_NATIVE_PROVIDERS.has(provider) &&
    config?.disableBetaHeaders !== true &&
    (!config?.baseURL || /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(config.baseURL))
  );
}

// The stored reminder of a lowered assistant turn (toAnthropicMessages). A
// symbol key: JSON serialization never puts it on the wire.
const TURN_REMINDER = Symbol('turnReminder');

function assistantWireMessage(message, content) {
  const wire = { role: 'assistant', content };
  if (typeof message.turnReminder === 'string' && message.turnReminder) wire[TURN_REMINDER] = message.turnReminder;
  return wire;
}

// Derived only from the stored text, so a replay is byte-identical to the
// request that first sent it. Text only, never a cache_control (both 400).
function turnReminderMessage(text) {
  return { role: 'system', clear_at: 'next_user_message', content: [{ type: 'text', text }] };
}

export function hasAnthropicTurnScopedMessages(messages) {
  return Array.isArray(messages) && messages.some((m) => m?.role === 'system' && m.clear_at);
}

// A turn-scoped message must follow a user turn; an effort control (empty
// system message, lowerAnthropicEffortHistory) may sit between them. Creation
// (appendAnthropicTurnReminder) and replay (withAnthropicTurnReminders) both
// decide by this one rule on the lowered array, so a turn whose request carried
// no reminder never gets one on replay.
function followsUserTurn(messages) {
  let index = messages.length - 1;
  const last = messages[index];
  if (last?.role === 'system' && Array.isArray(last.content) && last.content.length === 0) index--;
  return messages[index]?.role === 'user';
}

/** The lowered history with each stored reminder re-sent right before the
 *  assistant turn generated under it (after any effort control), exactly where
 *  that turn's own request carried it as its last message. String contents
 *  become one text block, so a cache marker (which turns a string into a block
 *  list on the turn it lands) never changes a message's shape between
 *  requests: the wire stays append-only. */
export function withAnthropicTurnReminders(anthropicMessages) {
  const out = [];
  for (const message of anthropicMessages) {
    const text = message?.role === 'assistant' ? message[TURN_REMINDER] : '';
    if (text && followsUserTurn(out)) out.push(turnReminderMessage(text));
    out.push(
      typeof message?.content === 'string' && message.content.trim()
        ? { ...message, content: [{ type: 'text', text: message.content }] }
        : message
    );
  }
  return out;
}

/** The current reminder as a turn-scoped system message ending the request.
 *  A tail that is not a user turn (an assistant continuation) cannot take one
 *  and gets no reminder at all: anything else would be missing from the next
 *  request, which replays that turn without one. */
export function appendAnthropicTurnReminder(anthropicMessages, reminder) {
  if (reminder && followsUserTurn(anthropicMessages)) anthropicMessages.push(turnReminderMessage(reminder));
  return anthropicMessages;
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
// Claude Code parity: exactly one message-level breakpoint advances with the
// live tail on every request. ANTHROPIC_MSG_SLOTS=0 disables message caching;
// any positive value enables that one marker when the system layout leaves a
// slot. messageTtl === null turns the tail off.
//
// The 4-breakpoint limit is request-wide: `tools` (native-tool markers) count
// next to the system blocks as reserved slots; markers already preserved in
// message content are enforced by applyAnthropicCacheMarkers via
// `reservedSlots`.
export function resolveAnthropicMessageCacheSlots(systemBlocks, ttls, { tools = [] } = {}) {
  // Tool markers take their slots first; system markers beyond the remainder
  // are dropped earliest-first (the last system marker covers the longest
  // prefix). The freshly built system blocks are edited in place.
  // Tool markers alone are capped first: beyond the request-wide limit the
  // earliest are dropped (the last covers the longest tool prefix). Tool
  // objects may be shared with the caller, so the array slot is replaced by a
  // marker-free copy instead of mutating the object.
  let toolExcess = countAnthropicCacheControls(tools) - ANTHROPIC_MAX_CACHE_BREAKPOINTS;
  for (let i = 0; toolExcess > 0 && i < tools.length; i++) {
    if (!tools[i]?.cache_control) continue;
    const { cache_control: _dropped, ...rest } = tools[i];
    tools[i] = rest;
    toolExcess--;
  }
  const toolSlots = countAnthropicCacheControls(tools);
  let systemExcess = countAnthropicCacheControls(systemBlocks) + toolSlots - ANTHROPIC_MAX_CACHE_BREAKPOINTS;
  for (const block of systemBlocks) {
    if (systemExcess <= 0) break;
    if (block?.cache_control) {
      delete block.cache_control;
      systemExcess--;
    }
  }
  const reservedSlots = countAnthropicCacheControls(systemBlocks) + toolSlots;
  const slotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
  const hasFreeSlot = reservedSlots < ANTHROPIC_MAX_CACHE_BREAKPOINTS;
  const capAllowsMessage = Number.isFinite(slotsCap) && slotsCap >= 0 ? slotsCap > 0 : true;
  const messageSlots = ttls.messages && hasFreeSlot && capAllowsMessage ? 1 : 0;
  return { messageTtl: messageSlots > 0 ? ttls.messages : null, messageSlots, reservedSlots };
}

// Single lowering of orchestrator messages to the Anthropic wire shape. The
// API-key provider (anthropic.mjs, via anthropic-messages.mjs) and the OAuth
// provider (anthropic-oauth.mjs) share this lowering.
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
  return [
    {
      type: 'text',
      text: `[tool references dropped - no longer available: ${droppedNames.join(', ')}]`,
    },
  ];
}

// API constraint: an `is_error` tool_result may hold ONLY text blocks
// ("all content must be type `text` if `is_error` is true" — a 400 that
// repeats on every later turn of the session once the block is in history).
// Computer Use / Browser Use failures legitimately carry a screenshot, so the
// media is not dropped: the tool_result keeps its text (joined, is_error
// intact) and the non-text blocks are hoisted as sibling blocks of the same
// user message, right after the tool_result. Applied at request-build time so
// already-persisted histories recover on their next request.
const ERROR_RESULT_EMPTY_TEXT = '[error result had no text; its attached content follows this block]';
const ERROR_RESULT_MEDIA_NOTE = '[attached screenshot/media for this failed call follows this block]';
function splitErrorToolResultContent(content) {
  if (!Array.isArray(content)) return { content, hoisted: [] };
  const texts = [];
  const hoisted = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block && typeof block === 'object') hoisted.push(block);
  }
  if (hoisted.length === 0) return { content, hoisted };
  const text = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    content: [{ type: 'text', text: text ? `${text}\n\n${ERROR_RESULT_MEDIA_NOTE}` : ERROR_RESULT_EMPTY_TEXT }],
    hoisted,
  };
}

// Native tool_search providers whose stored references this lowering replays.
const ANTHROPIC_NATIVE_PROVIDERS = new Set(['anthropic', 'anthropic-oauth']);

// `provider`: the engine's provider name. A gateway on a native Messages
// route (wire-route.mjs) also replays the references it tagged itself.
export function toAnthropicMessages(transcript, availableTools, provider = '') {
  const messages = withWireToolCallIds(transcript, ANTHROPIC_TOOL_CALL_IDS);
  const ownProvider = String(provider || '').toLowerCase();
  const availableNames = anthropicToolNameSet(availableTools);
  const result = [];
  // Tool-result user messages a provider request ended with (see the
  // `sentRequestTail` meta finalizeInterruptedTurn stamps).
  const sent = new WeakSet();
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m.role === 'system') continue;
    const orderedReplay = m.role === 'assistant' ? providerReplayItems(m, 'anthropic') : undefined;
    if (
      m.role === 'assistant' &&
      (orderedReplay?.length || m.toolCalls?.length || m.assistantBlocks?.length || m.thinkingBlocks?.length)
    ) {
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
        // A blank text block is a hard 400 on every request that replays it.
        if (!isBlankText(m.content)) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls || []) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      result.push(assistantWireMessage(m, content));
      continue;
    }
    if (m.role === 'tool') {
      const last = result[result.length - 1];
      const native = m.nativeToolSearch;
      const nativeProvider = String(native?.provider || '').toLowerCase();
      const references =
        (!nativeProvider || ANTHROPIC_NATIVE_PROVIDERS.has(nativeProvider) || nativeProvider === ownProvider) &&
        Array.isArray(native?.toolReferences)
          ? native.toolReferences.map((name) => String(name || '').trim()).filter(Boolean)
          : [];
      // Keep only references this request can actually back with a
      // definition; a reference without one is a hard 400 on every turn
      // that replays it (see anthropicToolNameSet).
      const usableReferences = availableNames ? references.filter((name) => availableNames.has(name)) : references;
      const droppedReferences =
        usableReferences.length === references.length
          ? []
          : references.filter((name) => !usableReferences.includes(name));
      const isError = m.toolKind === 'error' || m.isError === true;
      let content;
      if (usableReferences.length)
        content = usableReferences.map((tool_name) => ({ type: 'tool_reference', tool_name }));
      else if (droppedReferences.length) content = toolResultContentWithoutReferences(m, droppedReferences);
      else content = normalizeContentForAnthropic(m.content);
      let hoisted = [];
      if (isError) ({ content, hoisted } = splitErrorToolResultContent(content));
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId || '',
        content,
        ...(isError ? { is_error: true } : {}),
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block, ...hoisted);
      } else {
        result.push({ role: 'user', content: [block, ...hoisted] });
      }
      if (m.meta?.sentRequestTail === true) sent.add(result[result.length - 1]);
      continue;
    }
    // Text after a tool_result message a provider request already carried
    // (an interrupted request's tail: the restart or cancel marker, the next
    // prompt and anything riding with it) goes in as sibling blocks of that
    // user message. Folding it into the tool_result would rewrite a block the
    // provider cached, so the whole message prefix would be written again.
    const tail = result[result.length - 1];
    if (m.role === 'user' && m.meta?.source !== 'steering' && sent.has(tail)) {
      tail.content.push(...siblingBlocks(normalizeContentForAnthropic(m.content)));
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
    if (
      m.role === 'user' &&
      !isSteering &&
      foldUserTextIntoToolResultTail(result, normalizeContentForAnthropic(m.content))
    ) {
      // A reminder folded before the request was sent ends that request.
      if (m.meta?.sentRequestTail === true) sent.add(tail);
      continue;
    }
    // An assistant turn with no text and no blocks (a refused or empty final
    // kept in the transcript for diagnosis) has nothing to replay; sending it
    // would be a blank text block the API rejects on every later request.
    if (m.role === 'assistant' && isBlankText(m.content)) continue;
    const content = normalizeContentForAnthropic(m.content);
    result.push(m.role === 'assistant' ? assistantWireMessage(m, content) : { role: m.role, content });
  }
  return sanitizeAnthropicContentPairs(result);
}

// A user message's content as blocks of the message it joins; blank text is
// dropped (a blank text block is a hard 400).
function siblingBlocks(content) {
  let blocks = [];
  if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
  else if (Array.isArray(content)) blocks = content;
  return blocks.filter((block) => !(block?.type === 'text' && isBlankText(block.text)));
}

function isBlankText(content) {
  return content == null || (typeof content === 'string' && !content.trim());
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
    ? replayableBlocks.filter(
        (block) =>
          isNativeServerToolBlockType(block.type) ||
          REPLAYABLE_ASSISTANT_BLOCK_TYPES.has(block.type) ||
          block.type === 'text'
      )
    : [];
  const usage = message?.usage || {};
  const input = Number(usage.input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const costUsd = reportedCostUsd(usage.cost);
  const serverToolUse = normalizeServerToolUse(usage);
  return {
    content: text,
    model: fallbackEvents.at(-1)?.fallbackModel || message?.model || fallbackModel,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    stopReason: message?.stop_reason || null,
    ...(message?.stop_details != null ? { stopDetails: message.stop_details } : {}),
    ...(message?.stop_sequence != null ? { stopSequence: message.stop_sequence } : {}),
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
      ...(Number(usage.cache_creation?.ephemeral_1h_input_tokens) > 0
        ? { cacheWrite1hTokens: Number(usage.cache_creation.ephemeral_1h_input_tokens) }
        : {}),
      promptTokens: input + cacheRead + cacheWrite,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(serverToolUse ? { serverToolUse } : {}),
      raw: usage,
    },
  };
}

// Anthropic's tool spec forbids oneOf / allOf / anyOf at the TOP level of
// input_schema (nested usage inside properties is allowed). External MCP
// servers sometimes emit such schemas; convert them to a flat object schema
// so the API never sees a 400.
export function sanitizeAnthropicInputSchema(schema, toolName, logTag) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const compound = schema.oneOf || schema.anyOf || schema.allOf;
  if (!compound) return structuredClone(schema);
  const compoundKey = ['oneOf', 'anyOf', 'allOf'].find((key) => schema[key]);
  const conjunctive = compoundKey === 'allOf';
  const mergedProps = { ...(schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const branchDescs = [];
  for (const rawBranch of Array.isArray(compound) ? compound : []) {
    const branch =
      conjunctive && rawBranch?.allOf ? sanitizeAnthropicInputSchema(rawBranch, toolName, logTag) : rawBranch;
    if (branch && typeof branch === 'object' && branch.properties) {
      for (const [name, property] of Object.entries(branch.properties)) {
        // allOf is an intersection, not an alternative: retain both
        // constraints on a shared field. Nested allOf is supported.
        mergedProps[name] =
          conjunctive && Object.hasOwn(mergedProps, name)
            ? { allOf: [structuredClone(mergedProps[name]), structuredClone(property)] }
            : mergeFlatSchemaProperty(mergedProps[name], property);
      }
    }
    if (conjunctive) {
      for (const name of Array.isArray(branch?.required) ? branch.required : []) required.add(name);
    }
    if (branch && typeof branch === 'object') {
      const parts = [];
      if (branch.description) parts.push(branch.description);
      else if (branch.type) parts.push(`type:${branch.type}`);
      if (parts.length) branchDescs.push(parts.join(' '));
    }
  }
  const actionContract = actionInputContract(schema);
  if (actionContract && mergedProps.input) {
    mergedProps.input = { ...mergedProps.input, description: actionContract };
  }
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
    ...(required.size ? { required: [...required] } : {}),
    ...(schema.additionalProperties === false ? { additionalProperties: false } : {}),
  };
}

// The Messages `input_schema` of a tool: the flattened schema, lowered to
// 2020-12 with an object root when it is not valid as written ({ schema }), or
// { pointer, reason } when it is broken even then.
function anthropicInputSchema(tool, logTag) {
  // First-party Anthropic accepts nested per-action input alternatives;
  // gateways on the same wire keep the advertised flat schema.
  const flattened = sanitizeAnthropicInputSchema(
    ANTHROPIC_NATIVE_PROVIDERS.has(logTag) ? actionInputUnionFor(tool.inputSchema) : tool.inputSchema,
    tool.name,
    logTag
  );
  return wireInputSchema(flattened, 'anthropic');
}

/** The `{ name, pointer, reason }` for which the Messages wire leaves `tool`
 *  out of a request, or null when it is sent. Reports nothing. */
export function anthropicToolExclusion(tool, logTag = 'anthropic') {
  const result = anthropicInputSchema(tool, logTag);
  return result.schema ? null : { name: tool.name, pointer: result.pointer || '/', reason: result.reason };
}

// A Messages endpoint rejects the whole request for one invalid input_schema,
// so a tool broken even after lowering is reported and left out.
// `eager`: fine-grained tool streaming — the API streams each tool parameter as
// it is generated instead of buffering it until complete, so a large tool input
// does not leave the stream silent. First-party routes only.
function toAnthropicTools(tools, logTag, onToolExcluded, eager = false) {
  const out = [];
  tools.forEach((tool, index) => {
    const result = anthropicInputSchema(tool, logTag);
    if (!result.schema) {
      reportInvalidTool(tool.name, index, result, onToolExcluded, `[${logTag}] tool`);
      return;
    }
    const entry = { name: tool.name, description: tool.description, input_schema: result.schema };
    if (tool.deferLoading === true || tool.defer_loading === true) entry.defer_loading = true;
    if (eager) entry.eager_input_streaming = true;
    out.push(entry);
  });
  return out;
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
// only when the request actually carries tools.
//
// Mapping: 'auto'→auto, 'required'/'any'→any, {name}|{type:'tool',name}→tool,
// 'none'→none. Forced any/tool is rejected by the API while extended/adaptive
// thinking is on: with `thinking` set it falls back to auto (default) or throws
// (`onThinkingConflict: 'error'`). `disableParallelToolUse` adds
// disable_parallel_tool_use (not valid with none) unless the endpoint declares
// `supportsDisableParallelToolUse: false` (gateway capability).
export function toAnthropicToolChoice(
  toolChoice,
  {
    thinking = false,
    disableParallelToolUse = false,
    supportsDisableParallelToolUse = true,
    onThinkingConflict = 'fallback',
  } = {}
) {
  let choice;
  if (toolChoice === 'none') choice = { type: 'none' };
  else if (toolChoice === 'auto') choice = { type: 'auto' };
  else if (toolChoice === 'required' || toolChoice === 'any') choice = { type: 'any' };
  else if (toolChoice && typeof toolChoice === 'object') {
    const name = typeof toolChoice.name === 'string' ? toolChoice.name : toolChoice.function?.name;
    if (toolChoice.type === 'none') choice = { type: 'none' };
    else if (toolChoice.type === 'auto') choice = { type: 'auto' };
    else if (toolChoice.type === 'any') choice = { type: 'any' };
    else if (typeof name === 'string' && name) choice = { type: 'tool', name };
  }
  if (choice && (choice.type === 'any' || choice.type === 'tool') && thinking) {
    if (onThinkingConflict === 'error') {
      throw new Error(`Anthropic tool_choice "${choice.type}" is not allowed while extended thinking is enabled`);
    }
    choice = undefined;
  }
  if (disableParallelToolUse === true && supportsDisableParallelToolUse !== false && choice?.type !== 'none') {
    choice = { ...(choice || { type: 'auto' }), disable_parallel_tool_use: true };
  }
  return choice;
}

/** True when the request body enables extended/adaptive thinking. */
export function anthropicThinkingActive(body) {
  return body?.thinking?.type === 'enabled' || body?.thinking?.type === 'adaptive';
}

export function deferredAnthropicTools(activeTools, messages, opts, provider) {
  if (opts?.session?.deferredNativeTools !== true) return [];
  if (!Array.isArray(activeTools) || activeTools.length === 0) return [];
  const active = new Set(activeTools.map((tool) => String(tool?.name || '').trim()).filter(Boolean));
  const discovered = new Set(
    Array.isArray(opts?.session?.deferredDiscoveredTools)
      ? opts.session.deferredDiscoveredTools.map((name) => String(name || '').trim()).filter(Boolean)
      : []
  );
  for (const message of Array.isArray(messages) ? messages : []) {
    const native = message?.nativeToolSearch;
    const source = String(native?.provider || '').toLowerCase();
    if (
      source &&
      source !== provider &&
      !(ANTHROPIC_NATIVE_PROVIDERS.has(source) && ANTHROPIC_NATIVE_PROVIDERS.has(provider))
    )
      continue;
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

// `config`: the provider config (baseURL, disableBetaHeaders) deciding the route.
export function requestAnthropicTools(tools, messages, opts, provider, config = {}) {
  const activeTools = Array.isArray(tools) ? tools : [];
  const eager = anthropicFirstPartyRoute(provider, config);
  if (opts?.providerToolSnapshotAuthoritative === true) {
    const nativePrefixCount = providerNativeToolPrefixCount(activeTools, opts.providerNativeToolPrefixCount);
    return [
      ...activeTools.slice(0, nativePrefixCount),
      ...toAnthropicTools(activeTools.slice(nativePrefixCount), provider, opts.onToolExcluded, eager),
    ];
  }
  const deferredTools = deferredAnthropicTools(activeTools, messages, opts, provider);
  const nativeTools = Array.isArray(opts?.nativeTools)
    ? opts.nativeTools.filter((tool) => tool && typeof tool === 'object')
    : [];
  return [
    ...nativeTools,
    ...toAnthropicTools([...activeTools, ...deferredTools], provider, opts?.onToolExcluded, eager),
  ];
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
// messageTtl === null disables the tail. BP3 (tier3) rides a system block,
// so it is not marked here. ANTHROPIC_MSG_SLOTS=0 is honoured upstream by
// passing messageTtl = null.
// `sharedPrefix` (see sharedCachePrefixBoundary) moves the breakpoint off the
// tail onto a shared prefix's last block, or drops it (`false`).
export function applyAnthropicCacheMarkers(
  sanitizedMessages,
  { messageTtl = ANTHROPIC_CACHE_TTL_VOLATILE, messageSlots = 1, reservedSlots = 0 } = {},
  sharedPrefix = null
) {
  if (!Array.isArray(sanitizedMessages) || sanitizedMessages.length === 0) {
    return sanitizedMessages;
  }
  // Request-wide 4-breakpoint limit: slots held by system/tools are reserved;
  // markers preserved inside message content may only use what is left.
  const budget = Math.max(0, ANTHROPIC_MAX_CACHE_BREAKPOINTS - (Number(reservedSlots) || 0));
  const present = countAnthropicCacheControls(sanitizedMessages);
  if (present > budget) stripOldestMessageCacheControls(sanitizedMessages, present - budget);
  const free = budget - Math.min(present, budget);
  if (messageTtl === null || !(Number(messageSlots) > 0) || sharedPrefix === false || free <= 0) {
    return sanitizedMessages;
  }
  if (sharedPrefix) {
    const message = sanitizedMessages[sharedPrefix.index];
    if (message && contentBlockKey(message.content, sharedPrefix.blockIndex) === sharedPrefix.blockKey) {
      message.content = appendAnthropicCacheControl(message.content, messageTtl, sharedPrefix.blockIndex);
    }
    return sanitizedMessages;
  }
  const index = lastMarkableMessageIndex(sanitizedMessages);
  if (index < 0) return sanitizedMessages;
  const message = sanitizedMessages[index];
  message.content = appendAnthropicCacheControl(message.content, messageTtl);
  return sanitizedMessages;
}

// The breakpoint goes on the last message that has an eligible block: a
// trailing effort control (empty system message) or a thinking-only tail has
// nothing to mark, and a turn-scoped system message rejects cache_control.
// -1 when no message does.
function lastMarkableMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'system') continue;
    if (lastEligibleBlockIndex(messages[index].content) >= 0) return index;
  }
  return -1;
}

function contentBlockKey(content, blockIndex) {
  const block = Array.isArray(content) ? content[blockIndex] : content;
  return block === undefined ? undefined : JSON.stringify(block);
}

/**
 * Where a cache-sharing fork (a /btw side question) keeps its message
 * breakpoint. The fork re-sends an earlier request's messages unchanged and
 * appends a short suffix; `opts.sharedCachePrefixCount` is the number of
 * leading messages that make up that shared prefix (a plain number, so it
 * survives model-proxy serialization). The breakpoint stays on the block the earlier request
 * marked (the prefix's own lowered tail), so the fork reads that cache entry
 * and writes none for its suffix. `lowerPrefix(messages)` lowers a message
 * list exactly as the request does. Null for an ordinary request (tail
 * breakpoint); false when the prefix is not part of this request.
 */
export function sharedCachePrefixBoundary(messages, opts, lowerPrefix) {
  const count = opts?.sharedCachePrefixCount;
  if (!count) return null;
  if (!Number.isInteger(count) || count < 0 || count > messages.length) return false;
  const prefix = lowerPrefix(messages.slice(0, count));
  if (!prefix.length) return false;
  const index = lastMarkableMessageIndex(prefix);
  if (index < 0) return false;
  const content = prefix[index].content;
  const blockIndex = lastEligibleBlockIndex(content);
  const blockKey = contentBlockKey(content, blockIndex);
  return blockKey === undefined ? false : { index, blockIndex, blockKey };
}
