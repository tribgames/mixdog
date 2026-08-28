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
import { validateBrowserToolArgs } from './action-schema.mjs';

const DISCOVERY_FILE = 'browser-bridge.json';
const DISCOVERY_VERSION = 1;
/** Bridge heartbeat touches the file every 60s; anything older is a crash
 *  leftover and must not surface a dead tool. */
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;
/** Ceiling above the bridge's own per-action timeouts (navigation settle,
 *  surface auto-open), so the bridge's specific error wins over a bare abort. */
const REQUEST_TIMEOUT_MS = 45_000;

const BRIDGE_UNAVAILABLE_MESSAGE =
  'browser use is unavailable; open the Mixdog desktop app (the browser tool drives its Utilities → Browser Use pane)';

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

/** Execute one `browser` tool call. Returns MCP-shaped content so the
 *  internal-tools normalizer forwards text and screenshot images as-is. */
export async function executeBrowserTool(args, options = {}) {
  const validated = validateBrowserToolArgs(args);
  if (!validated.ok) {
    return { content: [{ type: 'text', text: `Error: ${validated.error}` }], isError: true };
  }
  let discovery = readDiscovery();
  if (!discovery) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  const payload = {
    action: validated.action,
    ...validated.input,
    ...(options.sessionId ? { session_id: String(options.sessionId) } : {}),
    ...(Number.isFinite(Number(options.turnId)) && Number(options.turnId) > 0
      ? { turn_id: Math.trunc(Number(options.turnId)) }
      : {}),
  };
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${discovery.token}`,
        },
        body: JSON.stringify(payload),
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        return { content: [{ type: 'text', text: 'Error: browser bridge timed out and cancelled the active command' }], isError: true };
      }
      if (options.signal?.aborted) {
        return { content: [{ type: 'text', text: 'Error: browser command cancelled' }], isError: true };
      }
      const replacement = readDiscovery();
      const changed = replacement
        && (replacement.port !== discovery.port || replacement.token !== discovery.token);
      if (attempt === 0 && changed) {
        discovery = replacement;
        continue;
      }
      return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
    }
  }
  if (!response) {
    return { content: [{ type: 'text', text: `Error: ${BRIDGE_UNAVAILABLE_MESSAGE}` }], isError: true };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { content: [{ type: 'text', text: `Error: browser bridge returned an invalid response (HTTP ${response.status})` }], isError: true };
  }
  if (!body?.ok) {
    const message = String(body?.error || `browser bridge request failed (HTTP ${response.status})`);
    return { content: [{ type: 'text', text: message.startsWith('Error:') ? message : `Error: ${message}` }], isError: true };
  }
  const value = body.value || {};
  const content = [{ type: 'text', text: String(value.text || 'OK') }];
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
  if (value.file?.data && value.file?.mimeType) {
    const mimeType = String(value.file.mimeType);
    if (mimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: String(value.file.data),
        },
      });
    } else {
      content.push({
        type: 'file',
        data: String(value.file.data),
        mimeType,
        filename: String(value.file.name || 'download'),
      });
    }
  }
  return { content };
}