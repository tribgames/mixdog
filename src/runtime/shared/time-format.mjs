/**
 * runtime/shared/time-format.mjs — compact elapsed-time labels shared by every
 * surface (TUI, terminal, desktop renderer). Moved verbatim from
 * src/tui/time-format.mjs so tool-card detail rows ("Running · 12s") derive
 * from ONE formatter; the TUI module re-exports from here.
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

function validDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function resolvedLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatUtcTimestamp(value = new Date()) {
  return validDate(value)?.toISOString() || '';
}

function normalizeUtcOffset(value) {
  const text = String(value || '');
  const match = /(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(text);
  if (!match) return 'UTC+00:00';
  return `UTC${match[1]}${String(Number(match[2])).padStart(2, '0')}:${match[3] || '00'}`;
}

export function localTimestampParts(value = new Date(), { timeZone = resolvedLocalTimeZone() } = {}) {
  const date = validDate(value);
  if (!date) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}:${get('second')}`,
      timeZone,
      offset: normalizeUtcOffset(get('timeZoneName')),
      utc: date.toISOString(),
    };
  } catch {
    return {
      date: date.toISOString().slice(0, 10),
      time: date.toISOString().slice(11, 19),
      timeZone: 'UTC',
      offset: 'UTC+00:00',
      utc: date.toISOString(),
    };
  }
}

export function formatLocalAndUtcTimestamp(value = new Date(), options = {}) {
  const parts = localTimestampParts(value, options);
  if (!parts) return '';
  return `Local: ${parts.date} ${parts.time} ${parts.timeZone} (${parts.offset})\nUTC: ${parts.utc}`;
}

export function formatRecallTimestamp(value, options = {}) {
  const parts = localTimestampParts(value, options);
  if (!parts) return '';
  return `${parts.date} ${parts.time.slice(0, 5)} ${parts.timeZone} (${parts.offset}; UTC ${parts.utc.slice(0, 16).replace('T', ' ')}Z)`;
}
