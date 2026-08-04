// i18n catalog sync wrapper (npm run i18n:sync).
// Runs `i18next-cli extract`, then repairs two extractor behaviors that do
// not fit the English-text-as-key catalog:
//   1. Plural-suffix keys (key_one/key_few/…) are DELETED. Count strings are
//      authored as single {{count}} forms; the seeded variants carry raw
//      English key text and would override the real translations at runtime
//      (i18next prefers the suffixed key and only falls back to the base key
//      when no suffixed entry exists).
//   2. Keys the extractor dropped (variables reaching t() through the
//      settings primitives are invisible to static analysis) are restored
//      with their pre-extract values.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localesDir = new URL("../src/renderer/locales/", import.meta.url);
const files = readdirSync(localesDir).filter((name) => name.endsWith(".json")).sort();
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const before = new Map();
for (const name of files) {
  before.set(name, JSON.parse(readFileSync(new URL(name, localesDir), "utf8")));
}

execSync("npx i18next-cli extract", {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});

for (const name of files) {
  const path = new URL(name, localesDir);
  const extracted = JSON.parse(readFileSync(path, "utf8"));
  const prior = before.get(name) ?? {};
  const repaired = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (PLURAL_SUFFIX.test(key)) continue; // drop seeded plural variants
    repaired[key] = value === "" && typeof prior[key] === "string" && prior[key] !== ""
      ? prior[key] // extractor blanked a key we already translated
      : value;
  }
  for (const [key, value] of Object.entries(prior)) {
    if (PLURAL_SUFFIX.test(key)) continue;
    if (!(key in repaired)) repaired[key] = value; // extractor dropped a dynamic key
  }
  const sorted = Object.fromEntries(Object.entries(repaired).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
console.log(`sync-i18n: extract + repair complete for ${files.length} locales.`);
