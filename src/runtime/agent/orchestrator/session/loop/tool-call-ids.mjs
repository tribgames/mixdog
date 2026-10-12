/**
 * tool-call-ids.mjs — a tool call id is unique within a transcript.
 *
 * Tool results are paired to their assistant turn by id, and the pairing
 * repairs treat a second assistant turn that reuses an id as a duplicate
 * with no result: they drop it, so its (already executed) result never
 * reaches the model and the model asks again, forever. Local and
 * OpenAI-compatible servers reuse ids across turns (`call_0`, `call_1`), so
 * a call whose id the history already carries is renamed before anything —
 * eager dispatch, the transcript, the UI — records it.
 */
import { collectAssistantToolCallIds } from '../context-tool-pairs.mjs';

function usedToolCallIds(messages) {
  const used = new Set();
  for (const message of messages) {
    if (message?.role === 'tool' && message.toolCallId) used.add(message.toolCallId);
    for (const id of collectAssistantToolCallIds(message)) used.add(id);
  }
  return used;
}

/** One resolver per provider round: a streamed call and the same call in the
 *  final response resolve to the same new id. Mutates and returns the call. */
export function createToolCallIdResolver(messages) {
  const renamed = new Map();
  return (call) => {
    const id = call?.id;
    if (!id) return call;
    if (renamed.has(id)) {
      call.id = renamed.get(id);
      return call;
    }
    const used = usedToolCallIds(messages);
    if (!used.has(id)) return call;
    let n = 2;
    while (used.has(`${id}-${n}`)) n += 1;
    renamed.set(id, `${id}-${n}`);
    call.id = renamed.get(id);
    return call;
  };
}