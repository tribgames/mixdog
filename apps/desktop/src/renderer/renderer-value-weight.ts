// Conservative retained-JS-size estimate in the shared cache's character units
// (roughly two bytes each). Unlike JSON serialization, long text costs O(1)
// to measure and never creates a second full string just to count its length.
// Only recomputable plain data belongs here; opaque/deep values bypass caching.
export function estimateRetainedChars(value: unknown, limit: number): number {
  if (!Number.isFinite(limit) || limit < 0) return Infinity;
  const overflow = limit + 1;
  const seen = new WeakSet<object>();
  let chars = 0;
  const visit = (current: unknown, depth: number): void => {
    if (chars > limit || current == null) return;
    if (typeof current === "string") { chars += current.length + 8; return; }
    if (typeof current === "number" || typeof current === "bigint") { chars += 4; return; }
    if (typeof current === "boolean") { chars += 2; return; }
    if (typeof current !== "object") { chars = overflow; return; }
    if (seen.has(current)) return;
    if (depth >= 64) { chars = overflow; return; }
    seen.add(current);
    if (Array.isArray(current)) {
      chars += 16;
      for (let index = 0; index < current.length && chars <= limit; index += 1) {
        chars += 4;
        visit(current[index], depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== null && prototype !== Object.prototype) { chars = overflow; return; }
    chars += 32;
    const record = current as Record<string, unknown>;
    for (const key in record) {
      if (chars > limit) break;
      if (!Object.hasOwn(record, key)) continue;
      chars += key.length + 8;
      visit(record[key], depth + 1);
    }
  };
  try { visit(value, 0); } catch { return overflow; }
  return Math.min(overflow, chars);
}
