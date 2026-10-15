// Transcript lowering is independent of request/turn metadata. A retained
// message must have the same wire representation in every subsequent request.
import { providerReplayItems } from './lib/provider-replay.mjs';
import { responsesEffortUpdates } from './effort-configuration.mjs';
import { ensureResponsesCallOutputs } from './lib/wire-pairing.mjs';
import { normalizeContentForOpenAIResponses, splitToolContentForOpenAIResponses } from './media-normalization.mjs';
import {
  customToolInputFromArguments,
  isCustomToolCallRecord,
  nativeToolSearchCallInput,
  nativeToolSearchOutputInput,
  toolCallNamespace,
} from './custom-tool-wire.mjs';

// A call record that carries a Responses namespace replays it beside `name`.
const namespaceField = (call) => {
  const namespace = toolCallNamespace(call);
  return namespace ? { namespace } : {};
};

// A replayed native tool_search item for a model that has no tool_search tool:
// a client call becomes the load_tool function call (its output is lowered
// from the tool message), server-executed calls and outputs are dropped.
function withoutNativeToolSearch(item) {
  if (item?.type === 'tool_search_output') return null;
  if (item?.type !== 'tool_search_call') return item;
  if (item.execution === 'server' || !item.call_id) return null;
  return {
    type: 'function_call',
    call_id: item.call_id,
    name: 'load_tool',
    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
  };
}

/**
 * One tool result → its wire item. Which item depends on how the call was
 * lowered: a custom tool answers with custom_tool_call_output, a native
 * search call with tool_search_output (whose text has to ride along as user
 * media, since that item carries no text field), everything else with
 * function_call_output.
 */
function pushToolResult(m, { out, pendingToolMedia, pendingToolLoads, customToolCallIds, nativeSearchCalls, opts }) {
  const { output, mediaContent } = (opts.splitToolContent || splitToolContentForOpenAIResponses)(m.content);
  if (customToolCallIds.has(m.toolCallId || '')) {
    // Documented custom_tool_call_output shape: call_id + output (+ id).
    out.push({
      type: 'custom_tool_call_output',
      call_id: m.toolCallId || '',
      output,
    });
    if (mediaContent) pendingToolMedia.push(...mediaContent);
    return;
  }
  const searchCall = nativeSearchCalls.get(m.toolCallId || '');
  if (searchCall) {
    const nativeSearchOutput = nativeToolSearchOutputInput(m, opts.nativeToolSearchProvider || 'openai-oauth') || {
      type: 'tool_search_output',
      call_id: m.toolCallId || '',
      status: 'completed',
      execution: 'client',
      tools: [],
    };
    out.push(nativeSearchOutput);
    // Native search outputs have no text field. Keep skill status,
    // missing dependencies and failed/denied loader results visible.
    if (searchCall.arguments?.name || !nativeSearchOutput.tools.length) {
      pendingToolMedia.push({ type: 'input_text', text: output });
    }
    if (mediaContent) pendingToolMedia.push(...mediaContent);
    return;
  }
  // A function result (e.g. Skill) cannot carry schemas. Tools it already
  // loaded ride a runtime load_tool pair emitted after the batch's outputs;
  // only a result from another native family falls back to a load hint.
  const loadedNames =
    opts.nativeToolSearch === false ? [] : (m.nativeToolSearch?.openaiTools || []).map((tool) => tool.name);
  const loadOutput = loadedNames.length
    ? nativeToolSearchOutputInput(m, opts.nativeToolSearchProvider || 'openai-oauth')
    : null;
  out.push({
    type: 'function_call_output',
    call_id: m.toolCallId || '',
    output:
      loadedNames.length && !loadOutput
        ? `${output}\nThis ordinary function result cannot register native tools. Use tool_search with names:${JSON.stringify(loadedNames)} to load their definitions.`
        : output,
  });
  if (loadOutput) {
    const loadCallId = `${m.toolCallId || ''}_load`;
    pendingToolLoads.push(
      nativeToolSearchCallInput({
        id: loadCallId,
        arguments: { names: loadedNames },
        nativeType: 'tool_search_call',
      }),
      { ...loadOutput, call_id: loadCallId }
    );
  }
  if (mediaContent) pendingToolMedia.push(...mediaContent);
}

/**
 * An assistant turn's tool calls → their wire items, remembering which id was
 * lowered as a custom tool or a native search call so the matching result
 * lowers the same way.
 */
function pushAssistantToolCalls(toolCalls, { out, customToolCallIds, nativeSearchCalls, nativeToolSearch }) {
  for (const tc of toolCalls) {
    // A model without native tool_search replays its load_tool call as the
    // plain function call it was declared as.
    const nativeSearchCall = nativeToolSearch ? nativeToolSearchCallInput(tc) : null;
    if (nativeSearchCall) {
      nativeSearchCalls.set(tc.id, nativeSearchCall);
      out.push(nativeSearchCall);
    } else if (isCustomToolCallRecord(tc)) {
      if (tc.id) customToolCallIds.add(tc.id);
      out.push({
        type: 'custom_tool_call',
        call_id: tc.id,
        name: tc.name,
        ...namespaceField(tc),
        input: customToolInputFromArguments(tc.name, tc.arguments),
      });
    } else {
      out.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.name === 'tool_search' ? 'load_tool' : tc.name,
        ...namespaceField(tc),
        arguments: JSON.stringify(tc.arguments),
      });
    }
  }
}

/**
 * Messages → Responses input items, native-aware. Defaults are the first-party
 * OpenAI lowering. Gateways that speak the same item types opt in through:
 *  - `replayProvider`: the providerReplay owner tag accepted for ordered
 *    replay (default 'openai-responses'); any other owner is never replayed.
 *  - `replayOwnedReasoning`: keep reasoning items of an accepted ordered
 *    replay even when `replayEncryptedReasoning` (flattened message
 *    reasoning) is off.
 *  - `reasoningByMessageIndex`: same-owner reasoning from provider state,
 *    injected before the message at that index (or after the last one).
 *  - `includeSystem`, `nativePdf`, `splitToolContent`, `startIndex`: the
 *    gateway's system/media/continuation handling.
 */
export function convertMessagesToResponsesInput(messages, opts = {}) {
  const out = [];
  const pendingToolMedia = [];
  const pendingToolLoads = [];
  const customToolCallIds = new Set();
  const nativeSearchCalls = new Map();
  const replayEncryptedReasoning = opts.replayEncryptedReasoning === true;
  const wireParity = opts.codexWireParity === true;
  const replayOwner = opts.replayProvider || 'openai-responses';
  const replayOwnedReasoning = opts.replayOwnedReasoning ?? replayEncryptedReasoning;
  // Native tool_search is a per-model capability (gpt-5.4 and later on the
  // public API); every other caller keeps it.
  const nativeToolSearch = opts.nativeToolSearch !== false;
  const nativePdf = opts.nativePdf;
  const contentOpts = (role) => (nativePdf === undefined ? { role } : { role, nativePdf });
  const wireMessage = (role, content, phase) => ({
    ...(wireParity ? { type: 'message' } : {}),
    role,
    content,
    ...(role === 'assistant' && (phase === 'commentary' || phase === 'final_answer') ? { phase } : {}),
    // Current turn_id belongs to request-level client metadata/headers,
    // never every historical message. Native replay items below retain
    // their original metadata instead of being restamped.
    ...(wireParity ? { internal_chat_message_metadata_passthrough: {} } : {}),
  });
  // `phase` replays each retained item on the side of the assistant text it
  // was emitted on, so the rebuilt turn keeps the response's own item order.
  const pushReasoningItems = (message, phase = 'before') => {
    if (!replayEncryptedReasoning || message?.role !== 'assistant' || !Array.isArray(message.reasoningItems)) return;
    for (const item of message.reasoningItems) {
      if ((item?.afterText === true) !== (phase === 'after')) continue;
      // Collector shape contract: the WS/HTTP stream collectors store
      // retained items as {id, encrypted_content, summary} WITHOUT a
      // type tag (openai-ws-stream pushReasoningItem). Requiring
      // type:'reasoning' here silently dropped every retained item, so
      // replay never actually fired. Accept untagged items; only an
      // explicit non-reasoning tag is rejected.
      if (!item || (item.type != null && item.type !== 'reasoning')) continue;
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) continue;
      out.push({
        type: 'reasoning',
        ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
        encrypted_content: item.encrypted_content,
        summary: Array.isArray(item.summary) ? item.summary : [],
      });
    }
  };
  // Batch boundary: runtime load pairs follow every output of the batch so
  // no call/output pair is split, then any tool media rides as user content.
  const flushToolMedia = () => {
    out.push(...pendingToolLoads.splice(0));
    if (!pendingToolMedia.length) return;
    out.push(wireMessage('user', pendingToolMedia.splice(0)));
  };
  const effortUpdates = responsesEffortUpdates(opts.effortProjection);
  for (let messageIndex = opts.startIndex || 0; messageIndex < messages.length; messageIndex += 1) {
    const m = messages[messageIndex];
    if (!m || (m.role === 'system' && opts.includeSystem !== true)) continue;
    const updates = effortUpdates.before(m);
    if (m.role === 'tool') {
      pushToolResult(m, { out, pendingToolMedia, pendingToolLoads, customToolCallIds, nativeSearchCalls, opts });
      continue;
    }
    flushToolMedia();
    out.push(...updates);
    // Preserve original assistant phases and item order even when encrypted
    // reasoning is explicitly disabled. Never replay another provider's data.
    const orderedReplay =
      m.role === 'assistant'
        ? providerReplayItems(m, replayOwner)?.filter((item) => replayOwnedReasoning || item?.type !== 'reasoning')
        : undefined;
    if (orderedReplay?.length) {
      for (const replayItem of orderedReplay) {
        const item = nativeToolSearch ? replayItem : withoutNativeToolSearch(replayItem);
        if (!item) continue;
        if (item?.type === 'custom_tool_call' && item.call_id) {
          customToolCallIds.add(item.call_id);
        }
        if (item?.type === 'tool_search_call' && item.call_id) {
          nativeSearchCalls.set(item.call_id, item);
        }
        out.push(item);
      }
      continue;
    }
    if (opts.reasoningByMessageIndex?.has(messageIndex)) out.push(...opts.reasoningByMessageIndex.get(messageIndex));
    pushReasoningItems(m, 'before');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      // Legacy sessions may have only flattened messages and reasoning.
      if (m.content)
        out.push(
          wireMessage('assistant', normalizeContentForOpenAIResponses(m.content, contentOpts('assistant')), m.phase)
        );
      pushReasoningItems(m, 'after');
      pushAssistantToolCalls(m.toolCalls, { out, customToolCallIds, nativeSearchCalls, nativeToolSearch });
      continue;
    }
    out.push(
      wireMessage(
        m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        normalizeContentForOpenAIResponses(m.role === 'system' ? m.content || '' : m.content, contentOpts(m.role)),
        m.phase
      )
    );
    pushReasoningItems(m, 'after');
  }
  flushToolMedia();
  if (opts.reasoningByMessageIndex?.has(messages.length)) out.push(...opts.reasoningByMessageIndex.get(messages.length));
  out.push(...effortUpdates.end());
  // Wire-level pairing guard: replay envelopes can carry a call whose
  // result never committed (cancel/abort). The provider hard-rejects the
  // unpaired call, so synthesize the missing outputs here.
  return ensureResponsesCallOutputs(out);
}
