// files[] normalisation. String entries use the default head excerpt; object
// entries {path, n?, full?} let the caller widen the window or pull the full
// file so a worker does not re-read deep ranges of an already-prefetched file
// (a recurring iteration burner observed in baseline session telemetry).
export function collectPrefetchFiles(rawFiles) {
  const files = [];
  const readOpts = new Map();
  const seen = new Set();
  const add = (file, opts = null) => {
    if (typeof file !== 'string' || !file) return;
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
    if (!opts || Object.keys(opts).length === 0) return;
    const merged = { ...(readOpts.get(file) || {}) };
    if (opts.mode === 'full') {
      merged.mode = 'full';
      delete merged.n;
    } else if (merged.mode !== 'full' && Number.isFinite(opts.n) && opts.n > 0) {
      merged.n = Math.max(Number(merged.n) || 0, opts.n);
    }
    if (Object.keys(merged).length > 0) readOpts.set(file, merged);
  };
  for (const entry of Array.isArray(rawFiles) ? rawFiles : []) {
    if (typeof entry === 'string' && entry) {
      add(entry);
    } else if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path) {
      const opts = {};
      if (entry.full === true) opts.mode = 'full';
      else if (Number.isFinite(entry.n) && entry.n > 0) opts.n = entry.n;
      add(entry.path, opts);
    }
  }
  return { files, readOpts };
}
