/** Shared by renderer preferences and native dialogs. */
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
export const UI_LANGUAGE_STORAGE_KEY = "mixdog.desktop.ui-language.v1";

export function uiLanguageForLocale(locale: string): UiLanguage | null {
  const lower = String(locale || "").trim().toLowerCase();
  const exact = SUPPORTED_UI_LANGUAGES.find(({ value }) => value.toLowerCase() === lower);
  if (exact) return exact.value;
  const base = lower.split(/[-_]/)[0];
  if (base === "zh") {
    const parts = lower.split(/[-_]/);
    if (parts.includes("hans")) return "zh-CN";
    if (parts.includes("hant")) return "zh-TW";
    return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
  }
  return SUPPORTED_UI_LANGUAGES.find(({ value }) => value.toLowerCase().split("-")[0] === base)?.value ?? null;
}

/** Stored choices must be selectable tags; system locales may be regional aliases. */
export function selectUiLanguage(preference: unknown, systemLocales: readonly string[]): UiLanguage {
  const selected = SUPPORTED_UI_LANGUAGES.find(({ value }) => value === preference);
  if (selected) return selected.value;
  for (const locale of systemLocales) {
    const language = uiLanguageForLocale(locale);
    if (language) return language;
  }
  return "en";
}
