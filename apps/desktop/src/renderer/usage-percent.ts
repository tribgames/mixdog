import { usageNumber } from './usage-format';

/** Meter tone class for a quota percentage: danger from 90 %, warning from 70 %. */
export function usageToneClass(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 90) return ' tone-danger';
  return percent >= 70 ? ' tone-warning' : '';
}

/** A percentage as every usage surface reads it: whole, or to a tenth under 1 % so a begun meter never reads 0. */
export function roundUsagePercent(percent: number): number {
  if (percent > 0 && percent < 1) return Math.round(percent * 10) / 10;
  return Math.round(percent);
}

export function displayUsagePercent(value: unknown): number | null {
  const parsed = usageNumber(value);
  if (parsed === null) return null;
  return roundUsagePercent(Math.max(0, Math.min(100, parsed)));
}
