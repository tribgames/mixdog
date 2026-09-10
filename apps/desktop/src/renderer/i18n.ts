// Renderer UI language. English source text IS the translation key: an
// untranslated (or missing) key renders its English original, so English
// stays the source of truth and existing English-asserting tests never see
// a difference. locales/*.json supply the translations; `npm run i18n:sync`
// keeps every catalog in step with renderer, native and boot-recovery usage.
import i18next from "i18next";
import pluralSources from "./ui-plurals.json";

import { publishUiLanguage } from "./push-notification-bridge";
import {
  SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_STORAGE_KEY, uiLanguageForLocale, selectUiLanguage,
  type UiLanguage, type UiLanguagePreference,
} from "../shared/ui-language";
export { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_STORAGE_KEY, type UiLanguage, type UiLanguagePreference };

const UI_LANGUAGE_VALUES: readonly string[] = SUPPORTED_UI_LANGUAGES.map((entry) => entry.value);

function asUiLanguage(value: unknown): UiLanguage | null {
  return typeof value === "string" && UI_LANGUAGE_VALUES.includes(value)
    ? (value as UiLanguage)
    : null;
}

export function getUiLanguagePreference(): UiLanguagePreference {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    const language = asUiLanguage(stored);
    if (language) return language;
  } catch { /* storage-less hosts (tests, remote shells) resolve as system */ }
  return "system";
}

export function setUiLanguagePreference(preference: UiLanguagePreference): boolean {
  try {
    if (preference === "system") window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, preference);
    return true;
  } catch {
    // Language changes reload module-level labels. An in-memory choice would
    // disappear immediately, so the settings surface must report this failure.
    return false;
  }
}

export function resolveUiLanguage(
  preference: UiLanguagePreference = getUiLanguagePreference(),
): UiLanguage {
  const explicit = asUiLanguage(preference);
  if (explicit) return explicit;
  // Test/deployment override (scripts/test-env.mjs pins 'en'): checked only
  // for the 'system' fallback so an explicit user choice always wins.
  const forced = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.MIXDOG_UI_LANGUAGE;
  const forcedLanguage = forced ? uiLanguageForLocale(forced) : null;
  if (forcedLanguage) return forcedLanguage;
  let systemLocales: readonly string[] = ["en"];
  try {
    systemLocales = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  } catch { /* no navigator (node tests): English pass-through */ }
  return selectUiLanguage(preference, systemLocales);
}

// Synchronous init (initImmediate: false): t() is usable from the first
// module that imports it — no async gate ahead of React's first render.
// fallbackLng false + returnEmptyString false make every unknown or
// still-untranslated key fall back to its English key text.
// Catalogs load per language: eleven static imports put ~750KB of JSON — a
// quarter of the first-paint bundle — in front of every visitor, ten
// languages of which they will never see. English needs no network catalog:
// its keys are source text, with only a small local singular/plural map.
const CATALOGS: Record<
  Exclude<UiLanguage, "en">,
  () => Promise<{ default: Record<string, string> }>
> = {
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  it: () => import("./locales/it.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ru: () => import("./locales/ru.json"),
  vi: () => import("./locales/vi.json"),
  "zh-CN": () => import("./locales/zh-CN.json"),
  "zh-TW": () => import("./locales/zh-TW.json"),
};

// Synchronous English init: t() stays usable from the moment this module is
// evaluated — node tests, and any module that runs before the entry has
// finished loading a catalog. fallbackLng false + returnEmptyString false
// make every unknown or still-untranslated key fall back to its English text.
void i18next.init({
  lng: "en",
  fallbackLng: false,
  resources: {
    en: { translation: Object.fromEntries(Object.entries(pluralSources).flatMap(([key, singular]) => [
      [key, key], [`${key}_one`, singular], [`${key}_other`, key],
    ])) },
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

/** Fetch the resolved language and switch onto it. The renderer entry awaits
 *  this BEFORE importing any app module, because module-level strings pass
 *  through t() at import time. Changing the language reloads the window
 *  (Settings → Display language), so one catalog per session is enough. */
export async function initUiLanguage(
  loadCatalog: (language: Exclude<UiLanguage, "en">) => Promise<{ default: Record<string, string> }>
    = (language) => CATALOGS[language](),
): Promise<void> {
  const language = resolveUiLanguage();
  if (language === "en") {
    await i18next.changeLanguage("en");
  } else {
    try {
      const catalog = await loadCatalog(language);
      i18next.addResourceBundle(language, "translation", catalog.default);
      await i18next.changeLanguage(language);
    } catch (error) {
      await i18next.changeLanguage("en");
      console.warn("Could not load UI translations; using English.", error);
    }
  }
  // Publish the language actually loaded, not a catalog that failed to arrive.
  const active = uiLanguageForLocale(i18next.language) || "en";
  if (typeof document !== "undefined") document.documentElement.lang = active;
  void publishUiLanguage(active);
}

/** All UI formatting follows the loaded catalog, including its English fallback. */
export function uiFormatLocale(): UiLanguage {
  return uiLanguageForLocale(i18next.language) || "en";
}

export function t(key: string, options?: Record<string, unknown>): string {
  return String(i18next.t(key, options));
}

/** Translate a runtime-composed phrase ONLY when the active catalog really
 *  carries the key, and hand back the English original otherwise.
 *
 *  Tool result summaries ("3 matches", "1 line") are built by the runtime with
 *  English pluralization already applied. Passing them through plain t() on an
 *  untranslated locale would interpolate the plural key itself and print
 *  "1 lines"; the original is always grammatical, so it wins the fallback. */
export function tExisting(
  key: string,
  original: string,
  options?: Record<string, unknown>,
): string {
  return i18next.exists(key, options) ? String(i18next.t(key, options)) : original;
}

/** Active keyed catalog only: no second bundle or fragile numeric indices. */
let activeCatalog: unknown;
let activeKeys: string[] = [];
export function activeUiTranslationKeys(): string[] {
  const catalog = i18next.getResourceBundle(i18next.language, "translation");
  if (catalog !== activeCatalog) {
    activeCatalog = catalog;
    activeKeys = Object.keys(catalog || {});
  }
  return activeKeys;
}

export default i18next;
