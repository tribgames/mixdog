// System blocks carry their own cache tier; anything else is the default tier.
const SYSTEM_CACHE_TIERS = new Set(['tier3', 'env']);
const systemCacheTier = (cacheTier) => (SYSTEM_CACHE_TIERS.has(cacheTier) ? cacheTier : 'system');

function pushSystemEntry(items, entry, tier) {
  if (entry == null) return;
  if (typeof entry === 'string') {
    const text = entry.trim();
    if (text) items.push({ text, tier });
    return;
  }
  if (Array.isArray(entry)) {
    for (const part of entry) pushSystemEntry(items, part, tier);
    return;
  }
  if (typeof entry === 'object') {
    const entryTier = entry.cacheTier === undefined ? tier : systemCacheTier(entry.cacheTier);
    if (entry.type === 'text' && typeof entry.text === 'string') return pushSystemEntry(items, entry.text, entryTier);
    if (entry.type === undefined && 'content' in entry) return pushSystemEntry(items, entry.content, entryTier);
  }
  throw new TypeError('Anthropic system instructions must be a string, text blocks, or system messages of those');
}

/**
 * Non-empty system instructions as `{ text, tier }` block items. Accepts a
 * string, a text-block array (`{ type: 'text', text }`), or an array of system
 * messages whose `content` is either. Null/undefined yields none; any other
 * shape throws rather than silently dropping structured instructions.
 */
export function systemBlockItems(system) {
  const items = [];
  pushSystemEntry(items, system, 'system');
  return items;
}
/** cacheTier:'env' (volatile session/project environment) is never marked —
 *  it rides the messages-tail breakpoint; a null TTL leaves the block uncached. */
export const systemBlockTtl = (tier, { tier3Ttl, systemTtl }) =>
  ({ tier3: tier3Ttl, env: null, system: systemTtl })[tier];
