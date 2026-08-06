/**
 * stream-outcome.mjs — canonical provider stream outcome / safety contract.
 *
 * ONE record describes how a provider stream ended, across every transport:
 * OpenAI Responses WS, OpenAI Responses HTTP/SSE, Anthropic API-key SSE,
 * Anthropic OAuth SSE and its non-streaming fallback, and any adapter that
 * only attaches partial state to a thrown error.
 *
 * Historically each consumer (retry classifier, transport fallback,
 * send-with-recovery, ask-session persistence) re-derived safety from a
 * DIFFERENT subset of scattered per-provider flags (liveTextEmitted,
 * emittedText, emittedToolCall, toolCallEmitted, partialToolCall,
 * emittedThinking, emittedReasoning, startedToolCall, partialToolCalls,
 * pendingToolUse, unsafeToRetry, sawCompleted, ...). A provider that set only
 * SOME of them (Anthropic's stall error carries partialContent but neither
 * liveTextEmitted nor unsafeToRetry) silently fell through the gaps: streamed
 * text was dropped from history, or an ambiguous end-of-stream was treated as
 * a clean success / a replayable request.
 *
 * ── Schema (canonical record, frozen) ───────────────────────────────────────
 *   version              1
 *   provider             string|null   informational
 *   transport            'ws'|'http-sse'|'sse'|'non-streaming'|'unknown'
 *   terminalObserved     bool  provider signalled end-of-turn (response.completed
 *                              / response.done / message_stop / explicit finish
 *                              reason / early-settle on a complete tool call)
 *   continuation         bool  stream ended WITHOUT a terminal signal (stall,
 *                              truncation, abnormal close, EOF mid-message)
 *   textEmitted          bool  non-empty text RELAYED to the client (visible)
 *   textObservedChars    int   assistant text accumulated by the adapter,
 *                              whether or not it was relayed
 *   reasoningEmitted     bool  thinking/reasoning deltas or blocks exposed
 *   toolCallsStarted     bool  tool input began streaming (args may be partial)
 *   toolCallsComplete    int   fully parsed tool calls
 *   toolCallsDispatched  int   tool calls handed to onToolCall (side effect may
 *                              already have run)
 *   dispatchAmbiguous    bool  dispatch count was INFERRED, not reported
 *   pendingToolInput     bool  a tool_use/function_call input never completed
 *   userAbort            bool  caller cancelled
 *   stallObserved        bool  watchdog/idle stall produced this outcome
 *   truncatedStream      bool  message_start-without-message_stop class
 *
 * ── Derived invariants ──────────────────────────────────────────────────────
 *   terminalObserved clears continuation ONLY when the turn was not declared
 *   a same-user-turn continuation. A terminal sample frame may still say
 *   `end_turn=false` (Responses) / continuationDeclared: the turn is NOT over,
 *   so continuation stays true and successEligible stays false.
 *   visibleOutput      = textEmitted || reasoningEmitted
 *   observedOutput     = visibleOutput || textObservedChars > 0
 *                        || toolCallsComplete > 0 || toolCallsDispatched > 0
 *   sideEffectDispatched = toolCallsDispatched > 0
 *   replayUnsafe       = the ONE architecture-specific deny MixDog adds on top
 *                        of the standard retry rules, because it streams UI text
 *                        and dispatches tools eagerly:
 *                        visibleOutput || sideEffectDispatched
 *                        || dispatchAmbiguous || unsafe marker
 *   replaySafe         = !replayUnsafe && !userAbort
 *   successEligible    = terminalObserved && !continuation && !pendingToolInput
 *
 * This record does NOT decide retries on its own. Whether a failure is retried
 * at all is the TYPED question owned by retry-classifier.mjs (known transient
 * status / errno / close code → bounded backoff + transport fallback; unknown
 * or untyped → error). `replaySafe` only answers "would re-issuing this turn
 * duplicate something the user already saw or a side effect that already ran".
 * Buffered-but-never-relayed text and a tool input that never completed (and
 * therefore never dispatched) are NOT replay denials; `observedOutput` remains
 * the signal for partial-failure PERSISTENCE, not for replay permission.
 * An absent or ambiguous terminal can never be promoted to success
 * (successEligible=false): an explicit terminal stream event is required.
 *
 * Compatibility: stampStreamOutcome() writes the canonical record AND the
 * historical alias flags (never clearing one that is already true), so every
 * legacy reader keeps working unchanged.
 */

export const STREAM_OUTCOME_VERSION = 1

export const STREAM_TRANSPORTS = Object.freeze({
  WS: 'ws',
  HTTP_SSE: 'http-sse',
  SSE: 'sse',
  NON_STREAMING: 'non-streaming',
  UNKNOWN: 'unknown',
})

const TRUE = (v) => v === true
const COUNT = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function _isAbortLike(source) {
  const name = String(source?.name || '')
  return name === 'AbortError' || name === 'APIUserAbortError' || source?.code === 'ABORT_ERR'
}

/** Raw (pre-derivation) signal read of ONE source object (error or midState). */
function _signalsOf(source) {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return null

  const partialContent = typeof source.partialContent === 'string' ? source.partialContent : ''
  const partialToolCalls = Array.isArray(source.partialToolCalls) ? source.partialToolCalls.length : 0
  const explicitComplete = COUNT(source.toolCallsComplete)
  const toolCallsComplete = Math.max(partialToolCalls, explicitComplete)

  const textEmitted = TRUE(source.textEmitted) || TRUE(source.liveTextEmitted) || TRUE(source.emittedText)
  const textObservedChars = Math.max(
    COUNT(source.textObservedChars),
    COUNT(source.emittedTextChars),
    partialContent.trim().length > 0 ? partialContent.length : 0,
  )
  const reasoningEmitted = TRUE(source.reasoningEmitted) || TRUE(source.emittedThinking)
    || TRUE(source.emittedReasoning) || TRUE(source.partialReasoningEmitted)
  // NOTE: `partialHasThinking` (an extended-thinking block EXISTED, possibly
  // empty / signature-only) is deliberately NOT read here: a thinking block
  // the user never saw is not exposed reasoning.

  // `pendingToolUse` alone is NOT "started": a tool_use whose input JSON never
  // completed was never dispatched, so re-requesting stays idempotent (the
  // documented truncated-stream retry). Only explicit partial-args markers
  // count as exposure.
  const toolCallsStarted = TRUE(source.toolCallsStarted) || TRUE(source.partialToolCall)
    || TRUE(source.startedToolCall) || TRUE(source.partialToolCallStarted)
    || toolCallsComplete > 0

  const dispatchReported = Object.prototype.hasOwnProperty.call(source, 'toolCallsDispatched')
  const dispatchFlag = TRUE(source.emittedToolCall) || TRUE(source.toolCallEmitted)
  let toolCallsDispatched = dispatchReported ? COUNT(source.toolCallsDispatched) : 0
  let dispatchAmbiguous = false
  if (!dispatchReported) {
    if (dispatchFlag) {
      toolCallsDispatched = Math.max(1, toolCallsComplete)
      dispatchAmbiguous = toolCallsComplete === 0
    } else if (toolCallsComplete > 0) {
      // Fail closed: every streaming adapter dispatches eagerly at
      // content_block_stop / function_call_arguments.done, so a complete tool
      // call with no dispatch report must be assumed to have side effects.
      toolCallsDispatched = toolCallsComplete
      dispatchAmbiguous = true
    }
  }

  const truncatedStream = TRUE(source.truncatedStream) || source.code === 'TRUNCATED_STREAM'
  const stallObserved = TRUE(source.streamStalled) || source.code === 'ESTREAMSTALL'
    || String(source.name || '') === 'StreamStalledError'
    || String(source.name || '') === 'StreamStalledAbortError'
    || String(source.name || '') === 'AgentStallAbortError'
    || String(source.watchdogAbort || '') !== ''

  const terminalObserved = TRUE(source.terminalObserved) || TRUE(source.sawCompleted)
    || TRUE(source.completed)
    || (TRUE(source.providerIncomplete) && !!source.finishReason)
  const streamStarted = TRUE(source.sawMessageStart) || TRUE(source.sawResponseCreated)
    || textEmitted || reasoningEmitted || textObservedChars > 0 || toolCallsStarted
  // Protocol distinction: a TERMINAL sample frame can still declare that the
  // same user turn continues (Responses `end_turn=false`). That is a
  // continuation, not a finished turn.
  const declaredContinuation = source.endTurn === false || TRUE(source.continuationDeclared)

  return {
    provider: source.provider ?? source.providerName ?? null,
    transport: typeof source.transport === 'string' ? source.transport : null,
    terminalObserved,
    continuation: !terminalObserved
      && (truncatedStream || stallObserved || streamStarted || TRUE(source.continuation)),
    declaredContinuation,
    textEmitted,
    textObservedChars,
    reasoningEmitted,
    toolCallsStarted,
    toolCallsComplete,
    toolCallsDispatched,
    // Monotonic across canonical round-trips: an already-recorded ambiguity is
    // never downgraded by a later read that happens to see a dispatch count.
    dispatchAmbiguous: TRUE(source.dispatchAmbiguous) || dispatchAmbiguous,
    pendingToolInput: TRUE(source.pendingToolInput) || TRUE(source.pendingToolUse),
    userAbort: TRUE(source.userAbort) || _isAbortLike(source),
    stallObserved,
    truncatedStream,
    unsafeMarker: TRUE(source.unsafeToRetry),
  }
}

const EMPTY_SIGNALS = {
  provider: null, transport: null,
  terminalObserved: false, continuation: false, declaredContinuation: false,
  textEmitted: false, textObservedChars: 0, reasoningEmitted: false,
  toolCallsStarted: false, toolCallsComplete: 0, toolCallsDispatched: 0,
  dispatchAmbiguous: false, pendingToolInput: false, userAbort: false,
  stallObserved: false, truncatedStream: false, unsafeMarker: false,
}

function _merge(a, b) {
  if (!b) return a
  if (!a) return b
  return {
    provider: a.provider || b.provider || null,
    transport: a.transport || b.transport || null,
    terminalObserved: a.terminalObserved || b.terminalObserved,
    continuation: a.continuation || b.continuation,
    declaredContinuation: a.declaredContinuation || b.declaredContinuation,
    textEmitted: a.textEmitted || b.textEmitted,
    textObservedChars: Math.max(a.textObservedChars, b.textObservedChars),
    reasoningEmitted: a.reasoningEmitted || b.reasoningEmitted,
    toolCallsStarted: a.toolCallsStarted || b.toolCallsStarted,
    toolCallsComplete: Math.max(a.toolCallsComplete, b.toolCallsComplete),
    toolCallsDispatched: Math.max(a.toolCallsDispatched, b.toolCallsDispatched),
    dispatchAmbiguous: a.dispatchAmbiguous || b.dispatchAmbiguous,
    pendingToolInput: a.pendingToolInput || b.pendingToolInput,
    userAbort: a.userAbort || b.userAbort,
    stallObserved: a.stallObserved || b.stallObserved,
    truncatedStream: a.truncatedStream || b.truncatedStream,
    unsafeMarker: a.unsafeMarker || b.unsafeMarker,
  }
}

function _finalize(signals) {
  const s = signals || EMPTY_SIGNALS
  const terminalObserved = s.terminalObserved === true
  const visibleOutput = s.textEmitted || s.reasoningEmitted
  const sideEffectDispatched = s.toolCallsDispatched > 0
  const observedOutput = visibleOutput || s.textObservedChars > 0
    || s.toolCallsComplete > 0 || sideEffectDispatched
  // The architecture-specific deny: a replay would duplicate output the user
  // already saw, or re-run a tool that was already handed off (including the
  // ambiguous case where a complete tool call carries no dispatch report).
  const replayUnsafe = visibleOutput || sideEffectDispatched
    || s.dispatchAmbiguous === true || s.unsafeMarker === true
  const replaySafe = !replayUnsafe && s.userAbort !== true
  // A terminal frame that declared `end_turn=false` keeps the turn open.
  const continuation = s.declaredContinuation === true
    ? true
    : (terminalObserved ? false : s.continuation === true)
  return Object.freeze({
    version: STREAM_OUTCOME_VERSION,
    provider: s.provider || null,
    transport: s.transport || STREAM_TRANSPORTS.UNKNOWN,
    terminalObserved,
    continuation,
    declaredContinuation: s.declaredContinuation === true,
    textEmitted: s.textEmitted === true,
    textObservedChars: s.textObservedChars | 0,
    reasoningEmitted: s.reasoningEmitted === true,
    toolCallsStarted: s.toolCallsStarted === true,
    toolCallsComplete: s.toolCallsComplete | 0,
    toolCallsDispatched: s.toolCallsDispatched | 0,
    dispatchAmbiguous: s.dispatchAmbiguous === true,
    pendingToolInput: s.pendingToolInput === true,
    userAbort: s.userAbort === true,
    stallObserved: s.stallObserved === true,
    truncatedStream: s.truncatedStream === true,
    // Derived verdicts.
    visibleOutput,
    observedOutput,
    sideEffectDispatched,
    replayUnsafe,
    replaySafe,
    successEligible: terminalObserved && !continuation && s.pendingToolInput !== true,
  })
}

/**
 * Normalize any number of sources (thrown error, provider midState, explicit
 * hint object) into the canonical record. Sources are OR/max merged; an
 * already-canonical `source.streamOutcome` is merged in as well.
 */
export function readStreamOutcome(...sources) {
  let signals = null
  for (const source of sources) {
    if (!source) continue
    const existing = source.streamOutcome
    if (existing && existing.version === STREAM_OUTCOME_VERSION) {
      signals = _merge(signals, _signalsOf(existing))
    }
    signals = _merge(signals, _signalsOf(source))
  }
  return _finalize(signals || EMPTY_SIGNALS)
}

/** Alias kept for callers that read a provider midState directly. */
export const streamOutcomeFromState = readStreamOutcome

/**
 * Attach the canonical record to `target` (usually a thrown error) and mirror
 * it onto the historical alias flags. Aliases are only ever SET, never
 * cleared, so a provider that already stamped one keeps it. Text that was
 * merely observed (buffered, never relayed) does NOT set liveTextEmitted:
 * only relayed text is a visibility/no-replay boundary.
 */
export function stampStreamOutcome(target, ...sources) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target
  const outcome = readStreamOutcome(target, ...sources)
  try {
    target.streamOutcome = outcome
    if (outcome.textEmitted) { target.liveTextEmitted = true; target.emittedText = true }
    if (outcome.reasoningEmitted) target.emittedThinking = true
    if (outcome.toolCallsStarted) target.partialToolCall = true
    if (outcome.sideEffectDispatched) { target.emittedToolCall = true; target.toolCallEmitted = true }
    if (outcome.pendingToolInput) target.pendingToolUse = true
    if (outcome.truncatedStream) target.truncatedStream = true
    if (outcome.replayUnsafe) target.unsafeToRetry = true
  } catch { /* frozen/exotic targets keep the returned record only */ }
  return outcome
}

/** True when re-issuing the turn would not duplicate exposure or side effects. */
export function isReplaySafe(source) {
  return readStreamOutcome(source).replaySafe
}

/** True when there is positive evidence that a replay would duplicate output. */
export function isReplayUnsafe(source) {
  return readStreamOutcome(source).replayUnsafe
}

/** True when the outcome may be promoted to a normal successful response. */
export function canPromoteToSuccess(source) {
  return readStreamOutcome(source).successEligible
}

/** True when anything the model produced was observed (visible or buffered). */
export function hasObservedOutput(source) {
  return readStreamOutcome(source).observedOutput
}

/** True when a tool call was handed off and may already have run. */
export function hasDispatchedToolCalls(source) {
  return readStreamOutcome(source).sideEffectDispatched
}
