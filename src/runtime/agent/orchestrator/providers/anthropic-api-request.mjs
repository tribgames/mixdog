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
import {
  anthropicPrefixFingerprint,
  anthropicPrefixSessionId,
  recordAnthropicPrefix,
} from './lib/anthropic-prefix-trace.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { applyAnthropicServerFallback } from './anthropic-server-fallback.mjs';
import { fastModeAvailable } from './anthropic-fast-mode.mjs';
import { applyAnthropicEffortToBody, shouldIncludeEffortBeta } from './anthropic-effort.mjs';
import { isCustomProviderName, resolveCustomReasoning } from './custom-reasoning.mjs';
import {
  anthropicThinkingActive,
  anthropicTurnScopedReminders,
  appendAnthropicTailReminder,
  appendAnthropicTurnReminder,
  applyAnthropicCacheMarkers,
  clampAnthropicThinkingBudget as clampThinkingBudgetTokens,
  hasAnthropicTurnScopedMessages,
  resolveAnthropicCacheTtls as resolveCacheTtls,
  resolveAnthropicMessageCacheSlots,
  sharedCachePrefixBoundary,
  toAnthropicToolChoice,
  withAnthropicTurnReminders,
} from './lib/anthropic-request-utils.mjs';
import { splitTailReminder } from './lib/tail-reminder-split.mjs';
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
export async function buildAnthropicApiRequest({
  name,
  config,
  messages: requestMessages,
  useModel,
  tools,
  opts,
  fastModeLatched,
  modelInfo = null,
  // The Claude id a gateway slug stands for (OpenRouter `anthropic/claude-opus-4.8`
  // → `claude-opus-4.8`): the output cap and the thinking/effort shape are read
  // from it, while the wire still names `useModel`.
  capabilityModel = useModel,
  // A gateway-supplied output limit for the model; wins over the Anthropic catalog.
  modelMaxOutputTokens = opts?.modelMaxOutputTokens ?? null,
}) {
  // A user-defined provider's reasoning comes from its own model row only:
  // the global by-model-id capability index and the Claude-id ladders are
  // first-party knowledge and must not leak onto (or from) a custom endpoint.
  const isCustom = isCustomProviderName(name);
  const { messages, reminder } = splitTailReminder(requestMessages);
  const maxTokens = resolveMaxTokens(capabilityModel, {
    modelMaxOutputTokens,
    override: opts?.maxOutputTokensOverride,
  });
  const effortOptions = { ...config, ...opts, disableBetaHeaders: config?.disableBetaHeaders };
  const gatewayEffort = typeof config?.messagesEffort === 'function' ? config.messagesEffort(opts) : null;
  const effortProjection = projectEffortConfiguration(messages, name, useModel, effortOptions);
  const ttls = resolveCacheTtls(opts);

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  // BP1 baseRules + BP2 stableSystem at ttls.system; BP3 sessionMarker
  // (cacheTier:'tier3') at ttls.tier3 — each its own system content block.
  const systemBlocks = buildSystemBlocks(systemMsgs, ttls.system, ttls.tier3);

  // Tools are resolved BEFORE the messages: the lowering needs the final
  // tool list to drop tool_reference blocks whose tool no longer ships
  // in this request (otherwise the API rejects the whole turn).
  const requestTools = requestAnthropicTools(tools, chatMsgs, opts, name, config);
  // Message-tail cache budget (4-BP layout + ANTHROPIC_MSG_SLOTS) is
  // shared with anthropic-oauth — see resolveAnthropicMessageCacheSlots.
  const messageCacheSlots = resolveAnthropicMessageCacheSlots(systemBlocks, ttls, { tools: requestTools });
  // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers
  // are applied to the FINAL sanitized array by invariant, so block
  // drops / inserts / reorders performed by the sanitizer can never move
  // or delete a marked block. NEVER sanitize again after this.
  // Turn-scoped tail reminders (tail-reminder-split.mjs): stored reminders are
  // re-sent before their assistant turns, the current one ends the request.
  const turnScoped = anthropicTurnScopedReminders(name, useModel, config);
  const lowerHistory = (history, projection) => {
    const lowered = lowerAnthropicEffortHistory(
      history.filter((m) => m.role !== 'system'),
      (segment) => toAnthropicMessages(segment, requestTools, name),
      projection
    );
    return turnScoped ? withAnthropicTurnReminders(lowered) : lowered;
  };
  const anthropicMessages = applyAnthropicCacheMarkers(
    lowerHistory(chatMsgs, effortProjection),
    messageCacheSlots,
    sharedCachePrefixBoundary(messages, opts, (prefix) =>
      lowerHistory(prefix, projectEffortConfiguration(prefix, name, useModel, effortOptions))
    )
  );

  const params = {
    model: useModel,
    max_tokens: maxTokens,
    system: systemBlocks.length ? systemBlocks : undefined,
    messages: await prepareAnthropicImages(
      turnScoped
        ? appendAnthropicTurnReminder(anthropicMessages, reminder)
        : appendAnthropicTailReminder(anthropicMessages, reminder),
      { signal: opts.signal }
    ),
  };
  // Server-side fallback and fast mode are decided from Claude model ids:
  // first-party knowledge, never applied to a custom endpoint.
  applyAnthropicServerFallback(params, useModel, {
    enabled: !isCustom && config?.disableBetaHeaders !== true && opts.serverFallback !== false,
  });
  if (requestTools.length) {
    // No cache_control on tools — the system BP covers tools via
    // Anthropic prefix semantics (order: tools → system → messages).
    params.tools = requestTools;
  }
  // tool_choice only when tools are actually present (Anthropic rejects
  // tool_choice without tools). 'none' rides the hard-cap final turn to
  // forbid tool USE while keeping the tools prefix stable for cache reuse.
  // The key is reserved here (wire key order) and resolved once thinking is
  // known: forced any/tool is invalid while thinking is enabled.
  if (params.tools) params.tool_choice = undefined;
  const hasDeferredTools = Array.isArray(params.tools) && params.tools.some((tool) => tool?.defer_loading === true);
  // Known tool names for the shared parseSSEStream leaked-tool-call guard
  // (same guard fixes both Anthropic providers). Recovered leaked calls
  // are only synthesized when they name a tool actually offered here.
  const knownToolNames = new Set(
    (Array.isArray(params.tools) ? params.tools : [])
      .map((t) => (t && typeof t.name === 'string' ? t.name : null))
      .filter(Boolean)
  );
  applyRequestReasoning(params, {
    isCustom,
    name,
    config,
    opts,
    modelInfo,
    capabilityModel,
    maxTokens,
    gatewayEffort,
    effortProjection,
  });
  if (params.tools) resolveRequestToolChoice(params, opts, config);
  // Fast mode → speed: "fast" on models Anthropic marks as speed-capable.
  // Suppressed while the fast capacity pool is cooling down.
  let fastLatched = fastModeLatched;
  if (!isCustom && opts.fast === true && supportsAnthropicFastMode(useModel) && fastModeAvailable()) {
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
  // Diagnostic: per-block prefix hashes of exactly what is sent.
  recordAnthropicPrefix(anthropicPrefixSessionId(opts), anthropicPrefixFingerprint(params));

  const betas = requestBetasFor(params, {
    opts,
    isCustom,
    fastLatched,
    hasDeferredTools,
    capabilityModel,
    effortProjection,
  });
  const requestHeaders = requestHeadersFor(betas, { config, opts });

  // `betas`: the selected beta names, whether or not this route sends them as a header.
  return { params, requestHeaders, betas, knownToolNames, fastModeLatched: fastLatched };
}

/** The turn's thinking/effort fields on `params` (in place): a custom
 *  provider's from its own model row, else the turn effort (or a gateway's
 *  own `messagesEffort`; 'none' sends no thinking at all). */
function applyRequestReasoning(
  params,
  { isCustom, name, config, opts, modelInfo, capabilityModel, maxTokens, gatewayEffort, effortProjection }
) {
  if (isCustom) {
    const { fields } = resolveCustomReasoning({
      protocol: 'anthropic',
      model: modelInfo,
      effort: opts.effort ?? config?.reasoningEffort,
    });
    if (fields.thinking) params.thinking = fields.thinking;
    if (fields.output_config) params.output_config = { ...(params.output_config || {}), ...fields.output_config };
  } else if (gatewayEffort !== 'none') {
    // A gateway's own reasoning control (`messagesEffort`) replaces the turn
    // effort; 'none' sends no thinking at all.
    const turnOpts = effortProjection ? { ...opts, effort: effortProjection.initialEffort } : opts;
    applyAnthropicEffortToBody(params, {
      model: capabilityModel,
      opts: gatewayEffort ? { ...turnOpts, effort: gatewayEffort } : turnOpts,
      maxTokens,
      clampThinkingBudgetTokens,
      logTag: name,
      progressUpdates: config?.disableBetaHeaders !== true,
    });
  }
}

/** The reserved `tool_choice` of a request with tools, resolved once
 *  thinking is known (forced any/tool is invalid while thinking is on);
 *  dropped when none applies. */
function resolveRequestToolChoice(params, opts, config) {
  const toolChoice = toAnthropicToolChoice(opts.toolChoice, {
    thinking: anthropicThinkingActive(params),
    disableParallelToolUse: opts.disableParallelToolUse === true,
    // A gateway that cannot honour disable_parallel_tool_use declares so.
    supportsDisableParallelToolUse: config?.supportsDisableParallelToolUse !== false,
    onThinkingConflict: opts.toolChoiceThinkingConflict,
  });
  if (toolChoice) params.tool_choice = toolChoice;
  else delete params.tool_choice;
}

/** The anthropic-beta names the final body `params` needs. A custom endpoint
 *  gets no first-party base betas; only those its own request body needs
 *  (row-driven effort, deferred tools). */
function requestBetasFor(params, { opts, isCustom, fastLatched, hasDeferredTools, capabilityModel, effortProjection }) {
  return [
    buildAnthropicBetaHeaders({
      ...(isCustom ? { base: '' } : {}),
      fastMode: fastLatched,
      toolSearch: hasDeferredTools,
      // Custom: the beta follows the resolver's output, not the model id.
      effort: isCustom ? Boolean(params.output_config?.effort) : shouldIncludeEffortBeta(capabilityModel, opts),
      serverFallback: params.fallbacks === 'default',
      thinkingDisplayUpdates: params.thinking?.display === 'updates',
      turnScopedSystem: hasAnthropicTurnScopedMessages(params.messages),
    }),
    ...(effortProjection ? [EFFORT_CONFIGURATION_BETA] : []),
  ]
    .join(',')
    .split(',')
    .filter(Boolean);
}

/** The per-request headers: the anthropic-beta header of `betas`, then the
 *  caller's `opts.requestHeaders`; null when none. */
function requestHeadersFor(betas, { config, opts }) {
  // Per-call headers override the client defaultHeaders, so the
  // constructor-level disableBetaHeaders opt-out must be honoured here
  // too — otherwise opencode-go's anthropic-compatible routing
  // (disableBetaHeaders:true) would still send beta strings that a
  // third-party endpoint may reject.
  const betaHeaders = !config?.disableBetaHeaders && betas.length ? { 'anthropic-beta': betas.join(',') } : null;
  return betaHeaders || opts.requestHeaders ? { ...(betaHeaders || {}), ...(opts.requestHeaders || {}) } : null;
}
