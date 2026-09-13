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

// Fewer decimals as the amount grows: $12 reads at a glance, $0.0042 does not
// survive rounding to two places.
export function usageMoney(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '—';
  return uiCurrency(amount, amount === 0 || amount >= 10 ? 0 : amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4);
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
  return new Intl.NumberFormat(uiFormatLocale(), {
    notation: 'compact', maximumFractionDigits: Math.abs(amount) >= 10_000 ? 0 : 1,
  }).format(amount);
}
