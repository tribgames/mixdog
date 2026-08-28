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
  toComputerHostCommand,
  validateComputerToolArgs,
} from './action-schema.mjs';

const DISCOVERY_FILE = 'computer-bridge.json';
const DISCOVERY_VERSION = 1;
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;
// Desktop UI Automation queries and input dispatch can be slow; sit above the
// bridge's own per-action timeouts so its specific error wins over a bare abort.
const REQUEST_TIMEOUT_MS = 60_000;
const SESSION_ABORT_TIMEOUT_MS = 8_000;
const READ_ONLY_ACTIONS = new Set([
  'list_windows', 'list_apps', 'diagnose', 'capture', 'snapshot', 'find', 'clipboard_read', 'wait',
  'window_bounds', 'screenshot', 'zoom',
]);
const activeComputerSessions = new Set();

const BRIDGE_UNAVAILABLE_MESSAGE =
  'computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings';

function canonicalResultText(text, args, safetyAcknowledgement = null) {
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
  if (args.action === 'click') value.button = args.input?.button || 'left';
  if (args.action === 'window') value.operation = args.input?.operation;
  if (args.action === 'clipboard') value.operation = args.input?.operation;
  if (safetyAcknowledgement) value.safety_acknowledgement = safetyAcknowledgement;
  return JSON.stringify(value);
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
export async function executeComputerTool(args, context = {}) {
  const discovery = readDiscovery();
  if (!discovery) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  const validationError = validateComputerToolArgs(args);
  if (validationError) {
    return { content: [{ type: 'text', text: `Error: ${validationError}` }], isError: true };
  }
  let safetyAcknowledgement = null;
  if (args.safety?.decision === 'require_confirmation') {
    if (typeof context?.requestApproval !== 'function') {
      return {
        content: [{
          type: 'text',
          text: 'Error: Computer Use confirmation is required but no approval UI is available',
        }],
        isError: true,
      };
    }
    let approval;
    try {
      approval = await context.requestApproval({
        name: 'computer',
        args,
        cwd: context.cwd || process.cwd(),
        sessionId: context.sessionId || null,
        toolCallId: context.toolCallId || null,
        reason: args.safety.explanation,
      });
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: Computer Use confirmation failed: ${error?.message || String(error)}`,
        }],
        isError: true,
      };
    }
    if (approval !== true && approval?.approved !== true) {
      return {
        content: [{
          type: 'text',
          text: `Error: Computer Use action was not approved${approval?.reason ? `: ${approval.reason}` : ''}`,
        }],
        isError: true,
      };
    }
    safetyAcknowledgement = {
      decision: 'confirmed',
      category: args.safety.category,
      explanation: args.safety.explanation,
    };
  }
  let response;
  const command = toComputerHostCommand(args);
  const sessionId = context?.sessionId ? String(context.sessionId) : '';
  const action = String(command?.action || '');
  if (sessionId && !READ_ONLY_ACTIONS.has(action) && command?.read_only !== true) {
    activeComputerSessions.add(sessionId);
  }
  try {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = context?.signal
      ? AbortSignal.any([timeoutSignal, context.signal])
      : timeoutSignal;
    response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify({
        ...command,
        ...(context?.sessionId ? { session_id: String(context.sessionId) } : {}),
      }),
      signal: requestSignal,
    });
  } catch (error) {
    const externallyAborted = context?.signal?.aborted === true;
    const abortConfirmed = externallyAborted && sessionId
      ? await abortComputerSession(sessionId)
      : false;
    const reason = error?.name === 'TimeoutError'
      ? 'computer bridge timed out'
      : externallyAborted
        ? (abortConfirmed
            ? 'computer command aborted; input state and desktop lease were released'
            : 'computer command aborted; host cleanup could not be confirmed')
        : BRIDGE_UNAVAILABLE_MESSAGE;
    return { content: [{ type: 'text', text: `Error: ${reason}` }], isError: true };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { content: [{ type: 'text', text: `Error: computer bridge returned an invalid response (HTTP ${response.status})` }], isError: true };
  }
  if (!body?.ok) {
    const message = String(body?.error || `computer bridge request failed (HTTP ${response.status})`);
    return { content: [{ type: 'text', text: message.startsWith('Error:') ? message : `Error: ${message}` }], isError: true };
  }
  const value = body.value || {};
  const content = [{
    type: 'text',
    text: canonicalResultText(String(value.text || 'OK'), args, safetyAcknowledgement),
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
  return { content };
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
  const aborted = await sendComputerSessionControl(id, 'session_abort', SESSION_ABORT_TIMEOUT_MS);
  if (aborted) activeComputerSessions.delete(id);
  return aborted;
}

/** Best-effort turn cleanup. The desktop host restores any persistent focus,
 * invalidates refs/frames, and releases the cross-session desktop lease. */
export async function releaseComputerSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  activeComputerSessions.delete(id);
  const released = await sendComputerSessionControl(id, 'session_release', REQUEST_TIMEOUT_MS);
  if (!released) activeComputerSessions.add(id);
  return released;
}