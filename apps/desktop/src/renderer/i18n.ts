// Renderer UI language. English source text IS the translation key: an
// untranslated (or missing) key renders its English original, so English
// stays the source of truth and existing English-asserting tests never see
// a difference. locales/*.json supply the translations; `npm run i18n:sync`
// (i18next-cli extract) keeps every catalog in step with literal t() usage.
import i18next from "i18next";

import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";
import vi from "./locales/vi.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

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
void i18next.init({
  lng: resolveUiLanguage(),
  fallbackLng: false,
  resources: {
    de: { translation: de },
    es: { translation: es },
    fr: { translation: fr },
    it: { translation: it },
    ja: { translation: ja },
    ko: { translation: ko },
    "pt-BR": { translation: ptBR },
    ru: { translation: ru },
    vi: { translation: vi },
    "zh-CN": { translation: zhCN },
    "zh-TW": { translation: zhTW },
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

export function t(key: string, options?: Record<string, unknown>): string {
  return String(i18next.t(key, options));
}

export default i18next;
