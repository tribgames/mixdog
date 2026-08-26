'use strict';

// Cross-shard provider cooldown encoding.
//
// Fast-mode capacity cooldown is an ACCOUNT-wide fact kept in process-local
// policy state. With the runtime split across several shard processes, a
// cooldown discovered by one shard must reach the others or its siblings keep
// hammering a pool that is already known to be drained.
//
// The policy module owns the decision rules, so a replay is expressed through
// its PUBLIC API as the same capacity rejection the discovering shard saw:
// this file only encodes/decodes that fact. The policy applies its own minimum
// window, so a replay can only ever be equal or MORE conservative than the
// observation — never a shorter or cleared cooldown.

const ECHO_TOLERANCE_MS = 1_000;

/** Read this process's live cooldown as a wire-safe record. */
export function readProviderCooldown(policy, now = Date.now()) {
  if (!policy) return null;
  let remaining = 0;
  let disabledReason = null;
  try {
    remaining = policy.fastModeCooldownRemainingMs(now);
    disabledReason = policy.fastModeDisabledReason();
  } catch { return null; }
  return {
    untilMs: Number.isFinite(remaining) && remaining > 0 ? now + remaining : 0,
    disabledReason: disabledReason || null,
    observedAt: now,
  };
}

/** True only for a materially LONGER cooldown or a newly disabled pool. */
export function providerCooldownAdvanced(previous, next) {
  const priorUntil = Number(previous?.untilMs) || 0;
  const nextUntil = Number(next?.untilMs) || 0;
  const nextReason = next?.disabledReason ? String(next.disabledReason) : null;
  const priorReason = previous?.disabledReason ? String(previous.disabledReason) : null;
  return nextUntil > priorUntil + ECHO_TOLERANCE_MS
    || (Boolean(nextReason) && nextReason !== priorReason);
}

export function mergeKnownProviderCooldown(previous, next) {
  return {
    untilMs: Math.max(Number(previous?.untilMs) || 0, Number(next?.untilMs) || 0),
    disabledReason: (next?.disabledReason ? String(next.disabledReason) : null)
      || (previous?.disabledReason ? String(previous.disabledReason) : null),
  };
}

/** Replay a sibling shard's cooldown into this process's policy state. */
export function applyProviderCooldown(policy, cooldown, now = Date.now()) {
  if (!policy) return false;
  const untilMs = Number(cooldown?.untilMs) || 0;
  const disabledReason = cooldown?.disabledReason ? String(cooldown.disabledReason) : '';
  const policyLimits = policy._FAST_MODE_POLICY || {};
  let applied = false;
  if (disabledReason && policyLimits.OVERAGE_DISABLED_HEADER) {
    policy.noteFastModeCapacityError({
      httpStatus: 429,
      headers: { [policyLimits.OVERAGE_DISABLED_HEADER]: disabledReason },
    }, { fast: true, now });
    applied = true;
  }
  const remainingMs = untilMs - now;
  // Below the policy's short-retry bound the discovering shard itself keeps
  // fast mode, so there is nothing to replicate.
  const shortRetryMs = Number(policyLimits.SHORT_RETRY_THRESHOLD_MS) || 0;
  if (remainingMs >= shortRetryMs && remainingMs > 0) {
    policy.noteFastModeCapacityError(
      { httpStatus: 429, retryAfterMs: remainingMs },
      { fast: true, now },
    );
    applied = true;
  }
  return applied;
}
