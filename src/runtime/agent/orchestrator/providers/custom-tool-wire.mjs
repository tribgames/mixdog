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
    tools: native.openaiTools,
  };
}
