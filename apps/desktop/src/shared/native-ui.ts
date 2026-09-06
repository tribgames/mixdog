import catalogs from "./native-ui-catalogs.json";
import { uiLanguageForLocale } from "./ui-language";

/** A small generated projection of the same keyed catalogs used by the UI. */
export function translateNativeUi(locale: string, key: string): string {
  const language = uiLanguageForLocale(locale) || "en";
  const catalog = (catalogs as Record<string, Record<string, string>>)[language];
  return catalog?.[key] || key;
}
