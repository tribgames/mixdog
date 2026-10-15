// Shared pre-dispatch deny — single source of truth for the remaining
// control-plane / role scoping rejects. Called by BOTH the eager dispatch
// path (startEagerTool) and the serial dispatch path (executeTool body).
// Returns null when the call is allowed to proceed; otherwise returns the
// Error string the serial path would emit. The eager caller ignores the
// message body and just treats non-null as "do not start eager".
//
// The persisted schema allowlist is also the execution allowlist, and so is the
// rest of the session's tool policy: a tool the policy removed from the schema
// (a disabled feature, delegation) stays refused, and a read-only session runs
// only what its surfaces offer. This keeps a provider-emitted call outside the
// advertised surface from reaching a tool merely because the process-wide
// registry knows its name.
import { isAgentOwner } from '../../agent-owner.mjs';
import { isOffReadonlySurface } from './deferred-call-through.mjs';
import { BRIDGE_CALL_TOOL_NAME, bridgeErrorText, isToolBridgeEnabled } from '../../runtime-core/tool-bridge.mjs';
import { sessionAllowlistExcludes, sessionDisallows } from '../../runtime-core/deferred-tool-availability.mjs';
import { providerToolExclusionReason } from './provider-tool-exclusions.mjs';

const WORKER_DENIED_TOOLS = new Set(['agent', 'ask_user', 'session']);
const BRIDGE_DISCOVERY_TOOL_NAMES = new Set(['load_tool']);

const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i;
const COMPACTED_PATCH_LINE_RE = /^\s*\[mixdog compacted\b[^\]\n]*\]/;

function hasCompactedPatchPlaceholder(call) {
  if (call?.name !== 'apply_patch') return false;
  const value = typeof call?.arguments === 'string' ? call.arguments : call?.arguments?.patch;
  if (typeof value !== 'string') return false;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) continue;
    if (COMPACTED_PATCH_LINE_RE.test(line)) return true;
  }
  return false;
}

function callUrls(call) {
  const value = call?.arguments?.url;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && item.trim())) {
    return value.map((item) => item.trim());
  }
  return [];
}

function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
    const match = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
    return Boolean(match && Number(match[1]) === 127);
  } catch {
    return false;
  }
}

/**
 * Rewrite only calls whose complete URL set has one unambiguous transport.
 * Mixed document/image or public/loopback batches stay on web_fetch, whose
 * existing SSRF checks fail closed rather than broadening local_fetch.
 */
export function routeWebFetchCall(call) {
  if (call?.name !== 'web_fetch') return call;
  // A JSON-stringified array ('["https://a","https://b"]') is a common
  // provider serialisation artifact. Parse it back into real URLs so the
  // fetch surface routes and validates them instead of rejecting the call.
  const rawUrl = call?.arguments?.url;
  if (typeof rawUrl === 'string' && /^\s*\[/.test(rawUrl)) {
    try {
      const parsed = JSON.parse(rawUrl);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((item) => typeof item === 'string' && item.trim())
      ) {
        call.arguments.url = parsed.map((item) => item.trim());
      }
    } catch {
      /* leave the original value for the downstream validator */
    }
  }
  const urls = callUrls(call);
  if (!urls.length) return call;
  if (urls.every(isLoopbackHttpUrl)) {
    call.schemaName = 'web_fetch';
    call.name = 'local_fetch';
  } else if (urls.every((value) => IMAGE_PATH_RE.test(value))) {
    call.schemaName = 'web_fetch';
    call.name = 'image_fetch';
  }
  return call;
}

/**
 * Exported for smoke tests — same runtime deny as the agent loop.
 */
export function preDispatchDenyForSession(sessionRef, call) {
  const name = call?.name;
  if (typeof name !== 'string' || !name) return null;
  // A call_tool request that could not be projected onto its target answers
  // its wire id with the projection error; call_tool itself never dispatches.
  if (typeof call.bridgeError === 'string') return call.bridgeError;
  if (name === BRIDGE_CALL_TOOL_NAME && isToolBridgeEnabled(sessionRef)) {
    return bridgeErrorText('BRIDGE_RECURSION', 'call_tool runs one tool named in its arguments and cannot be dispatched itself.');
  }
  const schemaName = String(call?.schemaName || name);
  // A tool the provider left out of this request still exists in the session;
  // a call to it is answered with why it is unavailable.
  const excluded = providerToolExclusionReason(sessionRef, schemaName);
  if (excluded) return `Error: ${excluded}`;
  // The bridge's discovery tools grant no authority (every call_tool target
  // is judged here under its own name), so an allowlist never strands them.
  const bridgeDiscovery = isToolBridgeEnabled(sessionRef) && BRIDGE_DISCOVERY_TOOL_NAMES.has(schemaName);
  if (!bridgeDiscovery && sessionAllowlistExcludes(sessionRef, schemaName)) {
    return `Error: tool "${name}" is not available on this session's schema allowlist.`;
  }
  if (sessionDisallows(sessionRef, schemaName)) {
    return `Error: tool "${name}" is not available in this session.`;
  }
  if (isOffReadonlySurface(sessionRef, schemaName)) {
    return `Error: tool "${name}" is not available in this read-only session.`;
  }
  if (hasCompactedPatchPlaceholder(call)) {
    return 'Error: [tool-input-validation] apply_patch received a compacted-history placeholder, not executable patch content. Re-read the current target files and submit a fresh full patch; do not replay or reconstruct the stored marker.';
  }
  const _agentOwned = sessionRef?.scope?.startsWith?.('agent:') || isAgentOwner(sessionRef);
  const _controlPlaneTool = WORKER_DENIED_TOOLS.has(name);
  if (_agentOwned && _controlPlaneTool) {
    return `Error: control-plane tool "${name}" is Lead-only and not available to agent workers.`;
  }
  return null;
}
