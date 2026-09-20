// manager/ask-support.mjs
// Per-ask option resolution and cleanup settling shared by askSession and
// the turn helpers it delegates to.
import { settleWithin } from '../../../../shared/abort-race.mjs';

const DEFAULT_ASK_CLEANUP_SETTLE_MS = 2_000;

export async function settleAskCleanup(promise, { timeoutMs } = {}) {
  const configured = Number(process.env.MIXDOG_ASK_CLEANUP_SETTLE_MS);
  const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const budget = positive(timeoutMs) ?? positive(configured) ?? DEFAULT_ASK_CLEANUP_SETTLE_MS;
  return await settleWithin(promise, budget);
}

// Live Agent projection is a per-ask send opt, never a session field.
// Callers that pass onTextDelta/onAssistantText still need `liveProjection`
// to un-suppress provider streaming: askSession always wraps those
// callbacks for interruption tracking, so agent-loop cannot infer intent
// from `typeof opts.onTextDelta === 'function'`.
export function resolveAskLiveProjection(askOpts = {}) {
  return askOpts?.liveProjection === true;
}

export function emitAskSessionStart(askOpts, detail) {
  if (typeof askOpts?.onSessionStart !== 'function') return;
  try {
    askOpts.onSessionStart(detail);
  } catch {
    /* best-effort */
  }
}

// Replacement is opt-in and transactional: a delta-only consumer cannot
// retract already exposed bytes, so absence, false, or rejection must
// preserve the original partial and force the provider's terminal
// no-replay behavior. Live projection never auto-acks.
export async function acknowledgeAskTextReset(askOpts, detail, onAcknowledged) {
  if (typeof askOpts?.onTextReset !== 'function') return false;
  let acknowledged = false;
  try {
    acknowledged = (await askOpts.onTextReset(detail)) === true;
  } catch {
    return false;
  }
  if (!acknowledged) return false;
  if (typeof onAcknowledged === 'function') onAcknowledged(detail);
  return true;
}
