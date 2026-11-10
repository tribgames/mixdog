// Quiet-time cue for a running turn: how long it has gone without progress
// the stall watchdog counts, and what it is waiting on. Display only — the
// watchdog's abort policy lives in stall-policy.mjs and is never read or
// changed here. Shared by the TUI spinner, the desktop live status line and
// the desktop agent rows, so every surface says the same thing.

/** A running turn with no counted progress for this long reads "quiet".
 *  Lenient on purpose: effort-mode models can think for minutes without a
 *  single semantic delta (stall-policy.mjs, the semantic-idle notes), so the
 *  cue stays neutral text; only the watchdog's own warn point escalates it. */
export const QUIET_PROGRESS_CUE_MS = 120_000;

/** The newest progress stamp of a runtime liveness entry or progress
 *  snapshot: the same signals the stall watchdog counts (stage changes,
 *  semantic stream deltas, tool starts and tool heartbeats, the turn start). */
export function lastProgressAt(liveness) {
  if (!liveness || typeof liveness !== 'object') return 0;
  return Math.max(
    Number(liveness.lastProgressAt) || 0,
    Number(liveness.lastStreamDeltaAt) || 0,
    Number(liveness.toolStartedAt) || 0,
    Number(liveness.askStartedAt) || 0
  );
}

/** The stage a provider reports once its request is on the wire and the
 *  response headers are still pending. The runtime keeps the turn in
 *  `requesting` and records the send time (`requestSentAt`); the display stage
 *  below reads "model thinking" from that record. */
export const MODEL_THINKING_STAGE = 'model_thinking';

/** Request sent, response headers (transport) not yet received — read from
 *  a runtime liveness entry or progress snapshot. */
export function awaitingModelResponse(liveness) {
  if (!liveness || typeof liveness !== 'object' || liveness.stage !== 'requesting') return false;
  const sentAt = Number(liveness.requestSentAt) || 0;
  return sentAt > 0 && !((Number(liveness.lastTransportAt) || 0) >= sentAt);
}

/** The stage a surface shows: `model_thinking` while the request waits for
 *  its headers, otherwise the runtime stage. */
export function displayProgressStage(liveness) {
  if (awaitingModelResponse(liveness)) return MODEL_THINKING_STAGE;
  return typeof liveness?.stage === 'string' ? liveness.stage : null;
}

const WAIT_BY_STAGE = {
  connecting: 'provider',
  requesting: 'provider',
  [MODEL_THINKING_STAGE]: 'thinking',
  streaming: 'model',
  tool_running: 'tool',
  resource_wait: 'slot',
  cancelling: 'cancel',
};

/** What a quiet turn waits on, from its runtime stage ('' when unknown). */
export function quietWaitKind(stage) {
  return WAIT_BY_STAGE[String(stage || '')] || '';
}

/** The quiet state of a running turn at `now`, or null while it is not
 *  quiet. `since` is the frozen progress stamp, so the value stays identical
 *  for the whole silence and publishing it costs one update per silence. */
export function quietProgress({ progressAt, stage, tool = null, now = Date.now() }) {
  const since = Number(progressAt) || 0;
  if (!since || now - since < QUIET_PROGRESS_CUE_MS) return null;
  const wait = quietWaitKind(stage);
  return { since, wait, ...(wait === 'tool' && tool ? { tool: String(tool) } : {}) };
}

/** Display parts of a quiet state at `now`: whole quiet minutes, and whether
 *  the silence reached the watchdog's warn point (`warnMs`, 0 = none). */
export function quietProgressParts(quiet, now, warnMs = 0) {
  const since = Number(quiet?.since) || 0;
  if (!since) return null;
  const quietMs = Math.max(0, now - since);
  if (quietMs < QUIET_PROGRESS_CUE_MS) return null;
  return {
    quietMs,
    minutes: Math.floor(quietMs / 60_000),
    wait: String(quiet.wait || ''),
    tool: typeof quiet.tool === 'string' ? quiet.tool : '',
    escalated: Number(warnMs) > 0 && quietMs >= Number(warnMs),
  };
}

const WAIT_TEXT = {
  provider: 'waiting on provider',
  thinking: 'model thinking',
  model: 'waiting on model',
  slot: 'waiting for a slot',
  cancel: 'stopping',
};

/** The TUI's lowercase English cue: `quiet for 2m · waiting on provider`. */
export function quietProgressLabel(parts) {
  if (!parts) return '';
  const wait = parts.wait === 'tool' ? `running ${parts.tool || 'a tool'}` : WAIT_TEXT[parts.wait] || '';
  return [`quiet for ${parts.minutes}m`, wait].filter(Boolean).join(' · ');
}
