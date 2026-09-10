// Optional maintenance tool, NEVER invoked by sync, check, builds or the app.
// Sends only missing English UI keys to Google's public translation endpoint.
// Run explicitly with --write, then review the translations before committing.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { catalogState, localesUrl, rendererUrl, readJson, pluralVariants } from "./catalog-state.mjs";
import { interpolationTokens, reusableTranslation } from "./source-keys.mjs";

if (process.argv[2] !== "--write" || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/i18n/translate-missing.mjs --write (sends missing UI keys to Google Translate)");
}
const cancellation = new AbortController();
process.once("SIGINT", () => cancellation.abort(new Error("Translation cancelled")));
const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15 * 60_000)]);
const { catalogs } = catalogState();
const neutral = new Set(readJson(new URL("ui-untranslated-allowlist.json", rendererUrl)));
const protectedLiteral = /\{\{[^}]+\}\}|--[a-z][\w-]*|\b(?:Mixdog|mixdog|GitHub|Git|OAuth|MCP|API|TUI|CLI|HEAD|Whisper|ffmpeg|soft|mixed|hard)\b/g;

function protect(key, variant) {
  const literals = [];
  const source = variant ? variant.source.replace(/\{\{count\}\}/g, String(variant.count)) : key;
  return {
    text: source.replace(protectedLiteral, (literal) => {
      literals.push(literal);
      return `__MXP${literals.length - 1}__`;
    }),
    restore(text) {
      if (variant) {
        let restoredCount = 0;
        text = text.replace(/__MXP\d+__|\d+(?:[.,\u00a0\u202f ]\d+)*/g, (token) => {
          if (token.startsWith("__")) return token;
          const number = Number(variant.count % 1
            ? token.replace(",", ".").replace(/[\s\u00a0\u202f]/g, "")
            : token.replace(/[.,\s\u00a0\u202f]/g, ""));
          if (number !== variant.count) return token;
          restoredCount += 1;
          return "{{count}}";
        });
        if (restoredCount !== 1) throw new Error(`Translation damaged the plural count: ${key}: ${text}`);
      }
      for (let index = 0; index < literals.length; index += 1) {
        const marker = `__MXP${index}__`;
        if (text.split(marker).length !== 2) throw new Error(`Translation damaged a protected literal: ${key}`);
      }
      const restored = text.replace(/__MXP(\d+)__/g, (_, index) => literals[Number(index)] ?? "");
      if (!restored.trim() || /__MXP/.test(restored)
        || JSON.stringify(interpolationTokens(key)) !== JSON.stringify(interpolationTokens(restored))) {
        throw new Error(`Invalid translation: ${key}`);
      }
      return restored.trim();
    },
  };
}

async function translate(language, entries) {
  const variants = pluralVariants(language);
  const prepared = entries.map(([key]) => protect(key, variants.get(key)));
  const text = entries.length === 1 ? prepared[0].text
    : prepared.map((entry, index) => `MXK${String(index).padStart(4, "0")}: ${entry.text}`).join("\n");
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  for (const [key, value] of Object.entries({ client: "gtx", sl: "en", tl: language, dt: "t", q: text })) {
    url.searchParams.set(key, value);
  }
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) {
        const error = new Error(`Translation HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      result = await response.json();
      break;
    } catch (error) {
      if (signal.aborted || error.retryable === false || attempt === 2) throw error;
      await delay(1000 * (attempt + 1), undefined, { signal });
    }
  }
  const output = result?.[0]?.map((part) => part?.[0] || "").join("");
  if (typeof output !== "string") throw new Error("Unexpected translation response");
  if (entries.length === 1) return [[entries[0][0], prepared[0].restore(output)]];
  const matches = [...output.matchAll(/MXK(\d{4})\s*[:：]\s*([\s\S]*?)(?=MXK\d{4}\s*[:：]|$)/g)];
  if (matches.length !== entries.length || matches.some((match, index) => Number(match[1]) !== index)) {
    // A single phrase needs no boundary markers. Retry only this affected
    // batch once, as single phrases; protected-literal validation still applies.
    console.warn(`${language}: batch boundaries changed; translating ${entries.length} phrases individually.`);
    const translated = [];
    for (const entry of entries) translated.push(...await translate(language, [entry]));
    return translated;
  }
  return matches.map((match, index) => [entries[index][0], prepared[index].restore(match[2])]);
}

async function complete(language, catalog) {
  const file = new URL(`${language}.json`, localesUrl);
  let previous = readFileSync(file, "utf8");
  const missing = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === "string" && value.trim()) continue;
    const reused = reusableTranslation(key, catalog);
    if (reused) catalog[key] = reused;
    else if (neutral.has(key) || !/[A-Za-z]/.test(key.replace(/\{\{[^}]+\}\}/g, ""))) catalog[key] = key;
    else missing.push([key, value]);
  }
  const save = () => {
    if (readFileSync(file, "utf8") !== previous) throw new Error(`${language}.json changed during translation; refusing to overwrite it.`);
    const next = `${JSON.stringify(catalog, null, 2)}\n`;
    if (next === previous) return;
    const temporary = new URL(`${language}.${process.pid}.i18n-tmp`, localesUrl);
    writeFileSync(temporary, next, { flag: "wx" });
    renameSync(temporary, file);
    previous = next;
  };
  save();
  let completed = 0;
  while (missing.length) {
    const batch = [];
    let length = 0;
    while (missing.length && batch.length < 35 && (length < 2000 || !batch.length)) {
      const entry = missing.shift();
      batch.push(entry);
      length += protect(entry[0]).text.length + 12;
    }
    for (const [key, value] of await translate(language, batch)) catalog[key] = value;
    save();
    completed += batch.length;
    console.log(`${language}: ${completed} translated; ${missing.length} remaining`);
    await delay(350, undefined, { signal });
  }
}

const pending = [...catalogs];
let failure;
await Promise.allSettled(Array.from({ length: 3 }, async () => {
  while (pending.length && !signal.aborted) {
    const [language, catalog] = pending.shift();
    try { await complete(language, catalog); }
    catch (error) {
      failure ??= error;
      cancellation.abort(new Error("Translation stopped; completed batches were retained."));
      throw error;
    }
  }
}));
if (failure) throw failure;
console.log("Translation complete. Review catalog changes, then run i18n:sync and i18n:check.");
