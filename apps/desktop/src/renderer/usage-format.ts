/**
 * Number shapes shared by the two usage surfaces. /usage reports the quota
 * that is LEFT and the statistics report what was SPENT; they quote the same
 * kinds of figure, so the rounding lives here rather than in both.
 */
import { uiFormatLocale } from './i18n';
import { uiCurrency } from './ui-format';

export function usageNumber(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}

// Keep cents for normal amounts and never round a positive micro-cost to zero.
export function usageMoney(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '—';
  if (amount > 0 && amount < 0.000001) return `<${uiCurrency(0.000001, 6)}`;
  return uiCurrency(amount, Math.abs(amount) >= 0.01 || amount === 0 ? 2 : Math.abs(amount) >= 0.0001 ? 4 : 6);
}

/**
 * "OpenAI OAuth" → "OpenAI". The plan badge sitting beside the name already
 * says which lane the spend belongs to, and the suffix is what pushed long
 * names onto a second line on a phone.
 */
export function usageProviderLabel(label: string): string {
  return label.replace(/\s+(?:API|OAuth)$/i, '');
}

export function usageCompact(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '';
  // One decimal at every magnitude: "1293만" and "4억" hid a third of the
  // difference between two routes that both rounded to the same figure.
  return new Intl.NumberFormat(uiFormatLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}
