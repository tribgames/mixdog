// Offline synchronization. Catalog JSON is the only translation source of truth;
// extraction never replaces reviewed text with English seeds or network output.
import { writeFileSync } from "node:fs";
import { catalogState, localesUrl, rendererUrl, readJson, requiredCatalogKeys } from "./i18n/catalog-state.mjs";
import { generatedCatalogs } from "./i18n/native-catalogs.mjs";
import { reusableTranslation } from "./i18n/source-keys.mjs";

const state = catalogState();
const { catalogs, keys } = state;
const neutral = new Set(readJson(new URL("ui-untranslated-allowlist.json", rendererUrl)));
let missing = 0;
for (const [language, catalog] of catalogs) {
  for (const key of requiredCatalogKeys(keys, language)) {
    if (typeof catalog[key] === "string" && catalog[key].trim()) continue;
    // These languages have no grammatical count categories to distinguish.
    if (["ko", "ja", "zh-CN", "zh-TW", "vi"].includes(language) && key.endsWith("_other") && catalog[key.slice(0, -6)]) {
      catalog[key] = catalog[key.slice(0, -6)];
      continue;
    }
    catalog[key] = reusableTranslation(key, catalog)
      ?? (neutral.has(key) || !/[A-Za-z]/.test(key.replace(/\{\{[^}]+\}\}/g, "")) ? key : "");
    if (!catalog[key]) missing += 1;
  }
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b, "en")));
  writeFileSync(new URL(`${language}.json`, localesUrl), `${JSON.stringify(sorted, null, 2)}\n`);
}
for (const [url, body] of generatedCatalogs(state, { allowMissing: true })) writeFileSync(url, body);
console.log(`sync-i18n: ${catalogs.size} catalogs; ${missing} entries still need translation.`);
