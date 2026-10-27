// Tools a provider left out of a request because it cannot accept their input
// schema even after the wire's normalization (a schema with an unknown type
// name, an unresolvable $ref, a non-object root), or that the provider
// rejected with an HTTP 400 naming the schema (dropped for the session).
// The user is told once per session and tool on the turn's display-only stage
// channel (stage 'notice'); a call the model still makes to such a tool is
// answered with the reason instead of running it.
import { geminiToolExclusion } from '../../providers/gemini-schema.mjs';
import { isGeminiFamilyModel } from '../../providers/gemini-family.mjs';
import { anthropicToolExclusion } from '../../providers/lib/anthropic-request-utils.mjs';
import { claudeBridgeInputSchema, wireInputSchema } from '../../providers/lib/claude-bridge-schema.mjs';
import { actionInputUnionFor } from '../../providers/lib/action-input-contract.mjs';
import { isAntigravityClaude } from '../../providers/antigravity-request.mjs';
import { isResponsesFreeformTool } from '../../providers/custom-tool-wire.mjs';
import { ANTHROPIC_NATIVE_PROVIDERS } from '../../runtime-core/tool-catalog-schema.mjs';
import {
  finalizeProviderRequestTools,
  providerNativeToolPrefixCount,
} from '../../runtime-core/provider-request-tools.mjs';

const sessions = new WeakMap();

function exclusionsFor(sessionRef) {
  let state = sessions.get(sessionRef);
  if (!state) {
    state = { noticed: new Set(), current: new Map(), dropped: new Map() };
    sessions.set(sessionRef, state);
  }
  return state;
}

const isSessionRef = (value) => value !== null && typeof value === 'object';

// A schema 400 drop holds for the schema rule that refused it: a route on
// another wire family (a fallback hop, a model switch) sends the tool again.
function droppedOnRoute(sessionRef, name) {
  const entry = isSessionRef(sessionRef) ? sessions.get(sessionRef)?.dropped.get(String(name || '')) : null;
  return entry && entry.family === routeSchemaFamily(sessionRef) ? entry : null;
}

/** A new provider request: exclusions describe the latest request only. */
export function beginProviderToolExclusions(sessionRef) {
  if (isSessionRef(sessionRef)) sessions.get(sessionRef)?.current.clear();
}

export function excludedToolNoticeText({ name, pointer, reason }) {
  return `Tool "${name}" was excluded from this session's requests: its input schema is invalid at ${pointer || '/'} (${reason}). Fix the tool's schema or disable the tool.`;
}

/** Record `exclusion` ({ name, pointer, reason }) for the session's current
 *  request and raise the user notice the first time this tool is excluded. */
export function recordProviderToolExclusion(sessionRef, exclusion, onStageChange) {
  const name = String(exclusion?.name || '');
  if (!name || !isSessionRef(sessionRef)) return;
  const state = exclusionsFor(sessionRef);
  state.current.set(name, exclusion);
  if (state.noticed.has(name)) return;
  state.noticed.add(name);
  try {
    onStageChange?.('notice', { tone: 'warn', message: excludedToolNoticeText(exclusion) });
  } catch {
    /* display-only */
  }
}

const unavailableText = (exclusion) =>
  `tool "${exclusion.name}" is unavailable with the current model: the provider rejected its input schema at ${exclusion.pointer || '/'} (${exclusion.reason}), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it.`;

/** Why `name` cannot be called in the session's current request, or null. */
export function providerToolExclusionReason(sessionRef, name) {
  if (!isSessionRef(sessionRef)) return null;
  const state = sessions.get(sessionRef);
  const key = String(name || '');
  const exclusion = state?.current.get(key) || droppedOnRoute(sessionRef, key);
  return exclusion ? unavailableText(exclusion) : null;
}

/** The provider rejected `exclusion.name`'s schema with an HTTP 400: leave the
 *  tool out of the session's later requests on this wire family and tell the
 *  user once. */
export function dropSessionTool(sessionRef, exclusion, onStageChange) {
  if (!isSessionRef(sessionRef)) return;
  exclusionsFor(sessionRef).dropped.set(exclusion.name, { ...exclusion, family: routeSchemaFamily(sessionRef) });
  recordProviderToolExclusion(sessionRef, exclusion, onStageChange);
}

/** The request's tool surface without the tools dropped for the session
 *  ({ sendTools, requestToolScope }, the same objects when none apply). */
export function withoutDroppedTools(sessionRef, { sendTools, requestToolScope }) {
  const dropped = isSessionRef(sessionRef) ? sessions.get(sessionRef)?.dropped : null;
  if (!dropped?.size) return { sendTools, requestToolScope };
  const prefix = providerNativeToolPrefixCount(sendTools);
  const kept = sendTools.filter((tool, index) => index < prefix || !droppedOnRoute(sessionRef, tool?.name));
  if (kept.length === sendTools.length) return { sendTools, requestToolScope };
  const next = finalizeProviderRequestTools(kept, prefix);
  return { sendTools: next, requestToolScope: { ...requestToolScope, requestTools: next } };
}

// The schema rule of the wire a session's requests use: 'gemini', 'anthropic'
// (Messages), 'antigravity-claude' (Anthropic bridge behind Antigravity) or
// 'openai' (Responses, Codex and every OpenAI-compatible chat route).
function routeSchemaFamily(session) {
  const provider = String(session?.provider || '').toLowerCase();
  const wire = session?.wireRoute?.wire;
  if (provider === 'antigravity-oauth' && isAntigravityClaude(session?.model)) return 'antigravity-claude';
  if (provider === 'gemini' || isGeminiFamilyModel(session?.model)) return 'gemini';
  if (ANTHROPIC_NATIVE_PROVIDERS.has(provider) || wire === 'messages') return 'anthropic';
  return 'openai';
}

function wireExclusion(tool, result) {
  return result.schema ? null : { name: tool.name, pointer: result.pointer || '/', reason: result.reason };
}

// The same normalization + validation the wire applies to `tool`, as
// { name, pointer, reason } when the route leaves it out of its requests.
function schemaExclusion(session, family, tool) {
  switch (family) {
    case 'gemini':
      return geminiToolExclusion(tool);
    case 'anthropic':
      return anthropicToolExclusion(tool, String(session?.provider || 'anthropic').toLowerCase());
    case 'antigravity-claude':
      return wireExclusion(tool, claudeBridgeInputSchema(actionInputUnionFor(tool.inputSchema)));
    default:
      if (tool.inputSchema == null) return null;
      if (/^openai(-oauth)?$/.test(String(session?.provider || '')) && isResponsesFreeformTool(tool)) return null;
      return wireExclusion(tool, wireInputSchema(tool.inputSchema, 'openai'));
  }
}

/** Why `tool` is left out of every request on the session's route, or null.
 *  Validation is a pure function of the tool's schema and the route's wire, so
 *  this holds before the tool was ever sent and stays stable across turns; a
 *  tool the provider rejected with a 400 is dropped for the session. Built-in
 *  tools are never excluded by the schema rule. */
export function routeToolExclusionReason(session, tool) {
  if (!tool) return null;
  const dropped = droppedOnRoute(session, tool.name);
  if (dropped) return unavailableText(dropped);
  const exclusion = schemaExclusion(session, routeSchemaFamily(session), tool);
  return exclusion ? unavailableText(exclusion) : null;
}
