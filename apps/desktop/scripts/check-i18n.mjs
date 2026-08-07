// i18n catalog validation (npm run i18n:check).
// Fails when any locale file under src/renderer/locales (a) is missing keys
// that other locales carry, (b) still holds empty ("" = untranslated) values,
// or (c) carries plural-suffix keys (key_one/…) — those are extractor
// artifacts that override real translations with English key text and are
// pruned by scripts/sync-i18n.mjs. Untranslated keys are SAFE at runtime
// (English pass-through); this gate surfaces omissions instead of letting
// them ship silently.
import { readFileSync, readdirSync } from "node:fs";

const localesDir = new URL("../src/renderer/locales/", import.meta.url);
const files = readdirSync(localesDir).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("check-i18n: no locale files found");
  process.exit(1);
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const INTERPOLATION = /\{\{[^}]+\}\}/g;

const catalogs = new Map();
for (const name of files) {
  catalogs.set(name, JSON.parse(readFileSync(new URL(name, localesDir), "utf8")));
}

const union = new Set();
for (const catalog of catalogs.values()) {
  for (const key of Object.keys(catalog)) {
    if (!PLURAL_SUFFIX.test(key)) union.add(key);
  }
}

let failed = false;
for (const [name, catalog] of catalogs) {
  const empty = Object.entries(catalog)
    .filter(([, value]) => typeof value !== "string" || value === "")
    .map(([key]) => key);
  const missing = [...union].filter((key) => !(key in catalog));
  const plural = Object.keys(catalog).filter((key) => PLURAL_SUFFIX.test(key));
  const interpolation = Object.entries(catalog)
    .filter(([key, value]) => {
      if (typeof value !== "string") return false;
      const expected = [...key.matchAll(INTERPOLATION)].map(([token]) => token).sort();
      const actual = [...value.matchAll(INTERPOLATION)].map(([token]) => token).sort();
      return expected.join("\0") !== actual.join("\0");
    })
    .map(([key]) => key);
  if (empty.length === 0 && missing.length === 0 && plural.length === 0 && interpolation.length === 0) continue;
  failed = true;
  console.error(`check-i18n: ${name} — empty: ${empty.length}, missing: ${missing.length}, plural artifacts: ${plural.length}, interpolation mismatches: ${interpolation.length}`);
  for (const key of [...empty.slice(0, 10), ...missing.slice(0, 10), ...plural.slice(0, 5), ...interpolation.slice(0, 10)]) {
    console.error(`  · ${key}`);
  }
  if (empty.length + missing.length + plural.length + interpolation.length > 35) console.error("  · …");
}

if (failed) {
  console.error("check-i18n: FAILED — run `npm run i18n:sync` and fill the listed keys.");
  process.exit(1);
}
console.log(`check-i18n: OK — ${files.length} locales × ${union.size} keys, no gaps.`);
