export function errText(e) {
  if (e == null) return String(e);
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || String(e);
  // ErrorEvent / event-like / plain object (NOT instanceof Error)
  if (typeof e.message === 'string' && e.message) return e.message;
  if (e.error != null && e.error !== e) return errText(e.error);
  if (e.reason != null && e.reason !== e) return errText(e.reason);
  if (typeof e.type === 'string' && e.type) return `${e.type} event`;
  try { const j = JSON.stringify(e); if (j && j !== '{}' && j !== 'null') return j; } catch {}
  return String(e);
}