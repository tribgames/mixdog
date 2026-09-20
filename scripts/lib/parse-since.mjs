// `--since` parsing shared by the bench/corpus scripts: `now`, an epoch in
// seconds or milliseconds, a relative window (`90m`, `2h`, `7d`) counted back
// from now, or anything Date.parse accepts. Returns a millisecond timestamp.
export const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSince(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^now$/i.test(raw)) return Date.now();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const rel = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return Date.now() - n * DURATION_UNIT_MS[unit];
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
