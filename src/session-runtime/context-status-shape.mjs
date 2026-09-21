// Pure pieces of the /context gauge: the token counters read off a session,
// the request budget, the resolved usage gauge and the status record shapes.
import {
  estimateRequestReserveTokens,
  estimateToolSchemaTokens,
  providerTokenCalibration,
  resolveSessionCompactPolicy,
  summarizeContextMessages,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import {
  resolveContextTokensWithSource,
  resolveContextUsageSnapshot,
  resolveWorkerCompactPolicy,
} from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { estimateToolSchemaBreakdown } from './tool-catalog.mjs';
import { sessionContextMeasurement } from '../ui/context-measurement.mjs';

// Every session counter the cache key depends on: usage, the pressure
// baseline, and the compaction boundary.
export function sessionTokenCounters(session) {
  return {
    autoCompactTokenLimit: Number(session?.autoCompactTokenLimit || 0),
    lastContextTokens: Number(session?.lastContextTokens || 0),
    lastContextTokensUpdatedAt: Number(session?.lastContextTokensUpdatedAt || 0),
    lastContextTokensStaleAfterCompact: session?.lastContextTokensStaleAfterCompact === true,
    lastInputTokens: Number(session?.lastInputTokens || 0),
    lastUncachedInputTokens: Number(session?.lastUncachedInputTokens || 0),
    lastOutputTokens: Number(session?.lastOutputTokens || 0),
    lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
    lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
    contextPressureBaselineTokens: Number(session?.contextPressureBaselineTokens || 0),
    contextPressureBaselineOutputTokens: Number(session?.contextPressureBaselineOutputTokens || 0),
    contextPressureBaselineMessageCount: Number(session?.contextPressureBaselineMessageCount ?? -1),
    contextPressureBaselineUpdatedAt: Number(session?.contextPressureBaselineUpdatedAt || 0),
    contextPressureBaselineBoundary: session?.contextPressureBaselineBoundary || null,
    contextPressureBaselineProvider: session?.contextPressureBaselineProvider || null,
    contextPressureBaselineModel: session?.contextPressureBaselineModel || null,
    contextPressureBaselineToolSignature: session?.contextPressureBaselineToolSignature || null,
    contextPressureBaselinePrefixSignature: session?.contextPressureBaselinePrefixSignature || null,
    contextPressureBaselineSource: session?.contextPressureBaselineSource || null,
    contextPressureUnanchoredAfterRestart: session?.contextPressureUnanchoredAfterRestart === true,
    contextPressureUnanchoredReason: session?.contextPressureUnanchoredReason || null,
    totalInputTokens: Number(session?.totalInputTokens || 0),
    reasoningUsage: session?.reasoningUsage || null,
    totalUncachedInputTokens: Number(session?.totalUncachedInputTokens || 0),
    totalOutputTokens: Number(session?.totalOutputTokens || 0),
    totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
    totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
    compactBoundaryTokens: Number(session?.compactBoundaryTokens || 0),
  };
}

function sessionUsageCounters(session, lastContextTokens) {
  return {
    reasoningUsage: session?.reasoningUsage || null,
    lastInputTokens: Number(session?.lastInputTokens || 0),
    lastUncachedInputTokens: Number(session?.lastUncachedInputTokens || 0),
    lastOutputTokens: Number(session?.lastOutputTokens || 0),
    lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
    lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
    lastContextTokens,
    totalInputTokens: Number(session?.totalInputTokens || 0),
    totalUncachedInputTokens: Number(session?.totalUncachedInputTokens || 0),
    totalOutputTokens: Number(session?.totalOutputTokens || 0),
    totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
    totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
  };
}

function emptyUsageCounters() {
  return {
    reasoningUsage: null,
    lastInputTokens: 0,
    lastUncachedInputTokens: 0,
    lastOutputTokens: 0,
    lastCachedReadTokens: 0,
    lastCacheWriteTokens: 0,
    lastContextTokens: 0,
    totalInputTokens: 0,
    totalUncachedInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
}

function emptyCompactionStatus(session, policy) {
  return {
    boundaryTokens: Number(session?.compactBoundaryTokens || policy?.boundaryTokens || 0) || null,
    triggerTokens: Number(policy?.triggerTokens || 0) || null,
    // Preserve explicit 0 (main full-window buffer). `|| null` would
    // collapse a real zero buffer into "unset".
    bufferTokens: Number.isFinite(Number(policy?.bufferTokens)) ? Math.max(0, Number(policy.bufferTokens)) : null,
    bufferRatio: Number.isFinite(policy?.bufferRatio) ? policy.bufferRatio : null,
    currentEstimatedTokens: 0,
    lastApiRequestTokens: 0,
    lastApiRequestStale: false,
  };
}

/** Identity fields every status record starts with. */
function statusIdentity(session, route, env) {
  return {
    sessionId: session?.id || null,
    provider: session?.provider || route.provider,
    model: session?.model || route.model,
    cwd: env.cwd,
    toolMode: env.mode,
  };
}

// A route is not a conversation. Keep a pristine desktop/TUI task truly
// empty until the first real turn. Remote auto-start may prepare a local
// session shell containing system/tool templates, but those templates have
// not entered a provider request and must not appear as consumed context.
export function emptyContextStatus(session, route, env) {
  let emptyCompactPolicy = null;
  if (session) {
    emptyCompactPolicy = resolveWorkerCompactPolicy(session, Array.isArray(session.tools) ? session.tools : []);
  }
  const routeWindow = Math.max(
    0,
    Number(session?.compactBoundaryTokens || session?.contextWindow || route?.contextWindow || 0)
  );
  return {
    ...statusIdentity(session, route, env),
    contextWindow: routeWindow || null,
    effectiveContextWindow: routeWindow || null,
    rawContextWindow: routeWindow || null,
    effectiveContextWindowPercent: null,
    usedTokens: 0,
    usedSource: 'empty',
    measurement: sessionContextMeasurement(session, false),
    currentEstimatedTokens: 0,
    lastApiRequestTokens: 0,
    lastApiRequestStale: false,
    freeTokens: routeWindow,
    compaction: emptyCompactionStatus(session, emptyCompactPolicy),
    messages: summarizeContextMessages([]),
    request: {
      toolSchemaTokens: 0,
      toolSchemaBreakdown: {},
      requestOverheadTokens: 0,
      reserveTokens: 0,
    },
    usage: emptyUsageCounters(),
  };
}

export function requestTokenBudget(requestTools) {
  const toolSchemaTokens = estimateToolSchemaTokens(requestTools);
  const reserveTokens = estimateRequestReserveTokens(requestTools);
  return {
    toolSchemaTokens,
    toolSchemaBreakdown: estimateToolSchemaBreakdown(requestTools),
    requestOverheadTokens: Math.max(0, reserveTokens - toolSchemaTokens),
    reserveTokens,
  };
}

// The last provider-reported context size is stale once a compaction (or an
// explicit stale mark) postdates it.
function lastUsageIsStale(session, lastContextTokens) {
  if (!lastContextTokens) return false;
  const compactAt = Number(session?.compaction?.lastChangedAt || session?.compaction?.lastCompactAt || 0);
  const usageAt = Number(session?.lastContextTokensUpdatedAt || 0);
  return (
    session?.lastContextTokensStaleAfterCompact === true ||
    (compactAt > 0 && usageAt > 0 && usageAt <= compactAt) ||
    (compactAt > 0 && usageAt <= 0)
  );
}

// Use the worker policy when a boundary is available so target/reserve
// headroom, trigger, buffer tokens, and buffer ratio stay identical to the
// auto-compact decision. Fall back only for incomplete session metadata.
// Meter the same pure provider-visible projection used by pre-send
// compaction and the actual agent-loop send/baseline fingerprint.
function contextCompactPolicy(session, route, requestTools, compactBoundaryTokens) {
  const workerCompactPolicy = resolveWorkerCompactPolicy(session, requestTools);
  if (workerCompactPolicy?.boundaryTokens) return workerCompactPolicy;
  return {
    ...resolveSessionCompactPolicy(session || {}, compactBoundaryTokens),
    tokenCalibration: providerTokenCalibration(session?.provider || route.provider),
  };
}

// Window sizes, the provider's last reading, the compaction policy and the
// resolved usage gauge for one status computation.
export function contextGauge(session, route, requestTools, messages, messageSummary) {
  const rawWindow = Number(session?.rawContextWindow || session?.contextWindow || 0);
  const effectiveWindow = Number(session?.contextWindow || rawWindow || 0);
  const lastContextTokens = Number(session?.lastContextTokens || 0);
  const lastUsageStale = lastUsageIsStale(session, lastContextTokens);
  const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
  const displayWindow = compactBoundaryTokens || effectiveWindow;
  const compactPolicy = contextCompactPolicy(session, route, requestTools, compactBoundaryTokens);
  // A successful compaction publishes one durable post-mutation reading.
  // Polling and cold resume keep that exact value until a fresh provider
  // baseline or a changed transcript/route/tool surface invalidates it.
  const usageSnapshot =
    !lastContextTokens || lastUsageStale ? resolveContextUsageSnapshot(session, compactPolicy, { messages }) : null;
  // One resolution owns both the number and its provenance. Deriving the
  // label from session fields instead let a calibrated whole-transcript
  // estimate report itself as `provider`, which hid a 4x disagreement with
  // the provider's own prompt size behind a trustworthy-looking source.
  const resolvedGauge = usageSnapshot
    ? { tokens: usageSnapshot.usedTokens, source: 'post_compact' }
    : resolveContextTokensWithSource(messageSummary.estimatedTokens, compactPolicy, {
        messages,
        sessionRef: session,
      });
  const usedTokens = resolvedGauge.tokens;
  return {
    rawWindow,
    effectiveWindow,
    displayWindow,
    compactBoundaryTokens,
    compactPolicy,
    lastContextTokens,
    lastUsageStale,
    usedTokens,
    usedSource: resolvedGauge.source,
    freeTokens: displayWindow ? Math.max(0, displayWindow - usedTokens) : 0,
  };
}

function compactionStatusFor(
  session,
  { compactPolicy, compactBoundaryTokens, usedTokens, lastContextTokens, lastUsageStale }
) {
  const compactBufferTokens = Number.isFinite(Number(compactPolicy.bufferTokens))
    ? Math.max(0, Number(compactPolicy.bufferTokens))
    : 0;
  return {
    ...(session?.compaction || {}),
    boundaryTokens: compactBoundaryTokens || null,
    triggerTokens: compactPolicy.triggerTokens || null,
    bufferTokens: Number.isFinite(compactBufferTokens) ? compactBufferTokens : null,
    bufferRatio: Number.isFinite(compactPolicy.bufferRatio) ? compactPolicy.bufferRatio : null,
    currentEstimatedTokens: usedTokens,
    pressureTokens: usedTokens,
    reserveTokens: Math.max(0, Number(compactPolicy.configuredReserveTokens) || 0),
    lastApiRequestTokens: lastContextTokens || 0,
    lastApiRequestStale: lastUsageStale,
  };
}

export function contextStatusValue(session, route, env, { messageSummary, request, gauge, hasConversationActivity }) {
  const { usedTokens, lastContextTokens, lastUsageStale, displayWindow, effectiveWindow, rawWindow } = gauge;
  return {
    ...statusIdentity(session, route, env),
    contextWindow: displayWindow || effectiveWindow || null,
    effectiveContextWindow: effectiveWindow || null,
    rawContextWindow: rawWindow || null,
    effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
    usedTokens,
    usedSource: gauge.usedSource,
    // Pressure remains private to compaction/diagnostics. Every display
    // consumes this measured-input contract instead of the pressure gauge.
    measurement: sessionContextMeasurement(session, hasConversationActivity),
    currentEstimatedTokens: usedTokens,
    lastApiRequestTokens: lastContextTokens || 0,
    lastApiRequestStale: lastUsageStale,
    freeTokens: gauge.freeTokens,
    compaction: compactionStatusFor(session, gauge),
    messages: messageSummary,
    request,
    usage: sessionUsageCounters(session, lastContextTokens),
  };
}
