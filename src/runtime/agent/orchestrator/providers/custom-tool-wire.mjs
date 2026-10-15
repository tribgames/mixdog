export function isResponsesFreeformTool(tool) {
  return !!(
    tool?.freeform &&
    tool.freeform.type === 'grammar' &&
    typeof tool.freeform.syntax === 'string' &&
    typeof tool.freeform.definition === 'string'
  );
}

export function toResponsesCustomTool(tool) {
  return {
    type: 'custom',
    name: tool.name,
    description: tool.freeformDescription || tool.description,
    format: tool.freeform,
  };
}

export function customToolInputFromArguments(name, args) {
  if (typeof args === 'string') return args;
  if (name === 'apply_patch' && typeof args?.patch === 'string') return args.patch;
  if (typeof args?.input === 'string') return args.input;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args ?? '');
  }
}

function customToolArgumentsFromInput(name, input) {
  const text =
    typeof input === 'string'
      ? input
      : (() => {
          try {
            return JSON.stringify(input ?? '');
          } catch {
            return String(input ?? '');
          }
        })();
  if (name === 'apply_patch') return { patch: text };
  return { input: text };
}

// Responses calls of a tool loaded from a declared namespace carry
// `namespace` beside `name`. Mixdog declares no namespaces today, so this is
// parse-side preservation only: a call that carries one keeps it on its
// record (and in replay), and its dispatch dedupe identity is qualified, so it
// is never conflated with a same-named top-level tool.
export function toolCallNamespace(item) {
  return typeof item?.namespace === 'string' && item.namespace ? item.namespace : '';
}

/** Copy the source item's namespace onto a call record (mutates; returns it). */
export function withToolCallNamespace(call, source) {
  const namespace = toolCallNamespace(source);
  if (call && namespace && !call.namespace) call.namespace = namespace;
  return call;
}

/** Dispatch dedupe identity: the namespace-qualified tool name. */
export function qualifiedToolCallName(call) {
  const namespace = toolCallNamespace(call);
  const name = call?.name || '';
  return namespace ? `${namespace}.${name}` : name;
}

export function customToolCallFromResponseItem(item) {
  if (item?.type !== 'custom_tool_call') return null;
  const id = item.call_id || item.id || '';
  const name = item.name || '';
  if (!id || !name) return null;
  return withToolCallNamespace(
    {
      id,
      name,
      arguments: customToolArgumentsFromInput(name, item.input ?? ''),
      nativeType: 'custom_tool_call',
    },
    item
  );
}

export function isCustomToolCallRecord(call) {
  return call?.nativeType === 'custom_tool_call';
}

// The client-side search tool is load_tool only; Skill stays its own function
// tool. Keep the actual response arguments intact for replay and dispatch policy.
export function nativeToolSearchCallFromArguments(id, args) {
  return {
    id,
    name: 'load_tool',
    arguments: args,
    nativeType: 'tool_search_call',
  };
}

export function nativeToolSearchCallInput(call) {
  if (call?.nativeType !== 'tool_search_call') return null;
  return {
    type: 'tool_search_call',
    call_id: call.id || '',
    execution: 'client',
    arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
  };
}

export function nativeToolSearchOutputInput(message, provider) {
  const native = message?.nativeToolSearch;
  const source = String(native?.provider || '').toLowerCase();
  const target = String(provider || '').toLowerCase();
  const openaiNative = new Set(['openai', 'openai-oauth']);
  const sameNativeFamily = source === target || (openaiNative.has(source) && openaiNative.has(target));
  if (!native || (source && !sameNativeFamily)) return null;
  if (!Array.isArray(native.openaiTools)) return null;
  return {
    type: 'tool_search_output',
    call_id: message.toolCallId || '',
    status: 'completed',
    execution: 'client',
    // Responses otherwise normalizes optional fields to required. Apply this
    // at the wire boundary so restored tool-search history is covered too.
    tools: native.openaiTools.map((tool) => (tool?.type === 'function' ? { ...tool, strict: false } : tool)),
  };
}
