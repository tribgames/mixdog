import { t, uiFormatLocale } from './i18n';

const TIERS: Record<string, () => string> = {
  none: () => t('Effort: None'),
  minimal: () => t('Effort: Minimal'),
  low: () => t('Effort: Low'),
  medium: () => t('Effort: Medium'),
  high: () => t('Effort: High'),
  xhigh: () => t('Effort: XHigh'),
  max: () => t('Effort: Max'),
};

/** A reasoning effort tier named in the UI language, keyed by the tier's stable id. The core's own label (English)
 *  stands for English and for any tier the UI has no name for. */
export function effortTierLabel(value: string, coreLabel: string): string {
  if (uiFormatLocale() === 'en') return coreLabel;
  return TIERS[String(value || '').trim().toLowerCase()]?.() ?? coreLabel;
}
