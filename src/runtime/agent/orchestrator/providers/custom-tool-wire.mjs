export function isResponsesFreeformTool(tool) {
  return !!(tool?.freeform
    && tool.freeform.type === 'grammar'
    && typeof tool.freeform.syntax === 'string'
    && typeof tool.freeform.definition === 'string');
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
  try { return JSON.stringify(args ?? {}); } catch { return String(args ?? ''); }
}

function customToolArgumentsFromInput(name, input) {
  const text = typeof input === 'string'
    ? input
    : (() => {
        try { return JSON.stringify(input ?? ''); } catch { return String(input ?? ''); }
      })();
  if (name === 'apply_patch') return { patch: text };
  return { input: text };
}

export function customToolCallFromResponseItem(item) {
  if (!item || item.type !== 'custom_tool_call') return null;
  const id = item.call_id || item.id || '';
  const name = item.name || '';
  if (!id || !name) return null;
  return {
    id,
    name,
    arguments: customToolArgumentsFromInput(name, item.input ?? ''),
    nativeType: 'custom_tool_call',
  };
}

export function isCustomToolCallRecord(call) {
  return call?.nativeType === 'custom_tool_call';
}

// A single client-side search tool loads either exact tool names or a skill.
// Keep the actual response arguments intact for replay and dispatch policy.
export function nativeToolSearchCallFromArguments(id, args) {
  return {
    id,
    name: typeof args?.name === 'string' && !Object.hasOwn(args, 'names') ? 'Skill' : 'load_tool',
    arguments: args,
    nativeType: 'tool_search_call',
  };
}

export function responsesToolLoadingSurface(tools = []) {
  const skill = tools.find((tool) => tool?.name === 'Skill');
  if (!skill) return tools;
  const loader = tools.find((tool) => tool?.name === 'load_tool' || tool?.name === 'tool_search');
  const parameters = {
    type: 'object',
    properties: {
      ...(loader?.inputSchema?.properties || {}),
      name: skill.inputSchema?.properties?.name || { type: 'string' },
    },
    ...(loader
      ? { oneOf: [{ required: ['name'] }, { required: ['names'] }] }
      : { required: ['name'] }),
    additionalProperties: false,
  };
  const combined = {
    ...(loader || skill),
    name: loader?.name || 'load_tool',
    description: [
      loader?.description,
      'For Skill instructions, call this tool with name:"skill-name" instead of names. It loads the skill body and its required tool schemas together; no second load is needed.',
      skill.description,
    ].filter(Boolean).join('\n'),
    inputSchema: parameters,
  };
  return tools.flatMap((tool) => {
    if (tool === (loader || skill)) return [combined];
    return tool === skill ? [] : [tool];
  });
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
  const sameNativeFamily = source === target
    || (openaiNative.has(source) && openaiNative.has(target));
  if (!native || (source && !sameNativeFamily)) return null;
  if (!Array.isArray(native.openaiTools)) return null;
  return {
    type: 'tool_search_output',
    call_id: message.toolCallId || '',
    status: 'completed',
    execution: 'client',
    // Responses otherwise normalizes optional fields to required. Apply this
    // at the wire boundary so restored tool-search history is covered too.
    tools: native.openaiTools.map(tool => tool?.type === 'function'
      ? { ...tool, strict: false }
      : tool),
  };
}
