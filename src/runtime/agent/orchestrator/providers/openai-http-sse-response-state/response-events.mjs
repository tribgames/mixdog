/**
 * openai-http-sse-response-state/response-events.mjs — the Responses event
 * switch: routes each `response.*` frame to the output-item handlers or the
 * terminal-frame handlers (see response-events/*.mjs).
 */
import { createOutputItemEvents } from './response-events/output-items.mjs';
import { createTerminalFrameEvents } from './response-events/terminal-frames.mjs';

export { endTurnFromEvent as _endTurnFromEvent } from '../lib/responses-terminal-fields.mjs';

export function createResponseEvents({ state, items, text, outcome, meaningful, onServerEvent }) {
  const output = createOutputItemEvents({ state, items, meaningful });
  const terminal = createTerminalFrameEvents({ state, items, text, outcome, meaningful });

  const handleEvent = (event) => {
    if (!event || typeof event.type !== 'string') return;
    onServerEvent();
    switch (event.type) {
      case 'response.created':
        if (event.response?.model) state.model = event.response.model;
        if (event.response?.id) state.responseId = event.response.id;
        meaningful('semantic');
        break;
      case 'response.output_text.delta':
        text.relayLeakText(event.delta || '');
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        if (event.delta) {
          // Reasoning exposure is a replay boundary the MOMENT a delta
          // arrives — not at response completion. A failure after this
          // point must never be re-issued (duplicate exposed thinking).
          state.emittedReasoning = true;
          meaningful('reasoning');
        }
        break;
      case 'response.output_item.added':
        output.onOutputItemAdded(event.item);
        break;
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        output.onToolInputDelta(event.item_id);
        break;
      case 'response.function_call_arguments.done':
        output.onFunctionCallArgumentsDone(event);
        break;
      case 'response.output_item.done':
        output.onOutputItemDone(event.item || {});
        break;
      case 'response.completed':
        terminal.onCompleted(event);
        break;
      case 'response.done':
        terminal.onDone(event);
        break;
      case 'response.failed':
        throw terminal.failedFrameError(event);
      case 'response.incomplete':
        terminal.onIncomplete(event, 'response.incomplete');
        break;
      case 'error':
        throw terminal.errorFrameError(event);
      default:
        break;
    }
  };

  return { handleEvent };
}
