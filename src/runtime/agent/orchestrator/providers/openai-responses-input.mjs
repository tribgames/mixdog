// Transcript lowering is independent of request/turn metadata. A retained
// message must have the same wire representation in every subsequent request.
import { providerReplayItems } from './lib/provider-replay.mjs';
import { ensureResponsesCallOutputs } from './lib/wire-pairing.mjs';
import { normalizeContentForOpenAIResponses, splitToolContentForOpenAIResponses } from './media-normalization.mjs';
import {
  customToolInputFromArguments,
  isCustomToolCallRecord,
  nativeToolSearchCallInput,
  nativeToolSearchOutputInput,
} from './custom-tool-wire.mjs';

/**
 * One tool result → its wire item. Which item depends on how the call was
 * lowered: a custom tool answers with custom_tool_call_output, a native
 * search call with tool_search_output (whose text has to ride along as user
 * media, since that item carries no text field), everything else with
 * function_call_output.
 */
function pushToolResult(
  m,
  { out, pendingToolMedia, pendingToolLoads, customToolCallNameById, nativeSearchCalls, opts }
) {
  const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
  if (customToolCallNameById.has(m.toolCallId || '')) {
    out.push({
      type: 'custom_tool_call_output',
      call_id: m.toolCallId || '',
      name: customToolCallNameById.get(m.toolCallId || '') || undefined,
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
  const loadedNames = (m.nativeToolSearch?.openaiTools || []).map((tool) => tool.name);
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
function pushAssistantToolCalls(toolCalls, { out, customToolCallNameById, nativeSearchCalls }) {
  for (const tc of toolCalls) {
    const nativeSearchCall = nativeToolSearchCallInput(tc);
    if (nativeSearchCall) {
      nativeSearchCalls.set(tc.id, nativeSearchCall);
      out.push(nativeSearchCall);
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
        name: tc.name === 'tool_search' ? 'load_tool' : tc.name,
        arguments: JSON.stringify(tc.arguments),
      });
    }
  }
}

export function convertMessagesToResponsesInput(messages, opts = {}) {
  const out = [];
  const pendingToolMedia = [];
  const pendingToolLoads = [];
  const customToolCallNameById = new Map();
  const nativeSearchCalls = new Map();
  const replayEncryptedReasoning = opts.replayEncryptedReasoning === true;
  const wireParity = opts.codexWireParity === true;
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
  // An update on a tool result applies after its whole batch; one on a user
  // message before it. Adjacent updates are rejected, so a batch update that
  // a user message directly follows yields to that message's own.
  let afterBatch = null;
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    const changedEffort = opts.effortProjection?.updates.get(m);
    if (m.role === 'tool') {
      pushToolResult(m, { out, pendingToolMedia, pendingToolLoads, customToolCallNameById, nativeSearchCalls, opts });
      if (changedEffort) afterBatch = changedEffort;
      continue;
    }
    flushToolMedia();
    if (changedEffort || afterBatch) out.push({ type: 'configuration_update', reasoning: { effort: changedEffort || afterBatch } });
    afterBatch = null;
    // Preserve original assistant phases and item order even when encrypted
    // reasoning is explicitly disabled. Never replay another provider's data.
    const orderedReplay =
      m.role === 'assistant'
        ? providerReplayItems(m, 'openai-responses')?.filter(
            (item) => replayEncryptedReasoning || item?.type !== 'reasoning'
          )
        : undefined;
    if (orderedReplay?.length) {
      for (const item of orderedReplay) {
        if (item?.type === 'custom_tool_call' && item.call_id) {
          customToolCallNameById.set(item.call_id, item.name || '');
        }
        if (item?.type === 'tool_search_call' && item.call_id) {
          nativeSearchCalls.set(item.call_id, item);
        }
        out.push(item);
      }
      continue;
    }
    pushReasoningItems(m, 'before');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      // Legacy sessions may have only flattened messages and reasoning.
      if (m.content)
        out.push(
          wireMessage('assistant', normalizeContentForOpenAIResponses(m.content, { role: 'assistant' }), m.phase)
        );
      pushReasoningItems(m, 'after');
      pushAssistantToolCalls(m.toolCalls, { out, customToolCallNameById, nativeSearchCalls });
      continue;
    }
    out.push(
      wireMessage(
        m.role === 'assistant' ? 'assistant' : 'user',
        normalizeContentForOpenAIResponses(m.content, { role: m.role }),
        m.phase
      )
    );
    pushReasoningItems(m, 'after');
  }
  flushToolMedia();
  if (afterBatch) out.push({ type: 'configuration_update', reasoning: { effort: afterBatch } });
  // Wire-level pairing guard: replay envelopes can carry a call whose
  // result never committed (cancel/abort). The provider hard-rejects the
  // unpaired call, so synthesize the missing outputs here.
  return ensureResponsesCallOutputs(out);
}
