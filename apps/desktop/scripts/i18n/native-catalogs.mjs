import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const keysUrl = new URL("../../src/shared/native-ui-keys.json", import.meta.url);
const localesUrl = new URL("../../src/renderer/locales/", import.meta.url);
export const nativeCatalogUrl = new URL("../../src/shared/native-ui-catalogs.json", import.meta.url);

export function nativeCatalogs() {
  const keys = JSON.parse(readFileSync(keysUrl, "utf8"));
  return Object.fromEntries(readdirSync(localesUrl).filter((name) => name.endsWith(".json")).sort()
    .map((name) => {
      const catalog = JSON.parse(readFileSync(new URL(name, localesUrl), "utf8"));
      return [name.slice(0, -5), Object.fromEntries(keys.map((key) => {
        if (!catalog[key]) throw new Error(`Missing native translation: ${name}: ${key}`);
        return [key, catalog[key]];
      }))];
    }));
}

export function writeNativeCatalogs() {
  writeFileSync(nativeCatalogUrl, `${JSON.stringify(nativeCatalogs(), null, 2)}\n`);
}
