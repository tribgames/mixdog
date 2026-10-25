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
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from '../attachments/limits.mjs';

const DISCOVERY_FILE = 'browser-bridge.json';
/** How long a request may go without a single byte from the bridge. Above the
 *  bridge's own per-action timeouts (navigation settle, surface auto-open), so
 *  the bridge's specific error wins over a bare abort. It is a silence limit,
 *  not a total: a command that waits on the person (an approval card, which has
 *  no limit) is kept alive by the bridge with a space every few seconds
 *  (apps/desktop/src/main/browser/bridge-server.ts), and each byte restarts it. */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 250_000;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4;
const MAX_FILE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;
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
  const result = await requestBridgeWithin(
    discovery,
    JSON.stringify({
      action: 'finish_turn',
      session_id: sessionId,
      turn_id: turnId,
      // A turn that ended well may still be continued by the next message,
      // so its pages stay; only an aborted run reclaims them.
      aborted: aborted === true,
    }),
    undefined,
    { sessionId, turnId, action: 'finish_turn' }
  );
  if (result.status !== 200 || result.body?.ok === false || result.body?.error) {
    throw new Error(
      `Browser task cleanup failed (HTTP ${result.status}): ${result.body?.error || 'bridge rejected cleanup'}`
    );
  }
}

const SECRET_FILL_OUTCOMES = new Set(['entered', 'no_field', 'page_changed', 'blocked', 'expired']);

/** Runtime-only: fill the secret the user handed the desktop for `requestId`
 *  into the field of the page it was bound to (browserHandoffPage), through
 *  the host's isolated-world fill. The value never passes through here; the
 *  host answers only the outcome ('entered', 'no_field', 'page_changed',
 *  'blocked', 'expired'); no desktop or an unknown answer is 'blocked'. */
export async function browserSecretInput(sessionId, requestId, { signal } = {}) {
  const discovery = readBridgeDiscovery(DISCOVERY_FILE);
  if (!discovery || !sessionId || !requestId) return 'blocked';
  try {
    const result = await requestBridgeWithin(
      discovery,
      JSON.stringify({ action: 'secret_input', session_id: String(sessionId), request_id: String(requestId) }),
      signal,
      { sessionId, action: 'secret_input' }
    );
    const text = result.status === 200 && result.body?.ok !== false ? result.body?.value?.text : '';
    return SECRET_FILL_OUTCOMES.has(text) ? text : 'blocked';
  } catch {
    return 'blocked';
  }
}

/** Runtime-only facts about a session's page for an ask_user handoff, with no
 *  value in either direction: `secret_bind` binds `request_id` to the page
 *  (`tab`, else the agent's page) and says its origin and field kind;
 *  `login_accounts` lists the masked saved logins of `url`'s origin;
 *  `page_url` says where the page is now. null when the desktop is absent or
 *  refuses. */
export async function browserHandoffPage(sessionId, action, fields = {}, { signal } = {}) {
  const discovery = readBridgeDiscovery(DISCOVERY_FILE);
  if (!discovery || !sessionId) return null;
  try {
    const result = await requestBridgeWithin(
      discovery,
      JSON.stringify({ ...fields, action, session_id: String(sessionId) }),
      signal,
      { sessionId, action }
    );
    const value = result.status === 200 && result.body?.ok !== false ? result.body?.value : null;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const BRIDGE_UNAVAILABLE_MESSAGE = 'browser use is unavailable; open the Mixdog desktop app and enable Browser Use';

/** Sync gate for the session tool surface (featureDisallowedTools). */
export function browserBridgeAvailableSync() {
  return readBridgeDiscovery(DISCOVERY_FILE) !== null;
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in a bridge-supplied file name
      /[\u0000-\u001f/\\]/.test(filename) ||
      data.length > MAX_FILE_BASE64_CHARS
    ) {
      return browserToolError('browser bridge returned an invalid file');
    }
    if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
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

// Read the body incrementally so a chunked response (no content-length) still
// honours MAX_RESPONSE_BYTES. `onChunk` hears every chunk read (the bridge's
// keep-alive spaces included).
export async function readCappedJson(response, maximum = MAX_RESPONSE_BYTES, onChunk = undefined) {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      onChunk?.();
      bytes += result.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new BrowserBridgeResponseError(`browser bridge response exceeds ${maximum} bytes`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

/** One bridge request's clock: it times out after `timeoutMs` without a byte
 *  from the bridge (`touch` restarts it), with the same TimeoutError an
 *  AbortSignal.timeout gives, and ends with `callerSignal` (the caller's own
 *  reason). `stop` leaves no timer behind. */
export function bridgeDeadline(callerSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const touch = () => {
    stop();
    timer = setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      timeoutMs
    );
    timer.unref?.();
  };
  touch();
  return {
    signal: callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal,
    touch,
    stop,
  };
}

/** `requestBridge` under the silence limit of `bridgeDeadline`. */
export async function requestBridgeWithin(
  discovery,
  encodedPayload,
  callerSignal,
  timingContext,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  const deadline = bridgeDeadline(callerSignal, timeoutMs);
  try {
    return await requestBridge(discovery, encodedPayload, deadline.signal, timingContext, deadline.touch);
  } finally {
    deadline.stop();
  }
}

async function requestBridge(discovery, encodedPayload, signal, timingContext, onActivity = undefined) {
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
    onActivity?.();
    status = response.status;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new BrowserBridgeResponseError(`browser bridge response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    try {
      body = await readCappedJson(response, MAX_RESPONSE_BYTES, onActivity);
      return { body, status: response.status };
    } catch (error) {
      if (error instanceof BrowserBridgeResponseError) throw error;
      // Silence past the clock, or the caller stopping, is not a bad response.
      if (signal?.aborted) throw signal.reason ?? error;
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
    // Set by the runtime from the session, never from the model's arguments: a
    // schedule/webhook run (or work it started) whose saved routine is the
    // user's grant for submits, posts and uploads (human-gate/run-policy.mjs).
    ...(options.unattendedRun === true
      ? { unattended_run: true, unattended_agent: String(options.unattendedAgent || '') }
      : {}),
    ...(Number.isFinite(Number(options.turnId)) && Number(options.turnId) > 0
      ? { turn_id: Math.trunc(Number(options.turnId)) }
      : {}),
  };
  const encodedPayload = JSON.stringify(payload);
  if (Buffer.byteLength(encodedPayload) > MAX_REQUEST_BYTES) {
    return browserToolError(`browser command exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  let discovery = readBridgeDiscovery(DISCOVERY_FILE);
  if (!discovery) return browserToolError(unavailableMessage());
  rememberBrowserTurn(sessionId, payload.turn_id, discovery);
  // An observation can be reported as a plain failure; a state-changing action
  // that may already have run must say so instead.
  const settleFailure = (message) =>
    RETRYABLE_ACTIONS.has(validated.action) ? browserToolError(message) : uncertainMutation(message);
  let bridgeResult;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      bridgeResult = await requestBridgeWithin(discovery, encodedPayload, options.signal, {
        sessionId,
        turnId: payload.turn_id,
        action: validated.action,
      });
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        return settleFailure('browser bridge timed out and cancelled the active command');
      }
      if (options.signal?.aborted) return settleFailure('browser command cancelled');
      const replacement = readBridgeDiscovery(DISCOVERY_FILE);
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
