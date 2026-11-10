const functionOrNull = (value) => (typeof value === 'function' ? value : null);

/** The caller-supplied stream/stage hooks of a send, each a function or null. */
export function streamCallbacks(opts) {
  return {
    onStageChange: functionOrNull(opts.onStageChange),
    onStreamDelta: functionOrNull(opts.onStreamDelta),
    onToolCall: functionOrNull(opts.onToolCall),
    onTextDelta: functionOrNull(opts.onTextDelta),
    onTextReset: functionOrNull(opts.onTextReset),
    onStreamItemStart: functionOrNull(opts.onStreamItemStart),
  };
}

/** Tell the caller a provider output item started streaming: `{ kind: 'tool' }`
 *  for a client tool call whose arguments are still on the way, `{ kind:
 *  'text', phase }` for an assistant message that names its phase
 *  (`commentary` / `final_answer`). A listener failure never reaches the
 *  stream. */
export function reportStreamItemStart(onStreamItemStart, detail) {
  if (typeof onStreamItemStart !== 'function' || !detail) return;
  try {
    onStreamItemStart(detail);
  } catch {}
}

const ASSISTANT_PHASES = new Set(['commentary', 'final_answer']);

/** What a Responses output item tells `reportStreamItemStart`: a client tool
 *  call, an assistant message carrying its phase, or nothing (null). */
export function responsesItemStart(item) {
  const type = item?.type;
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') return { kind: 'tool' };
  if (type === 'message' && ASSISTANT_PHASES.has(item.phase)) return { kind: 'text', phase: item.phase };
  return null;
}
