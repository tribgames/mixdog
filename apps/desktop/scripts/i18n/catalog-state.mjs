// Shared input contract for synchronization, diagnostics and generated projections.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { collectUiKeys, PLURAL_SUFFIX } from "./source-keys.mjs";

export const rendererUrl = new URL("../../src/renderer/", import.meta.url);
export const localesUrl = new URL("locales/", rendererUrl);
export const bootTemplateUrl = new URL("./boot.template.js", import.meta.url);
export function readJson(url) { return JSON.parse(readFileSync(url, "utf8")); }

// Both classic-script environments use generated code from the typed owner:
// no independent Chinese-script or preference rules to drift between surfaces.
export function languageRuntime() {
  const source = readFileSync(new URL("../../src/shared/ui-language.ts", import.meta.url), "utf8");
  return ts.transpileModule(source.replace(/^export /gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText;
}

export function supportedLanguages() {
  return runInNewContext(`${languageRuntime()}\nSUPPORTED_UI_LANGUAGES.map(({ value }) => value);`);
}

export function pluralVariants(language) {
  const rules = new Intl.PluralRules(language);
  const samples = new Map();
  // Larger Russian examples keep numeric slots numeric in machine drafts
  // (small inflected counts are often spelled out). CLDR still owns selection.
  for (const number of language === "ru" ? [21, 22, 25, 21.5] : [1, 2, 5, 0, 1.5, 1_000_000]) {
    const category = rules.select(number);
    if (!samples.has(category)) samples.set(category, number);
  }
  const variants = new Map();
  for (const [key, singular] of Object.entries(readJson(new URL("ui-plurals.json", rendererUrl)))) {
    for (const category of rules.resolvedOptions().pluralCategories) {
      const count = samples.get(category);
      if (count === undefined) throw new Error(`No plural sample for ${language}/${category}`);
      variants.set(`${key}_${category}`, { source: count === 1 ? singular : key, count });
    }
  }
  return variants;
}

export function requiredCatalogKeys(keys, language) {
  return new Set([...keys, ...pluralVariants(language).keys()]);
}

export function catalogState() {
  const catalogs = new Map(readdirSync(localesUrl).filter((name) => name.endsWith(".json")).sort()
    .map((name) => [name.slice(0, -5), readJson(new URL(name, localesUrl))]));
  const sources = collectUiKeys(fileURLToPath(rendererUrl));
  const nativeSources = collectUiKeys(fileURLToPath(new URL("../../src/main/", import.meta.url)), { explicitOnly: true });
  const bootSources = collectUiKeys(fileURLToPath(bootTemplateUrl), { explicitOnly: true });
  for (const [key, path] of collectUiKeys(fileURLToPath(rendererUrl), {
    explicitOnly: true, functions: ["earlyUiT"],
  })) bootSources.set(key, path);
  for (const [key, path] of nativeSources) sources.set(key, `main/${path}`);
  for (const key of bootSources.keys()) sources.set(key, "scripts/i18n/boot.template.js");
  const keys = new Set([
    ...sources.keys(),
    ...readJson(new URL("legacy-ui-keys.json", rendererUrl)),
    ...[...catalogs.values()].flatMap(Object.keys).filter((key) => !PLURAL_SUFFIX.test(key)),
  ]);
  return { catalogs, sources, keys, nativeKeys: [...nativeSources.keys()].sort(), bootKeys: [...bootSources.keys()].sort() };
}
