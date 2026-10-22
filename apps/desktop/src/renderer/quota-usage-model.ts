// Subscription usage presentation: meter percentages, clock times, the
// even-pace reference, the warning tone and the chart inks.
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';
import { usageMoney } from './usage-format';
import { localDayKey, statsNumber, type Row } from './usage-stats-model';

/** A limit window is valued at Mixdog's own rate over the whole limit at every
 *  reading, so outside use never enters it; period totals stay totals. */
export function quotaValue(row: Row, fullLimit = false): string {
  if (fullLimit) return row.costPerPercent == null ? '—' : usageMoney(statsNumber(row.costPerPercent) * 100);
  return usageMoney(row.estimatedTotalCostUsd ?? row.costUsd);
}

export function quotaValueBreakdown(row: Row): string {
  const outside = row.outsideCostUsd == null ? '—' : usageMoney(row.outsideCostUsd);
  return `${t('Recorded value')}: ${usageMoney(row.costUsd)} · ${t('Outside Mixdog')}: ${outside}`;
}

export function quotaValueCaution(): string {
  return t(
    'Estimates use Mixdog’s usage pattern. Different external models or continuous mixed use can change the result.'
  );
}

/** A meter reading or a share of the limit, rounded to a whole percent. */
export function quotaPercent(value: unknown): string {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount)) return '—';
  const rounded = Math.round(amount);
  return `${rounded.toLocaleString(uiFormatLocale())}%`;
}

/** A clock time, dated once it is not today. */
export function quotaClock(time: number, now: number): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    ...timeFormatOptions(),
  };
  if (localDayKey(time) !== localDayKey(now)) {
    options.month = 'short';
    options.day = 'numeric';
  }
  return new Intl.DateTimeFormat(uiFormatLocale(), options).format(new Date(time));
}

/** Where an even pace through a window stands at `now`, in percent. */
export function quotaPace(startMs: number, endMs: number, now: number): number | null {
  if (!(endMs > startMs)) return null;
  return Math.min(100, Math.max(0, ((now - startMs) / (endMs - startMs)) * 100));
}

type QuotaTone = '' | 'warning' | 'danger';

/** Danger once the window is nearly used up or forecast to run out before
 *  its reset; warning once it is past 70 % or well ahead of an even pace. */
export function quotaTone(used: number, paceDelta: number | null, runsOut: boolean): QuotaTone {
  if (runsOut || used >= 90) return 'danger';
  if (used >= 70 || (paceDelta !== null && paceDelta >= 10)) return 'warning';
  return '';
}

/** Chart ink of a model by its rank in the period: six inks, then one. */
export function quotaSeries(index: number): string {
  return index >= 0 && index < 6 ? String(index) : 'other';
}
