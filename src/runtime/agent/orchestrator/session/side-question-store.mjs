// side-question-store.mjs — the in-memory state behind /btw side questions:
// per session, the latest provider request the main loop sent (the request a
// side question or a compaction summary forks) and the side question in flight. It holds live
// provider/tool objects, so it never reaches the session record or disk.
import { isAgentOwner } from '../agent-owner.mjs';
import { armCacheWarm, cancelCacheWarm, forgetCacheWarm, noteCacheWarmActivity } from './cache-warm.mjs';

// sessionId -> { provider, model, messages, tools, opts, response }
const requests = new Map();
// sessionId -> AbortController of the side question in flight.
const inFlight = new Map();

// Send options that steer the live loop rather than shape the request: its
// abort signal, a one-shot cache-break trace tag and the per-request stall
// budget. A forced tool choice is dropped too (a side question must be able
// to answer in text); the hard-cap `none` choice is kept.
const LOOP_ONLY_OPTIONS = new Set(['signal', 'cacheBreakIntent', '_stallRetryBudget', 'toolChoice']);

function requestOptions(opts) {
  const out = {};
  for (const [key, value] of Object.entries(opts || {})) {
    if (typeof value === 'function' || LOOP_ONLY_OPTIONS.has(key)) continue;
    out[key] = value;
  }
  if (opts?.toolChoice === 'none') out.toolChoice = 'none';
  return out;
}

/** A request in the stored shape: its own message list and only the send
 *  options a fork may reuse. `response` is null until the reply settles;
 *  `sentAt` is when the provider read (and refreshed) its prompt cache. */
export function sideQuestionRequestSnapshot({ provider, model, messages, tools, opts }) {
  return {
    provider,
    model,
    messages: [...messages],
    tools: Array.isArray(tools) ? tools : [],
    opts: requestOptions(opts),
    response: null,
    sentAt: Date.now(),
  };
}

/**
 * Record a provider request the main loop is sending as the session's latest
 * one. Agent sessions keep nothing here (/btw is a Lead command); their
 * request only reaches the cache warmer. The handle attaches the reply once
 * the send proceeds, or puts the previous request back when this one fails,
 * so only a successfully sent request is kept.
 */
export function captureSideQuestionRequest({ sessionId, sessionRef, provider, model, messages, tools, opts }) {
  if (!sessionId || !provider) return null;
  const kept = !isAgentOwner(sessionRef);
  const previous = requests.get(sessionId);
  const request = sideQuestionRequestSnapshot({ provider, model, messages, tools, opts });
  if (kept) requests.set(sessionId, request);
  // A real request is session activity: it closes the session's idle gap and
  // replaces any cache warm (cache-warm.mjs); a settled one arms the next.
  noteCacheWarmActivity(sessionId, request);
  return {
    settle(response) {
      request.response = response || null;
      armCacheWarm(sessionId, request, response);
    },
    discard() {
      if (!kept || requests.get(sessionId) !== request) return;
      if (previous) requests.set(sessionId, previous);
      else requests.delete(sessionId);
    },
  };
}

export function sideQuestionRequest(sessionId) {
  return (sessionId && requests.get(sessionId)) || null;
}

/** The saved request a compaction summary may fork: one whose reply settled
 *  and whose transcript no compaction has rewritten since it was sent. */
export function compactionForkRequest(sessionId) {
  const request = sideQuestionRequest(sessionId);
  return request?.response && !request.compacted ? request : null;
}

/** A compaction rewrote the transcript: the saved request no longer holds the
 *  history a later compaction must summarize. A side question still forks it
 *  until the next request replaces it. */
export function retireCompactionFork(sessionId) {
  const request = sideQuestionRequest(sessionId);
  if (request) request.compacted = true;
  forgetCacheWarm(sessionId);
}

/** Start the session's side question, aborting the one still in flight. */
export function beginSideQuestion(sessionId) {
  cancelSideQuestion(sessionId);
  const controller = new AbortController();
  inFlight.set(sessionId, controller);
  return {
    signal: controller.signal,
    end() {
      if (inFlight.get(sessionId) === controller) inFlight.delete(sessionId);
    },
  };
}

export function cancelSideQuestion(sessionId) {
  const controller = sessionId ? inFlight.get(sessionId) : null;
  if (!controller) return false;
  inFlight.delete(sessionId);
  controller.abort(new Error('Side question canceled.'));
  return true;
}

/** The transcript the saved request carried is gone (clear, rewind): a later
 *  side question waits for the next request. `cancel` also aborts the side
 *  question in flight (session close / runtime unload). */
export function forgetSideQuestion(sessionId, { cancel = false } = {}) {
  if (!sessionId) return;
  requests.delete(sessionId);
  // Clear / rewind drop the cached prefix; a close or runtime unload (daemon
  // shutdown) keeps its durable touch for the restart re-arm.
  if (cancel) {
    cancelCacheWarm(sessionId);
    cancelSideQuestion(sessionId);
  } else forgetCacheWarm(sessionId);
}
