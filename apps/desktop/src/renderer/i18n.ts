// Renderer UI language. English source text IS the translation key: an
// untranslated (or missing) key renders its English original, so English
// stays the source of truth and existing English-asserting tests never see
// a difference. locales/*.json supply the translations; `npm run i18n:sync`
// (i18next-cli extract) keeps every catalog in step with literal t() usage.
import i18next from "i18next";

import { supplementalUiTranslations } from "./auto-i18n";

/** Selectable UI languages with their native display names (settings picker).
 *  RTL locales stay out until the chrome grows mirrored-layout support. */
export const SUPPORTED_UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁體）" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "ru", label: "Русский" },
  { value: "vi", label: "Tiếng Việt" },
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]["value"];
export type UiLanguagePreference = "system" | UiLanguage;

const UI_LANGUAGE_VALUES: readonly string[] = SUPPORTED_UI_LANGUAGES.map((entry) => entry.value);

function asUiLanguage(value: unknown): UiLanguage | null {
  return typeof value === "string" && UI_LANGUAGE_VALUES.includes(value)
    ? (value as UiLanguage)
    : null;
}

/** Map a BCP-47 locale onto a supported UI language: exact tag, Chinese
 *  script/region resolution, then the bare language prefix. */
export function uiLanguageForLocale(locale: string): UiLanguage | null {
  const lower = String(locale || "").trim().toLowerCase();
  if (!lower) return null;
  const exact = UI_LANGUAGE_VALUES.find((value) => value.toLowerCase() === lower);
  if (exact) return exact as UiLanguage;
  const base = lower.split(/[-_]/)[0];
  if (base === "zh") return /hant|tw|hk|mo/.test(lower) ? "zh-TW" : "zh-CN";
  const byBase = UI_LANGUAGE_VALUES.find((value) => value.toLowerCase().split("-")[0] === base);
  return (byBase as UiLanguage) || null;
}

export const UI_LANGUAGE_STORAGE_KEY = "mixdog.desktop.ui-language.v1";

export function getUiLanguagePreference(): UiLanguagePreference {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    const language = asUiLanguage(stored);
    if (language) return language;
  } catch { /* storage-less hosts (tests, remote shells) resolve as system */ }
  return "system";
}

export function setUiLanguagePreference(preference: UiLanguagePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, preference);
  } catch { /* the choice then lasts only until the window closes */ }
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
  let systemLocale = "en";
  try {
    systemLocale = navigator.language || "en";
  } catch { /* no navigator (node tests): English pass-through */ }
  return uiLanguageForLocale(systemLocale) || "en";
}

// Synchronous init (initImmediate: false): t() is usable from the first
// module that imports it — no async gate ahead of React's first render.
// fallbackLng false + returnEmptyString false make every unknown or
// still-untranslated key fall back to its English key text.
// Catalogs load per language: eleven static imports put ~750KB of JSON — a
// quarter of the first-paint bundle — in front of every visitor, ten
// languages of which they will never see. English needs no catalog at all,
// because the keys ARE the English source text.
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
  resources: {},
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
export async function initUiLanguage(): Promise<void> {
  const language = resolveUiLanguage();
  if (language === "en") return;
  try {
    const catalog = await CATALOGS[language]();
    i18next.addResourceBundle(language, "translation", {
      ...catalog.default,
      ...supplementalUiTranslations(language),
    });
    await i18next.changeLanguage(language);
  } catch {
    // A catalog that fails to load leaves the UI on its English source text,
    // which is readable; a blank chrome would not be.
  }
}

export function t(key: string, options?: Record<string, unknown>): string {
  return String(i18next.t(key, options));
}

// Used only by the legacy DOM compatibility localizer for interpolated
// hardcoded strings. Keeping the list on the function avoids another catalog
// import in the renderer entry.
(t as unknown as { autoKeys: string[] }).autoKeys = Object.keys(supplementalUiTranslations("ko"));

export default i18next;
