import i18next from 'i18next';
import { markKoValue, resolveKoParticles } from '../shared/ko-particle';
import pluralSources from './ui-plurals.json';

import { hasLocalDisplayChoice, markHostDisplayChoice, markLocalDisplayChoice } from './display-preference-source';
import { publishNativeNotificationLabels } from './native-push-bridge';
import { publishUiLanguage } from './push-notification-bridge';
import {
  SUPPORTED_UI_LANGUAGES,
  UI_LANGUAGE_STORAGE_KEY,
  uiLanguageForLocale,
  selectUiLanguage,
  type UiLanguage,
  type UiLanguagePreference,
} from '../shared/ui-language';
export { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_STORAGE_KEY, type UiLanguage, type UiLanguagePreference };

const UI_LANGUAGE_VALUES: readonly string[] = SUPPORTED_UI_LANGUAGES.map((entry) => entry.value);

function asUiLanguage(value: unknown): UiLanguage | null {
  return typeof value === 'string' && UI_LANGUAGE_VALUES.includes(value) ? (value as UiLanguage) : null;
}

export function getUiLanguagePreference(): UiLanguagePreference {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    const language = asUiLanguage(stored);
    if (language) return language;
  } catch {
    /* storage-less hosts (tests, remote shells) resolve as system */
  }
  return 'system';
}

/** The user's own choice on this device: it wins over the host PC from now on. */
export function setUiLanguagePreference(preference: UiLanguagePreference): boolean {
  try {
    if (preference === 'system') window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, preference);
    markLocalDisplayChoice('language');
    return true;
  } catch {
    // Language changes reload module-level labels. An in-memory choice would
    // disappear immediately, so the settings surface must report this failure.
    return false;
  }
}

/** Whether this device's UI language was chosen here (see display-preference-source.ts).
 *  An unmarked stored language counts as a choice; 'system' (nothing stored) is the default. */
export function hasLocalUiLanguageChoice(): boolean {
  return hasLocalDisplayChoice('language', getUiLanguagePreference() !== 'system');
}

/** Follow the host PC's language: stored but marked as the host's, so a later host
 *  change still replaces it. Returns true when the active language must change
 *  (the caller reloads, like Settings → Display language does). */
export function adoptHostUiLanguage(language: UiLanguage): boolean {
  const previous = resolveUiLanguage();
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  } catch {
    return false;
  }
  markHostDisplayChoice('language');
  return language !== previous;
}

export function resolveUiLanguage(preference: UiLanguagePreference = getUiLanguagePreference()): UiLanguage {
  const explicit = asUiLanguage(preference);
  if (explicit) return explicit;
  // Test/deployment override (scripts/test-env.mjs pins 'en'): checked only
  // for the 'system' fallback so an explicit user choice always wins.
  const forced = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.MIXDOG_UI_LANGUAGE;
  const forcedLanguage = forced ? uiLanguageForLocale(forced) : null;
  if (forcedLanguage) return forcedLanguage;
  let systemLocales: readonly string[] = ['en'];
  try {
    systemLocales = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
  } catch {
    /* no navigator (node tests): English pass-through */
  }
  return selectUiLanguage(preference, systemLocales);
}

const CATALOGS: Record<Exclude<UiLanguage, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  it: () => import('./locales/it.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  ru: () => import('./locales/ru.json'),
  vi: () => import('./locales/vi.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
  'zh-TW': () => import('./locales/zh-TW.json'),
};

void i18next.init({
  lng: 'en',
  fallbackLng: false,
  resources: {
    en: {
      translation: Object.fromEntries(
        Object.entries(pluralSources).flatMap(([key, singular]) => [
          [key, key],
          [`${key}_one`, singular],
          [`${key}_other`, key],
        ])
      ),
    },
  },
  nsSeparator: false,
  keySeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initImmediate: false,
  // The installed i18next types drop `initImmediate` from InitOptions, which
  // pushes the call onto the callback overload; the runtime option is real, so
  // the object is pinned to the options overload explicitly.
} as Parameters<typeof i18next.init>[0]);

// Disambiguated keys ("Island: …", "Goal state: …") keep a label distinct per
// surface in translation; English shows the plain wording, not the key.
i18next.addResourceBundle('en', 'translation', {
  'Goal state: In progress': 'In progress',
  'State: Open': 'Open',
  'Island: {{count}} agents': '{{count}} agents',
  'Island: {{count}} agents_other': '{{count}} agents',
  'Island: {{count}} shells': '{{count}} shells',
  'Island: {{count}} shells_other': '{{count}} shells',
  'Island: {{count}} files': '{{count}} files',
  'Island: {{count}} files_other': '{{count}} files',
  'Island: View changes': 'View changes',
  'Git remote: Fetch': 'Fetch',
  'Git remote: Fetch {{name}}': 'Fetch {{name}}',
  'Profile: Title': 'Title',
  'Always allowed: Ask again': 'Ask again',
  'Imported: Starred': 'Starred',
  'Setup: {{current}} of {{total}}': '{{current}} of {{total}}',
  'Effort: None': 'None',
  'Effort: Minimal': 'Minimal',
  'Effort: Low': 'Low',
  'Effort: Medium': 'Medium',
  'Effort: High': 'High',
  'Effort: XHigh': 'XHigh',
  'Effort: Max': 'Max',
  'Island: Running': 'Running',
  'Island: Exited': 'Exited',
  'Island: Close all': 'Close all',
  'Island: Git actions': 'Git actions',
  'Island: {{cost}} est. cost': '{{cost}} est. cost',
  'Turn changes: {{count}} files changed': '{{count}} files changed',
  'Preview badge: New': 'New',
  'Session send: Sent to {{name}}': 'Sent to {{name}}',
  'Turn changes: {{count}} files changed_other': '{{count}} files changed',
  // A settled tool group's past tense where English spells it apart (context "done").
  'Generate media_done': 'Generated media',
  'Generate {{count}} media_done': 'Generated {{count}} media',
  'Tidy code_done': 'Tidied code',
  'Tidy code {{count}} times_done': 'Tidied code {{count}} times',
  // The English singular of a counted sentence whose key is its plural.
  'The app on the server restarts, and {{count}} running sessions stop._one':
    'The app on the server restarts, and {{count}} running session stops.',
});

/** Fetch the resolved language and switch onto it. The renderer entry awaits
 *  this BEFORE importing any app module, because module-level strings pass
 *  through t() at import time. Changing the language reloads the window
 *  (Settings → Display language), so one catalog per session is enough. */
export async function initUiLanguage(
  loadCatalog: (language: Exclude<UiLanguage, 'en'>) => Promise<{ default: Record<string, string> }> = (language) =>
    CATALOGS[language]()
): Promise<void> {
  const language = resolveUiLanguage();
  if (language === 'en') {
    await i18next.changeLanguage('en');
  } else {
    try {
      const catalog = await loadCatalog(language);
      i18next.addResourceBundle(language, 'translation', catalog.default);
      await i18next.changeLanguage(language);
    } catch (error) {
      await i18next.changeLanguage('en');
      console.warn('Could not load UI translations; using English.', error);
    }
  }
  // Publish the language actually loaded, not a catalog that failed to arrive.
  const active = uiLanguageForLocale(i18next.language) || 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = active;
  void publishUiLanguage(active);
  // The phone app labels an approval notification's actions as the card does.
  void publishNativeNotificationLabels({ deny: t('Deny'), allowOnce: t('Allow just once') });
}

/** All UI formatting follows the loaded catalog, including its English fallback. */
export function uiFormatLocale(): UiLanguage {
  return uiLanguageForLocale(i18next.language) || 'en';
}

/** Subscribe to active-language changes (catalog load finishing after first paint, or a switch). */
export function subscribeUiLanguage(listener: () => void): () => void {
  i18next.on('languageChanged', listener);
  return () => i18next.off('languageChanged', listener);
}

/** t() options that are i18next settings, not interpolated values. */
const I18NEXT_OPTIONS = new Set(['defaultValue', 'lng', 'lngs', 'ns', 'context', 'keyPrefix', 'postProcess']);

export function t(key: string, options?: Record<string, unknown>): string {
  if (!options || !i18next.language?.startsWith('ko')) return String(i18next.t(key, options));
  // Korean: a dual particle after a name ("{{name}}을(를)") becomes the one
  // its last syllable takes (shared/ko-particle.ts).
  const marked = Object.fromEntries(
    Object.entries(options).map(([name, value]) => [
      name,
      typeof value === 'string' && !I18NEXT_OPTIONS.has(name) ? markKoValue(value) : value,
    ])
  );
  return resolveKoParticles(String(i18next.t(key, marked)));
}

/** Translate a runtime-composed phrase ONLY when the active catalog really
 *  carries the key, and hand back the English original otherwise.
 *
 *  Tool result summaries ("3 matches", "1 line") are built by the runtime with
 *  English pluralization already applied. Passing them through plain t() on an
 *  untranslated locale would interpolate the plural key itself and print
 *  "1 lines"; the original is always grammatical, so it wins the fallback. */
export function tExisting(key: string, original: string, options?: Record<string, unknown>): string {
  return i18next.exists(key, options) ? String(i18next.t(key, options)) : original;
}

export default i18next;
