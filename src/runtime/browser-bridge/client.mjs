/**
 * Loopback client for the desktop app's agent browser bridge.
 *
 * The Mixdog desktop app (apps/desktop/src/main/browser-host.ts) serves
 * browser commands on 127.0.0.1 and advertises { port, token } through a
 * heartbeated discovery file in the Mixdog data directory. This client is the
 * runtime half: a sync availability probe that gates the `browser` tool
 * surface, and the async executor behind actual tool calls.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_OBSERVATION_ACTIONS,
  validateBrowserToolArgs,
} from './action-schema.mjs';

const DISCOVERY_FILE = 'browser-bridge.json';
const DISCOVERY_VERSION = 1;
/** Bridge heartbeat touches the file every 60s; anything older is a crash
 *  leftover and must not surface a dead tool. */
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;
/** Ceiling above the bridge's own per-action timeouts (navigation settle,
 *  surface auto-open), so the bridge's specific error wins over a bare abort. */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 250_000;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(100 * 1024 * 1024 * 4 / 3) + 4;
const MAX_FILE_BASE64_CHARS = Math.ceil(8 * 1024 * 1024 * 4 / 3) + 4;
const SAFE_RASTER_IMAGE_TYPES = new Set([
  'image/gif', 'image/jpeg', 'image/png', 'image/webp',
]);
const RETRYABLE_ACTIONS = new Set(BROWSER_OBSERVATION_ACTIONS);

const BRIDGE_UNAVAILABLE_MESSAGE =
  'browser use is unavailable; open the Mixdog desktop app and enable Browser Use';

function discoveryPath() {
  const dataDir = process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
  return join(dataDir, DISCOVERY_FILE);
}

/** Sync gate for the session tool surface (featureDisallowedTools). */
export function browserBridgeAvailableSync() {
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

class BrowserBridgeResponseError extends Error {}

async function requestBridge(discovery, encodedPayload, signal) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discovery.token}`,
    },
    body: encodedPayload,
    signal,
  });
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new BrowserBridgeResponseError(
      `browser bridge response exceeds ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  try {
    return { body: await response.json(), status: response.status };
  } catch {
    throw new BrowserBridgeResponseError(
      `browser bridge returned an invalid response (HTTP ${response.status})`,
    );
  }
}

function uncertainMutation(message) {
  return {
    content: [{
      type: 'text',
      text: `Error: ${message}; the action may have executed and was not replayed`,
    }],
    isError: true,
  };
}

/** Execute one `browser` tool call. Returns MCP-shaped content so the
 *  internal-tools normalizer forwards text and screenshot images as-is. */
export async function executeBrowserTool(args, options = {}) {
  const validated = validateBrowserToolArgs(args);
  if (!validated.ok) {
    return { content: [{ type: 'text', text: `Error: ${validated.error}` }], isError: true };
  }
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) {
    return { content: [{ type: 'text', text: 'Error: browser session context is unavailable' }], isError: true };
  }
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
    return {
      content: [{ type: 'text', text: `Error: browser command exceeds ${MAX_REQUEST_BYTES} bytes` }],
      isError: true,
    };
  }
  let discovery = readDiscovery();
  if (!discovery) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  let bridgeResult;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      bridgeResult = await requestBridge(
        discovery,
        encodedPayload,
        options.signal
          ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        return RETRYABLE_ACTIONS.has(validated.action)
          ? { content: [{ type: 'text', text: 'Error: browser bridge timed out and cancelled the active command' }], isError: true }
          : uncertainMutation('browser bridge timed out and cancelled the active command');
      }
      if (options.signal?.aborted) {
        return RETRYABLE_ACTIONS.has(validated.action)
          ? { content: [{ type: 'text', text: 'Error: browser command cancelled' }], isError: true }
          : uncertainMutation('browser command cancelled');
      }
      const replacement = readDiscovery();
      const changed = replacement
        && (replacement.port !== discovery.port || replacement.token !== discovery.token);
      if (attempt === 0 && changed) {
        if (RETRYABLE_ACTIONS.has(validated.action)) {
          discovery = replacement;
          continue;
        }
        return uncertainMutation('browser bridge was replaced after command dispatch');
      }
      if (!RETRYABLE_ACTIONS.has(validated.action)) {
        const message = error instanceof BrowserBridgeResponseError
          ? error.message
          : 'browser bridge connection failed after command dispatch';
        return uncertainMutation(message);
      }
      if (error instanceof BrowserBridgeResponseError) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
    }
  }
  if (!bridgeResult) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  const { body, status } = bridgeResult;
  if (!body?.ok) {
    const message = String(body?.error || `browser bridge request failed (HTTP ${status})`);
    return { content: [{ type: 'text', text: message.startsWith('Error:') ? message : `Error: ${message}` }], isError: true };
  }
  const value = body.value && typeof body.value === 'object' && !Array.isArray(body.value)
    ? body.value
    : {};
  const text = String(value.text || 'OK');
  if (text.length > MAX_TEXT_CHARS) {
    return { content: [{ type: 'text', text: 'Error: browser bridge returned oversized text' }], isError: true };
  }
  const content = [{ type: 'text', text }];
  if (value.image?.data && value.image?.mimeType) {
    const mimeType = String(value.image.mimeType);
    const data = String(value.image.data);
    if (!['image/jpeg', 'image/png'].includes(mimeType)
      || data.length > MAX_IMAGE_BASE64_CHARS) {
      return { content: [{ type: 'text', text: 'Error: browser bridge returned an invalid image' }], isError: true };
    }
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data,
      },
    });
  }
  if (value.file?.data && value.file?.mimeType) {
    const mimeType = String(value.file.mimeType);
    const data = String(value.file.data);
    const filename = String(value.file.name || 'download');
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)
      || filename.length > 255
      || /[\u0000-\u001f/\\]/.test(filename)
      || data.length > MAX_FILE_BASE64_CHARS) {
      return { content: [{ type: 'text', text: 'Error: browser bridge returned an invalid file' }], isError: true };
    }
    if (SAFE_RASTER_IMAGE_TYPES.has(mimeType.toLowerCase())) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data,
        },
      });
    } else {
      content.push({
        type: 'file',
        data,
        mimeType,
        filename,
      });
    }
  }
  return { content };
}