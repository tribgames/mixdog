/**
 * Loopback client for the desktop app's computer-use bridge.
 *
 * Mirrors browser-bridge/client.mjs: the Mixdog desktop app serves computer
 * commands on 127.0.0.1 and advertises { port, token } through a heartbeated
 * discovery file. This runtime half is a sync availability probe that gates the
 * `computer` tool surface plus the async executor behind tool calls. The bridge
 * only exists while the desktop app runs with Computer Use enabled.
 */
import { normalizeComputerToolArgs, toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';
import { computerResultRecovery, formatComputerToolError } from './error-recovery.mjs';
import { computerErrorCode } from './error-code.mjs';
import { bridgeDiscoveryChanged, readBridgeDiscovery } from '../bridge-discovery.mjs';
import { MAX_COMPUTER_REQUEST_BYTES, readComputerBridgeJson, validateComputerReply } from './limits.mjs';
import { computerActionHas } from './actions.mjs';
import { continuePendingComputerWork, isPendingComputerWork } from './pending-continuation.mjs';

const DISCOVERY_FILE = 'computer-bridge.json';
// Desktop UI Automation queries and input dispatch can be slow; sit above the
// bridge's own per-action timeouts so its specific error wins over a bare abort.
const REQUEST_TIMEOUT_MS = 150_000;
const SESSION_ABORT_TIMEOUT_MS = 15_000;
const EXECUTION_END_TIMEOUT_MS = 3_000;
const SESSION_RELEASE_TIMEOUT_MS = 60_000;
const DEFERRED_SESSION_RELEASE_MS = 2 * 60_000;
// Shutdown stays bounded: an unresponsive host must not hold the exit path open
// for the full per-session release budget.
const SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS = 5_000;
// Host-level action names, matching what toComputerHostCommand emits: the tool
// schema can produce no other observation action, and anything unlisted is
// treated as a mutation that owns a write-active session.
export function isReplaySafeComputerCommand(command) {
  return computerActionHas(String(command?.action || ''), 'replaySafe');
}
const activeComputerSessions = new Set();
const deferredComputerSessionReleases = new Map();
const pendingComputerSessionReleases = new Map();
// Every session that reached the host owns a worker there, including read-only
// ones that never enter activeComputerSessions. The host reaps those only on an
// explicit release, so shutdown needs the full set.
const hostBoundComputerSessions = new Set();
const activeComputerExecutions = new Set();
const BRIDGE_UNAVAILABLE_MESSAGE =
  'computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings';

const ACT_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'pending', 'uncertain']);

function canonicalizeActResult(value, args) {
  value.completed_actions = value.completed_steps;
  value.total_actions = value.total_steps;
  const canonicalStep = (row, index) => {
    const normalized = { ...row };
    normalized.type = args.input?.actions?.[index]?.type || normalized.action;
    if (!ACT_STEP_STATUSES.has(normalized.status)) {
      normalized.status = normalized.ok === false ? 'failed' : 'succeeded';
    }
    delete normalized.action;
    delete normalized.ok;
    return normalized;
  };
  value.actions = Array.isArray(value.steps) ? value.steps.map(canonicalStep) : value.steps;
  delete value.completed_steps;
  delete value.total_steps;
  delete value.steps;
}

export function canonicalComputerResultText(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') {
    return text;
  }
  value.action = args.action;
  if (args.action === 'list') value.kind = args.input?.kind;
  if (args.action === 'capture') value.mode = args.input?.mode || 'state';
  if (args.action === 'window') value.operation = args.input?.operation;
  if (args.action === 'clipboard') value.operation = args.input?.operation;
  if (args.action === 'act') canonicalizeActResult(value, args);
  if (value.capture_after && value.observation === undefined) {
    value.observation = value.capture_after;
    delete value.capture_after;
  }
  if (value.ok === false && value.recovery === undefined) {
    const recovery = computerResultRecovery(value, args);
    if (recovery) value.recovery = recovery;
  }
  return JSON.stringify(value);
}

// A capture payload reports the frame's real pixel size (`width`/`height`,
// nested under `observation` for action replies). Carrying it on the image
// block lets the context estimator bill a screenshot at its true vision cost
// instead of the flat unknown-image allowance. Provider normalizers rebuild
// the wire block from `type`/`source` alone, so these fields never reach an
// API and never shift the cached prefix.
function computerImageDimensions(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  for (const frame of [value, value?.observation]) {
    const width = Number(frame?.width);
    const height = Number(frame?.height);
    if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  }
  return null;
}

function canonicalComputerResultIsError(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return false;
  try {
    const value = JSON.parse(text);
    return Boolean(
      value && typeof value === 'object' && !Array.isArray(value) && value.action === args.action && value.ok === false
    );
  } catch {
    return false;
  }
}

/** Sync gate for the session tool surface (featureDisallowedTools). */
export function computerBridgeAvailableSync() {
  return readDiscovery() !== null;
}

function readDiscovery() {
  return readBridgeDiscovery(DISCOVERY_FILE);
}

function computerCommandHeaders(bridge) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${bridge.token}`,
  };
}

async function postComputerCommand(bridge, payload, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  return await fetch(`http://127.0.0.1:${bridge.port}/command`, {
    method: 'POST',
    headers: computerCommandHeaders(bridge),
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    signal: requestSignal,
  });
}

function computerMutationMayHaveExecuted(command) {
  return !isReplaySafeComputerCommand(command) && command?.read_only !== true;
}

function computerUncertainMutationResult(
  message = 'computer command may have executed and was not replayed; inspect fresh state before retrying'
) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

async function cancelledComputerResult(sessionId, mutationMayHaveExecuted) {
  const confirmed = sessionId ? await abortComputerSession(sessionId) : false;
  const cleanup = confirmed ? 'input state and session resources were released' : 'host cleanup could not be confirmed';
  const partial = mutationMayHaveExecuted
    ? '; input may have partially executed; inspect fresh state before retrying'
    : '';
  return { content: [{ type: 'text', text: `Error: computer command aborted; ${cleanup}${partial}` }], isError: true };
}

function computerErrorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// These refusals happen before any input is dispatched and always end in
// "capture the exact window again", so the client does that capture itself and
// returns it with the refusal instead of spending a separate call on it.
const RECAPTURE_ON_REFUSAL_CODES = new Set(['stale_target', 'stale_frame']);
const READ_ONLY_TOOL_ACTIONS = new Set(['list', 'diagnose', 'capture', 'verify', 'wait_for_user']);

async function refusalWithRecapture(message, args, context) {
  const windowId = args?.input?.window_id;
  if (!windowId || READ_ONLY_TOOL_ACTIONS.has(String(args?.action || ''))) return null;
  if (!RECAPTURE_ON_REFUSAL_CODES.has(computerErrorCode(message))) return null;
  const capture = await executeComputerTool({ action: 'capture', input: { window_id: windowId } }, context);
  if (capture.isError) return null;
  return {
    content: [
      {
        type: 'text',
        text:
          `Error: ${message}\nRecovery: no input was sent; window ${windowId} was captured again below. ` +
          'Act only on its fresh refs, OCR marks, or frame_id.',
      },
      ...capture.content,
    ],
    isError: true,
  };
}

// A previous session release must be confirmed before new input goes out.
// Returns the error result that ends the call, or null to proceed.
async function awaitPendingSessionRelease(sessionId, args, context) {
  cancelDeferredComputerSessionRelease(sessionId);
  try {
    const released = await waitForComputerRelease(
      pendingComputerSessionReleases.get(sessionId)?.promise,
      context.signal
    );
    if (!released) {
      return computerErrorResult(
        formatComputerToolError(
          'computer_cleanup_pending: previous session release was not confirmed; no new input was dispatched',
          args
        )
      );
    }
    context.signal?.throwIfAborted();
  } catch (error) {
    if (context.signal?.aborted) return cancelledComputerResult(sessionId, false);
    throw error;
  }
  return null;
}

// Posts the command, following one bridge republication. The desktop app
// republishes the bridge with a fresh port/token when it restarts:
// observations are replay-safe; input may already have executed before the
// response vanished, so it is never sent twice. Returns { bridge, response }
// or the error result that ends the call.
async function postWithBridgeRecovery(discovery, command, encoded, sessionId, context) {
  let bridge = discovery;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await postComputerCommand(bridge, encoded, { signal: context?.signal });
      if (response.status === 401 && attempt === 0 && isReplaySafeComputerCommand(command)) {
        const replacement = readDiscovery();
        if (bridgeDiscoveryChanged(bridge, replacement)) {
          await response.body?.cancel().catch(() => undefined);
          bridge = replacement;
          continue;
        }
      }
      return { bridge, response };
    } catch (error) {
      const externallyAborted = context?.signal?.aborted === true;
      const timedOut = error?.name === 'TimeoutError';
      const mutationMayHaveExecuted = computerMutationMayHaveExecuted(command);
      if (attempt === 0 && !externallyAborted && !timedOut) {
        const replacement = readDiscovery();
        if (bridgeDiscoveryChanged(bridge, replacement)) {
          if (isReplaySafeComputerCommand(command)) {
            bridge = replacement;
            continue;
          }
          return computerUncertainMutationResult();
        }
      }
      if (!externallyAborted && mutationMayHaveExecuted) return computerUncertainMutationResult();
      if (externallyAborted) return cancelledComputerResult(sessionId, mutationMayHaveExecuted);
      return computerErrorResult(`Error: ${timedOut ? 'computer bridge timed out' : BRIDGE_UNAVAILABLE_MESSAGE}`);
    }
  }
  return computerErrorResult(`Error: ${BRIDGE_UNAVAILABLE_MESSAGE}`);
}

// The read-only continuation for pending computer work. Control can change
// between Resume and the read-only capture: keep the original progress and
// wait again; never resubmit input.
function pendingWorkReader(bridge, sessionId, context) {
  return async (readCommand) => {
    const pendingResponse = await postComputerCommand(
      bridge,
      { ...readCommand, ...(sessionId ? { session_id: sessionId } : {}) },
      { signal: context.signal }
    );
    const pendingBody = await readComputerBridgeJson(pendingResponse);
    if (
      readCommand.action === 'capture' &&
      pendingBody?.ok === false &&
      pendingResponse.status !== 401 &&
      pendingResponse.status !== 403 &&
      /^computer_user_control_active(?::|$)/.test(String(pendingBody.error || ''))
    ) {
      return { text: JSON.stringify({ ok: false, status: 'paused', code: 'computer_user_intervention_pending' }) };
    }
    if (!pendingResponse.ok || !pendingBody?.ok) throw new Error('computer_pending_connection_lost');
    validateComputerReply(pendingBody.value);
    return pendingBody.value;
  };
}

function computerToolResult(value, args) {
  const text = canonicalComputerResultText(String(value.text || 'OK'), args);
  const content = [{ type: 'text', text }];
  if (value.image?.data && value.image?.mimeType) {
    content.push({
      type: 'image',
      ...(computerImageDimensions(text) ?? {}),
      source: {
        type: 'base64',
        media_type: String(value.image.mimeType),
        data: String(value.image.data),
      },
    });
  }
  return {
    content,
    ...(canonicalComputerResultIsError(text, args) ? { isError: true } : {}),
  };
}

/** Execute one `computer` tool call. Returns MCP-shaped content so the
 *  internal-tools normalizer forwards text and screenshot images as-is. */
export async function executeComputerTool(rawArgs, context = {}) {
  const discovery = readDiscovery();
  if (!discovery) return computerErrorResult(`Error: ${BRIDGE_UNAVAILABLE_MESSAGE}`);
  // Resolve the argument shape once so validation, host translation, and the
  // canonical result text all read the same input.
  const args = normalizeComputerToolArgs(rawArgs);
  const validationError = validateComputerToolArgs(args);
  if (validationError) return computerErrorResult(`Error: ${validationError}`);
  const command = toComputerHostCommand(args);
  const sessionId = context?.sessionId ? String(context.sessionId) : '';
  const encoded = JSON.stringify({ ...command, ...(sessionId ? { session_id: sessionId } : {}) });
  if (Buffer.byteLength(encoded) > MAX_COMPUTER_REQUEST_BYTES) {
    return computerErrorResult('Error: computer request exceeds byte limit; no input was dispatched');
  }
  const releaseError = await awaitPendingSessionRelease(sessionId, args, context);
  if (releaseError) return releaseError;
  trackComputerSession(sessionId, command);
  const posted = await postWithBridgeRecovery(discovery, command, encoded, sessionId, context);
  if (!posted.response) return posted;
  const { bridge, response } = posted;
  const read = await readComputerBridgeBody(response, command, sessionId, context);
  if (read.result) return read.result;
  const { body } = read;
  if (!body?.ok) {
    const message = String(body?.error || `computer bridge request failed (HTTP ${response.status})`);
    return (
      (await refusalWithRecapture(message, args, context)) ?? computerErrorResult(formatComputerToolError(message, args))
    );
  }
  const value = body.value || {};
  try {
    validateComputerReply(value);
  } catch (error) {
    return computerErrorResult(`Error: ${error.message}; input may have executed and was not replayed`);
  }
  if (!isPendingComputerWork(value)) return computerToolResult(value, args);
  const settled = await settlePendingComputerWork(value, command, bridge, sessionId, context);
  return settled.result || computerToolResult(settled.value, args);
}

function trackComputerSession(sessionId, command) {
  if (!sessionId) return;
  hostBoundComputerSessions.add(sessionId);
  activeComputerExecutions.add(sessionId);
  if (computerMutationMayHaveExecuted(command)) {
    activeComputerSessions.add(sessionId);
  }
}

// The bridge reply's JSON body, or the tool result to return when the body
// is unreadable or the caller cancelled meanwhile.
async function readComputerBridgeBody(response, command, sessionId, context) {
  let body;
  try {
    body = await readComputerBridgeJson(response);
  } catch {
    if (context.signal?.aborted) {
      return { result: cancelledComputerResult(sessionId, computerMutationMayHaveExecuted(command)) };
    }
    const message = computerMutationMayHaveExecuted(command)
      ? 'computer command may have executed but the bridge returned an invalid response; inspect fresh state before retrying'
      : `computer bridge returned an invalid response (HTTP ${response.status})`;
    return { result: computerErrorResult(`Error: ${message}`) };
  }
  if (context.signal?.aborted) {
    return { result: cancelledComputerResult(sessionId, computerMutationMayHaveExecuted(command)) };
  }
  return { body };
}

// The settled value of a pending reply, or the tool result when the wait
// was interrupted.
async function settlePendingComputerWork(value, command, bridge, sessionId, context) {
  try {
    const settled = await continuePendingComputerWork(
      value,
      command,
      pendingWorkReader(bridge, sessionId, context),
      context.signal
    );
    return { value: settled };
  } catch {
    if (context.signal?.aborted && sessionId) await abortComputerSession(sessionId);
    return {
      result: computerErrorResult(
        'Error: pending computer work was interrupted; no input was replayed. Inspect fresh state before continuing.'
      ),
    };
  }
}

async function sendComputerSessionControl(sessionId, action, timeoutMs) {
  const discovery = readDiscovery();
  if (!discovery) return false;
  try {
    const response = await postComputerCommand(
      discovery,
      {
        action,
        session_id: sessionId,
      },
      { timeoutMs }
    );
    const body = await readComputerBridgeJson(response);
    return response.ok && body?.ok === true;
  } catch {
    return false;
  }
}

async function abortComputerSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  cancelDeferredComputerSessionRelease(id);
  const aborted = await sendComputerSessionControl(id, 'session_abort', SESSION_ABORT_TIMEOUT_MS);
  if (aborted) {
    activeComputerExecutions.delete(id);
    activeComputerSessions.delete(id);
    hostBoundComputerSessions.delete(id);
  }
  return aborted;
}

/** End the visible Computer Use execution at agent-turn settlement without
 * dropping the warm worker and observation refs kept for a possible follow-up. */
export async function endComputerExecution(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !activeComputerExecutions.has(id)) return false;
  const ended = await sendComputerSessionControl(id, 'execution_end', EXECUTION_END_TIMEOUT_MS);
  if (ended) activeComputerExecutions.delete(id);
  return ended;
}

function cancelDeferredComputerSessionRelease(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const timer = deferredComputerSessionReleases.get(id);
  if (!timer) return false;
  clearTimeout(timer);
  deferredComputerSessionReleases.delete(id);
  return true;
}

/** A caller can stop waiting without cancelling or duplicating the old cleanup. */
function waitForComputerRelease(pending, signal) {
  if (!pending) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Keep observation-bound refs/frames alive across the next model turn while
 * guaranteeing idle workflows eventually release session workers and target claims. */
export function deferComputerSessionRelease(sessionId, delayMs = DEFERRED_SESSION_RELEASE_MS) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  cancelDeferredComputerSessionRelease(id);
  if (pendingComputerSessionReleases.has(id)) return false;
  // A session that never reached the host owns nothing there. Releasing it
  // anyway would only raise a no-op cleanup on the desktop every turn.
  if (!hostBoundComputerSessions.has(id) && !activeComputerSessions.has(id)) return false;
  const delay = Math.max(1, Number(delayMs) || DEFERRED_SESSION_RELEASE_MS);
  const timer = setTimeout(() => {
    deferredComputerSessionReleases.delete(id);
    // A release already in flight is this idle cleanup's outcome too.
    if (pendingComputerSessionReleases.has(id)) return;
    void startComputerSessionRelease(id, SESSION_RELEASE_TIMEOUT_MS, true).catch(() => false);
  }, delay);
  timer.unref?.();
  deferredComputerSessionReleases.set(id, timer);
  return true;
}

/** One in-flight host release per session; `deferred` marks the idle timer's
 * speculative attempt so a caller asking for cleanup never inherits it. */
function startComputerSessionRelease(id, timeoutMs, deferred) {
  activeComputerExecutions.delete(id);
  activeComputerSessions.delete(id);
  const record = { deferred, promise: null };
  record.promise = sendComputerSessionControl(id, 'session_release', timeoutMs)
    .then((released) => {
      if (released) hostBoundComputerSessions.delete(id);
      else if (hostBoundComputerSessions.has(id)) activeComputerSessions.add(id);
      return released;
    })
    .finally(() => {
      if (pendingComputerSessionReleases.get(id) === record) pendingComputerSessionReleases.delete(id);
    });
  pendingComputerSessionReleases.set(id, record);
  return record.promise;
}

/** Explicit session cleanup invalidates refs/frames and releases the
 * agent worker and target claims immediately. */
export async function releaseComputerSession(sessionId, timeoutMs = SESSION_RELEASE_TIMEOUT_MS) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  for (;;) {
    cancelDeferredComputerSessionRelease(id);
    const pending = pendingComputerSessionReleases.get(id);
    if (!pending) break;
    // Another caller's release is this caller's release too. The idle timer's
    // is not: its request was composed before this cleanup was asked for, so a
    // host that refused it would silently become this caller's failure and
    // leave the closing session's worker and target claims pinned. Wait it out,
    // then issue the release this caller is waiting on.
    if (!pending.deferred) return await pending.promise;
    await pending.promise.catch(() => false);
  }
  return await startComputerSessionRelease(id, timeoutMs, false);
}

/** Process-shutdown backstop. The deferred release timer is unref'd, so a
 * runtime that exits first would leave host session workers and target claims
 * pinned until they go stale. Entry points call this on the way out; with no
 * bridge on disk it costs nothing. Returns the released session count. */
export async function releaseAllComputerSessions(timeoutMs = SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS) {
  for (const id of [...deferredComputerSessionReleases.keys()]) {
    cancelDeferredComputerSessionRelease(id);
  }
  const ids = [...new Set([...hostBoundComputerSessions, ...activeComputerSessions])];
  if (ids.length === 0) return 0;
  const timeout = Math.max(1, Number(timeoutMs) || SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS);
  const outcomes = await Promise.all(
    ids.map(async (id) => {
      try {
        return await waitForComputerRelease(releaseComputerSession(id, timeout), AbortSignal.timeout(timeout));
      } catch {
        return false;
      }
    })
  );
  return outcomes.filter(Boolean).length;
}
