/**
 * Loopback client for the desktop app's computer-use bridge.
 *
 * Mirrors browser-bridge/client.mjs: the Mixdog desktop app serves computer
 * commands on 127.0.0.1 and advertises { port, token } through a heartbeated
 * discovery file. This runtime half is a sync availability probe that gates the
 * `computer` tool surface plus the async executor behind tool calls. The bridge
 * only exists while the desktop app runs with Computer Use enabled.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeComputerToolArgs,
  toComputerHostCommand,
  validateComputerToolArgs,
} from './action-schema.mjs';
import {
  computerResultRecovery,
  formatComputerToolError,
} from './error-recovery.mjs';

const DISCOVERY_FILE = 'computer-bridge.json';
const DISCOVERY_VERSION = 1;
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;
// Desktop UI Automation queries and input dispatch can be slow; sit above the
// bridge's own per-action timeouts so its specific error wins over a bare abort.
const REQUEST_TIMEOUT_MS = 150_000;
const SESSION_ABORT_TIMEOUT_MS = 8_000;
const EXECUTION_END_TIMEOUT_MS = 3_000;
const SESSION_RELEASE_TIMEOUT_MS = 60_000;
const DEFERRED_SESSION_RELEASE_MS = 2 * 60_000;
// Shutdown stays bounded: an unresponsive host must not hold the exit path open
// for the full per-session release budget.
const SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS = 5_000;
// Host-level action names, matching what toComputerHostCommand emits: the tool
// schema can produce no other observation action, and anything unlisted is
// treated as a mutation that owns a write-active session.
const READ_ONLY_ACTIONS = new Set([
  'list_windows', 'list_apps', 'diagnose', 'capture', 'clipboard_read', 'wait', 'zoom',
  'verify',
]);

export function isReplaySafeComputerCommand(command) {
  return READ_ONLY_ACTIONS.has(String(command?.action || ''));
}
const activeComputerSessions = new Set();
const deferredComputerSessionReleases = new Map();
// Every session that reached the host owns a worker there, including read-only
// ones that never enter activeComputerSessions. The host reaps those only on an
// explicit release, so shutdown needs the full set.
const hostBoundComputerSessions = new Set();
const activeComputerExecutions = new Set();
const BRIDGE_UNAVAILABLE_MESSAGE =
  'computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings';

export function canonicalComputerResultText(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.action !== 'string') {
    return text;
  }
  value.action = args.action;
  if (args.action === 'list') value.kind = args.input?.kind;
  if (args.action === 'capture') value.mode = args.input?.mode || 'state';
  if (args.action === 'window') value.operation = args.input?.operation;
  if (args.action === 'clipboard') value.operation = args.input?.operation;
  if (args.action === 'act') {
    value.completed_actions = value.completed_steps;
    value.total_actions = value.total_steps;
    value.actions = Array.isArray(value.steps)
      ? value.steps.map((row, index) => {
          const normalized = { ...row };
          normalized.type = args.input?.actions?.[index]?.type || normalized.action;
          normalized.status = ['succeeded', 'failed', 'skipped'].includes(normalized.status)
            ? normalized.status
            : normalized.ok === false ? 'failed' : 'succeeded';
          delete normalized.action;
          delete normalized.ok;
          return normalized;
        })
      : value.steps;
    delete value.completed_steps;
    delete value.total_steps;
    delete value.steps;
  }
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

function canonicalComputerResultIsError(text, args) {
  if (args.action === 'clipboard' && args.input?.operation === 'read') return false;
  try {
    const value = JSON.parse(text);
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.action === args.action
      && value.ok === false,
    );
  } catch {
    return false;
  }
}

function discoveryPath() {
  const dataDir = process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
  return join(dataDir, DISCOVERY_FILE);
}

/** Sync gate for the session tool surface (featureDisallowedTools). */
export function computerBridgeAvailableSync() {
  return readDiscovery() !== null;
}

function readDiscovery() {
  let parsed;
  try {
    const path = discoveryPath();
    if (Date.now() - statSync(path).mtimeMs >= DISCOVERY_MAX_AGE_MS) return null;
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const version = Number(parsed?.version);
  const port = Number(parsed?.port);
  const token = String(parsed?.token || '');
  if (version !== DISCOVERY_VERSION
    || !Number.isInteger(port) || port <= 0 || port > 65_535 || !token) return null;
  return { port, token };
}

/** Execute one `computer` tool call. Returns MCP-shaped content so the
 *  internal-tools normalizer forwards text and screenshot images as-is. */
export async function executeComputerTool(rawArgs, context = {}) {
  const discovery = readDiscovery();
  if (!discovery) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  // Resolve the argument shape once so validation, host translation, and the
  // canonical result text all read the same input.
  const args = normalizeComputerToolArgs(rawArgs);
  const validationError = validateComputerToolArgs(args);
  if (validationError) {
    return { content: [{ type: 'text', text: `Error: ${validationError}` }], isError: true };
  }
  let response;
  const command = toComputerHostCommand(args);
  const sessionId = context?.sessionId ? String(context.sessionId) : '';
  cancelDeferredComputerSessionRelease(sessionId);
  const action = String(command?.action || '');
  if (sessionId) hostBoundComputerSessions.add(sessionId);
  if (sessionId) activeComputerExecutions.add(sessionId);
  if (sessionId && !isReplaySafeComputerCommand(command) && command?.read_only !== true) {
    activeComputerSessions.add(sessionId);
  }
  let bridge = discovery;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = context?.signal
        ? AbortSignal.any([timeoutSignal, context.signal])
        : timeoutSignal;
      response = await fetch(`http://127.0.0.1:${bridge.port}/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify({
          ...command,
          ...(context?.sessionId ? { session_id: String(context.sessionId) } : {}),
        }),
        signal: requestSignal,
      });
      if (response.status === 401 && attempt === 0 && isReplaySafeComputerCommand(command)) {
        const replacement = readDiscovery();
        if (replacement
          && (replacement.port !== bridge.port || replacement.token !== bridge.token)) {
          await response.arrayBuffer().catch(() => undefined);
          bridge = replacement;
          continue;
        }
      }
      break;
    } catch (error) {
      const externallyAborted = context?.signal?.aborted === true;
      const timedOut = error?.name === 'TimeoutError';
      const mutationMayHaveExecuted = !isReplaySafeComputerCommand(command)
        && command?.read_only !== true;
      // The desktop app republishes the bridge with a fresh port/token when it
      // restarts. Observations are replay-safe; input may already have executed
      // before the response vanished, so never send it twice.
      if (attempt === 0 && !externallyAborted && !timedOut) {
        const replacement = readDiscovery();
        if (replacement
          && (replacement.port !== bridge.port || replacement.token !== bridge.token)) {
          if (isReplaySafeComputerCommand(command)) {
            bridge = replacement;
            continue;
          }
          return {
            content: [{
              type: 'text',
              text: 'Error: computer command may have executed and was not replayed; inspect fresh state before retrying',
            }],
            isError: true,
          };
        }
      }
      if (!externallyAborted && mutationMayHaveExecuted) {
        return {
          content: [{
            type: 'text',
            text: 'Error: computer command may have executed and was not replayed; inspect fresh state before retrying',
          }],
          isError: true,
        };
      }
      const abortConfirmed = externallyAborted && sessionId
        ? await abortComputerSession(sessionId)
        : false;
      const reason = timedOut
        ? 'computer bridge timed out'
        : externallyAborted
          ? (abortConfirmed
              ? mutationMayHaveExecuted
                ? 'computer command aborted; input state and session resources were released, but input may have partially executed; inspect fresh state before retrying'
                : 'computer command aborted; input state and session resources were released'
              : mutationMayHaveExecuted
                ? 'computer command aborted; host cleanup could not be confirmed and input may have partially executed; inspect fresh state before retrying'
                : 'computer command aborted; host cleanup could not be confirmed')
          : BRIDGE_UNAVAILABLE_MESSAGE;
      return { content: [{ type: 'text', text: `Error: ${reason}` }], isError: true };
    }
  }
  if (!response) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const message = !isReplaySafeComputerCommand(command) && command?.read_only !== true
      ? 'computer command may have executed but the bridge returned an invalid response; inspect fresh state before retrying'
      : `computer bridge returned an invalid response (HTTP ${response.status})`;
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
  if (!body?.ok) {
    const message = String(body?.error || `computer bridge request failed (HTTP ${response.status})`);
    return { content: [{ type: 'text', text: formatComputerToolError(message, args) }], isError: true };
  }
  const value = body.value || {};
  const text = canonicalComputerResultText(String(value.text || 'OK'), args);
  const content = [{
    type: 'text',
    text,
  }];
  if (value.image?.data && value.image?.mimeType) {
    content.push({
      type: 'image',
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

async function sendComputerSessionControl(sessionId, action, timeoutMs) {
  const discovery = readDiscovery();
  if (!discovery) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify({
        action,
        session_id: sessionId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
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

/** Keep observation-bound refs/frames alive across the next model turn while
 * guaranteeing idle workflows eventually release session workers and target claims. */
export function deferComputerSessionRelease(sessionId, delayMs = DEFERRED_SESSION_RELEASE_MS) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  cancelDeferredComputerSessionRelease(id);
  const delay = Math.max(1, Number(delayMs) || DEFERRED_SESSION_RELEASE_MS);
  const timer = setTimeout(() => {
    deferredComputerSessionReleases.delete(id);
    void releaseComputerSession(id);
  }, delay);
  timer.unref?.();
  deferredComputerSessionReleases.set(id, timer);
  return true;
}

/** Explicit session cleanup invalidates refs/frames and releases the
 * agent worker and target claims immediately. */
export async function releaseComputerSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  cancelDeferredComputerSessionRelease(id);
  activeComputerExecutions.delete(id);
  activeComputerSessions.delete(id);
  const released = await sendComputerSessionControl(id, 'session_release', SESSION_RELEASE_TIMEOUT_MS);
  if (released) hostBoundComputerSessions.delete(id);
  else activeComputerSessions.add(id);
  return released;
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
  const outcomes = await Promise.all(ids.map(async (id) => {
    const released = await sendComputerSessionControl(id, 'session_release', timeout);
    if (released) {
      activeComputerExecutions.delete(id);
      hostBoundComputerSessions.delete(id);
      activeComputerSessions.delete(id);
    }
    return released;
  }));
  return outcomes.filter(Boolean).length;
}