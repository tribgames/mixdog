import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { DATA_DIR } from "./config.mjs";
// Computed lazily (not at module top) so this module can be imported in a
// cycle with config.mjs without touching DATA_DIR before config.mjs has
// finished evaluating it (ESM temporal-dead-zone safety).
function cacheFile() {
  return join(DATA_DIR, "holidays-cache.json");
}
const FALLBACK_FILE = join(homedir(), ".claude", "schedules", "holidays.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
// In-memory, pre-warmed holiday cache for SYNC reads (isHolidaySync).
// Keyed by `${year}:${countryCode}` -> Set<dateStr>. Absent key == cold
// (not yet warmed); callers fall back to their documented cold-cache
// behavior until a warm completes.
const memCache = /* @__PURE__ */ new Map();
const warming = /* @__PURE__ */ new Set();
function cacheKey(year, countryCode) {
  return `${year}:${countryCode}`;
}
function holidaySet(holidays) {
  return new Set((holidays || []).map((h) => h.date));
}
async function fetchHolidays(year, countryCode) {
  const url = `https://date.nager.at/api/v3/publicholidays/${year}/${countryCode}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Nager API ${res.status}: ${res.statusText}`);
  return res.json();
}
function loadCache(year, countryCode) {
  try {
    const file = cacheFile();
    if (!existsSync(file)) return null;
    const cache = JSON.parse(readFileSync(file, "utf8"));
    if (cache.year !== year || cache.countryCode !== countryCode) return null;
    if (Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) return null;
    return cache.holidays;
  } catch {
    return null;
  }
}
function saveCache(year, countryCode, holidays) {
  const cache = { year, countryCode, fetchedAt: Date.now(), holidays };
  try {
    const file = cacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch {
  }
}
function loadFallback() {
  try {
    if (!existsSync(FALLBACK_FILE)) return /* @__PURE__ */ new Set();
    const data = JSON.parse(readFileSync(FALLBACK_FILE, "utf8"));
    const dates = data.holidays ?? [];
    return new Set(dates);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function isHoliday(date, countryCode) {
  const year = date.getFullYear();
  const dateStr = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  let holidays = loadCache(year, countryCode);
  if (!holidays) {
    try {
      holidays = await fetchHolidays(year, countryCode);
      saveCache(year, countryCode, holidays);
    } catch (err) {
      process.stderr.write(`mixdog holidays: API fetch failed: ${err}
`);
      holidays = null;
    }
  }
  if (holidays) {
    return holidays.some((h) => h.date === dateStr);
  }
  const fallback = loadFallback();
  return fallback.has(dateStr);
}
// Synchronous, non-blocking holiday lookup backed by the pre-warmed
// in-memory cache. `dateStr` is a plain 'YYYY-MM-DD' string (the same
// representation warmHolidays stores), so there is no Date round-trip to
// shift the day across host offsets. Returns:
//   true  — date is a recognized public holiday (cache warm),
//   false — date is NOT a holiday (cache warm),
//   null  — cache is cold (not warmed yet); the async warm is kicked off
//           and the caller should apply its documented cold-cache
//           fallback. Never performs network OR blocking disk I/O — the
//           cold path consults the in-memory cache only.
function isHolidaySync(dateStr, countryCode) {
  if (!countryCode) return false;
  const year = Number(dateStr.slice(0, 4));
  const key = cacheKey(year, countryCode);
  const set = memCache.get(key);
  if (set === void 0) {
    // Cold: no synchronous disk probe here. Kick off the async warm
    // (which does any on-disk/network lookup off the sync path) and
    // report cold so the caller applies its documented fallback.
    warmHolidays(dateStr, countryCode);
    return null;
  }
  return set.has(dateStr);
}
// Asynchronously populate the in-memory sync cache for the given
// dateStr's year/country (from the on-disk cache when fresh, else Nager).
// `dateStr` is a plain 'YYYY-MM-DD' string. Idempotent and
// self-deduplicating; failures leave the entry cold so the next sync
// read retries.
async function warmHolidays(dateStr, countryCode) {
  if (!countryCode) return;
  const year = Number(dateStr.slice(0, 4));
  const key = cacheKey(year, countryCode);
  if (memCache.has(key) || warming.has(key)) return;
  warming.add(key);
  try {
    // Yield once before touching disk so the cold sync caller that
    // triggered this warm is never blocked by the loadCache file read.
    await Promise.resolve();
    let holidays = loadCache(year, countryCode);
    if (!holidays) {
      holidays = await fetchHolidays(year, countryCode);
      saveCache(year, countryCode, holidays);
    }
    memCache.set(key, holidaySet(holidays));
  } catch (err) {
    process.stderr.write(`mixdog holidays: warm failed: ${err}
`);
  } finally {
    warming.delete(key);
  }
}
export {
  isHoliday,
  isHolidaySync,
  warmHolidays
};
