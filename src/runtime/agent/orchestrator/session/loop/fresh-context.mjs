// Rule-first compaction. Only conversation pressure can request an AI summary;
// tool history, skills and protected context follow deterministic rules.
import { loadConfig } from '../../config.mjs';
import { getProvider, initProviders } from '../../providers/registry.mjs';
import { resolveMaintenanceRoute } from '../../agent-runtime/maintenance-route.mjs';
import { resolveSessionContextMeta } from '../manager/context-meta.mjs';
import { isAccountQuotaError } from '../../providers/account-pool.mjs';
import { builtinFeatureActive } from '../../../../../session-runtime/builtin-features.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { estimateMessagesTokens, providerTokenCalibration } from '../context-utils.mjs';
import {
  conversationCompactionInput,
  freshContextCompactMessages,
  generateFreshHandoffSummary,
  SUMMARY_OUTPUT_TOKENS,
  COMPACT_TARGET_MIN_TOKENS,
} from '../compact.mjs';

// Conversation summarization triggers independently of the post-compact target.
const CONVERSATION_COMPACT_TRIGGER_RATIO = 0.05;

// Select an explicitly configured, enabled maintenance route only. An absent
// or disabled maintenance role falls back to the conversation's own model,
// not an unrelated global default. Provider failures/cancellation are not
// absence and must propagate without silently routing around them.
export async function resolveCompactionRoute({
  sessionRef,
  provider,
  model,
  config = loadConfig(),
  signal,
  getProviderFn = getProvider,
  initProvidersFn = initProviders,
  allowMaintenance = true,
} = {}) {
  signal?.throwIfAborted();
  const route =
    allowMaintenance && builtinFeatureActive(config, 'memory') && config.recap?.enabled !== false
      ? resolveMaintenanceRoute({ agent: 'cycle1-agent', config, includeDefault: false })
      : null;
  const useMaintenance = !!(route?.provider && route?.model && config.providers?.[route.provider]?.enabled !== false);
  const providerName = useMaintenance ? route.provider : sessionRef?.provider || provider?.name;
  const selectedModel = useMaintenance ? route.model : model || sessionRef?.model;
  if (useMaintenance) await initProvidersFn(config.providers || {}, { signal });
  signal?.throwIfAborted();
  const selectedProvider = useMaintenance ? getProviderFn(providerName) : provider || getProviderFn(providerName);
  if (!selectedProvider || typeof selectedProvider.send !== 'function' || !selectedModel) {
    throw new Error(`compact summary route unavailable: ${providerName || 'unknown'}/${selectedModel || 'unknown'}`);
  }
  const sameModel = providerName === sessionRef?.provider && selectedModel === sessionRef?.model;
  const contextWindow =
    sameModel && positiveInt(sessionRef?.contextWindow)
      ? positiveInt(sessionRef.contextWindow)
      : resolveSessionContextMeta(selectedProvider, selectedModel).contextWindow;
  return {
    provider: selectedProvider,
    providerName,
    model: selectedModel,
    contextWindow,
    fast: useMaintenance ? route.fast === true : undefined,
    source: useMaintenance ? 'maintenance' : 'session',
  };
}

// The isolated summary request on one route. Its input budget belongs to
// its OWN model, whereas the rebuilt conversation must fit the original
// session's target/window.
function summarizeConversation(target, ctx) {
  const { sessionRef, sessionId, signal, sendOpts, compactPolicy } = ctx;
  const summaryWindow = positiveInt(target.contextWindow) || ctx.contextWindow;
  const outputTokens = Math.min(SUMMARY_OUTPUT_TOKENS, Math.max(256, Math.floor(summaryWindow * 0.15)));
  const inputBudget = Math.max(
    1,
    Math.floor((summaryWindow - outputTokens) / providerTokenCalibration(target.providerName))
  );
  const summarySession = {
    id: `${sessionId || 'unknown'}:compact`,
    provider: target.providerName,
    model: target.model,
    cwd: sessionRef?.cwd,
  };
  return generateFreshHandoffSummary(
    target.provider,
    ctx.conversationInput,
    target.model,
    Math.max(ctx.compactBudgetTokens, ctx.hardBudget),
    {
      reserveTokens: compactPolicy.reserveTokens,
      compactionInputBudgetTokens: inputBudget,
      maxOutputTokens: outputTokens,
      providerName: target.providerName,
      sessionId,
      signal,
      // Never share provider conversation state or cross-provider
      // credentials with the summary request.
      sendOpts: {
        ...(target.providerName === sessionRef?.provider ? sendOpts : {}),
        session: summarySession,
      },
      fast: target.fast,
      timeoutMs: compactPolicy.handoffTimeoutMs,
      force: true,
      filterOldHistoryForIngest: true,
    }
  );
}

// A maintenance summary model that is out of quota must not take the whole
// turn down: the conversation's own model still has budget and can
// summarize. Only exhaustion reroutes — every other compaction failure
// (overflow, malformed summary, transport) keeps its existing handling, and
// an aborted turn stays aborted.
async function summarizeWithQuotaFallback(ctx, routeInput) {
  const route = await resolveCompactionRoute(routeInput);
  try {
    return { route, generated: await summarizeConversation(route, ctx) };
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
    const exhausted = error?.code === 'provider_accounts_exhausted' || status === 429 || isAccountQuotaError(error);
    const fallback =
      route.source === 'maintenance' && exhausted
        ? await resolveCompactionRoute({ ...routeInput, allowMaintenance: false })
        : null;
    if (!fallback || (fallback.providerName === route.providerName && fallback.model === route.model)) {
      error.compactRoute = { provider: route.providerName, model: route.model };
      throw error;
    }
    try {
      return { route: fallback, generated: await summarizeConversation(fallback, ctx) };
    } catch (fallbackError) {
      fallbackError.compactRoute = { provider: fallback.providerName, model: fallback.model };
      throw fallbackError;
    }
  }
}

// The window this compaction must fit (calibrated to the provider's token
// counting) and the conversation size that decides whether a model-written
// summary is needed at all.
function freshContextBudget({ compactPolicy, sessionRef, provider, compactBudgetTokens, messages }) {
  const contextWindow =
    positiveInt(compactPolicy.contextWindow) ||
    positiveInt(sessionRef?.contextWindow) ||
    positiveInt(compactPolicy.boundaryTokens) ||
    compactBudgetTokens;
  const calibration =
    Number(compactPolicy.tokenCalibration) > 0
      ? Number(compactPolicy.tokenCalibration)
      : providerTokenCalibration(sessionRef?.provider || provider?.name);
  const hardBudget = Math.max(1, Math.floor(contextWindow / calibration));
  const conversationInput = conversationCompactionInput(messages);
  const conversationTokens = Math.ceil(estimateMessagesTokens(conversationInput) * calibration);
  const conversationThresholdTokens =
    positiveInt(sessionRef?.compaction?.conversationThresholdTokens) ||
    Math.max(
      Math.min(contextWindow, COMPACT_TARGET_MIN_TOKENS),
      Math.ceil(contextWindow * CONVERSATION_COMPACT_TRIGGER_RATIO)
    );
  return { contextWindow, hardBudget, conversationInput, conversationTokens, conversationThresholdTokens };
}

export async function runFreshContextCompact({
  sessionRef,
  messages,
  compactBudgetTokens,
  compactPolicy = {},
  sessionId = sessionRef?.id,
  signal,
  provider,
  model,
  sendOpts = {},
  goalReminderText,
  activeTurn,
  config,
  getProviderFn,
  initProvidersFn,
} = {}) {
  const startedAt = Date.now();
  signal?.throwIfAborted();
  const { contextWindow, hardBudget, conversationInput, conversationTokens, conversationThresholdTokens } =
    freshContextBudget({ compactPolicy, sessionRef, provider, compactBudgetTokens, messages });
  const summaryTriggered = conversationTokens >= conversationThresholdTokens;
  const build = (handoffText) =>
    freshContextCompactMessages(messages, compactBudgetTokens, {
      reserveTokens: compactPolicy.reserveTokens,
      maxBudgetTokens: hardBudget,
      force: true,
      handoffText,
      contextWindow,
      sessionId,
      latestUserPrefix: goalReminderText,
      activeTurn,
    });
  const pipeline = {
    mode: summaryTriggered ? 'conversation-summary' : 'rules',
    conversationTokens,
    conversationThresholdTokens,
    summaryTriggered,
  };
  if (!summaryTriggered) {
    const result = build();
    signal?.throwIfAborted();
    return finishFreshResult(result, {
      usage: null,
      handoffSource: 'rules',
      route: null,
      pipeline: { ...pipeline, totalMs: Date.now() - startedAt },
    });
  }
  const { route, generated } = await summarizeWithQuotaFallback(
    {
      sessionRef,
      sessionId,
      signal,
      sendOpts,
      compactPolicy,
      compactBudgetTokens,
      hardBudget,
      contextWindow,
      conversationInput,
    },
    { sessionRef, provider, model, config, signal, getProviderFn, initProvidersFn }
  );
  signal?.throwIfAborted();
  const result = build(generated.summary);
  signal?.throwIfAborted();
  return finishFreshResult(result, {
    usage: generated.usage,
    handoffSource: 'session-local',
    route,
    pipeline: {
      ...pipeline,
      handoffSource: 'session-local',
      summaryRoute: route.source,
      summaryProvider: route.providerName,
      summaryModel: route.model,
      generated: generated.diagnostics,
      totalMs: Date.now() - startedAt,
    },
  });
}

// The compact result annotated with where its handoff came from.
function finishFreshResult(result, { usage, handoffSource, route, pipeline }) {
  result.usage = usage;
  result.handoffSource = handoffSource;
  result.summaryProvider = route ? route.providerName : null;
  result.summaryModel = route ? route.model : null;
  result.diagnostics.pipeline = pipeline;
  return result;
}
