// Execution-call projection for the fixed tool bridge. A wire call
// `call_tool {name: T, arguments: A}` (id X) becomes the execution call
// `{ id: X, name: T, arguments: A, wireCall }` before eager admission and
// classification, so every policy, ordering, cache, hook, approval and audit
// layer sees the target itself. The tool result still answers wire id X and
// the transcript keeps the original wire call (`wireCall`, an immutable copy).
// Non-bridge sessions and every other call pass through unchanged.
import { formatInvalidToolArgsResult, isInvalidToolArgsMarker } from '../../providers/lib/openai-tool-args.mjs';
import {
  BRIDGE_CALL_TOOL_NAME,
  bridgeErrorText,
  isToolBridgeEnabled,
  resolveBridgeTarget,
} from '../../runtime-core/tool-bridge.mjs';

const CALL_TOOL_KEYS = new Set(['name', 'arguments']);

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function projectionFailure(wireCall, wire, text) {
  return { id: wireCall.id, name: wireCall.name, arguments: wireCall.arguments, wireCall: wire, bridgeError: text };
}

/**
 * @returns the execution call for `wireCall`: the projected target call, a
 *   call carrying `bridgeError` (answered with that error, never executed),
 *   or `wireCall` itself when no projection applies. Idempotent.
 */
export function resolveExecutionToolCall(wireCall, session) {
  if (!wireCall || wireCall.name !== BRIDGE_CALL_TOOL_NAME || wireCall.wireCall || !isToolBridgeEnabled(session)) {
    return wireCall;
  }
  const wire = deepFreeze(structuredClone(wireCall));
  const args = wireCall.arguments;
  if (isInvalidToolArgsMarker(args)) return projectionFailure(wireCall, wire, formatInvalidToolArgsResult(wireCall));
  if (!isPlainObject(args)) {
    return projectionFailure(
      wireCall,
      wire,
      bridgeErrorText('INVALID_ARGUMENTS', 'call_tool requires {name, arguments}.')
    );
  }
  const extra = Object.keys(args).filter((key) => !CALL_TOOL_KEYS.has(key));
  if (extra.length) {
    return projectionFailure(
      wireCall,
      wire,
      bridgeErrorText('INVALID_ARGUMENTS', `call_tool does not accept: ${extra.join(', ')}.`)
    );
  }
  if (!isPlainObject(args.arguments)) {
    return projectionFailure(
      wireCall,
      wire,
      bridgeErrorText('INVALID_ARGUMENTS', 'call_tool arguments must be an object of the target tool arguments.')
    );
  }
  const target = resolveBridgeTarget(session, args.name);
  if (target.error) return projectionFailure(wireCall, wire, bridgeErrorText(target.error.code, target.error.message));
  const call = { id: wireCall.id, name: target.name, arguments: structuredClone(args.arguments), wireCall: wire };
  // The target definition drives read-only classification of the call; it is
  // never serialized with the call.
  Object.defineProperty(call, 'bridgeTool', { value: target.tool, enumerable: false });
  return call;
}

export function resolveExecutionToolCalls(calls, session) {
  return Array.isArray(calls) ? calls.map((call) => resolveExecutionToolCall(call, session)) : calls;
}

/**
 * The classification tool list for `calls`: `tools` plus the definitions of
 * bridged targets that are not on it, so a bridged target is classified
 * (read-only, dedup, stale-read invalidation) exactly like a direct call.
 */
export function bridgeClassificationTools(tools, calls) {
  const base = Array.isArray(tools) ? tools : [];
  const seen = new Set(base.map((tool) => tool?.name));
  const extra = [];
  for (const call of calls || []) {
    const definition = call?.bridgeTool;
    if (!definition || seen.has(definition.name)) continue;
    seen.add(definition.name);
    extra.push(definition);
  }
  return extra.length ? [...base, ...extra] : tools;
}
