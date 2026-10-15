// Normalized Anthropic server-tool usage counters (`usage.server_tool_use`):
// the number of server-side web searches / web fetches the turn ran. Returns
// undefined when the usage reports none, so ordinary turns carry no field.
const COUNTERS = [
  ['web_search_requests', 'webSearchRequests'],
  ['web_fetch_requests', 'webFetchRequests'],
];

export function normalizeServerToolUse(raw) {
  const source = raw && typeof raw === 'object' ? raw.server_tool_use : null;
  if (!source || typeof source !== 'object') return undefined;
  const out = {};
  for (const [wire, key] of COUNTERS) {
    const n = Number(source[wire]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}
