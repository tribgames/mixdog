// cache-warm-targets.mjs — the `cacheWarming` setting: the conversations the
// user lets the prompt-cache warmer (agent/orchestrator/session/cache-warm.mjs)
// keep warm, stored as a list of target names ([] = off). Dependency-free:
// the desktop renderer and IPC validation import it too.
//
// - scheduled:     before a known scheduled run (a bot's routine fire);
// - bot-chats:     a bot's home thread while idle;
// - bot-rooms:     a bot's member session in a group room while idle;
// - favorites:     the user's favorite or pinned conversations while idle;
// - conversations: every other Lead conversation while idle.
// Sub-agents are never warmed, whatever the setting.

export const CACHE_WARM_TARGETS = Object.freeze(['scheduled', 'bot-chats', 'bot-rooms', 'favorites', 'conversations']);
/** The targets the idle trigger serves (every one but `scheduled`). */
export const CACHE_WARM_IDLE_TARGETS = Object.freeze(CACHE_WARM_TARGETS.filter((name) => name !== 'scheduled'));
export const DEFAULT_CACHE_WARM_TARGETS = Object.freeze(['scheduled']);
// Values of the earlier on/off setting.
const LEGACY_VALUES = Object.freeze({ routine: DEFAULT_CACHE_WARM_TARGETS, off: Object.freeze([]) });

const legacy = (value) => (Object.hasOwn(LEGACY_VALUES, value) ? LEGACY_VALUES[value] : null);

/** A stored `cacheWarming` value as the canonical target list: a list keeps
 *  its known names in canonical order, 'routine' → ['scheduled'], 'off' → [],
 *  anything else (absent) → the default. */
export function normalizeCacheWarmTargets(value) {
  if (Array.isArray(value)) return CACHE_WARM_TARGETS.filter((name) => value.includes(name));
  const old = typeof value === 'string' ? legacy(value) : null;
  return [...(old || DEFAULT_CACHE_WARM_TARGETS)];
}

/** MIXDOG_CACHE_WARMING: a comma list of target names (the old 'routine' and
 *  'off' accepted), any case. null when empty or when a word is unknown. */
export function parseCacheWarmTargetsEnv(text) {
  const words = String(text ?? '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return null;
  const names = new Set();
  for (const word of words) {
    const old = legacy(word);
    if (old) for (const name of old) names.add(name);
    else if (CACHE_WARM_TARGETS.includes(word)) names.add(word);
    else return null;
  }
  return CACHE_WARM_TARGETS.filter((name) => names.has(name));
}

/** The effective targets: the env value when it parses, else the setting. */
export function resolveCacheWarmTargets(config, env = process.env) {
  return parseCacheWarmTargetsEnv(env?.MIXDOG_CACHE_WARMING) ?? normalizeCacheWarmTargets(config?.cacheWarming);
}
