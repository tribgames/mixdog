// One keyed catalog per language, shared by explicit and legacy UI text.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectUiKeys, catalogProblems } from "./i18n/source-keys.mjs";
import { nativeCatalogs, nativeCatalogUrl } from "./i18n/native-catalogs.mjs";

const localesDir = new URL("../src/renderer/locales/", import.meta.url);
const files = readdirSync(localesDir).filter((name) => name.endsWith(".json")).sort();
const supported = ["de", "es", "fr", "it", "ja", "ko", "pt-BR", "ru", "vi", "zh-CN", "zh-TW"];
const catalogs = new Map(files.map((name) => [name, JSON.parse(readFileSync(new URL(name, localesDir), "utf8"))]));
const readData = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const sources = collectUiKeys(fileURLToPath(new URL("../src/renderer/", import.meta.url)));
const keys = new Set([
  ...sources.keys(),
  ...readData("../src/renderer/legacy-ui-keys.json"),
  ...readData("../src/shared/native-ui-keys.json"),
  ...[...catalogs.values()].flatMap(Object.keys),
]);
let failed = false;
if (JSON.stringify(files) !== JSON.stringify(supported.map((language) => `${language}.json`))) {
  console.error("check-i18n: supported language catalogs are missing or unexpected.");
  failed = true;
}
for (const [name, catalog] of catalogs) {
  const problems = catalogProblems(catalog, keys);
  if (!problems.length) continue;
  failed = true;
  console.error(`check-i18n: ${name} — ${problems.length} problems`);
  for (const { key, reason } of problems.slice(0, 25)) {
    console.error(`  · ${reason}: ${key}${sources.has(key) ? ` (${sources.get(key)})` : ""}`);
  }
}
const neutral = new Set(readData("../src/renderer/ui-untranslated-allowlist.json"));
for (const key of keys) {
  if (!neutral.has(key) && /[A-Za-z]/.test(key.replace(/\{\{[^}]+\}\}/g, ""))
    && [...catalogs.values()].every((catalog) => catalog[key] === key)) {
    console.error(`check-i18n: English-only UI phrase: ${key}`);
    failed = true;
  }
}
try {
  if (JSON.stringify(JSON.parse(readFileSync(nativeCatalogUrl, "utf8"))) !== JSON.stringify(nativeCatalogs())) {
    console.error("check-i18n: native dialog catalogs are stale; run i18n:sync.");
    failed = true;
  }
} catch (error) {
  console.error(`check-i18n: native catalogs: ${error.message}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`check-i18n: OK — ${files.length} locales × ${keys.size} keys; source coverage, interpolation and native catalogs checked.`);
