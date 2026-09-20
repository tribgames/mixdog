/**
 * output-style-cache.mjs — short-TTL cache of the output-style status,
 * keyed on the plugin data dir it was scanned from.
 */
const OUTPUT_STYLE_STATUS_TTL_MS = 2500;

export function createOutputStyleStatusCache({
  cfgMod,
  STANDALONE_DATA_DIR,
  resolve,
  outputStyleStatus,
  performanceNow,
}) {
  let cache = null;
  let cachedAt = 0;
  let cachedDir = '';
  const dataDirOf = () => cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
  return {
    getOutputStyleStatusCached({ fresh = false } = {}) {
      const dataDir = dataDirOf();
      const cacheDir = resolve(dataDir);
      const now = performanceNow();
      if (!fresh && cache && cachedDir === cacheDir && now - cachedAt < OUTPUT_STYLE_STATUS_TTL_MS) return cache;
      cache = outputStyleStatus(dataDir, { fresh });
      cachedAt = now;
      cachedDir = cacheDir;
      return cache;
    },
    invalidateOutputStyleStatusCache() {
      cache = null;
      cachedAt = 0;
      cachedDir = '';
    },
    // In-memory seed of the status cache after an outputStyle select (avoids a
    // second forced-fresh filesystem scan during the debounce window).
    seedOutputStyleStatusCache(status) {
      cache = status;
      cachedAt = performanceNow();
      cachedDir = resolve(dataDirOf());
    },
  };
}
