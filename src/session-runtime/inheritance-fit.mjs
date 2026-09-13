import { estimateMessagesTokens } from '../runtime/agent/orchestrator/session/context-utils.mjs';
import {
  compactTargetBudget,
  currentContextEstimateTokens,
  resolveWorkerCompactPolicy,
} from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { resolveSessionContextMeta } from '../runtime/agent/orchestrator/session/manager/context-meta.mjs';
import { getProvider } from '../runtime/agent/orchestrator/providers/registry.mjs';

// ---------------------------------------------------------------------------
// ONE yardstick for session inheritance.
//
// The source session's gauge is anchored on ITS provider's billed prompt, on
// ITS model's boundary. A heir is a different route with no billing history at
// all, so its first reading is the calibrated whole-transcript estimate — a
// number up to ~2x the source gauge for the very same conversation (user:
// 87%인데 85만 토큰이라고 거부됨). Deciding the carry on one scale while
// offering it on the other is what made inheritance fail only after the click.
//
// Everything that asks "does this conversation fit the heir?" — the preflight
// the surfaces call before offering the action, and the runtime guard that
// performs it — goes through inheritanceFit() with the TARGET route's policy.
// ---------------------------------------------------------------------------

/** The conversation that travels. System blocks belong to the session that
 *  built them, so they never enter the measurement or the carry. */
export function inheritableMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.role !== 'system');
}

/**
 * Measure `messages` against the compaction trigger of `target` — a real heir
 * session or the route shape built by inheritanceRouteTarget().
 *
 * An unmeasurable route (no boundary metadata, auto-compaction off) reports
 * `known: false` and stays permissive: a missing reading is not evidence that
 * the conversation is too large.
 */
export function inheritanceFit(messages, target) {
  const carried = inheritableMessages(messages);
  const provider = String(target?.provider || '').trim();
  const model = String(target?.model || '').trim();
  const base = { provider, model, messages: carried.length };
  const tools = Array.isArray(target?.tools) ? target.tools : [];
  const policy = target ? resolveWorkerCompactPolicy(target, tools) : null;
  const limit = Math.max(0, Number(policy?.triggerTokens) || 0);
  if (!policy || policy.auto === false || !limit) {
    return { ...base, known: false, fits: true, used: 0, limit: 0, percent: null };
  }
  // Same formula the heir's own context gauge will report on its first turn:
  // transcript estimate + request reserve, on the target provider's scale.
  const used = currentContextEstimateTokens(estimateMessagesTokens(carried), policy);
  return {
    ...base,
    known: true,
    fits: used < limit,
    used,
    limit,
    percent: Math.max(0, Math.ceil((used / limit) * 100)),
  };
}

// A compacted transcript must land well inside the heir, not one token under
// its trigger. The compactor counts raw message estimate, while the heir's
// gauge prices that same transcript through its provider calibration.
// compactTargetBudget now owns that translation for every caller, so the
// budget it returns is already on the estimate scale. The compactor itself
// subtracts the request reserve; do not subtract it a second time here.
const INHERITANCE_COMPACT_MIN_BUDGET_TOKENS = 4_000;

/**
 * How to compact a conversation INTO this heir, or null when the route has no
 * measurable boundary to aim at.
 */
export function inheritanceCompactionPlan(target) {
  const tools = Array.isArray(target?.tools) ? target.tools : [];
  const policy = target ? resolveWorkerCompactPolicy(target, tools) : null;
  if (!policy?.boundaryTokens) return null;
  const calibration = Number(policy.tokenCalibration) > 0 ? Number(policy.tokenCalibration) : 1;
  const rawBudget = compactTargetBudget({ ...policy, force: true })
    || Math.max(1, Math.floor(policy.boundaryTokens / calibration));
  return {
    budgetTokens: Math.max(
      INHERITANCE_COMPACT_MIN_BUDGET_TOKENS,
      rawBudget,
    ),
    boundaryTokens: policy.boundaryTokens,
    reserveTokens: Math.max(0, Number(policy.reserveTokens) || 0),
    contextWindow: Math.max(0, Number(policy.contextWindow) || 0) || policy.boundaryTokens,
  };
}

/** The heir's measurable shape for a route that has no session yet. Windows
 *  come from the same resolver session creation uses, so a preflight and the
 *  session it predicts share one boundary. */
export function inheritanceRouteTarget({
  provider,
  model,
  selectedContextWindow = null,
  tools = [],
} = {}) {
  const name = String(provider || '').trim();
  const modelId = String(model || '').trim();
  if (!name || !modelId) return null;
  let providerImpl = null;
  try { providerImpl = getProvider(name); } catch { providerImpl = null; }
  const window = Number(selectedContextWindow);
  const meta = resolveSessionContextMeta(providerImpl, modelId, {
    ...(Number.isFinite(window) && window > 0 ? { selectedContextWindow: window } : {}),
  });
  return {
    provider: name,
    model: modelId,
    contextWindow: meta.contextWindow,
    rawContextWindow: meta.rawContextWindow,
    effectiveContextWindowPercent: meta.effectiveContextWindowPercent,
    autoCompactTokenLimit: meta.autoCompactTokenLimit,
    compactBoundaryTokens: meta.compactBoundaryTokens,
    compaction: { auto: true },
    // The heir opens on the surface's current catalog, so its request reserve
    // is the one this session already sends.
    tools: Array.isArray(tools) ? tools : [],
  };
}

/** Engine-side refusal sentence. Surfaces localize their own wording; this is
 *  the fallback for CLI/TUI and for any caller that skipped the preflight. */
export function inheritanceFitMessage(fit) {
  const route = [fit?.provider, fit?.model].filter(Boolean).join('/') || 'the selected model';
  return `inheritFrom: the full conversation needs ${Math.ceil(Number(fit?.used) || 0)} tokens `
    + `but ${route} allows ${Math.floor(Number(fit?.limit) || 0)} before compaction`;
}
