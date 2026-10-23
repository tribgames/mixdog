// Lowers a Mixdog transcript, system prompt and tool list into one Devin
// GetChatMessageRequest (Cascade request type), the way the native CLI
// builds it.
//
// Wire roles: USER for user/developer turns (and mid-history system notes),
// SYSTEM (the Cascade "bot" channel) for assistant turns, TOOL for tool
// results. Leading system messages become the request `prompt`.
import { createHash, randomUUID } from 'node:crypto';
import { DEVIN_ENUMS, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import { DEVIN_DEFAULT_MAX_OUTPUT_TOKENS } from './devin-wire-models.mjs';
import { degradeMediaParts, normalizeContentForGeminiParts } from './media-normalization.mjs';
import { devinDemotedThinking, isDevinGeminiModel } from './devin-wire-identity.mjs';
import { devinGoogleToolSchema, devinToolWireSchema } from './devin-wire-schema.mjs';
import { providerReplayItems } from './lib/provider-replay.mjs';

export const DEVIN_PROVIDER_ID = 'devin-oauth';
// Replayed tool-call ids reach the backend serving the model; OpenAI-routed
// models refuse ids over 40 chars or outside [A-Za-z0-9_-].
export const DEVIN_TOOL_CALL_ID_MAX_LENGTH = 40;
// The providerReplay item a Devin assistant turn carries (see devin.mjs).
export const DEVIN_REPLAY_ITEM_TYPE = 'devin_assistant';
// Result text for a tool call whose result never committed.
export const DEVIN_MISSING_TOOL_RESULT = 'No result provided';
// An opaque invalid_argument on a request whose compactable history is at
// least this large is treated as a context overflow.
export const DEVIN_LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

const { ChatMessageSource, ChatMessageRequestType, ConversationalPlannerMode, CacheControlType } = DEVIN_ENUMS;
// Cascade has no ASSISTANT source: the model's own turns ride the SYSTEM channel.
export const DEVIN_ASSISTANT_SOURCE = ChatMessageSource.SYSTEM;

// Completion knobs the native CLI sends with every Cascade turn.
const CLI_TOP_K = 40;
const CLI_TOP_P = 0.95;
const CLI_MAX_NEWLINES = 400;

/** The leading 128 bits of sha256(`seed`) in the 8-4-4-4-12 UUID layout. */
export function devinDeterministicUuid(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A foreign tool-call id on the Devin wire: unsupported characters to `_`, capped. */
export function normalizeDevinToolCallId(id) {
  return String(id)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, DEVIN_TOOL_CALL_ID_MAX_LENGTH);
}

// Tool-call ids a Responses-API turn mints can be composite (`call_id|item_id`).
// A turn is Responses-origin when its replay record came from a Responses
// transport (OpenAI/Codex, xAI, or a compat gateway's Responses wire).
function isResponsesOrigin(message) {
  const owner = message?.providerReplay?.provider;
  return (
    owner === 'openai-responses' ||
    owner === 'xai-responses' ||
    (typeof owner === 'string' && owner.startsWith('compat-responses:'))
  );
}

/** The call_id half of a composite Responses id; an id with no non-empty first half stays whole. */
export function responsesCallComponent(id) {
  const value = String(id);
  const pipe = value.indexOf('|');
  return pipe <= 0 ? value : value.slice(0, pipe);
}

function duplicateId(id, index) {
  const suffix = `_dup${index}`;
  if (id.length + suffix.length <= DEVIN_TOOL_CALL_ID_MAX_LENGTH) return `${id}${suffix}`;
  return `${id.slice(0, Math.max(0, DEVIN_TOOL_CALL_ID_MAX_LENGTH - suffix.length))}${suffix}`;
}

// Text plus inline images of one content value; parts concatenate as written.
// Images are sent only to a vision model; otherwise every media part degrades
// to its fixed text form.
function loweredContent(content, vision) {
  if (typeof content === 'string') return { text: content, images: [] };
  const source = !vision && Array.isArray(content) ? degradeMediaParts(content) : content;
  let text = '';
  const images = [];
  for (const part of normalizeContentForGeminiParts(source)) {
    if (part.inlineData && String(part.inlineData.mimeType).startsWith('image/')) {
      if (vision) images.push({ base64Data: part.inlineData.data, mimeType: part.inlineData.mimeType });
    } else if (part.fileData?.fileUri) {
      text += `[image: ${part.fileData.fileUri}]`;
    } else if (typeof part.text === 'string') {
      text += part.text;
    }
  }
  return { text, images };
}

/** The Devin replay record of an assistant turn (any model), or null. */
export function devinReplayItem(message) {
  return (
    providerReplayItems(message, DEVIN_PROVIDER_ID)?.find((entry) => entry?.type === DEVIN_REPLAY_ITEM_TYPE) || null
  );
}

// Same-model turns: produced by this provider for the requested model uid.
function sameModelReplay(message, model) {
  const item = devinReplayItem(message);
  return item && item.model === model ? item : null;
}

const textsOf = (parts, type) =>
  (Array.isArray(parts) ? parts : []).filter((part) => part?.type === type).map((part) => part.text);

const thinkingTexts = (blocks) =>
  (Array.isArray(blocks) ? blocks : []).filter((block) => block?.type === 'thinking').map((block) => block.thinking);

const reasoningItemTexts = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((item) => item?.type === 'reasoning' || (item && item.type === undefined && item.summary))
    .map((item) => {
      const summary = textsOf(item.summary, 'summary_text');
      return (summary.length ? summary : textsOf(item.content, 'reasoning_text')).join('\n');
    });

function providerReplayReasoning(message) {
  const replay = message.providerReplay;
  const items = Array.isArray(replay?.items) ? replay.items : [];
  if (replay?.provider === 'anthropic') return thinkingTexts(items);
  if (replay?.provider === 'gemini' || replay?.provider === 'antigravity') {
    return items.filter((part) => part?.thought === true).map((part) => part.text);
  }
  if (isResponsesOrigin(message)) return reasoningItemTexts(items);
  return [];
}

const nonBlank = (blocks) => blocks.filter((text) => typeof text === 'string' && text.trim());

// The reasoning blocks another model's turn carries. Mixdog may keep one
// trace in several representations, so the first one that holds any reasoning
// wins and the rest are never added. Block-shaped sources come first, so each
// block is demoted on its own: a Devin replay record of another model, the
// provider replay (Anthropic thinking blocks, Gemini thought parts, Responses
// reasoning summaries or reasoning text), the ordered Anthropic
// `assistantBlocks`, the standalone `thinkingBlocks`, Responses
// `reasoningItems`; the flattened `reasoningContent` and plain `reasoning`
// strings are the fallback. Signatures and encrypted payloads never carry over.
function foreignReasoningBlocks(message) {
  const sources = [
    () => {
      const devin = devinReplayItem(message);
      return devin ? [devin.thinking] : [];
    },
    () => providerReplayReasoning(message),
    () => thinkingTexts(message.assistantBlocks),
    () => thinkingTexts(message.thinkingBlocks),
    () => reasoningItemTexts(message.reasoningItems),
    () => [message.reasoningContent],
    () => [message.reasoning],
  ];
  for (const source of sources) {
    const blocks = nonBlank(source());
    if (blocks.length) return blocks;
  }
  return [];
}

// Reasoning of another model replays as text in the target's thinking form,
// each block followed by a line break; a block with nothing after it is
// trimmed first. Blank blocks are dropped.
function assistantPrompt(message, model, messageId) {
  const native = sameModelReplay(message, model);
  const demoted = native
    ? []
    : foreignReasoningBlocks(message)
        .filter((thinking) => typeof thinking === 'string' && thinking.trim())
        .map((thinking) => devinDemotedThinking(model, thinking));
  const text = loweredContent(message.content, false).text;
  let prompt = demoted.map((block) => `${block}\n`).join('') + text;
  if (demoted.length && !text)
    prompt = `${demoted
      .slice(0, -1)
      .map((block) => `${block}\n`)
      .join('')}${demoted.at(-1).trimEnd()}\n`;
  const toolCalls = (message.toolCalls || []).map((call) => ({
    id: String(call.id),
    name: call.name,
    argumentsJson: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }));
  const thinking = native?.thinking || '';
  const signature = native?.signature || '';
  if (!prompt && !thinking && !signature && !toolCalls.length) return null;
  return {
    // Native assistant ids are the response's own message id.
    messageId: native?.messageId || messageId,
    source: DEVIN_ASSISTANT_SOURCE,
    prompt,
    ...(thinking ? { thinking } : {}),
    ...(signature ? { signature } : {}),
    toolCalls,
  };
}

/**
 * Tool-call ids as the wire carries them: a same-model turn keeps its ids
 * verbatim; any other turn's ids are normalized (normalizeDevinToolCallId).
 * A Responses-API turn's composite id (`call_id|item_id`) keeps only its
 * call_id first; ids of every other origin keep all their segments.
 * A repeated id then gets a `_dupN` suffix and the next unanswered result of
 * that id follows it, so every call/result pair stays distinct.
 */
export function devinWireToolCallIds(messages, model) {
  // Exact original id → wire id, for every call whose id changed.
  const normalized = new Map();
  // call_id component of every Responses-origin call → its wire id, recorded
  // even when the id did not change: a composite result (`call_A|item`) of a
  // plain call `call_A` resolves through it. Opaque ids of other origins pair
  // by exact id only, so their `|` segments stay distinct.
  const responsesComponents = new Map();
  // Concrete `|`-bearing call ids of every other origin, same-model turns
  // included: opaque correlation tokens that only ever pair by exact id, even
  // when their first segment matches an earlier Responses call.
  const opaqueCompositeIds = new Set();
  for (const message of messages) {
    if (message?.role !== 'assistant' || isResponsesOrigin(message)) continue;
    for (const call of message.toolCalls || []) {
      const id = String(call.id);
      if (id.includes('|')) opaqueCompositeIds.add(id);
    }
  }
  const projected = messages.map((message) => {
    if (message?.role === 'tool') {
      const id = String(message.toolCallId);
      const viaComponent =
        id.includes('|') && !opaqueCompositeIds.has(id)
          ? responsesComponents.get(responsesCallComponent(id))
          : undefined;
      const wire = normalized.get(id) ?? viaComponent;
      return wire && wire !== id ? { ...message, toolCallId: wire } : message;
    }
    if (message?.role !== 'assistant' || !message.toolCalls?.length || sameModelReplay(message, model)) return message;
    const responses = isResponsesOrigin(message);
    let changed = false;
    const toolCalls = message.toolCalls.map((call) => {
      const id = String(call.id);
      const wire = normalizeDevinToolCallId(responses ? responsesCallComponent(id) : id);
      if (responses) responsesComponents.set(responsesCallComponent(id), wire);
      if (wire === id) return call;
      normalized.set(id, wire);
      changed = true;
      return { ...call, id: wire };
    });
    return changed ? { ...message, toolCalls } : message;
  });

  const seen = new Map();
  const pending = new Map();
  return projected.map((message) => {
    if (message?.role === 'tool') {
      const id = String(message.toolCallId);
      const queue = pending.get(id);
      if (!queue?.length) return message;
      const replacement = queue.shift();
      if (!queue.length) pending.delete(id);
      return replacement ? { ...message, toolCallId: replacement } : message;
    }
    if (message?.role !== 'assistant' || !message.toolCalls?.length) return message;
    const touched = new Set();
    let changed = false;
    const toolCalls = message.toolCalls.map((call) => {
      const id = String(call.id);
      // A later turn re-emitting an id takes over its pending results.
      if (!touched.has(id)) {
        touched.add(id);
        pending.delete(id);
      }
      const queue = pending.get(id) || [];
      pending.set(id, queue);
      const previous = seen.get(id) || 0;
      if (previous === 0) {
        seen.set(id, 1);
        queue.push(undefined);
        return call;
      }
      let index = previous;
      let replacement = duplicateId(id, index);
      while (seen.has(replacement)) replacement = duplicateId(id, ++index);
      seen.set(id, index + 1);
      seen.set(replacement, 1);
      queue.push(replacement);
      changed = true;
      return { ...call, id: replacement };
    });
    return changed ? { ...message, toolCalls } : message;
  });
}

function toolResultTexts(content) {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
    .map((part) => part.text);
}

/**
 * Tool-call pairing on the wire transcript: every assistant tool call is
 * answered right after its turn by exactly one result. A result that arrives
 * later (after other messages) is pulled forward into that slot; a call with
 * no result gets an error result ("No result provided", or "aborted" for an
 * errored/aborted turn). A duplicate result is dropped. A result whose call
 * is gone (folded away by compaction) survives as a user note of its text,
 * unless a call window is still open, in which case it is dropped.
 */
export function devinPairedTranscript(messages) {
  const realResults = new Map();
  const liveCallIds = new Set();
  messages.forEach((message, index) => {
    if (message?.role === 'tool') {
      const id = String(message.toolCallId);
      if (!realResults.has(id)) realResults.set(id, []);
      realResults.get(id).push({ index, message, consumed: false });
    } else if (message?.role === 'assistant') {
      for (const call of message.toolCalls || []) liveCallIds.add(String(call.id));
    }
  });
  const takeResult = (id, afterIndex) => {
    for (const entry of realResults.get(id) || []) {
      if (entry.consumed || entry.index <= afterIndex) continue;
      entry.consumed = true;
      return entry.message;
    }
    return undefined;
  };

  const out = [];
  const resolved = new Set();
  let pending = [];
  let pendingStart = -1;
  let aborted = new Map();
  let abortedOpen = false;
  let abortedStart = -1;
  const resolveCalls = (calls, startIndex, fallbackText) => {
    for (const call of calls) {
      const id = String(call.id);
      if (resolved.has(id)) continue;
      out.push(
        takeResult(id, startIndex) || {
          role: 'tool',
          toolCallId: id,
          toolName: call.name,
          content: fallbackText,
          isError: true,
        }
      );
      resolved.add(id);
    }
  };
  const flushPending = () => {
    if (!pending.length) return;
    resolveCalls(pending, pendingStart, DEVIN_MISSING_TOOL_RESULT);
    pending = [];
  };
  const flushAborted = () => {
    if (!abortedOpen) return;
    resolveCalls([...aborted.values()], abortedStart, 'aborted');
    aborted = new Map();
    abortedOpen = false;
  };

  messages.forEach((message, index) => {
    const role = message?.role;
    if (role === 'assistant') {
      flushPending();
      flushAborted();
      const calls = message.toolCalls || [];
      out.push(message);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        aborted = new Map(calls.map((call) => [String(call.id), call]));
        abortedOpen = true;
        abortedStart = index;
      } else if (calls.length) {
        pending = calls;
        pendingStart = index;
      }
      return;
    }
    if (role !== 'tool') {
      flushPending();
      flushAborted();
      out.push(message);
      return;
    }
    const id = String(message.toolCallId);
    if (resolved.has(id)) return;
    if (aborted.has(id) || pending.some((call) => String(call.id) === id)) {
      aborted.delete(id);
      resolved.add(id);
      out.push(message);
      return;
    }
    if (liveCallIds.has(id)) return;
    if (pending.some((call) => !resolved.has(String(call.id))) || aborted.size > 0) return;
    const texts = toolResultTexts(message.content);
    if (!texts.length) return;
    const errorAttr = message.isError === true || message.toolKind === 'error' ? ' is-error="true"' : '';
    const toolName = message.toolName ?? message.name ?? '';
    out.push({
      role: 'user',
      content: `<stale-tool-result tool="${toolName}" id="${id}"${errorAttr}>\n${texts.join('\n')}\n</stale-tool-result>`,
    });
  });
  flushPending();
  flushAborted();
  return out;
}

function chatPrompts(messages, { model, vision, cascadeId }) {
  const prompts = [];
  messages.forEach((message, index) => {
    const role = message?.role;
    const seed = `${cascadeId}\0${index}\0${role}`;
    if (role === 'assistant') {
      const prompt = assistantPrompt(message, model, devinDeterministicUuid(`${cascadeId}\0${index}\0assistant`));
      if (prompt) prompts.push(prompt);
      return;
    }
    if (role === 'tool') {
      const { text, images } = loweredContent(message.content, vision);
      prompts.push({
        messageId: devinDeterministicUuid(`${cascadeId}\0${index}\0tool\0${message.toolCallId}`),
        source: ChatMessageSource.TOOL,
        toolCallId: String(message.toolCallId),
        toolResultIsError: message.toolKind === 'error' || message.isError === true,
        prompt: text,
        images,
      });
      return;
    }
    const { text, images } = loweredContent(message?.content, vision);
    prompts.push({ messageId: devinDeterministicUuid(seed), source: ChatMessageSource.USER, prompt: text, images });
  });
  return prompts;
}

// The current turn, read off the conversation as Mixdog holds it (before
// pairing adds synthetic results or stale-result notes): the trailing user
// prompt, plus the user/developer messages right before a trailing developer
// message. Everything earlier is history that compaction can shrink.
function activeTailCount(messages) {
  const userRole = (message) => message?.role === 'user' || message?.role === 'developer';
  const last = messages.at(-1);
  if (!userRole(last)) return 0;
  if (last.role === 'user') return 1;
  let count = 1;
  for (let index = messages.length - 2; index >= 0 && userRole(messages[index]); index -= 1) count += 1;
  return count;
}

/** Wire bytes of the request's compactable history (every prompt before the active turn). */
export function devinHistoryBytes(request, activeTail) {
  const prompts = request.chatMessagePrompts || [];
  return encodeDevinMessage('GetChatMessageRequest', {
    chatMessagePrompts: activeTail > 0 ? prompts.slice(0, -activeTail) : prompts,
  }).length;
}

/**
 * The prompt a model router scores: the latest user/developer turn alone,
 * with no message id (the chat request that follows mints it).
 */
export function devinRouterPrompt(messages, { vision = false } = {}) {
  const message = (Array.isArray(messages) ? messages : []).findLast(
    (entry) => entry?.role === 'user' || entry?.role === 'developer'
  );
  if (!message) return undefined;
  const { text, images } = loweredContent(message.content, vision);
  return { messageId: '', source: ChatMessageSource.USER, prompt: text, images };
}

function toolDefinitions(tools, model, chatModelUid) {
  if (!tools?.length) return [];
  // Gemini backends (the catalog model or the concrete wire uid, e.g. a
  // router's MODEL_GOOGLE_GEMINI_* assignment) apply Google's schema rules.
  const google = isDevinGeminiModel(model, chatModelUid);
  return tools.map((tool) => {
    const schema = devinToolWireSchema(tool.inputSchema);
    return {
      name: tool.name,
      description: tool.description || '',
      jsonSchemaString: JSON.stringify(google ? devinGoogleToolSchema(schema) : schema),
      strict: tool.strict === true,
    };
  });
}

/**
 * The GetChatMessageRequest for one turn.
 * `model` is the catalog model id (replay identity); `chatModelUid` the
 * concrete wire uid (effort route or router assignment, default `model`);
 * `modelAssignmentJwt` the router assignment that authorizes it.
 * `modelRow` is the normalized catalog row of `model` (null when unknown:
 * text-only, sequential tool calls, default output cap).
 * Returns { request, activeTail }: `activeTail` is the number of trailing
 * prompts that belong to the current turn (see devinHistoryBytes).
 */
export function buildDevinChatRequest(
  messages,
  {
    model,
    chatModelUid = model,
    modelAssignmentJwt,
    modelRow = null,
    tools = [],
    metadata,
    cascadeId,
    executionId = randomUUID(),
    maxOutputTokens,
    temperature,
    topP,
    stopSequences,
  }
) {
  const all = Array.isArray(messages) ? messages : [];
  let start = 0;
  while (start < all.length && all[start]?.role === 'system') start += 1;
  const prompt = all
    .slice(0, start)
    .map((message) => loweredContent(message.content, false).text)
    .filter((text) => text.trim())
    .join('\n\n');
  const history = devinPairedTranscript(devinWireToolCallIds(all.slice(start), model));
  const request = {
    metadata,
    prompt,
    chatMessagePrompts: chatPrompts(history, { model, vision: modelRow?.supportsVision === true, cascadeId }),
    chatModelUid,
    ...(modelAssignmentJwt ? { modelAssignmentJwt } : {}),
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: { optionName: 'auto' },
    systemPromptCacheOptions: { type: CacheControlType.EPHEMERAL },
    disableParallelToolCalls: modelRow?.supportsParallelToolCalls !== true,
    cascadeId,
    executionId,
    configuration: {
      numCompletions: 1,
      maxTokens: Number(maxOutputTokens) || Number(modelRow?.maxOutputTokens) || DEVIN_DEFAULT_MAX_OUTPUT_TOKENS,
      maxNewlines: CLI_MAX_NEWLINES,
      temperature: Number.isFinite(Number(temperature)) && temperature !== null ? Number(temperature) : 1,
      topK: CLI_TOP_K,
      // The CLI sends topP as a float32 widened to double.
      topP: Math.fround(Number.isFinite(Number(topP)) && topP !== null ? Number(topP) : CLI_TOP_P),
      stopPatterns: Array.isArray(stopSequences) ? stopSequences.map(String) : [],
    },
    tools: toolDefinitions(tools, model, chatModelUid),
  };
  return { request, activeTail: activeTailCount(all.slice(start)) };
}
