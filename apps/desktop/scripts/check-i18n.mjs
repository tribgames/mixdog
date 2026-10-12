// One keyed catalog per language, shared by explicit and legacy UI text.
import { readFileSync } from 'node:fs';
import { catalogProblems, untranslatedProblems } from './i18n/source-keys.mjs';
import { generatedCatalogs } from './i18n/native-catalogs.mjs';
import { catalogState, neutralAllowlist, supportedLanguages, requiredCatalogKeys } from './i18n/catalog-state.mjs';

const state = catalogState();
const { catalogs, sources, keys } = state;
const supported = supportedLanguages()
  .filter((language) => language !== 'en')
  .sort();
let failed = false;
if (JSON.stringify([...catalogs.keys()]) !== JSON.stringify(supported)) {
  console.error('check-i18n: supported language catalogs are missing or unexpected.');
  failed = true;
}
for (const [name, catalog] of catalogs) {
  const problems = catalogProblems(catalog, requiredCatalogKeys(keys, name));
  if (!problems.length) continue;
  failed = true;
  console.error(`check-i18n: ${name} — ${problems.length} problems`);
  for (const { key, reason } of problems.slice(0, 25)) {
    console.error(`  · ${reason}: ${key}${sources.has(key) ? ` (${sources.get(key)})` : ''}`);
  }
}
const allowlist = neutralAllowlist();
for (const [name, catalog] of catalogs) {
  const problems = untranslatedProblems(name, catalog, keys, allowlist);
  if (!problems.length) continue;
  failed = true;
  console.error(`check-i18n: ${name} — ${problems.length} untranslated`);
  for (const { key } of problems.slice(0, 25)) {
    console.error(`  · untranslated: ${key}${sources.has(key) ? ` (${sources.get(key)})` : ''}`);
  }
}
try {
  for (const [url, body] of generatedCatalogs(state)) {
    if (readFileSync(url, 'utf8') !== body) {
      console.error(`check-i18n: stale generated artifact ${url.pathname}; run i18n:sync.`);
      failed = true;
    }
  }
} catch (error) {
  console.error(`check-i18n: generated catalogs: ${error.message}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(
  `check-i18n: OK — ${catalogs.size} locales × ${keys.size} keys; renderer, native dialogs, boot recovery and interpolation checked.`
);
