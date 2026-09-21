/**
 * Loopback client for the desktop app's agent browser bridge.
 *
 * The Mixdog desktop app (apps/desktop/src/main/browser-host.ts) serves
 * browser commands on 127.0.0.1 and advertises { port, token } through a
 * heartbeated discovery file in the Mixdog data directory. This client is the
 * runtime half: a sync availability probe that gates the `browser` tool
 * surface, and the async executor behind actual tool calls.
 */
import { BROWSER_OBSERVATION_ACTIONS, validateBrowserToolArgs } from './action-schema.mjs';
import { bridgeDiscoveryChanged, readBridgeDiscovery, readBridgeDiscoveryDetail } from '../bridge-discovery.mjs';
import { traceBrowserTiming } from './timing.mjs';
import { base64ByteLength, inlineFileKind } from '../shared/inline-file-kind.mjs';

const DISCOVERY_FILE = 'browser-bridge.json';
/** Ceiling above the bridge's own per-action timeouts (navigation settle,
 *  surface auto-open), so the bridge's specific error wins over a bare abort. */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 250_000;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((100 * 1024 * 1024 * 4) / 3) + 4;
const MAX_FILE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;
const SAFE_RASTER_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const RETRYABLE_ACTIONS = new Set(BROWSER_OBSERVATION_ACTIONS);
const browserTurns = new Map();

/** Terminal lifecycle cleanup uses the exact bridge that owned this turn.
 * It is never retried after dispatch and never inherits the cancelled tool signal. */
export async function finishBrowserTurn(sessionId, turnId, { aborted = false } = {}) {
  const turns = browserTurns.get(sessionId);
  const discovery = turns?.get(turnId);
  if (!discovery) return;
  turns.delete(turnId);
  if (!turns.size) browserTurns.delete(sessionId);
  const result = await requestBridge(
    discovery,
    JSON.stringify({
      action: 'finish_turn',
      session_id: sessionId,
      turn_id: turnId,
      // A turn that ended well may still be continued by the next message,
      // so its pages stay; only an aborted run reclaims them.
      aborted: aborted === true,
    }),
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    { sessionId, turnId, action: 'finish_turn' }
  );
  if (result.status !== 200 || result.body?.ok === false || result.body?.error) {
    throw new Error(
      `Browser task cleanup failed (HTTP ${result.status}): ${result.body?.error || 'bridge rejected cleanup'}`
    );
  }
}

const BRIDGE_UNAVAILABLE_MESSAGE = 'browser use is unavailable; open the Mixdog desktop app and enable Browser Use';

/** Sync gate for the session tool surface (featureDisallowedTools). */
export function browserBridgeAvailableSync() {
  return readDiscovery() !== null;
}

function readDiscovery() {
  return readBridgeDiscovery(DISCOVERY_FILE);
}

function rememberBrowserTurn(sessionId, turnId, discovery) {
  if (!turnId) return;
  const turns = browserTurns.get(sessionId) ?? new Map();
  turns.set(turnId, discovery);
  browserTurns.set(sessionId, turns);
}

function browserToolError(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function attachBrowserMedia(content, value) {
  if (value.image?.data && value.image?.mimeType) {
    const mimeType = String(value.image.mimeType);
    const data = String(value.image.data);
    if (!['image/jpeg', 'image/png'].includes(mimeType) || data.length > MAX_IMAGE_BASE64_CHARS) {
      return browserToolError('browser bridge returned an invalid image');
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data },
    });
  }
  if (value.file?.data && value.file?.mimeType) {
    const mimeType = String(value.file.mimeType);
    const data = String(value.file.data);
    const filename = String(value.file.name || 'download');
    if (
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) ||
      filename.length > 255 ||
      /[\u0000-\u001f/\\]/.test(filename) ||
      data.length > MAX_FILE_BASE64_CHARS
    ) {
      return browserToolError('browser bridge returned an invalid file');
    }
    if (SAFE_RASTER_IMAGE_TYPES.has(mimeType.toLowerCase())) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data },
      });
    } else if (inlineFileKind(mimeType, data) === 'binary') {
      // No provider accepts an archive or a spreadsheet as an inline block, and
      // the listing above already names the file on disk. Point at it instead
      // of carrying megabytes of base64 through the conversation.
      content.push({
        type: 'text',
        text: `Download ${filename} (${mimeType}, ${base64ByteLength(data)} bytes) is binary and stays on disk; open it from the path listed above with read.`,
      });
    } else {
      content.push({ type: 'file', data, mimeType, filename });
    }
  }
  return null;
}

/** Why the bridge is unavailable right now, so a stale file names its dead
 *  writer instead of asking the user to enable a setting that is already on. */
function unavailableMessage() {
  const { reason } = readBridgeDiscoveryDetail(DISCOVERY_FILE);
  return reason && reason !== 'missing'
    ? `${BRIDGE_UNAVAILABLE_MESSAGE} (discovery ${reason})`
    : BRIDGE_UNAVAILABLE_MESSAGE;
}

class BrowserBridgeResponseError extends Error {}

async function requestBridge(discovery, encodedPayload, signal, timingContext) {
  const started = performance.now();
  let body;
  let status;
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
      },
      body: encodedPayload,
      signal,
    });
    status = response.status;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new BrowserBridgeResponseError(`browser bridge response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    try {
      body = await response.json();
      return { body, status: response.status };
    } catch {
      throw new BrowserBridgeResponseError(`browser bridge returned an invalid response (HTTP ${response.status})`);
    }
  } finally {
    traceBrowserTiming(timingContext, performance.now() - started, body, status);
  }
}

function uncertainMutation(message) {
  return browserToolError(`${message}; the action may have executed and was not replayed`);
}

/** Execute one `browser` tool call. Returns MCP-shaped content so the
 *  internal-tools normalizer forwards text and screenshot images as-is. */
export async function executeBrowserTool(args, options = {}) {
  const validated = validateBrowserToolArgs(args, { tool: options.tool });
  if (!validated.ok) return browserToolError(validated.error);
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return browserToolError('browser session context is unavailable');
  const payload = {
    action: validated.action,
    ...validated.input,
    session_id: sessionId,
    ...(Number.isFinite(Number(options.turnId)) && Number(options.turnId) > 0
      ? { turn_id: Math.trunc(Number(options.turnId)) }
      : {}),
  };
  const encodedPayload = JSON.stringify(payload);
  if (Buffer.byteLength(encodedPayload) > MAX_REQUEST_BYTES) {
    return browserToolError(`browser command exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  let discovery = readDiscovery();
  if (!discovery) return browserToolError(unavailableMessage());
  rememberBrowserTurn(sessionId, payload.turn_id, discovery);
  // An observation can be reported as a plain failure; a state-changing action
  // that may already have run must say so instead.
  const settleFailure = (message) =>
    RETRYABLE_ACTIONS.has(validated.action) ? browserToolError(message) : uncertainMutation(message);
  let bridgeResult;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      bridgeResult = await requestBridge(
        discovery,
        encodedPayload,
        options.signal
          ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        { sessionId, turnId: payload.turn_id, action: validated.action }
      );
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        return settleFailure('browser bridge timed out and cancelled the active command');
      }
      if (options.signal?.aborted) return settleFailure('browser command cancelled');
      const replacement = readDiscovery();
      if (attempt === 0 && bridgeDiscoveryChanged(discovery, replacement)) {
        if (RETRYABLE_ACTIONS.has(validated.action)) {
          discovery = replacement;
          rememberBrowserTurn(sessionId, payload.turn_id, discovery);
          continue;
        }
        return uncertainMutation('browser bridge was replaced after command dispatch');
      }
      if (!RETRYABLE_ACTIONS.has(validated.action)) {
        const message =
          error instanceof BrowserBridgeResponseError
            ? error.message
            : 'browser bridge connection failed after command dispatch';
        return uncertainMutation(message);
      }
      if (error instanceof BrowserBridgeResponseError) return browserToolError(error.message);
      return browserToolError(unavailableMessage());
    }
  }
  if (!bridgeResult) return browserToolError(unavailableMessage());
  const { body, status } = bridgeResult;
  if (!body?.ok) {
    const message = String(body?.error || `browser bridge request failed (HTTP ${status})`);
    return {
      content: [{ type: 'text', text: message.startsWith('Error:') ? message : `Error: ${message}` }],
      isError: true,
    };
  }
  const value = body.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value : {};
  const text = String(value.text || 'OK');
  if (text.length > MAX_TEXT_CHARS) return browserToolError('browser bridge returned oversized text');
  const content = [{ type: 'text', text }];
  const mediaError = attachBrowserMedia(content, value);
  if (mediaError) return mediaError;
  // An inconclusive outcome (a postcondition that already held) is a warning
  // in the reply text, not a failure: the action itself executed once.
  return {
    content,
    ...(value.outcome === 'blocked' ? { isError: true } : {}),
  };
}
