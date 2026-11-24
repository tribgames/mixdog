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
  return uiCurrency(amount, moneyDigits(amount));
}

function moneyDigits(amount: number): number {
  const magnitude = Math.abs(amount);
  if (magnitude >= 0.01 || amount === 0) return 2;
  return magnitude >= 0.0001 ? 4 : 6;
}

/** "OpenAI OAuth" → "OpenAI": the plan badge already names the lane. */
export function usageProviderLabel(label: string): string {
  return label.replace(/\s+(?:API|OAuth)$/i, '');
}

export function usageCompact(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '';
  // Token units (K, M, B) read the same in every language. One decimal at
  // every magnitude: whole units hid a third of the difference between two
  // routes that both rounded to the same figure.
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}
