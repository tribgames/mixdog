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

/**
 * One resolver per provider round. A call keeps its id unless the history, an
 * id this round already handed out, or (for the final batch) another call of
 * the batch holds it; then it gets the smallest free `<id>-<n>`.
 *
 * A call is seen twice per round: streamed (`resolve`, one at a time, often a
 * clone) and in the final batch (`resolve.all`). The n-th call carrying an
 * original id in the final batch is the n-th streamed one, so both resolve to
 * the same new id while two distinct calls that share an id stay distinct.
 * Mutates and returns the calls.
 */
export function createToolCallIdResolver(messages) {
  const handedOut = new Set();
  const byCall = new WeakMap();
  const byOriginal = new Map();

  const isTaken = (id, reserved) => handedOut.has(id) || reserved.has(id) || usedToolCallIds(messages).has(id);

  const allocate = (call, reserved) => {
    const original = call.id;
    let id = original;
    if (isTaken(id, new Set())) {
      let n = 2;
      while (isTaken(`${original}-${n}`, reserved)) n += 1;
      id = `${original}-${n}`;
    }
    handedOut.add(id);
    if (!byOriginal.has(original)) byOriginal.set(original, []);
    byOriginal.get(original).push(id);
    byCall.set(call, { original, id });
    call.id = id;
    return call;
  };

  const resolve = (call) => {
    if (!call?.id) return call;
    const known = byCall.get(call);
    if (known) {
      call.id = known.id;
      return call;
    }
    return allocate(call, new Set());
  };

  resolve.all = (calls) => {
    const seen = new Map();
    const originals = calls.map((call) => byCall.get(call)?.original ?? call?.id);
    calls.forEach((call, index) => {
      if (!call?.id) return;
      const original = originals[index];
      const nth = seen.get(original) ?? 0;
      seen.set(original, nth + 1);
      const known = byCall.get(call) ?? null;
      const mapped = known?.id ?? byOriginal.get(original)?.[nth];
      if (mapped) {
        call.id = mapped;
        if (!known) byCall.set(call, { original, id: mapped });
        return;
      }
      // Ids later in the batch that no earlier pass has placed yet stay theirs.
      const reserved = new Set(originals.slice(index + 1).filter(Boolean));
      allocate(call, reserved);
    });
    return calls;
  };

  return resolve;
}
