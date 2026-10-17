export const BRIDGE_NAME_MAX_CHARS = 256;
const META_NAMES = new Set(['load_tool', 'call_tool', 'tool_search']);

export function isBridgeMetaTool(name) {
  return typeof name === 'string' && META_NAMES.has(name.toLowerCase());
}
