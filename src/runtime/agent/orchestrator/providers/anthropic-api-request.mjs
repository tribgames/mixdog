/**
 * anthropic-api-request.mjs — the exact wire request one API-key Anthropic
 * turn sends: the system/cache-breakpoint layout, the message-tail cache
 * budget, the tool list and tool_choice, the effort projection with its
 * history lowering, fast-mode speed, prepared image bytes, and the
 * per-request anthropic-beta header set derived from that final body.
 *
 * Transport, mid-stream recovery and usage accounting live elsewhere
 * (anthropic-api-transport.mjs, anthropic-api-recovery.mjs,
 * anthropic-turn-result.mjs); nothing here touches the socket.
 */
import { prepareAnthropicImages } from './lib/anthropic-image-input.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { applyAnthropicServerFallback } from './anthropic-server-fallback.mjs';
import { fastModeAvailable } from './anthropic-fast-mode.mjs';
import { applyAnthropicEffortToBody, shouldIncludeEffortBeta } from './anthropic-effort.mjs';
import {
  applyAnthropicCacheMarkers,
  clampAnthropicThinkingBudget as clampThinkingBudgetTokens,
  resolveAnthropicCacheTtls as resolveCacheTtls,
  resolveAnthropicMessageCacheSlots,
  toAnthropicToolChoice,
} from './lib/anthropic-request-utils.mjs';
import {
  buildSystemBlocks,
  resolveMaxTokens,
  requestAnthropicTools,
  toAnthropicMessages,
} from './anthropic-messages.mjs';
import {
  EFFORT_CONFIGURATION_BETA,
  projectEffortConfiguration,
  lowerAnthropicEffortHistory,
} from './effort-configuration.mjs';

/**
 * @param {object} deps
 * @param {string} deps.name  provider instance name (effort projection key + log tag)
 * @param {object} deps.config  provider config (beta opt-out, baseURL, extra headers)
 * @param {Array<object>} deps.messages  turn history, already tool-pair sanitized
 * @param {string} deps.useModel
 * @param {Array<object>|undefined} deps.tools
 * @param {object} deps.opts  send options
 * @param {boolean} deps.fastModeLatched  the provider's sticky fast-mode beta latch
 * @returns {Promise<{ params: object, requestHeaders: object|null, knownToolNames: Set<string>, fastModeLatched: boolean }>}
 */
export async function buildAnthropicApiRequest({ name, config, messages, useModel, tools, opts, fastModeLatched }) {
  const maxTokens = resolveMaxTokens(useModel);
  const effortProjection = projectEffortConfiguration(messages, name, useModel, {
    ...config,
    ...opts,
    disableBetaHeaders: config?.disableBetaHeaders,
  });
  const ttls = resolveCacheTtls(opts);

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  // BP1 baseRules + BP2 stableSystem at ttls.system; BP3 sessionMarker
  // (cacheTier:'tier3') at ttls.tier3 — each its own system content block.
  const systemBlocks = buildSystemBlocks(systemMsgs, ttls.system, ttls.tier3);

  // Message-tail cache budget (4-BP layout + ANTHROPIC_MSG_SLOTS) is
  // shared with anthropic-oauth — see resolveAnthropicMessageCacheSlots.
  const messageCacheSlots = resolveAnthropicMessageCacheSlots(systemBlocks, ttls);
  // Tools are resolved BEFORE the messages: the lowering needs the final
  // tool list to drop tool_reference blocks whose tool no longer ships
  // in this request (otherwise the API rejects the whole turn).
  const requestTools = requestAnthropicTools(tools, chatMsgs, opts);
  // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers
  // are applied to the FINAL sanitized array by invariant, so block
  // drops / inserts / reorders performed by the sanitizer can never move
  // or delete a marked block. NEVER sanitize again after this.
  const anthropicMessages = applyAnthropicCacheMarkers(
    lowerAnthropicEffortHistory(chatMsgs, (segment) => toAnthropicMessages(segment, requestTools), effortProjection),
    messageCacheSlots
  );

  const params = {
    model: useModel,
    max_tokens: maxTokens,
    system: systemBlocks.length ? systemBlocks : undefined,
    messages: await prepareAnthropicImages(anthropicMessages, { signal: opts.signal }),
  };
  applyAnthropicServerFallback(params, useModel, {
    enabled: config?.disableBetaHeaders !== true && opts.serverFallback !== false,
  });
  if (requestTools.length) {
    // No cache_control on tools — the system BP covers tools via
    // Anthropic prefix semantics (order: tools → system → messages).
    params.tools = requestTools;
  }
  // tool_choice only when tools are actually present (Anthropic rejects
  // tool_choice without tools). 'none' rides the hard-cap final turn to
  // forbid tool USE while keeping the tools prefix stable for cache reuse.
  if (params.tools) {
    const toolChoice = toAnthropicToolChoice(opts.toolChoice);
    if (toolChoice) params.tool_choice = toolChoice;
  }
  const hasDeferredTools = Array.isArray(params.tools) && params.tools.some((tool) => tool?.defer_loading === true);
  // Known tool names for the shared parseSSEStream leaked-tool-call guard
  // (same guard fixes both Anthropic providers). Recovered leaked calls
  // are only synthesized when they name a tool actually offered here.
  const knownToolNames = new Set(
    (Array.isArray(params.tools) ? params.tools : [])
      .map((t) => (t && typeof t.name === 'string' ? t.name : null))
      .filter(Boolean)
  );
  applyAnthropicEffortToBody(params, {
    model: useModel,
    opts: effortProjection ? { ...opts, effort: effortProjection.initialEffort } : opts,
    maxTokens,
    clampThinkingBudgetTokens,
    logTag: name,
  });
  // Fast mode → speed: "fast" on models Anthropic marks as speed-capable.
  // Suppressed while the fast capacity pool is cooling down.
  let fastLatched = fastModeLatched;
  if (opts.fast === true && supportsAnthropicFastMode(useModel) && fastModeAvailable()) {
    params.speed = 'fast';
    fastLatched = true;
  }
  // NOTE: do NOT sanitize here. params.messages was already sanitized
  // once inside toAnthropicMessages and then had cache markers applied.
  // Re-sanitizing after marking could drop/reorder a marked block and
  // move the provider-visible cache breakpoint off the cached one — the
  // exact COLD-turn bug this change fixes. Order: build → sanitize
  // (once) → mark → prepare image bytes → send.
  params.stream = true;

  // Per-call headers override the client defaultHeaders, so the
  // constructor-level disableBetaHeaders opt-out must be honoured here
  // too — otherwise opencode-go's anthropic-compatible routing
  // (disableBetaHeaders:true) would still send beta strings that a
  // third-party endpoint may reject.
  let betaHeaders = null;
  if (!config?.disableBetaHeaders) {
    const betas = [
      buildAnthropicBetaHeaders({
        fastMode: fastLatched,
        toolSearch: hasDeferredTools,
        effort: shouldIncludeEffortBeta(useModel, opts),
        serverFallback: params.fallbacks === 'default',
      }),
      ...(effortProjection ? [EFFORT_CONFIGURATION_BETA] : []),
    ];
    betaHeaders = { 'anthropic-beta': betas.join(',') };
  }
  const requestHeaders =
    betaHeaders || opts.requestHeaders ? { ...(betaHeaders || {}), ...(opts.requestHeaders || {}) } : null;

  return { params, requestHeaders, knownToolNames, fastModeLatched: fastLatched };
}
