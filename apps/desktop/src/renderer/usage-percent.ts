import { usageNumber } from './usage-format';

/** Meter tone class for a quota percentage: danger from 90 %, warning from 70 %. */
export function usageToneClass(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 90) return ' tone-danger';
  return percent >= 70 ? ' tone-warning' : '';
}

export function displayUsagePercent(value: unknown): number | null {
  const parsed = usageNumber(value);
  if (parsed === null) return null;
  const percent = Math.max(0, Math.min(100, parsed));
  if (percent > 0 && percent < 1) return Math.round(percent * 10) / 10;
  return Math.round(percent);
}
