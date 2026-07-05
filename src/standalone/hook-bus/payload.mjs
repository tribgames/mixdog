export function compactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 12)) {
      if (/token|secret|key|password/i.test(key)) {
        out[key] = '<redacted>';
      } else {
        out[key] = compactValue(val);
      }
    }
    return out;
  }
  return String(value);
}

export function summarizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');
  const parts = [];
  if (payload.sessionId || payload.session_id) parts.push(`session=${payload.sessionId || payload.session_id}`);
  if (payload.name || payload.tool_name) parts.push(`name=${payload.name || payload.tool_name}`);
  if (payload.provider || payload.model) parts.push([payload.provider, payload.model].filter(Boolean).join('/'));
  if (payload.prompt) parts.push(`prompt=${String(payload.prompt).slice(0, 60).replace(/\s+/g, ' ')}`);
  if (payload.reason) parts.push(`reason=${String(payload.reason).slice(0, 120)}`);
  if (payload.error) parts.push(`error=${String(payload.error).slice(0, 120)}`);
  if (payload.elapsedMs != null) parts.push(`${payload.elapsedMs}ms`);
  return parts.join(' · ');
}
