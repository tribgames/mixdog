/**
 * Loopback client for the desktop app's visualize bridge. The desktop app
 * advertises { port, token } through `visualize-bridge.json`; this runtime
 * half is the sync availability probe and the executor behind tool calls.
 * Request: POST /command { sessionId, cwd, action, input }.
 * Response: { ok:true, text, tabs?, path? } | { ok:false, error }.
 */
import { bridgeDiscoveryChanged, readBridgeDiscovery, readBridgeDiscoveryDetail } from '../bridge-discovery.mjs';
import { visualizeOwnerToolMeta } from './tool-meta.mjs';

const DISCOVERY_FILE = 'visualize-bridge.json';
const REQUEST_TIMEOUT_MS = 30_000;
/** `export` renders a page and writes a file; the desktop host's own deadline
 *  for it (45 s) is shorter, so a timeout is reported by the host, which then
 *  writes nothing, rather than raced by this client. */
const EXPORT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ACTIONS = new Set(['open', 'close', 'annotate', 'capture', 'export', 'check', 'inspect']);
const INLINE_KINDS = ['mermaid', 'svg', 'chart', 'html', 'markdown'];
const MAX_INLINE_BYTES = 512 * 1024;
const BRIDGE_UNAVAILABLE_MESSAGE = 'visualize is unavailable; the Mixdog desktop app must be running';

export function visualizeBridgeAvailableSync() {
  return readBridgeDiscovery(DISCOVERY_FILE) !== null;
}

function toolError(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function unavailableMessage() {
  const { reason } = readBridgeDiscoveryDetail(DISCOVERY_FILE);
  return reason && reason !== 'missing'
    ? `${BRIDGE_UNAVAILABLE_MESSAGE} (discovery ${reason})`
    : BRIDGE_UNAVAILABLE_MESSAGE;
}

export function validateVisualizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'visualize arguments must be an object' };
  }
  if (!ACTIONS.has(args.action))
    return { ok: false, error: 'action must be open, close, annotate, capture, export, check, or inspect' };
  const input = args.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'input must be an object' };
  if (args.action === 'open' && input.content != null) {
    const content = input.content;
    if (input.targets != null)
      return { ok: false, error: 'open takes either input.targets or input.content, not both' };
    if (typeof content !== 'object' || Array.isArray(content)) {
      return { ok: false, error: 'open input.content must be { kind, source, title? }' };
    }
    if (!INLINE_KINDS.includes(content.kind)) {
      return { ok: false, error: `open input.content.kind must be one of ${INLINE_KINDS.join(', ')}` };
    }
    if (typeof content.source !== 'string' || !content.source.trim()) {
      return { ok: false, error: 'open input.content.source must be a non-empty string' };
    }
    if (Buffer.byteLength(content.source) > MAX_INLINE_BYTES) {
      return { ok: false, error: `open input.content.source must be at most ${MAX_INLINE_BYTES / 1024} KiB` };
    }
    if (content.title != null && typeof content.title !== 'string') {
      return { ok: false, error: 'open input.content.title must be a string' };
    }
    if (input.version != null && !(Number.isInteger(input.version) && input.version >= 1)) {
      return { ok: false, error: 'open input.version must be a positive integer (a kept version number)' };
    }
  } else if (args.action === 'open') {
    const targets = input.targets;
    if (
      !Array.isArray(targets) ||
      targets.length < 1 ||
      targets.length > 3 ||
      targets.some((target) => typeof target !== 'string' || !target.trim())
    ) {
      return { ok: false, error: 'open requires input.targets: 1-3 non-empty strings' };
    }
    if (targets.some((target) => /^https?:\/\//i.test(target.trim())) && targets.length > 1) {
      return { ok: false, error: 'a web URL must be the only target; do not mix it with files or other URLs' };
    }
    if (input.version != null && !(Number.isInteger(input.version) && input.version >= 1)) {
      return { ok: false, error: 'open input.version must be a positive integer (a kept version number)' };
    }
  }
  if (
    ['annotate', 'capture', 'export', 'check', 'inspect'].includes(args.action) &&
    (typeof input.tab !== 'string' || !input.tab)
  ) {
    return { ok: false, error: `${args.action} requires input.tab` };
  }
  if (args.action === 'inspect') {
    const { viewport, selector } = input;
    if (viewport != null) {
      const sized = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
      if (
        typeof viewport !== 'object' ||
        Array.isArray(viewport) ||
        !sized(viewport.width, 200, 3000) ||
        (viewport.height != null && !sized(viewport.height, 200, 4000))
      ) {
        return {
          ok: false,
          error: 'inspect input.viewport must be { width: 200-3000, height?: 200-4000 } in whole pixels',
        };
      }
    }
    if (selector != null && (typeof selector !== 'string' || !selector.trim() || selector.length > 500)) {
      return { ok: false, error: 'inspect input.selector must be a non-empty CSS selector of at most 500 characters' };
    }
  }
  if (args.action === 'capture' && !(typeof input.output === 'string' && /\.png$/i.test(input.output.trim()))) {
    return { ok: false, error: 'capture requires input.output ending in .png' };
  }
  if (args.action === 'export') {
    if (input.format !== 'png' && input.format !== 'pdf')
      return { ok: false, error: 'export requires input.format png or pdf' };
    if (typeof input.output !== 'string' || !new RegExp('\\.' + input.format + '$', 'i').test(input.output.trim())) {
      return { ok: false, error: `export requires input.output ending in .${input.format}` };
    }
    if (input.version != null && !(Number.isInteger(input.version) && input.version >= 1)) {
      return { ok: false, error: 'export input.version must be a positive integer (a kept version number)' };
    }
    if (input.overwrite != null && typeof input.overwrite !== 'boolean') {
      return { ok: false, error: 'export input.overwrite must be a boolean' };
    }
  }
  return { ok: true, action: args.action, input };
}

async function requestBridge(discovery, payload, signal) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${discovery.token}` },
    body: JSON.stringify(payload),
    signal,
  });
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
    return { body: JSON.parse(text), status: response.status };
  } catch {
    throw new Error(`visualize bridge returned an invalid response (HTTP ${response.status})`);
  }
}

function formatSuccess(body) {
  const lines = [String(body.text ?? '')];
  if (Array.isArray(body.tabs) && body.tabs.length) {
    lines.push(...body.tabs.map((tab) => `${tab.id} ${tab.kind} ${tab.label} → ${tab.target}`));
  }
  if (typeof body.path === 'string' && body.path) lines.push(`path: ${body.path}`);
  return lines.filter(Boolean).join('\n');
}

/** Execute one `visualize` tool call. */
export async function executeVisualizeTool(args, options = {}) {
  const validated = validateVisualizeArgs(args);
  if (!validated.ok) return toolError(validated.error);
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return toolError('visualize session context is unavailable');
  const payload = {
    sessionId,
    cwd: options.cwd || process.cwd(),
    action: validated.action,
    input: validated.input,
  };
  let discovery = readBridgeDiscovery(DISCOVERY_FILE);
  if (!discovery) return toolError(unavailableMessage());
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = AbortSignal.timeout(validated.action === 'export' ? EXPORT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    try {
      result = await requestBridge(
        discovery,
        payload,
        options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
      );
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') return toolError('visualize bridge timed out');
      if (options.signal?.aborted) return toolError('visualize command cancelled');
      const replacement = readBridgeDiscovery(DISCOVERY_FILE);
      if (attempt === 0 && bridgeDiscoveryChanged(discovery, replacement)) {
        discovery = replacement;
        continue;
      }
      return toolError(error?.message?.startsWith('visualize bridge') ? error.message : unavailableMessage());
    }
  }
  const { body, status } = result;
  if (!body?.ok) {
    return toolError(
      String(body?.error || `visualize bridge request failed (HTTP ${status})`).replace(/^Error:\s*/, '')
    );
  }
  // The host ran it for another session's panel: the owner rides as a field
  // (toolMeta, kept with the stored result), never only as prose.
  const toolMeta = visualizeOwnerToolMeta(body.ownerSessionId);
  return { content: [{ type: 'text', text: formatSuccess(body) }], ...(toolMeta ? { toolMeta } : {}) };
}
