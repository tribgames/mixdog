import { createProviderReplay } from '../lib/provider-replay.mjs';
import { _cloneJson, _stableStringify } from '../openai-ws-delta.mjs';

function responseItemKey(item, fallbackIndex = 0) {
  if (!item || typeof item !== 'object') return `primitive:${fallbackIndex}`;
  if (item.id) return `${item.type || 'item'}:id:${item.id}`;
  if (item.call_id) return `${item.type || 'item'}:call:${item.call_id}`;
  try {
    return `${item.type || 'item'}:json:${_stableStringify(item)}`;
  } catch {}
  return `${item.type || 'item'}:${fallbackIndex}`;
}

// Response items collected for next-turn replay (deduped by id/call_id/shape)
// plus the reasoning items with encrypted_content.
export function createReplayItems() {
  const items = [];
  const keys = new Set();
  // Reasoning items collected from response.output_item.done (or salvaged
  // from response.completed.response.output) stay in the logical history.
  // The delta builder strips already-anchored items from the wire tail;
  // the reasoning replay policy suppresses them only after a duplicate-item
  // rejection, so full frames remain self-contained.
  const reasoningItems = [];

  function push(item) {
    if (!item || typeof item !== 'object') return;
    const key = responseItemKey(item, items.length);
    if (keys.has(key)) {
      const existing = items.find((candidate, index) => responseItemKey(candidate, index) === key);
      if (existing?.type === 'function_call' && item.type === 'function_call') {
        if (!existing.call_id && item.call_id) existing.call_id = item.call_id;
        if (!existing.name && item.name) existing.name = item.name;
        if ((existing.arguments == null || existing.arguments === '') && item.arguments != null)
          existing.arguments = item.arguments;
      }
      return;
    }
    keys.add(key);
    items.push(_cloneJson(item));
  }

  function enrichFunctionCall({ itemId = '', callId = '', name = '', argumentsText = '' } = {}) {
    for (const item of items) {
      if (item?.type !== 'function_call') continue;
      if (itemId && item.id && item.id !== itemId) continue;
      if (callId && item.call_id && item.call_id !== callId) continue;
      if (!item.call_id && callId) item.call_id = callId;
      if (!item.name && name) item.name = name;
      if ((item.arguments == null || item.arguments === '') && argumentsText) item.arguments = argumentsText;
    }
  }

  function pushReasoning(item) {
    if (item?.type !== 'reasoning') return;
    if (!item.encrypted_content) return;
    reasoningItems.push({
      id: item.id || '',
      encrypted_content: item.encrypted_content,
      summary: Array.isArray(item.summary) ? item.summary : [],
      // Emission order is part of the chain proof. A turn can reason, speak,
      // then reason again before calling a tool; rebuilding it with every
      // reasoning item in front of the text yields an order the previous
      // response never produced, and the incremental check then fails on the
      // message item and drops the chain to a cold full frame. Record which
      // side of the text this item arrived on.
      ...(items.some((added) => added?.type === 'message') ? { afterText: true } : {}),
    });
  }

  return {
    items,
    reasoningItems,
    push,
    enrichFunctionCall,
    pushReasoning,
    hasReasoning: (id) => reasoningItems.some((r) => r.id === id),
    replay: (provider) => createProviderReplay(provider, items),
  };
}
