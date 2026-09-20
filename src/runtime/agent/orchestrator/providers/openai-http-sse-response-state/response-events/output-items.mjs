/**
 * response-events/output-items.mjs — the output-item lifecycle frames:
 * output_item.added (tool in-flight marking), tool input deltas,
 * function_call_arguments.done (the dispatched call) and output_item.done
 * (collectors + in-flight recompute).
 */
import { recomputeToolInFlight } from '../response-state.mjs';
import { parseJsonObject } from '../response-items.mjs';

function outputItemKind(item) {
  if (item.type === 'reasoning') return 'reasoning';
  if (/tool|function_call/.test(item.type || '')) return 'tool';
  return 'semantic';
}

export function createOutputItemEvents({ state, items, meaningful }) {
  const { toolTracker } = state;

  const onOutputItemAdded = (item) => {
    if (item?.type === 'function_call') {
      toolTracker.mark(item);
      state.pendingCalls.set(item.id || '', {
        name: item.name || '',
        callId: item.call_id || '',
      });
      state.toolInFlight = true;
    } else if (item?.type === 'tool_search_call') {
      // Mark tool_search as in-flight the moment the item is added,
      // mirroring function_call above, so the semantic idle watchdog's
      // pendingToolUse gate (pendingCalls.size) sees a mid-flight
      // tool_search and never lets stall recovery drop it before
      // response.output_item.done. kind:'tool_search' tags the entry so
      // the shared function_call_arguments.done handler never mistakes it
      // for a function call by id collision/empty id.
      if (item.id) {
        state.pendingCalls.set(item.id, {
          name: 'load_tool',
          callId: item.call_id || '',
          kind: 'tool_search',
        });
      }
      toolTracker.mark(item);
      state.toolInFlight = true;
    } else if (item?.type === 'custom_tool_call') {
      // Custom tool calls surface no pendingCalls entry, so mark the item
      // active at added-time (mirroring function_call / tool_search_call
      // above). The later custom_tool_call_input.delta still marks too, but
      // a stall between added and the first input delta must already read
      // as pendingToolUse.
      toolTracker.mark(item);
      state.toolInFlight = true;
    }
    meaningful(state.toolInFlight ? 'tool' : 'semantic');
  };

  const onToolInputDelta = (itemId) => {
    toolTracker.mark(null, itemId);
    state.toolInFlight = true;
    meaningful('tool');
  };

  const onFunctionCallArgumentsDone = (event) => {
    const itemId = event.item_id || '';
    const pending = state.pendingCalls.get(itemId);
    if (pending?.kind === 'tool_search') {
      meaningful('tool');
      return;
    }
    const call = {
      id: pending?.callId || event.call_id || '',
      name: pending?.name || event.name || '',
      arguments: parseJsonObject(event.arguments),
      _pendingItemId: itemId,
    };
    state.toolCalls.push(call);
    if (call.id && call.name) {
      delete call._pendingItemId;
      items.emitToolCall(call);
    }
    meaningful('tool');
  };

  const onOutputItemDone = (item) => {
    items.pushResponseItem(item);
    items.pushReasoningItem(item);
    items.pushWebSearchCall(item);
    if (item.type === 'function_call') {
      const tc = state.toolCalls.find((t) => t._pendingItemId === (item.id || ''));
      if (tc) items.completePendingCall(tc, item);
      // Drop the resolved function item from pendingCalls before
      // recomputing toolInFlight (mirrors tool_search_call below and the
      // compat path).
      state.pendingCalls.delete(item.id || '');
      toolTracker.clear(item, item.id || '');
      recomputeToolInFlight(state);
    } else if (item.type === 'tool_search_call') {
      state.pendingCalls.delete(item.id || '');
      items.pushToolSearchCall(item);
      toolTracker.clear(item, item.id || '');
      recomputeToolInFlight(state);
    } else if (item.type === 'custom_tool_call') {
      items.pushCustomToolCall(item);
      toolTracker.clear(item, item.id || '');
      recomputeToolInFlight(state);
    }
    meaningful(outputItemKind(item));
  };

  return { onOutputItemAdded, onToolInputDelta, onFunctionCallArgumentsDone, onOutputItemDone };
}
