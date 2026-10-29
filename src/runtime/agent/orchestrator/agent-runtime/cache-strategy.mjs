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
 * Lead class vs agent class: the Lead class is every Lead session — a coding
 * Lead (incl. a task session a bot creates with `session create`, which is a
 * coding Lead with agent 'lead'), raw/CLI callers without an agent, and every
 * agent-mode Lead (a bot's home thread `sess_home_*` incl. Mixy and routine
 * turns in it, a room member session, a schedule/webhook run). Sub-agents a
 * Lead or home thread spawns (owner:'agent') and hidden roles are the agent
 * class (isLeadCacheClass).
 *
 * OpenAI caching (https://developers.openai.com/api/docs/guides/prompt-caching,
 * checked 2026-10-21):
 *   - OpenAI (public API key): prompt_cache_key plus model-specific lifetime
 *     when response storage is enabled. GPT-5.6+ Responses take
 *     prompt_cache_options.ttl: "30m" (default, writes 1.25x input) or "12h"
 *     (writes 2.5x); reads 0.1x (0.05x on GPT-6.1 Sol) either way. Earlier
 *     models keep prompt_cache_retention '24h' on the extended-retention list.
 *     The request ttl is "30m" (moving tail); Lead-class sessions add one
 *     explicit "12h" breakpoint at the end of the stable prefix (tools +
 *     instructions + environment developer item; top-level instructions
 *     cannot carry a breakpoint). Break-even: the 12h write costs
 *     (2.5-1.25)=1.25x the prefix once per 12h window, every gap > 30m saves
 *     a 1.25x rewrite for a 0.1x read (1.15x), so it pays from ~1.09 long gaps
 *     per 12h — an hourly routine or a returning user pays it back many times;
 *     a short sub-agent never sees one, so agents stay on "30m".
 *   - OpenAI OAuth (Codex/ChatGPT login): prompt_cache_key only, request body
 *     unchanged. Since 2026-10-20 OpenAI keeps the cache of logged-in Codex
 *     users indefinitely ("we keep cache forever … guaranteed to hit the
 *     cache", https://x.com/thsottiaux/status/2112712984644784534), so the
 *     tail never expires: no cache-driven idle clear or compaction.
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
import { isAgentOwner } from '../agent-owner.mjs';
import { isAgentModeSession } from '../session/agent-mode.mjs';
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
 * Whether a session gets the Lead cache class (see the header): the Lead,
 * raw callers without an agent, and agent-mode Leads (a bot's home thread,
 * a room member session, a schedule/webhook run) whose `agent` is the bot's
 * id. `session` is the record or create options (`id`, `owner`,
 * `sessionMode`, `ownerAgentId`); a delegated sub-agent (owner:'agent') and
 * hidden roles are always the agent class.
 */
export function isLeadCacheClass(agent, session = null) {
  if (getHiddenAgent(agent) || (session && isAgentOwner(session))) return false;
  if (!agent || agent === 'lead') return true;
  return Boolean(session) && isAgentModeSession(session);
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
 * Lead-class sessions (isLeadCacheClass — incl. bot home threads, whose
 * hourly routine turns otherwise re-wrote the whole chat on a 5m tail) are
 * linked to the user's autoClear idle-sweep config (see
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
 * (These tiers only drive explicit-breakpoint providers — Anthropic. OpenAI's
 * lifetimes are resolveOpenAiPrefixCacheTtl / providerTailCacheLifetimeMs;
 * the 5m-vs-1h reasoning does not apply to openai-oauth, whose cache does
 * not expire.)
 *
 * Exception: one-shot LLM-only maintenance roles are asked once on a fresh
 * session and closed, so their per-call message tail is never read back and
 * stays unmarked. Their system prompt is shared by every call: replaying the
 * ledger's call times (memory-cycle, title) priced that prefix at 11-19% of
 * uncached input with a 1h breakpoint versus 34-59% with 5m. A prefix below
 * Anthropic's minimum cacheable length is simply not written, so the marker
 * costs nothing there.
 */
export function resolveCacheStrategy(agent, { autoClear, session = null } = {}) {
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
  if (!isLeadCacheClass(agent, session)) {
    // Hidden roles and sub-agents use a flat 5m tail that pre-send
    // compaction rebuilds once it expires — only Lead-class tails are linked
    // to autoClear.
    return applyEnv({ tools: 'none', system: '1h', tier3: '1h', messages: '5m' });
  }
  // Lead class (Lead, raw/CLI callers, bot home threads and other
  // agent-mode Leads): message tail TTL is linked to autoClear (see
  // resolveLeadMessagesTtl).
  return applyEnv({ tools: 'none', system: '1h', tier3: '1h', messages: resolveLeadMessagesTtl(autoClear) });
}

// OpenAI public API, GPT-5.6+ Responses: the moving tail rides the request
// ttl "30m"; Lead-class sessions pin their stable prefix with one "12h"
// breakpoint (header: break-even). Earlier models' typical retention is
// ~30 min as well.
const OPENAI_LEAD_PREFIX_CACHE_TTL = '12h';
export const ANTHROPIC_TAIL_LIFETIME_MS = Object.freeze({ '5m': 5 * 60_000, '1h': 60 * 60_000 });
const OPENAI_TAIL_LIFETIME_MS = 30 * 60_000;

/** The OpenAI (API key) stable-prefix TTL for a session: '12h' for the Lead
 *  class, null (request default "30m" only) for sub-agents and hidden roles. */
export function resolveOpenAiPrefixCacheTtl(agent, session = null) {
  return isLeadCacheClass(agent, session) ? OPENAI_LEAD_PREFIX_CACHE_TTL : null;
}

/**
 * Single source of truth for how long a session's message-tail cache stays
 * readable, per provider, in ms. null = no expiring tail to act on: the cache
 * does not expire (openai-oauth — logged-in Codex cache is kept indefinitely),
 * or the provider exposes no tail lifetime. Any "compact or clear because the
 * tail cache expired" rule must read this.
 *   - openai-oauth → null (permanent; never compact for cache reasons)
 *   - openai       → 30m (request ttl "30m"; the Lead's 12h prefix survives)
 *   - Anthropic    → the session cacheStrategy.messages tier (5m / 1h)
 */
export function providerTailCacheLifetimeMs(provider, cacheStrategy = null) {
  const key = cleanString(provider).toLowerCase();
  if (key === 'openai-oauth') return null;
  if (key === 'openai') return OPENAI_TAIL_LIFETIME_MS;
  if (cacheCapabilityForProvider(key) === 'explicit-breakpoint') {
    return ANTHROPIC_TAIL_LIFETIME_MS[cacheStrategy?.messages] ?? null;
  }
  return null;
}

/** Whether `session`'s message tail expired since its last model call. */
export function sessionTailCacheExpired(session, now = Date.now()) {
  const lifetime = providerTailCacheLifetimeMs(session?.provider, session?.providerCacheOpts?.cacheStrategy);
  const lastSendAt = Number(session?.lastProviderSendAt);
  return lifetime !== null && lastSendAt > 0 && now - lastSendAt > lifetime;
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
  'opencode-go-oauth': 'implicit-observed',
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

/** A cache identity as a prompt_cache_key: kept as is up to the 64-char wire
 *  limit, a bounded hash identity beyond it, '' when empty. */
export function normalizeCacheKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const wellFormed = text.toWellFormed();
  if (wellFormed.length <= 64) return wellFormed;
  return `pc_${createHash('sha256').update(wellFormed).digest('hex').slice(0, 32)}`;
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
function oneShotPromptCacheOpts(agent) {
  return isOneShotMaintenanceAgent(agent) ? { promptCacheScope: 'shared' } : null;
}

/**
 * Cache send options for a session-less loop whose system prompt and tool
 * schemas are the same bytes on every call (the explore tool's explorers):
 * keyed on that prefix, never per call, on the default 5m tier. The parallel
 * explorers of a fan-out and the next calls minutes later are its only
 * readers, so the Lead's 1h / 12h tiers would only raise the write price.
 */
export function sharedPrefixProviderCacheOpts(provider) {
  const shared = { promptCacheScope: 'shared' };
  if (cacheCapabilityForProvider(provider) !== 'explicit-breakpoint') return shared;
  return { ...shared, cacheStrategy: { tools: 'none', system: '5m', tier3: 'none', messages: '5m' } };
}

/**
 * Cache send options for a role's requests on `provider`: the breakpoint
 * strategy on explicit-breakpoint providers, the Lead-class 12h prefix TTL on
 * the OpenAI public API, plus the one-shot shared scope. Session and
 * session-less callers use this one resolution; `options.session` (record or
 * create options) classifies agent-mode Leads such as bot home threads.
 */
export function roleProviderCacheOpts(provider, agent, options = {}) {
  return buildProviderCacheOpts(provider, null, agent, options);
}

export function buildProviderCacheOpts(provider, _sessionId, agent, options = {}) {
  const capability = cacheCapabilityForProvider(provider);
  if (provider === 'openai') {
    // Read by applyOpenAIDirectCachePolicy (GPT-5.6+ Responses only).
    const prefixTtl = resolveOpenAiPrefixCacheTtl(agent, options.session);
    const opts = { ...(prefixTtl ? { promptCachePrefixTtl: prefixTtl } : {}), ...oneShotPromptCacheOpts(agent) };
    return Object.keys(opts).length ? opts : null;
  }
  if (capability !== 'explicit-breakpoint') return oneShotPromptCacheOpts(agent);
  // 2026-03-06 Anthropic dropped default TTL 1h→5m. We request 1h via
  // cache_control ttl:"1h"; no beta header is required.
  // Verified 2026-04-17 (ephemeral_1h_input_tokens=4722).
  return { cacheStrategy: resolveCacheStrategy(agent, options), ...oneShotPromptCacheOpts(agent) };
}
