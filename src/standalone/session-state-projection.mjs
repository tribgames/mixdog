import { sanitizeForWire } from './session-wire-values.mjs';

/** Immutable source fields keep their wire identity until they actually change.
 * In particular, a live tail must not rebuild the settled transcript or resend
 * the unchanged prompt queue on every token. */
export function projectSessionState(entry, raw) {
  if (!raw || typeof raw !== 'object') {
    entry.fieldCache?.clear();
    entry.itemCache?.clear();
    entry.fieldCache = null;
    entry.itemCache = null;
    return sanitizeForWire(raw);
  }
  const fields = entry.fieldCache ??= new Map();
  for (const key of fields.keys()) {
    if (!Object.hasOwn(raw, key)) fields.delete(key);
  }
  if (!Array.isArray(raw.items)) entry.itemCache = null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const cached = fields.get(key);
    if (cached && cached.source === value) {
      out[key] = cached.value;
      continue;
    }
    let cloned;
    if (key === 'queued' && Array.isArray(value)) {
      cloned = value.map((item) => ({
        id: item?.id,
        submittedAt: item?.submittedAt,
        text: String(item?.displayText ?? item?.text ?? '').slice(0, 2_000),
        displayText: String(item?.displayText ?? item?.text ?? '').slice(0, 2_000),
        mode: item?.mode || 'prompt',
        priority: item?.priority || 'next',
        ...(Array.isArray(item?.images) && item.images.length ? { images: item.images } : {}),
      }));
    } else if (key === 'items' && Array.isArray(value)) {
      const items = entry.itemCache;
      const nextItems = new Map();
      cloned = value.map((item) => {
        const projected = items?.has(item) ? items.get(item) : sanitizeForWire(item);
        nextItems.set(item, projected);
        return projected;
      });
      entry.itemCache = nextItems;
    } else {
      cloned = sanitizeForWire(value);
    }
    if (cloned === undefined) {
      fields.delete(key);
      continue;
    }
    fields.set(key, { source: value, value: cloned });
    out[key] = cloned;
  }
  return out;
}
