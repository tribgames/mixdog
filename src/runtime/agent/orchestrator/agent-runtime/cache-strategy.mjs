/**
 * Agent Runtime — Cache Strategy
 *
 * Provider-level cache policy. Anthropic supports explicit cache_control
 * breakpoints (up to 4 per request) — we spend them on the stable system /
 * session prefix plus the reusable message tail. Non-breakpoint providers
 * rely on provider-managed prefix routing or provider-local cache objects.
 *
 * Anthropic 4-BP layout:
 *   BP_1  system#1  (1h)  — shared tool policy
 *   BP_2  system#2  (1h)  — profile/settings + skills + deferred/MCP catalog
 *   BP_3  system#3  (1h)  — workflow/role + memory (stable core only)
 *   ---   system#4  (unmarked) — volatile session/project environment
 *         (cacheTier:'env'); covered by the messages-tail BP so an
 *         environment change never invalidates the BP3 core write
 *   BP_4  messages  (5m public/hidden agents; Lead linked to autoClear,
 *                    whose Anthropic default is 1h — see below) —
 *         sliding tool_result / prior user-text tail
 *
 * Tool schemas still sit before system in the provider prompt prefix. We do
 * not spend a separate cache_control slot on tools; the first system BP covers
 * the preceding tool prefix via Anthropic prefix caching semantics. Keeping
 * agent worker tool schemas byte-stable is therefore still load-bearing.
 *
 * Tier 3 gets its own BP because role/memory context is stable within the
 * session. The volatile environment block stays unmarked and rides the sliding
 * messages BP, which also handles tool_result accumulation and per-call
 * task/event data while isolating volatile text from stable prefix BPs.
 *
 * Non-breakpoint providers:
 *   - OpenAI (public): prompt_cache_key plus model-specific retention when
 *     response storage is enabled (30m cache options or 24h retention).
 *   - OpenAI OAuth: prompt_cache_key only; the Codex backend keeps the
 *     prompt cache at least 30 minutes on GPT-5.6+ models, refreshed on use
 *     (the openai-oauth auto-clear window matches it)
 *   - Gemini: provider-managed explicit cachedContents with 5m default TTL, plus
 *     implicit caching as a fallback when the prefix is below cache minimums.
 *   - xAI: conversation routing for chat; Responses omits prompt_cache_key
 *     by default, with explicit session/prefix routing available.
 *   - DeepSeek / OpenCode Go: automatic KV/prefix cache; observe provider
 *     cached token fields when returned
 *   - Groq: auto 50% cache (gpt-oss-120b) — no knob
 *   - Copilot / Local Provider: no API-level cache
 */

import { createHash } from 'node:crypto';
import { stableHashStringify } from '../stable-hash-stringify.mjs';
import { getHiddenAgent } from '../internal-agents.mjs';
import { cleanString } from '../../../shared/clean.mjs';
import { nonNegativeInt, positiveInt } from '../../../shared/numbers.mjs';

/**
 * One-shot, tool-free maintenance hidden roles (cycle1-agent, title-agent):
 * every call is a fresh stateless session (or a session-less send), asked
 * exactly once — the per-call user prompt is NEVER reused, while the role's
 * system prompt is identical across calls. Identified by the declarative
 * (kind:'maintenance' + toolSchemaProfile:'none') pair rather than
 * hardcoded names, so new roles sharing the pattern are covered for free.
 */
function isOneShotMaintenanceAgent(agent) {
  const hidden = getHiddenAgent(agent);
  // Shipped one-shot maintenance roles declare toolSchemaProfile:'none'.
  return Boolean(hidden && hidden.kind === 'maintenance' && hidden.toolSchemaProfile === 'none');
}

/**
 * Lead-session BP4 (messages tail) TTL, linked to the autoClear idle-sweep
 * config (config.mjs `autoClear: { enabled, idleMs }`, normalized via
 * session-runtime/config-helpers.mjs normalizeAutoClearConfig):
 *   - autoClear disabled                → '1h' (session may live indefinitely;
 *     amortize the 2x write premium over a long-lived tail)
 *   - idleMs >= 1h (3_600_000ms)        → '1h' (idle-sweep window is at least
 *     as long as the 1h TTL, so the longer TTL is never wasted)
 *   - otherwise (shorter idle-sweep)    → '5m' (session reaps before a 1h
 *     write would ever be re-read; cheaper 5m write wins)
 */
export function resolveLeadMessagesTtl(autoClear) {
  if (autoClear && autoClear.enabled === false) return '1h';
  const idleMs = Number(autoClear?.idleMs);
  if (Number.isFinite(idleMs) && idleMs >= 3_600_000) return '1h';
  return '5m';
}

/**
 * Return the layered cache policy for Anthropic-family providers.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no breakpoint written on this layer
 *
 * BP1~3 stay at 1h: the system/role/tier3 prefix is shared across sessions
 * (pool-stable), so the 2x write premium is amortized cross-session and the
 * warm window survives per-session gaps. The volatile message tail (BP4) is
 * per-session.
 *
 * Lead sessions are linked to the user's autoClear idle-sweep config (see
 * resolveLeadMessagesTtl); its Anthropic default is 1h, while explicit
 * shorter overrides retain the shorter-sweep behavior. The 2026-07-16 6.8h
 * trace supports the 1h Lead tail: 24/25 Lead intra-session gaps over 5m were
 * agent waits (5–27m), during which autoClear correctly cannot fire, and no
 * gap over 1h was observed (tail-cost simulation, input-token equivalents:
 * 1h=11.75M vs 5m=20.11M).
 *
 * Hidden and public-agent sessions use a 5m tail. Replaying the usage
 * ledger's Anthropic agent requests (2026-09-15..30, 25K requests) found 0.9%
 * of intra-session gaps over 5m, and pre-send compaction rebuilds an agent
 * transcript once its 5m tail has expired (compact-policy.mjs
 * shouldCompactForExpiredAgentCache), so the cold request rewrites the
 * compacted transcript instead of the whole accumulated tail. Replayed agent
 * cost vs a 1h tail: -24.6% with that compaction, +2.7% without it.
 * (Tail TTL only affects explicit-breakpoint providers — Anthropic; no-op
 * elsewhere.)
 *
 * Exception: one-shot LLM-only maintenance roles are asked once on a fresh
 * session and closed, so their per-call message tail is never read back and
 * stays unmarked. Their system prompt is shared by every call: replaying the
 * ledger's call times (memory-cycle, title) priced that prefix at 11-19% of
 * uncached input with a 1h breakpoint versus 34-59% with 5m. A prefix below
 * Anthropic's minimum cacheable length is simply not written, so the marker
 * costs nothing there.
 */
export function resolveCacheStrategy(agent, { autoClear } = {}) {
  if (isOneShotMaintenanceAgent(agent)) {
    return { tools: 'none', system: '1h', tier3: '1h', messages: 'none' };
  }
  // Operator override for the BP4 (messages-tail) TTL. Short-lived
  // rapid-turn deployments (bench-style: session dies in <15min) never
  // benefit from a 1h tail across its premium window, so '5m' trades the
  // 2x write premium (1h, $10/M) down to 1.25x ($6.25/M) and deactivates
  // the 1h volatile-content anchor guard. Product defaults below stay
  // untouched when the env is unset.
  const envMessagesTtl = (process.env.MIXDOG_CACHE_MESSAGES_TTL || '').trim();
  const applyEnv = (strategy) => {
    if (envMessagesTtl === '1h' || envMessagesTtl === '5m' || envMessagesTtl === 'none') {
      return { ...strategy, messages: envMessagesTtl };
    }
    return strategy;
  };
  if (getHiddenAgent(agent) || (agent && agent !== 'lead')) {
    // Hidden and public agents use a flat 5m tail that pre-send compaction
    // rebuilds once it expires — only the Lead session's tail is linked to
    // autoClear.
    return applyEnv({ tools: 'none', system: '1h', tier3: '1h', messages: '5m' });
  }
  // Lead session (agent === 'lead', or no agent — raw/CLI callers default
  // to Lead behavior): message tail TTL is linked to autoClear (see
  // resolveLeadMessagesTtl).
  return applyEnv({ tools: 'none', system: '1h', tier3: '1h', messages: resolveLeadMessagesTtl(autoClear) });
}

// Provider cache capability kinds:
//   'explicit-breakpoint' — explicit provider-side cache_control writes
//   'key-prefix'          — provider-managed shard keyed by cache key/session
//   'managed-explicit'    — provider object creates/attaches explicit caches
//   'implicit-observed'   — cache hits are observable but not guaranteed warm
//   'none'                — no API-level cache knob/metric
const PROVIDER_CACHE_CAPABILITY = Object.freeze({
  anthropic: 'explicit-breakpoint',
  'anthropic-oauth': 'explicit-breakpoint',
  openai: 'key-prefix',
  'openai-oauth': 'key-prefix',
  xai: 'key-prefix',
  'grok-oauth': 'key-prefix',
  gemini: 'managed-explicit',
  deepseek: 'implicit-observed',
  'opencode-go': 'implicit-observed',
});

export function cacheCapabilityForProvider(provider) {
  return PROVIDER_CACHE_CAPABILITY[provider] || 'none';
}

export function shouldMarkWarmForProvider(provider) {
  const capability = cacheCapabilityForProvider(provider);
  return capability === 'explicit-breakpoint' || capability === 'key-prefix' || capability === 'managed-explicit';
}

export function shouldRecordObservedForProvider(provider) {
  return cacheCapabilityForProvider(provider) === 'implicit-observed';
}

// Stable provider namespaces, not final wire cache keys. The request builders
// add session identity by default; explicit overrides can enable shared routing.
// Anthropic/Gemini use content-keyed breakpoints / explicit cache objects instead.
const PROVIDER_CACHE_KEY_DEFAULT = Object.freeze({
  openai: 'mixdog-openai',
  'openai-oauth': 'mixdog-codex',
  xai: 'mixdog-xai',
  'grok-oauth': 'mixdog-xai',
});

/**
 * Resolve the prompt-cache namespace for a
 * key-prefix provider. Precedence: explicit provider key > prompt key >
 * session-scoped prompt key > stable shared default. Invariant: always returns a
 * non-empty stable namespace. Final session isolation is applied by the
 * provider's request-key builder, not by this namespace resolver.
 *
 * The socket poolKey stays sessionId-scoped at each
 * call site to avoid cross-session socket/delta-state reuse.
 */
export function resolveProviderCacheKey(opts, provider) {
  return (
    opts?.providerCacheKey ||
    opts?.promptCacheKey ||
    opts?.session?.promptCacheKey ||
    PROVIDER_CACHE_KEY_DEFAULT[provider] ||
    'mixdog-shared'
  );
}

function shortHash(value, chars = 18) {
  return createHash('sha256').update(stableHashStringify(value)).digest('hex').slice(0, chars);
}

function normalizePromptCacheNamespace(value) {
  const s = String(value || '').trim() || 'mixdog-shared';
  // Keep the key boring for OpenAI OAuth's 64-char prompt_cache_key cap while
  // preserving user overrides as much as possible.
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mixdog-shared';
}

function fitPromptCacheKey(value, fallback = 'mixdog-shared') {
  const s = normalizePromptCacheNamespace(value || fallback);
  if (s.length <= 64) return s;
  const hash = shortHash(s, 12);
  const head = s.slice(0, Math.max(1, 64 - hash.length - 1));
  return `${head}-${hash}`;
}

function codexThreadPromptCacheKey(opts, namespace) {
  const explicit =
    cleanString(opts?.providerCacheKey) ||
    cleanString(opts?.promptCacheKey) ||
    cleanString(opts?.session?.promptCacheKey);
  if (process.env.MIXDOG_OAI_CACHE_KEY_SHARED === '1') {
    return fitPromptCacheKey(explicit || namespace, 'mixdog-codex');
  }
  const codexIdentity =
    cleanString(opts?.codexSessionId) ||
    cleanString(opts?.codexThreadId) ||
    cleanString(opts?.session?.codexWireSessionId);
  const sessionKey = codexIdentity || cleanString(opts?.sessionId || opts?.session?.id);
  return fitPromptCacheKey(sessionKey || explicit || namespace, namespace);
}

function summarizePromptCacheTools(tools) {
  return (tools || []).map((t) => ({
    type: cleanString(t?.type) || 'function',
    name: cleanString(t?.name || t?.function?.name),
    description: cleanString(t?.description || t?.function?.description),
    parameters: t?.parameters || t?.inputSchema || t?.function?.parameters || null,
  }));
}

/**
 * Build a stable, prefix-scoped prompt_cache_key for OpenAI-style key-prefix
 * providers. OpenAI OAuth uses a thread-scoped key by default:
 * prompt_cache_key is the session/thread identity, clamped to the backend's
 * 64-character limit. Other OpenAI-style providers keep the older
 * namespace+prefix-hash key shape, but no longer get a shard suffix unless an
 * explicit cache-lane override opts into it.
 */
export function buildStableProviderPromptCacheKey(provider, opts, prefix = {}) {
  const namespace = normalizePromptCacheNamespace(resolveProviderCacheKey(opts, provider));
  const sharedScope = opts?.promptCacheScope === 'shared';
  if (
    provider === 'openai-oauth' &&
    !sharedScope &&
    process.env.MIXDOG_OAI_CODEX_THREAD_CACHE_KEY !== '0' &&
    String(process.env.MIXDOG_OAI_CODEX_THREAD_CACHE_KEY || '').toLowerCase() !== 'false'
  ) {
    return codexThreadPromptCacheKey(opts, namespace);
  }
  const lane = promptCacheLaneParts(prefix, opts);
  const seed = {
    provider: cleanString(provider),
    model: cleanString(prefix.model),
    instructions: cleanString(prefix.instructions),
    tools: summarizePromptCacheTools(prefix.tools),
    effort: cleanString(prefix.effort ?? opts?.effort),
    fast: prefix.fast === true || opts?.fast === true,
    serviceTier: cleanString(prefix.serviceTier),
    parallelToolCalls: prefix.parallelToolCalls !== false,
    cacheLaneSlot: lane.cacheLaneSlot,
    cacheLaneShards: lane.cacheLaneShards,
    // Per-session cache-key isolation. R8 A/B (2026-07-03) showed parallel
    // sessions sharing one prompt_cache_key evict each other's transcript
    // body on the server cache node (same key -> same node; bodies differ),
    // producing 8-23% genuine mid-session misses at tens of thousands of
    // uncached tokens each. Mixing sessionId in costs only the small static
    // prefix hit (~2-4k tokens) on a session's FIRST call — every later
    // call's body cache is protected. Opt out: MIXDOG_OAI_CACHE_KEY_SHARED=1.
    // A one-shot role (promptCacheScope 'shared') has no later call to
    // protect: every call is a new session, so it keys on the prefix alone.
    session:
      sharedScope || process.env.MIXDOG_OAI_CACHE_KEY_SHARED === '1'
        ? null
        : cleanString(opts?.sessionId || opts?.session?.id || '') || null,
  };
  const hash = shortHash(seed);
  const head = namespace.slice(0, Math.max(1, 64 - hash.length - lane.laneSuffix.length - 1));
  return `${head}-${hash}${lane.laneSuffix}`;
}

// The lane the key is sharded into: its seed fields and the `-sNN` suffix
// (empty when the lane is a single un-suffixed shard).
function promptCacheLaneParts(prefix, opts) {
  const rawShards = prefix.cacheLaneShards ?? opts?.promptCacheLane?.shards ?? opts?.cacheLaneShards;
  const rawShardMode = String(rawShards ?? '')
    .trim()
    .toLowerCase();
  const autoLane =
    prefix.cacheLaneAuto === true ||
    opts?.promptCacheLane?.auto === true ||
    rawShards === 0 ||
    ['auto', 'unbounded', 'unlimited', 'none', 'off'].includes(rawShardMode);
  const shardCount = autoLane ? 0 : positiveInt(rawShards, 1);
  const rawSlot = nonNegativeInt(prefix.cacheLaneSlot ?? opts?.promptCacheLane?.slot ?? opts?.cacheLaneSlot, 0);
  const shardSlot = autoLane ? rawSlot : Math.max(0, Math.min(rawSlot, Math.max(0, shardCount - 1)));
  const laneEnabled = autoLane || shardCount > 1;
  let cacheLaneShards = null;
  if (autoLane) cacheLaneShards = 'auto';
  else if (shardCount > 1) cacheLaneShards = shardCount;
  return {
    cacheLaneSlot: laneEnabled ? shardSlot : null,
    cacheLaneShards,
    laneSuffix: laneEnabled ? `-s${shardSlot.toString(36).padStart(2, '0')}` : '',
  };
}

function providerEnvKey(provider) {
  return String(provider || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

const providerPromptCacheLaneAssignments = new Map();
const PROVIDER_PROMPT_CACHE_LANE_MAX_ASSIGNMENTS = 4096;
const DEFAULT_PROVIDER_PROMPT_CACHE_LANE_SHARDS = 1;

function promptCacheLaneGroupKey(provider, opts) {
  return [cleanString(provider), normalizePromptCacheNamespace(resolveProviderCacheKey(opts, provider))].join('\0');
}

function promptCacheLaneAutoRequested(value) {
  if (value === true) return true;
  if (value === 0) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return ['0', 'auto', 'unbounded', 'unlimited', 'none', 'off'].includes(s);
  }
  return false;
}

function parsePromptCacheLaneLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_PROVIDER_PROMPT_CACHE_LANE_SHARDS;
  if (promptCacheLaneAutoRequested(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function assignPromptCacheLaneSlot(provider, opts, shards, seed, { auto = false } = {}) {
  const explicit = opts?.promptCacheLaneSlot ?? opts?.cacheLaneSlot;
  const explicitSlot = Number(explicit);
  if (Number.isFinite(explicitSlot) && explicitSlot >= 0) {
    return auto ? Math.floor(explicitSlot) : Math.floor(explicitSlot) % Math.max(1, shards);
  }
  if (!auto && shards <= 1) return 0;
  const groupKey = promptCacheLaneGroupKey(provider, opts);
  let state = providerPromptCacheLaneAssignments.get(groupKey);
  if (!state) {
    state = { nextSlot: 0, bySeed: new Map() };
    providerPromptCacheLaneAssignments.set(groupKey, state);
  }
  const seedKey = cleanString(seed) || 'mixdog';
  if (state.bySeed.has(seedKey)) return state.bySeed.get(seedKey);
  const slot = auto ? state.nextSlot : state.nextSlot % shards;
  state.nextSlot = auto ? state.nextSlot + 1 : (state.nextSlot + 1) % shards;
  state.bySeed.set(seedKey, slot);
  if (state.bySeed.size > PROVIDER_PROMPT_CACHE_LANE_MAX_ASSIGNMENTS) {
    const oldest = state.bySeed.keys().next().value;
    if (oldest !== undefined) state.bySeed.delete(oldest);
  }
  return slot;
}

// The requested lane limit: 'auto' when any auto flag is set, else the lane
// SHARDS, requested either by their own name (`*CacheLaneShards`) or through
// the legacy `*CacheMaxParallel` / MIXDOG_*_CACHE_MAX_PARALLEL aliases. Those
// knobs also bounded in-flight admission for the removed compat cache lane —
// that half is gone for good, admission now belongs solely to the
// provider/account scheduler — but on OpenAI direct/OAuth they have always
// selected the prompt-cache shard count as well, and existing configurations
// depend on it. They stay accepted here at LOWER precedence than the
// explicitly named shard settings.
// Exception: xAI compatibility routing passes promptCacheLaneIgnoreAliases
// so the alias keeps meaning nothing there (openai-compat-xai.mjs), where
// it never selected shards and would silently fan out cache keys.
function requestedPromptCacheLaneLimit(provider, opts, config) {
  const envKey = providerEnvKey(provider);
  const env = process.env;
  const requestedAuto =
    promptCacheLaneAutoRequested(opts?.promptCacheLaneAuto) ||
    promptCacheLaneAutoRequested(opts?.openaiCacheLaneAuto) ||
    promptCacheLaneAutoRequested(opts?.promptCacheLane?.auto) ||
    promptCacheLaneAutoRequested(config?.promptCacheLaneAuto) ||
    promptCacheLaneAutoRequested(config?.openaiCacheLaneAuto);
  if (requestedAuto) return 'auto';
  const ignoreAliases = opts?.promptCacheLaneIgnoreAliases === true || config?.promptCacheLaneIgnoreAliases === true;
  const rawShards =
    opts?.promptCacheLaneShards ??
    opts?.promptCacheLane?.shards ??
    opts?.openaiCacheLaneShards ??
    config?.promptCacheLaneShards ??
    config?.openaiCacheLaneShards ??
    env[`MIXDOG_${envKey}_CACHE_LANE_SHARDS`] ??
    env.MIXDOG_OPENAI_CACHE_LANE_SHARDS;
  const rawAlias = ignoreAliases
    ? undefined
    : (opts?.promptCacheLaneMaxParallel ??
      opts?.promptCacheLane?.maxParallel ??
      opts?.openaiCacheMaxParallel ??
      config?.promptCacheLaneMaxParallel ??
      config?.openaiCacheMaxParallel ??
      env[`MIXDOG_${envKey}_CACHE_MAX_PARALLEL`] ??
      env.MIXDOG_OPENAI_CACHE_MAX_PARALLEL);
  return rawShards ?? rawAlias;
}

/**
 * Resolve an optional cache-lane slot for OpenAI-style prompt cache sharding.
 * prompt_cache_key is not sharded by default, so every provider now gets
 * one un-suffixed key unless an env/config override opts into shards.
 */
export function resolveProviderPromptCacheLane(provider, opts = {}, config = {}) {
  const rawLimit = requestedPromptCacheLaneLimit(provider, opts, config);
  const shards = parsePromptCacheLaneLimit(rawLimit);
  const auto = shards <= 0;
  const seed = cleanString(
    opts?.promptCacheLaneSeed ??
      opts?.sessionId ??
      opts?.session?.id ??
      opts?.providerCacheKey ??
      opts?.promptCacheKey ??
      provider ??
      'mixdog'
  );
  const slot = assignPromptCacheLaneSlot(provider, opts, shards, seed, { auto });
  return {
    enabled: auto || shards > 1,
    auto,
    shards: auto ? 0 : shards,
    slot,
    seedHash: shortHash(seed || 'mixdog', 12),
  };
}

/**
 * A one-shot role's calls are each a new session, so routing their prompt
 * cache by session scatters an identical system prefix across a fresh
 * server-side lane per call. `promptCacheScope: 'shared'` tells every
 * key-prefix provider to key the cache on the prefix instead.
 */
export function oneShotPromptCacheOpts(agent) {
  return isOneShotMaintenanceAgent(agent) ? { promptCacheScope: 'shared' } : null;
}

/**
 * Cache send options for a role's requests on `provider`: the breakpoint
 * strategy on explicit-breakpoint providers plus the one-shot shared scope.
 * Session and session-less callers use this one resolution.
 */
export function roleProviderCacheOpts(provider, agent, options = {}) {
  if (cacheCapabilityForProvider(provider) !== 'explicit-breakpoint') return oneShotPromptCacheOpts(agent);
  return buildProviderCacheOpts(provider, null, agent, options);
}

export function buildProviderCacheOpts(provider, _sessionId, agent, options = {}) {
  const ttls = resolveCacheStrategy(agent, options);
  const capability = cacheCapabilityForProvider(provider);
  if (capability === 'explicit-breakpoint') {
    // 2026-03-06 Anthropic dropped default TTL 1h→5m. We send
    // extended-cache-ttl-2025-04-11 header to retain 1h.
    // Verified 2026-04-17 (ephemeral_1h_input_tokens=4722).
    return { cacheStrategy: ttls, ...oneShotPromptCacheOpts(agent) };
  }
  // NOTE: createSession's direct-call site (manager.mjs) only invokes this
  // for explicit-breakpoint (Anthropic-family) providers, so this branch
  // stays reachable only from other callers (none in-tree today) — keeping
  // it here preserves the documented public API/behavior of this function.
  if (provider === 'openai') {
    // Public OpenAI API: prompt_cache_retention extends prefix retention.
    // openai-oauth rejects the header — falls through to default.
    return { cacheRetention: '24h' };
  }
  return {};
}
