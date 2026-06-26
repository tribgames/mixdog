/**
 * TUI duration formatting, matching Claude Code's formatDuration shape.
 *
 * Examples:
 *   42s
 *   9m 23s
 *   1h 2m 3s
 *   1d 3h 20m
 */
export function formatDuration(ms, options = {}) {
  if (!Number.isFinite(Number(ms))) return '';
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) {
    if (value < 1_000) return '';
    return `${Math.floor(value / 1000)}s`;
  }

  let days = Math.floor(value / 86_400_000);
  let hours = Math.floor((value % 86_400_000) / 3_600_000);
  let minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);

  if (options.mostSignificantOnly) {
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  const hide = options.hideTrailingZeros;
  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`;
    if (hide && minutes === 0) return `${days}d ${hours}h`;
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`;
    if (hide && seconds === 0) return `${hours}h ${minutes}m`;
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`;
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatElapsed(ms) {
  const n = Math.max(0, Number(ms || 0));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return '';
  return formatDuration(n);
}
