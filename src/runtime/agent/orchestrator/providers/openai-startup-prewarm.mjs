/**
 * openai-startup-prewarm.mjs — owner of the openai-oauth session-startup
 * WebSocket prewarm.
 *
 * Codex opens a session by sending a generate:false request and handing the
 * live socket to the first real turn. Everything about that reservation lives
 * here: which turn it fits, how it is armed, when it expires, and how it is
 * released — plus the request shaping (target resolution, prewarm sendOpts,
 * stable prefix identity) the provider previously inlined.
 *
 * The registry itself stays a provider field
 * (OpenAIOAuthProvider._startupPrewarmReadyByPoolKey): one provider instance
 * serves many sessions, and both the provider and the integration tests
 * address reservations through it. This module owns every transition over that
 * map, so release/disarm ordering exists in exactly one place.
 */
import { createHash } from 'crypto';

import { appendAgentTrace } from '../agent-trace.mjs';
import { envFlag } from '../../../shared/env.mjs';
import { buildCodexStartupPrewarmBody } from './openai-responses-payload.mjs';
import { releaseWebSocket, WS_IDLE_MS } from './openai-ws-pool.mjs';

/**
 * One gate for both billed generate:false paths — the per-send warmup body and
 * the session-startup prompt prewarm. OFF by default: the prewarm pays the
 * full input price of the stable prefix to save at most 90% of that same
 * prefix on the first real call, and only wins if the prewarm itself lands on
 * a warm node (measured 0 of 445 sessions). The connection-only reservation
 * below is unaffected and keeps running.
 */
export function startupPromptWarmupEnabled() {
  return envFlag('MIXDOG_OPENAI_OAUTH_WS_WARMUP', false);
}

/**
 * Identity of the STABLE prefix a startup prewarm actually warmed (model +
 * instructions/tools, never the live transcript). A reservation may only be
 * consumed by a request whose own prefix hashes the same: the first turn
 * refreshes environment/tool surface after the prewarm was fired, and adopting
 * a socket anchored on the older prefix costs the whole prewarm and forces the
 * real request back to a full frame.
 */
export function codexStartupPrefixHash(body) {
  const prewarm = buildCodexStartupPrewarmBody(body);
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: prewarm?.model ?? null,
        instructions: prewarm?.instructions ?? null,
        tools: prewarm?.tools ?? null,
        input: prewarm?.input ?? [],
      })
    )
    .digest('hex')
    .slice(0, 24);
}

/**
 * What a prewarm call is being asked to warm. Callers pass either an explicit
 * messages/tools/model triple or a materialized session; a caller without a
 * prompt gets the connection-only reservation (promptWarmup false), which
 * keeps the socket handshake off the first turn's critical path (measured
 * 371ms connection-only vs 1869ms with the prompt).
 */
export function resolveStartupPrewarmTarget(opts) {
  const session = opts.session && typeof opts.session === 'object' ? opts.session : null;
  const messages = Array.isArray(opts.messages)
    ? opts.messages
    : Array.isArray(session?.messages)
      ? session.messages
      : null;
  const tools = Array.isArray(opts.tools) ? opts.tools : Array.isArray(session?.tools) ? session.tools : [];
  const model = opts.model || session?.model || null;
  return {
    poolKey: opts.sessionId || null,
    session,
    messages,
    tools,
    model,
    promptWarmup: !!(messages && model && startupPromptWarmupEnabled()),
  };
}

/**
 * sendOpts for the prompt prewarm turn: the session's own dispatch identity
 * (thread/cache/effort), marked as a prewarm so the WS transport stops after
 * the generate:false response and retains the socket. messages/tools/model are
 * stripped because send() takes them positionally.
 */
export function buildStartupPrewarmSendOpts(target, opts) {
  const { messages: _messages, tools: _tools, model: _model, ...baseSendOpts } = opts;
  const { poolKey, session } = target;
  const codexSessionId = baseSendOpts.codexSessionId || session?.codexWireSessionId || null;
  return {
    ...baseSendOpts,
    sessionId: poolKey,
    session,
    effort: baseSendOpts.effort ?? session?.effort ?? null,
    fast: baseSendOpts.fast === true || session?.fast === true,
    modelParameters: baseSendOpts.modelParameters || session?.modelParameters || {},
    promptCacheKey: baseSendOpts.promptCacheKey || session?.promptCacheKey || null,
    ...(codexSessionId
      ? {
          codexSessionId,
          codexThreadId: baseSendOpts.codexThreadId || codexSessionId,
          threadId: baseSendOpts.threadId || codexSessionId,
        }
      : {}),
    requestKind: 'prewarm',
    codexRequestKind: 'prewarm',
    _startupPrewarmOnly: true,
  };
}

/** Prewarm telemetry is best-effort: tracing must never fail a prewarm. */
export function traceStartupPrewarm(poolKey, payload) {
  try {
    appendAgentTrace({
      sessionId: poolKey,
      kind: 'spawn_ws_prewarm',
      provider: 'openai-oauth',
      transport: 'websocket',
      payload,
    });
  } catch {}
}

function disarmReservationExpiry(handle) {
  if (!handle?._reservationTimer) return;
  clearTimeout(handle._reservationTimer);
  handle._reservationTimer = null;
}

/**
 * Record which stable prefix the completed prewarm anchored. Until this is
 * stamped the handle cannot match any turn, so a prewarm result is only a
 * reservation once it is stamped.
 */
export function stampStartupPrewarmReservation(handle, prefixHash) {
  if (!handle) return handle;
  handle.prefixHash = prefixHash;
  handle.promptWarmup = true;
  return handle;
}

/** Give up a reservation: disarm its expiry and close the socket it holds. */
export function discardStartupPrewarmReservation(handle, poolKey) {
  if (!handle) return;
  disarmReservationExpiry(handle);
  if (handle.entry) releaseWebSocket({ entry: handle.entry, poolKey, keep: false });
}

/**
 * True when this session already holds a reservation that covers the request.
 * A connection-only reservation (session create, before the prompt is
 * materialized) does not satisfy a prompt prewarm.
 */
export function hasStartupPrewarmReservation(registry, poolKey, { promptWarmup = false } = {}) {
  const reserved = registry.get(poolKey) || null;
  if (!reserved) return false;
  return !promptWarmup || reserved.promptWarmup === true;
}

/**
 * Publish a completed prewarm for the first real turn. The reservation holds a
 * live socket, so it is bounded by the pool's idle window and dropped as soon
 * as its socket closes; a superseded reservation is released, never leaked.
 */
export function armStartupPrewarmReservation(registry, poolKey, handle, { idleMs = WS_IDLE_MS } = {}) {
  const previous = registry.get(poolKey);
  if (previous && previous !== handle) discardStartupPrewarmReservation(previous, poolKey);
  registry.set(poolKey, handle);
  handle._reservationTimer = setTimeout(() => {
    if (registry.get(poolKey) !== handle) return;
    registry.delete(poolKey);
    handle._reservationTimer = null;
    releaseWebSocket({ entry: handle.entry, poolKey, keep: false });
  }, idleMs);
  try {
    handle._reservationTimer.unref?.();
  } catch {}
  try {
    handle.entry.socket?.once?.('close', () => {
      disarmReservationExpiry(handle);
      if (registry.get(poolKey) === handle) registry.delete(poolKey);
    });
  } catch {}
  return handle;
}

/**
 * Consume this session's reservation, if it fits the turn.
 *
 * A reservation is single-use: it always leaves the registry (and its expiry
 * timer is disarmed) and is then either handed to the request or released.
 * Adopting a socket anchored on a different prefix/cache lane would cost the
 * whole prewarm and still force the request back to a full frame.
 */
export function claimStartupPrewarmReservation(registry, { poolKey, cacheKey, prefixHash }) {
  if (!poolKey) return null;
  const candidate = registry.get(poolKey) || null;
  if (!candidate) return null;
  registry.delete(poolKey);
  disarmReservationExpiry(candidate);
  if (
    candidate.poolKey === poolKey &&
    candidate.cacheKey === cacheKey &&
    candidate.prefixHash === prefixHash &&
    candidate.entry
  ) {
    return candidate;
  }
  discardStartupPrewarmReservation(candidate, poolKey);
  return null;
}

/**
 * Drop an in-flight prewarm's bookkeeping, but only while it is still the
 * current one: a later prewarm for the same session owns the slot from the
 * moment it registers.
 */
export function retireStartupPrewarmRecord(inFlight, poolKey, record) {
  if (inFlight.get(poolKey) === record) inFlight.delete(poolKey);
}
