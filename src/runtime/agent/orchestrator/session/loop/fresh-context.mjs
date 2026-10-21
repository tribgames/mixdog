// Rule-first compaction. Only conversation pressure can request an AI summary;
// tool history, skills and protected context follow deterministic rules.
import { loadConfig } from '../../config.mjs';
import { getProvider, initProviders } from '../../providers/registry.mjs';
import { resolveMaintenanceRoute } from '../../agent-runtime/maintenance-route.mjs';
import { resolveSessionContextMeta } from '../manager/context-meta.mjs';
import { isAccountQuotaError } from '../../providers/account-pool.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { estimateMessagesTokens, providerTokenCalibration } from '../context-utils.mjs';
import {
  conversationCompactionInput,
  freshContextCompactMessages,
  generateFreshHandoffSummary,
  SUMMARY_OUTPUT_TOKENS,
  COMPACT_TARGET_MIN_TOKENS,
} from '../compact.mjs';
import { summarizeOnSharedPrefix } from '../compact/forked-summary.mjs';
import { normalizeCompactionSummaryMode } from '../compact/summary-mode.mjs';
import { compactionCacheWarm, lighterSubscriptionModel } from '../compact/summary-route.mjs';
import { retireCompactionFork } from '../side-question-store.mjs';

// Conversation summarization triggers independently of the post-compact target:
// at 5% of the window, capped so a large window does not carry tens of
// thousands of tokens of verbatim dialogue through every Compact.
const CONVERSATION_COMPACT_TRIGGER_RATIO = 0.05;
const CONVERSATION_COMPACT_TRIGGER_MAX_TOKENS = 20_000;

// One summary route: the provider, its model and the window the summary
// request must fit. `source` names the step: 'session' (the conversation's
// own model), 'maintenance' (the Maintainer) or 'lighter' (the subscription
// provider's lighter model).
function summaryRoute({ sessionRef, provider, providerName, model, fast, source }) {
  if (!provider || typeof provider.send !== 'function' || !model) {
    throw new Error(`compact summary route unavailable: ${providerName || 'unknown'}/${model || 'unknown'}`);
  }
  const sameModel = providerName === sessionRef?.provider && model === sessionRef?.model;
  const contextWindow =
    sameModel && positiveInt(sessionRef?.contextWindow)
      ? positiveInt(sessionRef.contextWindow)
      : resolveSessionContextMeta(provider, model, {}, { wholeWindow: true }).contextWindow;
  return { provider, providerName, model, contextWindow, fast, source };
}

// The Maintainer's own model when one is set and enabled, whatever the memory
// or recap settings; null otherwise (an unrelated global default is never
// borrowed). Provider failures/cancellation are not absence and propagate.
async function resolveMaintainerRoute({ sessionRef, config, signal, getProviderFn, initProvidersFn }) {
  const route = resolveMaintenanceRoute({ agent: 'cycle1-agent', config, includeDefault: false });
  if (!(route?.provider && route?.model && config.providers?.[route.provider]?.enabled !== false)) return null;
  await initProvidersFn(config.providers || {}, { signal });
  signal?.throwIfAborted();
  return summaryRoute({
    sessionRef,
    provider: getProviderFn(route.provider),
    providerName: route.provider,
    model: route.model,
    fast: route.fast === true,
    source: 'maintenance',
  });
}

function resolveSessionRoute({ sessionRef, provider, model, getProviderFn }) {
  const providerName = sessionRef?.provider || provider?.name;
  return summaryRoute({
    sessionRef,
    provider: provider || getProviderFn(providerName),
    providerName,
    model: model || sessionRef?.model,
    source: 'session',
  });
}

// The newest lighter model of a subscription provider's saved account
// catalog; null on any other provider, without a saved catalog, when none is
// listed, or when the conversation already runs on it.
async function resolveLighterRoute(input) {
  const session = resolveSessionRoute(input);
  const lighter = await lighterSubscriptionModel(session.providerName);
  input.signal?.throwIfAborted();
  if (!lighter || lighter === session.model) return null;
  return summaryRoute({
    sessionRef: input.sessionRef,
    provider: session.provider,
    providerName: session.providerName,
    model: lighter,
    source: 'lighter',
  });
}

/**
 * The compaction summary plan (compact/summary-mode.mjs): the saved mode,
 * whether the session's prompt cache is warm, and the routes in the order
 * they are tried, each resolved only when reached (null = unavailable, the
 * next one runs). The conversation's own model is always the last step.
 */
export function compactionSummaryPlan({
  sessionRef,
  sessionId = sessionRef?.id,
  provider,
  model,
  config = loadConfig(),
  signal,
  getProviderFn = getProvider,
  initProvidersFn = initProviders,
  now = Date.now(),
} = {}) {
  signal?.throwIfAborted();
  const input = { sessionRef, provider, model, config, signal, getProviderFn, initProvidersFn };
  const mode = normalizeCompactionSummaryMode(config.compaction);
  const warm = compactionCacheWarm(sessionId, now);
  const session = async () => resolveSessionRoute(input);
  const maintainer = () => resolveMaintainerRoute(input);
  const lighter = () => resolveLighterRoute(input);
  let steps = [session];
  if (mode === 'maintainer') steps = [maintainer, session];
  else if (mode === 'smart' && !warm) steps = [maintainer, lighter, session];
  return { mode, warm, steps };
}

// The summary request on one route: the conversation alone (earlier summary
// and dialogue; tool output, skills and injections excluded), never the
// cached context. Its input budget belongs to its OWN model, split into
// batches when the conversation is larger, whereas the rebuilt conversation
// must fit the original session's target/window.
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
    // Usage attribution: background sessions stay background.
    sourceType: sessionRef?.sourceType,
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

function sumUsage(a, b) {
  if (!a || !b) return a || b || null;
  return Object.fromEntries(Object.keys(a).map((key) => [key, (a[key] || 0) + (Number(b[key]) || 0)]));
}

// The summary on one route. While the session's prompt cache is warm, the
// summary forks the latest cached request on the conversation's own model
// (compact/forked-summary.mjs): reading the cached context costs a tenth to a
// twentieth of sending the text-only transcript uncached, and the summary
// sees the full execution context. A cold cache would be rewritten in full,
// so the isolated text-only request runs instead; so does any other route
// (a cache is never shared across models). A fork that cannot run or fails
// falls back to the isolated request on the same route.
async function summarizeOnRoute(route, ctx, warm) {
  const shared = warm
    ? await summarizeOnSharedPrefix({
        sessionId: ctx.sessionId,
        route,
        conversationInput: ctx.conversationInput,
        signal: ctx.signal,
        timeoutMs: ctx.compactPolicy.handoffTimeoutMs,
      })
    : { fallback: 'cold_cache' };
  if (shared.generated) return shared.generated;
  ctx.signal?.throwIfAborted();
  const generated = await summarizeConversation(route, ctx);
  return {
    ...generated,
    usage: sumUsage(generated.usage, shared.usage),
    diagnostics: { ...generated.diagnostics, mode: 'isolated', sharedPrefixFallback: shared.fallback },
  };
}

// A Maintainer or lighter model that is out of quota or not available to the
// account must not take the whole turn down: the next route still can
// summarize. Every other compaction failure (overflow, malformed summary,
// transport) keeps its existing handling, and an aborted turn stays aborted.
function fallsToNextRoute(error) {
  const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
  return (
    error?.code === 'provider_accounts_exhausted' ||
    error?.code === 'model_not_found' ||
    status === 429 ||
    status === 404 ||
    isAccountQuotaError(error)
  );
}

// Resolving a route (provider init, catalog lookup) is part of its step: a
// quota or availability failure there moves to the next route like one from
// the summary request. The conversation's own model is the last step, so its
// failure always ends the compaction.
async function summarizeOnPlan(ctx, plan) {
  const tried = new Set();
  let failure = null;
  for (const step of plan.steps) {
    let route = null;
    try {
      route = await step();
      ctx.signal?.throwIfAborted();
      const key = route && `${route.providerName}\u0000${route.model}`;
      if (!route || tried.has(key)) continue;
      tried.add(key);
      return { route, generated: await summarizeOnRoute(route, ctx, plan.warm) };
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (route) error.compactRoute = { provider: route.providerName, model: route.model };
      if (route?.source === 'session' || !fallsToNextRoute(error)) throw error;
      failure = error;
    }
  }
  throw failure;
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
      Math.min(Math.ceil(contextWindow * CONVERSATION_COMPACT_TRIGGER_RATIO), CONVERSATION_COMPACT_TRIGGER_MAX_TOKENS)
    );
  return { contextWindow, hardBudget, conversationInput, conversationTokens, conversationThresholdTokens };
}

function freshContextBuildOptions(
  { compactPolicy = {}, sessionId, goalReminderText, activeTurn, referenceLatestAttachments },
  budget
) {
  return {
    reserveTokens: compactPolicy.reserveTokens,
    maxBudgetTokens: budget.hardBudget,
    force: true,
    contextWindow: budget.contextWindow,
    sessionId,
    latestUserPrefix: goalReminderText,
    activeTurn,
    referenceLatestAttachments: referenceLatestAttachments === true,
  };
}

// Compare like-for-like local estimates, not billed prompt tokens against a
// rebuilt local estimate. Use the actual rules, including recovery references,
// retained skills, summary framing and active-turn continuation. No AI or
// archive writes are allowed here. Unknown summary text reserves the existing
// output ceiling instead of assuming a compression ratio.
export function previewFreshContextCompaction(input) {
  const budget = freshContextBudget(input);
  const summaryTriggered = budget.conversationTokens >= budget.conversationThresholdTokens;
  const result = freshContextCompactMessages(input.messages, input.compactBudgetTokens, {
    ...freshContextBuildOptions(input, budget),
    preview: true,
    previewSummary: summaryTriggered,
  });
  const beforeTokens = estimateMessagesTokens(input.messages);
  const afterTokens = estimateMessagesTokens(result.messages) + (summaryTriggered ? SUMMARY_OUTPUT_TOKENS : 0);
  return { beforeTokens, afterTokens, reducesTokens: afterTokens < beforeTokens, summaryTriggered };
}

function buildFreshContextResult(
  { messages, compactBudgetTokens, buildOptions, requireReduction, sessionId },
  handoffText
) {
  const result = freshContextCompactMessages(messages, compactBudgetTokens, { ...buildOptions, handoffText });
  // A generated summary can differ from its prediction. Never replace the
  // original with an automatic result that is equal-sized or larger.
  if (requireReduction && estimateMessagesTokens(result.messages) >= estimateMessagesTokens(messages)) {
    return {
      ...result,
      messages,
      freshContext: false,
      skipped: true,
      diagnostics: { ...result.diagnostics, noOp: true, reason: 'no_token_reduction' },
    };
  }
  // The rewritten transcript is no longer what the saved request carried.
  if (result.freshContext) retireCompactionFork(sessionId);
  return result;
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
  requireReduction = false,
  referenceLatestAttachments = false,
} = {}) {
  const startedAt = Date.now();
  signal?.throwIfAborted();
  const { contextWindow, hardBudget, conversationInput, conversationTokens, conversationThresholdTokens } =
    freshContextBudget({ compactPolicy, sessionRef, provider, compactBudgetTokens, messages });
  const summaryTriggered = conversationTokens >= conversationThresholdTokens;
  const buildOptions = freshContextBuildOptions(
    { compactPolicy, sessionId, goalReminderText, activeTurn, referenceLatestAttachments },
    { contextWindow, hardBudget }
  );
  const build = (handoffText) =>
    buildFreshContextResult({ messages, compactBudgetTokens, buildOptions, requireReduction, sessionId }, handoffText);
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
  const plan = compactionSummaryPlan({
    sessionRef,
    sessionId,
    provider,
    model,
    config,
    signal,
    getProviderFn,
    initProvidersFn,
  });
  const { route, generated } = await summarizeOnPlan(
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
    plan
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
      summaryMode: plan.mode,
      cacheWarm: plan.warm,
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
