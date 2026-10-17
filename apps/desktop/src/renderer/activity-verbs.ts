// Spinner wording for the live-activity row. Every string that can reach the
// row passes through here so a non-English UI never shows an English verb:
// the pool follows the ACTIVE language (not a memoized t() probe), runtime
// authored text is mapped through catalog keys, and the fallback is itself a
// localized catalog entry.
import { t, uiFormatLocale, type UiLanguage } from './i18n';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from '../../../../src/tui/spinner-verbs.mjs';

/** Pool used outside English: every entry is a catalog key in all 11 locales. */
export const LOCALIZED_ACTIVITY_VERBS: string[] = [
  'Thinking',
  'Pondering',
  'Musing',
  'Mulling',
  'Ruminating',
  'Contemplating',
  'Considering',
  'Deliberating',
  'Cogitating',
  'Inferring',
  'Ideating',
  'Envisioning',
];

/** Catalog keys for the state modes; the shared table may carry a surface-specific
 *  (Korean) string for `task-wait` that is not a key. */
const MODE_VERB_KEYS: Record<string, string> = {
  compacting: 'Compacting conversation',
  'auto-clear': 'Auto-clearing conversation',
  resuming: 'Resuming conversation',
  'task-wait': 'Waiting for tasks',
  'model-thinking': 'Model thinking',
};

const HAS_LATIN = /[A-Za-z]/;

export function activityVerbPool(language: UiLanguage = uiFormatLocale()): string[] {
  return language === 'en' ? (SPINNER_VERBS as string[]) : LOCALIZED_ACTIVITY_VERBS;
}

function localizedOrFallback(key: string, language: UiLanguage): string {
  const text = t(key);
  // An untranslated key echoes itself: outside English fall back to a localized word.
  if (language !== 'en' && text === key && HAS_LATIN.test(text)) return t('Working');
  return text;
}

/** The engine authors the reconnect text in English (retry countdown, quota and
 *  rate-limit notices). English shows it as-is; other languages get the
 *  localized "Reconnecting…" plus the attempt counter when the text has one. */
export function reconnectActivityVerb(runtimeVerb: string, language: UiLanguage = uiFormatLocale()): string {
  const text = String(runtimeVerb || '').trim();
  if (language === 'en') return text || t('Working');
  const attempt = /(\d+)\s*\/\s*(\d+)/.exec(text);
  const base = t('Reconnecting…');
  return attempt ? `${base} ${attempt[1]}/${attempt[2]}` : base;
}

export function activityVerb({
  mode,
  runtimeVerb = '',
  anchor,
  now,
  language = uiFormatLocale(),
}: {
  mode: string;
  runtimeVerb?: string;
  anchor: number;
  now: number;
  language?: UiLanguage;
}): string {
  if (SPINNER_MODE_OVERRIDE_VERBS[mode]) {
    const key = MODE_VERB_KEYS[mode] || String(SPINNER_MODE_OVERRIDE_VERBS[mode]);
    return localizedOrFallback(key, language);
  }
  if (mode === 'reconnecting') return reconnectActivityVerb(runtimeVerb, language);
  return localizedOrFallback(String(spinnerVerbFor(anchor, now, activityVerbPool(language))), language);
}

/** The "thinking" part of the byline. The effort word is the model chip's own
 *  name ("High"), kept spelled like the chip; the surrounding words localize. */
export function thinkingEffortLabel(effortWord: string, language: UiLanguage = uiFormatLocale()): string {
  if (effortWord) return t('Thinking ({{effort}})', { effort: effortWord });
  return t('Thinking (spinner)', { defaultValue: language === 'en' ? 'Thinking' : t('Thinking') });
}
