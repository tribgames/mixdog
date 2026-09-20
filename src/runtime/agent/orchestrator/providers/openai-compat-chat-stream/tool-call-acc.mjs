/**
 * openai-compat-chat-stream/tool-call-acc.mjs — accumulating streamed
 * tool_calls deltas keyed by index/id/anonymous bucket, and turning the
 * accumulator back into the message shape parseToolCalls expects.
 */
export function createToolCallAccumulator() {
  return { byKey: new Map(), orderSeq: 0, nextAnonId: 0, lastAnonKey: null };
}

export function mergeToolCallDelta(acc, deltaCalls) {
  for (const tc of deltaCalls || []) {
    let key;
    if (Number.isFinite(Number(tc?.index))) {
      key = `n:${Number(tc.index)}`;
    } else if (tc.id) {
      key = `id:${tc.id}`;
    } else if (tc.function?.name) {
      const anonId = ++acc.nextAnonId;
      key = `anon:${anonId}`;
    } else {
      key = acc.lastAnonKey;
      if (!key) continue;
    }
    // Bare argument deltas continue the most recently identified call.
    acc.lastAnonKey = key;
    let prev = acc.byKey.get(key);
    if (!prev) {
      prev = {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
        _order: ++acc.orderSeq,
      };
      acc.byKey.set(key, prev);
    }
    if (tc.id) prev.id = tc.id;
    if (tc.type) prev.type = tc.type;
    if (tc.function?.name && !prev.function.name) prev.function.name = tc.function.name;
    if (tc.function?.arguments) {
      const delta = tc.function.arguments;
      // Preserve support for providers that repeat cumulative arguments.
      if (prev.function.arguments && delta.startsWith(prev.function.arguments)) {
        prev.function.arguments = delta;
      } else {
        prev.function.arguments += delta;
      }
    }
  }
}

/** Accumulated calls in arrival order, without the private ordering field. */
export function orderedToolCalls(acc) {
  return [...acc.byKey.values()]
    .sort((a, b) => a._order - b._order)
    .map((v) => {
      const { _order, ...rest } = v;
      return rest;
    });
}

export function toolCallsFromStreamAcc(acc, parseToolCalls, label, finishReason) {
  if (!acc.byKey.size) return undefined;
  const choice = {
    // The observed terminal reason distinguishes bad JSON from truncation.
    finish_reason: finishReason || null,
    message: { tool_calls: orderedToolCalls(acc) },
  };
  return parseToolCalls(choice, label);
}
