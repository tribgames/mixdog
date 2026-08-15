export function displayUsagePercent(value: unknown): number | null {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) {
    return null;
  }
  const percent = Math.max(0, Math.min(100, parsed));
  return percent > 0 && percent < 1 ? 1 : Math.round(percent);
}
