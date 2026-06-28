/**
 * Agent Runtime — Cache Strategy
 *
 * Provider-level cache policy. Anthropic supports explicit cache_control
 * breakpoints (up to 4 per request) — we spend them on the stable system /
 * session prefix plus the reusable message tail. Non-breakpoint providers
 * rely on provider-managed prefix routing or provider-local cache objects.
 *
 * Anthropic 4-BP layout:
 *   BP_1  system#1  (1h)  — shared tool policy + compact skill manifest
 *   BP_2  system#2  (1h)  — role/system rules (Lead / agent / hidden role)
 *   BP_3  tier3     (1h)  — stable memory/meta marker (sentinel system-reminder)
 *   BP_4  messages  (1h/5m) — sliding tool_result / prior user-text tail
 *
 * Tool schemas still sit before system in the provider prompt prefix. We do
 * not spend a separate cache_control slot on tools; the first system BP covers
 * the preceding tool prefix via Anthropic prefix caching semantics. Keeping
 * agent worker tool schemas byte-stable is therefore still load-bearing.
 *
 * Tier 3 gets its own BP because memory/meta context is stable within the
 * session. The sliding messages BP handles tool_result accumulation and
 * per-call task/event data without pinning volatile text into the 1h tier.
 *
 * Non-breakpoint providers:
 *   - OpenAI (public): prompt_cache_key + prompt_cache_retention=24h
 *   - OpenAI OAuth (Codex): prompt_cache_key only (server in-memory 5-10min)
 *   - Gemini: provider-managed explicit cachedContents with 1h TTL, plus
 *     implicit caching as a fallback when the prefix is below cache minimums.
 *   - xAI: x-grok-conv-id (server routing pin) + prompt_cache_key on
 *     Responses API. Treat as key-prefix, not implicit.
 *   - DeepSeek / OpenCode Go: automatic KV/prefix cache; observe provider
 *     cached token fields when returned
 *   - Groq: auto 50% cache (gpt-oss-120b) — no knob
 *   - Copilot / Ollama / LMStudio: no API-level cache
 */

import { createHash } from 'crypto';
import { getHiddenRole } from '../internal-roles.mjs';

/**
 * One-shot, LLM-only maintenance hidden roles (cycle1/cycle2/cycle3-agent):
 * a fresh stateless session is created per call, asked exactly once, and
 * closed (agent-dispatch.mjs) — the per-batch user prompt can NEVER be reused.
 * Writing a message-tail cache breakpoint on it just pays the 1.25x write
 * premium for content read back 0 times. Identified by the declarative
 * (kind:'maintenance' + toolSchemaProfile:'llm-only') pair rather than
 * hardcoded names, so new roles sharing the pattern are covered for free.
 * Multi-turn maintenance roles (scheduler-task / webhook-handler) are
 * 'unified' and therefore excluded — they run a tool loop whose tail caches
 * legitimately reuse across iterations.
 */
function isOneShotMaintenanceRole(role) {
    const hidden = getHiddenRole(role);
    return Boolean(
        hidden
        && hidden.kind === 'maintenance'
        && hidden.toolSchemaProfile === 'llm-only',
    );
}

/**
 * Return the layered cache policy for Anthropic-family providers.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no breakpoint written on this layer
 *
 * Public agents stay resumable for up to 1h (the terminal-reap window)
 * for same-task reuse, so their message tail uses 1h too. Hidden multi-turn
 * roles (explorer / scheduler / webhook) run a single fan-out or entry-driven
 * session that is not resumed for same-task reuse, so their volatile tail stays
 * at the cheaper 5m TTL. (Tail TTL only affects explicit-breakpoint providers
 * — Anthropic; no-op elsewhere.)
 *
 * Exception: one-shot LLM-only maintenance roles are asked once on a fresh
 * session and closed, so their volatile per-call message tail is never read
 * back — and trace data (2026-06) shows the 1h system/tools prefix never
 * gets read back either: cycle1's prompt sits below Anthropic's minimum
 * cacheable length (0 writes), and cycle2's 1h run interval lands at/after
 * the 1h TTL expiry (writes every run, 0 reads). All layers go 'none' for
 * these roles — single-iteration calls pay the write premium with no reuse.
 */
export function resolveCacheStrategy(role) {
    if (isOneShotMaintenanceRole(role)) {
        return { tools: 'none', system: 'none', tier3: 'none', messages: 'none' };
    }
    if (getHiddenRole(role)) {
        return { tools: 'none', system: '1h', tier3: '1h', messages: '5m' };
    }
    // Public agents: resumable up to 1h for same-task reuse -> 1h tail.
    return { tools: 'none', system: '1h', tier3: '1h', messages: '1h' };
}

/**
 * Build provider-specific sendOpts.
 *
 * @param {string} provider
 * @param {string} [sessionId]
 * @param {string} [role]
 * @returns {object} partial sendOpts — spread into provider.send call
 */

// Provider cache capability kinds:
//   'explicit-breakpoint' — explicit provider-side cache_control writes
//   'key-prefix'          — provider-managed shard keyed by cache key/session
//   'managed-explicit'    — provider object creates/attaches explicit caches
//   'implicit-observed'   — cache hits are observable but not guaranteed warm
//   'none'                — no API-level cache knob/metric
const PROVIDER_CACHE_CAPABILITY = Object.freeze({
    'anthropic':       'explicit-breakpoint',
    'anthropic-oauth': 'explicit-breakpoint',
    'openai':          'key-prefix',
    'openai-oauth':    'key-prefix',
    'xai':             'key-prefix',
    'grok-oauth':      'key-prefix',
    'gemini':          'managed-explicit',
    'deepseek':        'implicit-observed',
    'opencode-go':     'implicit-observed',
});

export function cacheCapabilityForProvider(provider) {
    return PROVIDER_CACHE_CAPABILITY[provider] || 'none';
}

export function shouldMarkWarmForProvider(provider) {
    const capability = cacheCapabilityForProvider(provider);
    return capability === 'explicit-breakpoint'
        || capability === 'key-prefix'
        || capability === 'managed-explicit';
}

export function shouldRecordObservedForProvider(provider) {
    return cacheCapabilityForProvider(provider) === 'implicit-observed';
}

// Stable per-provider shared prompt-cache key. key-prefix providers MUST land on
// a cross-session shard, so the resolver below NEVER falls back to sessionId
// (which isolates each session into its own bucket and forces a cold start).
// Generalizes the xai pattern ('mixdog-xai') that already defaulted to a shared
// key. Anthropic/Gemini use content-keyed cache_control / explicit CachedContent
// and do not consult this map.
const PROVIDER_CACHE_KEY_DEFAULT = Object.freeze({
    'openai':       'mixdog-openai',
    'openai-oauth': 'mixdog-codex',
    'xai':          'mixdog-xai',
    'grok-oauth':   'mixdog-xai',
});

/**
 * Resolve the server-side prompt-cache grouping key (prompt_cache_key) for a
 * key-prefix provider. Precedence: explicit provider key > prompt key >
 * session-scoped prompt key > stable shared default. Invariant: always returns a
 * non-empty stable key, and deliberately EXCLUDES sessionId so a fresh session
 * reuses the warm shard instead of cold-starting its own bucket.
 *
 * This is the CACHE key only. The socket poolKey stays sessionId-scoped at each
 * call site to avoid cross-session socket/delta-state reuse.
 */
export function resolveProviderCacheKey(opts, provider) {
    return opts?.providerCacheKey
        || opts?.promptCacheKey
        || opts?.session?.promptCacheKey
        || PROVIDER_CACHE_KEY_DEFAULT[provider]
        || 'mixdog-shared';
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',') + '}';
}

function shortHash(value, chars = 18) {
    return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, chars);
}

function positiveInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizePromptCacheNamespace(value) {
    const s = String(value || '').trim() || 'mixdog-shared';
    // Keep the key boring for OpenAI/Codex's 64-char prompt_cache_key cap while
    // preserving user overrides as much as possible.
    return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mixdog-shared';
}

function summarizePromptCacheTools(tools) {
    return (tools || []).map(t => ({
        type: cleanString(t?.type) || 'function',
        name: cleanString(t?.name || t?.function?.name),
        description: cleanString(t?.description || t?.function?.description),
        parameters: t?.parameters || t?.inputSchema || t?.function?.parameters || null,
    }));
}

/**
 * Build a stable, prefix-scoped prompt_cache_key for OpenAI-style key-prefix
 * providers. The base namespace still comes from resolveProviderCacheKey()
 * (so overrides keep working), but a model/system/tools hash is appended so
 * unrelated main/worker prefixes do not evict each other inside one shared
 * provider lane.
 */
export function buildStableProviderPromptCacheKey(provider, opts, prefix = {}) {
    const namespace = normalizePromptCacheNamespace(resolveProviderCacheKey(opts, provider));
    const rawShards = prefix.cacheLaneShards ?? opts?.promptCacheLane?.shards ?? opts?.cacheLaneShards;
    const rawShardMode = String(rawShards ?? '').trim().toLowerCase();
    const autoLane = prefix.cacheLaneAuto === true
        || opts?.promptCacheLane?.auto === true
        || rawShards === 0
        || ['auto', 'unbounded', 'unlimited', 'none', 'off'].includes(rawShardMode);
    const shardCount = autoLane ? 0 : positiveInt(rawShards, 1);
    const rawSlot = nonNegativeInt(prefix.cacheLaneSlot ?? opts?.promptCacheLane?.slot ?? opts?.cacheLaneSlot, 0);
    const shardSlot = autoLane
        ? rawSlot
        : Math.max(0, Math.min(rawSlot, Math.max(0, shardCount - 1)));
    const laneEnabled = autoLane || shardCount > 1;
    const laneSuffix = laneEnabled ? `-s${shardSlot.toString(36).padStart(2, '0')}` : '';
    const seed = {
        provider: cleanString(provider),
        model: cleanString(prefix.model),
        instructions: cleanString(prefix.instructions),
        tools: summarizePromptCacheTools(prefix.tools),
        effort: cleanString(prefix.effort ?? opts?.effort),
        fast: prefix.fast === true || opts?.fast === true,
        serviceTier: cleanString(prefix.serviceTier),
        toolChoice: cleanString(prefix.toolChoice),
        parallelToolCalls: prefix.parallelToolCalls === false ? false : true,
        cacheLaneSlot: laneEnabled ? shardSlot : null,
        cacheLaneShards: autoLane ? 'auto' : shardCount > 1 ? shardCount : null,
    };
    const hash = shortHash(seed);
    const head = namespace.slice(0, Math.max(1, 64 - hash.length - laneSuffix.length - 1));
    return `${head}-${hash}${laneSuffix}`;
}

function providerEnvKey(provider) {
    return String(provider || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

const providerPromptCacheLaneAssignments = new Map();
const PROVIDER_PROMPT_CACHE_LANE_MAX_ASSIGNMENTS = 4096;
const DEFAULT_PROVIDER_PROMPT_CACHE_LANE_SHARDS = 12;

function promptCacheLaneGroupKey(provider, opts) {
    return [
        cleanString(provider),
        normalizePromptCacheNamespace(resolveProviderCacheKey(opts, provider)),
    ].join('\0');
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

function parsePromptCacheLaneLimit(raw, fallback = DEFAULT_PROVIDER_PROMPT_CACHE_LANE_SHARDS) {
    if (raw === null || raw === undefined || raw === '') return fallback;
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

/**
 * Resolve a stable cache-lane slot for OpenAI-style prompt cache sharding.
 * The shard count is the maximum same-prefix parallelism; each final shard key
 * is still internally queued and rate-shaped by the transport for stable server
 * cache hits. OpenAI's prompt caching guide says one prefix+prompt_cache_key
 * combination can overflow around 15 RPM, so transport owns that timing gate.
 * Default to the safer 12-lane pool. Explicit 0/auto/unbounded keeps the
 * no-cap execution mode for callers that prefer throughput over stricter
 * same-key serialization.
 */
export function resolveProviderPromptCacheLane(provider, opts = {}, config = {}) {
    const envKey = providerEnvKey(provider);
    const env = process.env;
    const requestedAuto = promptCacheLaneAutoRequested(opts?.promptCacheLaneAuto)
            || promptCacheLaneAutoRequested(opts?.openaiCacheLaneAuto)
            || promptCacheLaneAutoRequested(opts?.promptCacheLane?.auto)
            || promptCacheLaneAutoRequested(config?.promptCacheLaneAuto)
            || promptCacheLaneAutoRequested(config?.openaiCacheLaneAuto);
    const rawLimit = requestedAuto
        ? 'auto'
        : (opts?.promptCacheLaneShards
            ?? opts?.promptCacheLane?.shards
            ?? opts?.openaiCacheLaneShards
            ?? opts?.openaiCacheMaxParallel
            ?? config?.promptCacheLaneShards
            ?? config?.openaiCacheLaneShards
            ?? config?.openaiCacheMaxParallel
            ?? env[`MIXDOG_${envKey}_CACHE_LANE_SHARDS`]
            ?? env[`MIXDOG_${envKey}_CACHE_MAX_PARALLEL`]
            ?? env.MIXDOG_OPENAI_CACHE_LANE_SHARDS
            ?? env.MIXDOG_OPENAI_CACHE_MAX_PARALLEL);
    const shards = parsePromptCacheLaneLimit(rawLimit, DEFAULT_PROVIDER_PROMPT_CACHE_LANE_SHARDS);
    const auto = shards <= 0;
    const seed = cleanString(
        opts?.promptCacheLaneSeed
            ?? opts?.sessionId
            ?? opts?.session?.id
            ?? opts?.providerCacheKey
            ?? opts?.promptCacheKey
            ?? provider
            ?? 'mixdog',
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

export function buildProviderCacheOpts(provider, sessionId, role) {
    const ttls = resolveCacheStrategy(role);
    const capability = cacheCapabilityForProvider(provider);
    if (capability === 'explicit-breakpoint') {
        // 2026-03-06 Anthropic dropped default TTL 1h→5m. We send
        // extended-cache-ttl-2025-04-11 header to retain 1h.
        // Verified 2026-04-17 (ephemeral_1h_input_tokens=4722).
        return { cacheStrategy: ttls };
    }
    if (provider === 'openai') {
        // Public OpenAI API: prompt_cache_retention extends prefix retention.
        // openai-oauth (Codex) rejects the header — falls through to default.
        return { cacheRetention: '24h' };
    }
    return {};
}

/**
 * Prefix content used to derive the cache hash for registry tracking.
 * Excludes the volatile user message — only the stable prefix (tools,
 * system) determines whether our cache is "still warm". The Pool B prefix
 * is workspace-wide, so a single hash represents every Pool B caller.
 *
 * `systemPrompt` is an array of system-role message contents in their send
 * order (BP1 / BP2 / ...), serialized deterministically as a JSON array.
 * Invariant: callers must pass an array.
 */
export function computePrefixContent(systemPrompt, tools) {
    const systemMessages = Array.isArray(systemPrompt)
        ? systemPrompt.map(s => s == null ? '' : String(s))
        : [systemPrompt == null ? '' : String(systemPrompt)];
    return {
        systemPrompt: JSON.stringify(systemMessages),
        tools: (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    };
}

/**
 * Longest-lived layer TTL (seconds) for registry expiry tracking.
 */
export function ttlSecondsForCache(role) {
    const ttls = resolveCacheStrategy(role);
    if (
        ttls.tools === 'none'
        && ttls.system === 'none'
        && ttls.tier3 === 'none'
        && ttls.messages === 'none'
    ) {
        return 0;
    }
    return Math.max(
        ttlToSeconds(ttls.tools),
        ttlToSeconds(ttls.system),
        ttlToSeconds(ttls.tier3),
        ttlToSeconds(ttls.messages),
    );
}

// --- Helpers ---

function ttlToSeconds(v) {
    if (v === '24h') return 86400;
    if (v === '1h') return 3600;
    if (v === '5m') return 300;
    return 0;
}
