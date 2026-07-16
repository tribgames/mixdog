// Environment-variable coercion helpers shared by session-runtime modules.
export function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

export function envPresent(name) {
  return process.env[name] !== undefined && process.env[name] !== '';
}

export function envDelayMs(name, fallback, { min = 0, max = 60_000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
