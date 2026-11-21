import { t } from './i18n';
import { usageNumber } from './usage-format';
import { formatUsageResetRemaining } from './usage-reset-time';

/** Epoch milliseconds from a seconds or milliseconds value; null when absent. */
export function usageTimestamp(value: unknown): number | null {
  const parsed = usageNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

export function usageWindowLabel(window: { label?: unknown }): string {
  const label = String(window.label || 'Quota').trim();
  if (/^(?:w|wk|week|weekly)$/i.test(label)) return 'W';
  if (/^(?:mo|mon|month|monthly)$/i.test(label)) return 'M';
  if (/^flsh$/i.test(label)) return 'FLASH';
  return label.toUpperCase();
}

// Reset durations stay lowercase (`5h` is elapsed time), distinct from the
// uppercase quota-window labels (`5H`, W, M).
export function usageResetSchedule(value: unknown): { state: 'due' | 'soon' | 'in' | ''; time: string } {
  const resetAt = usageTimestamp(value);
  if (resetAt === null) return { state: '', time: '' };
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return { state: 'due', time: '' };
  const time = formatUsageResetRemaining(remaining);
  return time ? { state: 'in', time } : { state: 'soon', time: '' };
}

export function usageResetText(value: unknown): string {
  const schedule = usageResetSchedule(value);
  if (schedule.state === 'due') return t('Reset due');
  if (schedule.state === 'in') return t('Resets in {{time}}', { time: schedule.time });
  return schedule.state === 'soon' ? t('Resets soon') : '';
}

/** Compact reset duration closing the meter row; units are notation, left untranslated. */
export function usageResetShortText(value: unknown): string {
  const schedule = usageResetSchedule(value);
  if (schedule.state === 'due') return '—';
  if (schedule.state === 'in') return schedule.time;
  return schedule.state === 'soon' ? '<1h' : '—';
}
