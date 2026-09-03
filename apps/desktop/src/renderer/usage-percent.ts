export function displayUsagePercent(value: unknown): number | null {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) {
    return null;
  }
  const percent = Math.max(0, Math.min(100, parsed));
  if (percent > 0 && percent < 1) return Math.round(percent * 10) / 10;
  return Math.round(percent);
}
