// Deferred-tool catalog: measured-usage ordering, kind/bucket classification,
// tool_search ranking + auto-selection, and the session tool-surface
// application/selection logic. Pure module (session objects passed in).
import { clean, LATE_TOOL_ANNOUNCEMENT_SENTINEL } from './session-text.mjs';
import { estimateToolSchemaTokens, toolSchemaSignature } from '../runtime/agent/orchestrator/session/context-utils.mjs';
import {
  applyInitialDeferredToolManifestToBp1,
  buildDeferredToolManifest,
  stripDeferredToolManifestBlock,
} from '../runtime/agent/orchestrator/context/collect.mjs';
import { getMcpServerInstructionsMap } from '../runtime/agent/orchestrator/mcp/client.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import {
  finalizeProviderRequestTools,
  providerNativeToolPrefixCount,
} from './provider-request-tools.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_SELECT_ALIASES,
  MEASURED_TOOL_ORDER,
  MEASURED_TOOL_USAGE,
  READONLY_TOOL_NAMES,
} from './tool-catalog-data.mjs';
import { toolKind, measuredToolUsage, parseToolSelection, parseToolSearchQuerySelection, measuredToolRank, sortedCatalogByMeasuredUsage, activeToolForSurface, deferredProviderMode, nativeProviderFamily } from './tool-catalog-schema.mjs';
export { toolKind, toolSchemaBucket, estimateToolSchemaBreakdown, measuredToolUsage, parseToolSelection, parseToolSearchQuerySelection, sortedCatalogByMeasuredUsage } from './tool-catalog-schema.mjs';
export { resolveProviderRequestTools, snapshotProviderRequestTools } from './provider-request-snapshot.mjs';
export {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  MEASURED_TOOL_USAGE,
} from './tool-catalog-data.mjs';


export function filterDisallowedTools(tools, disallowed = []) {
  if (!Array.isArray(disallowed) || disallowed.length === 0) return tools;
  const deny = new Set(disallowed.map((name) => clean(name)).filter(Boolean));
  if (deny.size === 0) return tools;
  return (tools || []).filter((tool) => !deny.has(clean(tool?.name)));
}

export function sortedNamesByMeasuredUsage(names) {
  return [...(names || [])].sort((a, b) => {
    const au = measuredToolUsage(a);
    const bu = measuredToolUsage(b);
    if (bu !== au) return bu - au;
    const ar = measuredToolRank(a);
    const br = measuredToolRank(b);
    if (ar !== br) return ar - br;
    return String(a).localeCompare(String(b));
  });
}

export function defaultDeferredToolNames(catalog, mode) {
  const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
  if (mode === 'lead') {
    return new Set(DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => available.has(name)));
  }
  if (mode === 'readonly') {
    return new Set(DEFERRED_DEFAULT_READONLY_TOOLS.filter((name) => available.has(name)));
  }
  return new Set(DEFERRED_DEFAULT_FULL_TOOLS.filter((name) => available.has(name)));
}

export function compactToolSearchDescription(value, max = 220) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Late-announcement lines stay skill-manifest shaped but much tighter than the
// BP1 pool (first sentence, hard 80-char cap): the reminder is transient
// discovery only — the full description/schema arrives when the tool loads.
function lateAnnouncementDescription(value) {
  const text = clean(value).replace(/\s+/g, ' ');
  const sentence = text.split(/(?<=[.!?])\s+/, 1)[0] || text;
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

export function toolRow(tool, activeNames = new Set()) {
  const name = clean(tool?.name);
  return {
    name,
    kind: toolKind(tool),
    usage: measuredToolUsage(name),
    active: activeNames.has(name),
    description: compactToolSearchDescription(tool?.description),
  };
}

function providerSupportsResponsesCustomTools(provider) {
  const p = clean(provider).toLowerCase();
  if (!p) return true;
  return p === 'openai' || p === 'openai-oauth';
}

function openAILoadableToolSpec(tool, provider = '') {
  if (providerSupportsResponsesCustomTools(provider) && isResponsesFreeformTool(tool)) return toResponsesCustomTool(tool);
  return {
    type: 'function',
    name: clean(tool?.name),
    description: clean(tool?.description),
    defer_loading: true,
    parameters: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  };
}

function toolSearchNativePayload(catalog, names, provider = '') {
  const selected = new Set((names || []).map(clean).filter(Boolean));
  if (!selected.size) return null;
  const tools = [];
  const refs = [];
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name || !selected.has(name)) continue;
    refs.push(name);
    tools.push(openAILoadableToolSpec(tool, provider));
  }
  if (!refs.length) return null;
  return {
    provider: clean(provider).toLowerCase(),
    toolReferences: refs,
    openaiTools: tools,
    summary: `Loaded deferred tools: ${refs.join(', ')}`,
  };
}

// Plain case-insensitive substring filter over name + description. No scores,
// no aliases, no auto-selection: tool_search only lists and (via select)
// loads. Empty query matches every row.
export function toolSearchMatches(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return true;
  const haystack = `${clean(row?.name)} ${clean(row?.description)}`.toLowerCase();
  return haystack.includes(raw);
}

function expandSelectionNames(names) {
  const out = [];
  for (const raw of names || []) {
    const key = clean(raw);
    if (!key) continue;
    const alias = DEFERRED_SELECT_ALIASES[key.toLowerCase()];
    if (alias) out.push(...alias);
    else out.push(key);
  }
  return [...new Set(out)];
}

function storedDeferredToolNames(session) {
  for (const source of [session?.deferredDiscoveredTools, session?.deferredSelectedTools]) {
    const names = parseToolSelection(source);
    if (names.length) return names;
  }
  return [];
}

function canonicalDeferredToolNames(catalog, names) {
  const byName = new Map();
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, name);
    byName.set(name.toLowerCase(), name);
  }
  const out = [];
  for (const raw of expandSelectionNames(names)) {
    const name = clean(raw);
    const canonical = byName.get(name) || byName.get(name.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return sortedNamesByMeasuredUsage(new Set(out));
}

function setDeferredToolState(session, names) {
  if (!session) return [];
  const selected = sortedNamesByMeasuredUsage(new Set(parseToolSelection(names)));
  session.deferredDiscoveredTools = selected;
  session.deferredSelectedTools = selected;
  return selected;
}

export function deferredPoolToolNames(session) {
  if (!session || session.deferredProviderMode === 'full'
    || session.deferredProviderMode === 'manifest'
    || session.deferredProviderMode === 'canonical') return [];
  const catalog = Array.isArray(session.deferredToolCatalog)
    ? session.deferredToolCatalog
    : [];
  const active = new Set([
    ...(session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session.deferredCallableTools),
  ]);
  const out = [];
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (name && !active.has(name)) out.push(name);
  }
  return sortedNamesByMeasuredUsage(out);
}

// Union of the boot-frozen deferred catalog and the late-connected MCP catalog.
// The boot catalog (session.deferredToolCatalog) is what the Anthropic providers
// serialize as defer_loading tools, so it MUST stay byte-identical after boot;
// tools whose MCP servers connected after boot live in
// session.deferredLateToolCatalog and are merged in ONLY for lookup/selection
// (never for provider serialization) so the request tools param — and its cache
// hash — is unchanged until a late tool is actually loaded.
export function deferredCatalogUnion(session) {
  const boot = Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : [];
  const late = Array.isArray(session?.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [];
  if (!late.length) return boot;
  const byName = new Map();
  // On a same-name collision (a boot MCP tool whose server reconnected with a
  // possibly fresher schema also lives in the late pool) prefer the LATE entry
  // for lookup/load resolution. The boot-catalog ARRAY itself is never mutated,
  // so provider defer_loading serialization stays byte-identical.
  for (const tool of boot) {
    const name = clean(tool?.name);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  for (const tool of late) {
    const name = clean(tool?.name);
    if (name) byName.set(name, tool);
  }
  return [...byName.values()];
}

export function isReadonlySelectable(tool) {
  const name = clean(tool?.name);
  if (READONLY_TOOL_NAMES.has(name)) return true;
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

export function applyDeferredToolSurface(session, mode, extraTools = [], options = {}) {
  if (!session || !Array.isArray(session.tools)) return session;
  const providerMode = deferredProviderMode(options.provider || session.provider);
  const byName = new Map();
  for (const tool of [...session.tools, ...(extraTools || [])]) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  const storedNames = providerMode === 'native' ? [] : storedDeferredToolNames(session);
  let selectedNames = providerMode === 'full' || providerMode === 'manifest' || providerMode === 'canonical'
    ? sortedNamesByMeasuredUsage(catalog.map((tool) => clean(tool?.name)).filter(Boolean))
    : [];
  if (!['full', 'manifest', 'canonical'].includes(providerMode)) {
    selectedNames = storedNames.length ? canonicalDeferredToolNames(catalog, storedNames) : [];
    if (!selectedNames.length || providerMode === 'native') selectedNames = sortedNamesByMeasuredUsage(defaultNames);
  }
  const selected = new Set(selectedNames);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredDefaultTools = sortedNamesByMeasuredUsage(defaultNames);
  session.deferredProviderMode = providerMode;
  session.deferredNativeTools = providerMode === 'native';
  session.deferredSurfaceMode = mode;
  session.tools.length = 0;
  const active = [];
  for (const tool of catalog) {
    if (!selected.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
    active.push(clean(tool?.name));
  }
  session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
  if (providerMode === 'native') {
    const discovered = canonicalDeferredToolNames(catalog, session.deferredDiscoveredTools || []);
    session.deferredSelectedTools = active;
    session.deferredDiscoveredTools = discovered.filter((name) => !selected.has(name));
  } else {
    setDeferredToolState(session, active);
  }
  if (!session.deferredToolBp1Applied && session.messages?.some((m) => m?.role === 'system')) {
    if (!session.mcpServerInstructions || typeof session.mcpServerInstructions !== 'object') {
      session.mcpServerInstructions = getMcpServerInstructionsMap();
    }
    applyInitialDeferredToolManifestToBp1(session, deferredPoolToolNames(session));
  }
  if (!Array.isArray(session.deferredAnnouncedTools) && session.deferredToolBp1Applied) {
    // Seed the announced set with everything already advertised in the BP1
    // manifest, so the turn-boundary MCP delta (reconcileDeferredMcpToolCatalog)
    // only announces genuinely new, late-connecting tools and never re-announces
    // the startup pool.
    session.deferredAnnouncedTools = deferredPoolToolNames(session);
  }
  return session;
}

export function rebuildDeferredToolSurfaceForProvider(session, provider) {
  if (!session || !Array.isArray(session.tools)) return session;
  const previousMode = session.deferredProviderMode;
  const previousFamily = nativeProviderFamily(session.provider);
  const nextFamily = nativeProviderFamily(provider);
  const preserveNativeState = previousFamily && previousFamily === nextFamily;
  const discovered = preserveNativeState
    ? canonicalDeferredToolNames(deferredCatalogUnion(session), session.deferredDiscoveredTools || [])
    : [];
  const catalog = deferredCatalogUnion(session).slice();
  session.deferredDiscoveredTools = discovered;
  applyDeferredToolSurface(
    session,
    session.deferredSurfaceMode || 'lead',
    catalog,
    { provider },
  );
  if (session.deferredProviderMode === 'native' && discovered.length) {
    session.deferredDiscoveredTools = discovered;
    session.deferredCallableTools = sortedNamesByMeasuredUsage(new Set([
      ...(session.deferredCallableTools || []),
      ...discovered,
    ]));
    session.deferredSelectedTools = session.deferredCallableTools.slice();
  }
  if (previousMode && previousMode !== session.deferredProviderMode) {
    if (session.deferredProviderMode === 'native') {
      session.mcpServerInstructions = getMcpServerInstructionsMap();
      applyInitialDeferredToolManifestToBp1(session, deferredPoolToolNames(session), { rebuild: true });
      const rendered = session.messages?.find((message) => message?.role === 'system')?.content;
      session.deferredAnnouncedTools = deferredPoolToolNames(session)
        .filter((name) => typeof rendered === 'string' && rendered.includes(name));
    } else if (previousMode === 'native') {
      const system = session.messages?.find((message) => message?.role === 'system');
      if (system && typeof system.content === 'string') {
        system.content = stripDeferredToolManifestBlock(system.content);
      }
      session.deferredAnnouncedTools = [];
      session.deferredToolBp1Applied = true;
    }
  }
  return session;
}

// FIRST-TURN deferred-surface refresh (claude-code turn-time deferred manifest).
// An MCP server may finish its handshake BETWEEN session-create and the first
// user send. Fold those LIVE MCP tools into the boot deferred catalog + the
// provider-visible first-turn surface. Native providers rebuild the initial BP1
// <available-deferred-tools> manifest IN PLACE and pre-mark names announced.
// Manifest/canonical providers update their active fixed surface directly; the
// canonical path never emits a deferred manifest or late reminder. Fully sync
// and idempotent: no genuinely-new MCP name => no-op / no mutation.
export function refreshInitialDeferredMcpSurface(session, liveMcpTools) {
  if (!session || !Array.isArray(session.messages)) return false;
  if (session.deferredProviderMode === 'full') return false;
  const isMcp = (name) => typeof name === 'string' && name.startsWith('mcp__');
  const byName = new Map();
  for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    const name = clean(tool?.name);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  let added = false;
  for (const tool of Array.isArray(liveMcpTools) ? liveMcpTools : []) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name) || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
    added = true;
  }
  if (!added) return false;
  session.deferredToolCatalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  if (session.deferredProviderMode === 'manifest' || session.deferredProviderMode === 'canonical') {
    const next = session.deferredToolCatalog.filter((tool) => (
      session.deferredSurfaceMode !== 'readonly' || isReadonlySelectable(tool)
    ));
    session.tools.splice(0, session.tools.length, ...next);
    session.deferredCallableTools = next.map((tool) => clean(tool?.name)).filter(Boolean);
    if (session.deferredProviderMode === 'canonical') {
      setDeferredToolState(session, session.deferredCallableTools);
    }
    session.updatedAt = Date.now();
    return true;
  }
  // Refresh MCP server instructions so a newly-connected server's block is
  // included when BP1 is re-rendered below.
  session.mcpServerInstructions = getMcpServerInstructionsMap();
  const applied = applyInitialDeferredToolManifestToBp1(session, deferredPoolToolNames(session), { rebuild: true });
  if (!applied) return false;
  // Pre-mark ONLY the names that ACTUALLY landed in the rebuilt BP1 manifest as
  // announced; anything the manifest could not advertise stays un-announced so
  // the turn-boundary late reminder can still surface it.
  const rendered = (() => {
    const sys = session.messages.find((m) => m?.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
  })();
  session.deferredAnnouncedTools = deferredPoolToolNames(session).filter((name) => rendered.includes(name));
  session.updatedAt = Date.now();
  return true;
}

/**
 * Turn-boundary reconciliation (full snapshot + delta).
 * Merge currently-connected MCP tools into session.deferredLateToolCatalog (a
 * SEPARATE pool from the boot-frozen session.deferredToolCatalog) so tools from
 * servers that finished their handshake AFTER this session was created become
 * reachable (deferred-call-through / load_tool resolve against the union of both
 * catalogs and auto-load them on first direct call). The boot catalog — the only
 * one the Anthropic providers serialize as defer_loading tools — is never
 * touched, so the tools request parameter (and its cache hash) is byte-identical
 * until a late tool is actually loaded (promoted onto session.tools).
 * When the late pool gains MCP names not yet advertised, deliver ONE persistent
 * <system-reminder> through the pending-message queue (options.enqueue) so it
 * rides inside the next real user turn; if that queue is unreachable, fall back
 * to a tail append ONLY when the transcript tail is an assistant turn, else defer
 * the announcement (names stay un-announced and are retried next turn). No filler
 * assistant messages are ever appended.
 * A disconnected server's unloaded tools leave the late pool; a loaded (active)
 * tool stays on session.tools, is never announced as removed, and is re-linked to
 * the fresh server tool on reconnect.
 * Returns the announced names, or null when nothing was announced.
 */
export function reconcileDeferredMcpToolCatalog(session, liveMcpTools, options = {}) {
  if (!session || !Array.isArray(session.messages)) return null;
  if (session.deferredProviderMode === 'full' || session.deferredProviderMode === 'canonical') return null;
  const isMcp = (name) => typeof name === 'string' && name.startsWith('mcp__');
  const live = Array.isArray(liveMcpTools) ? liveMcpTools : [];
  if (session.deferredProviderMode === 'manifest') {
    const byName = new Map();
    for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
      const name = clean(tool?.name);
      if (name && !isMcp(name)) byName.set(name, tool);
    }
    for (const tool of live) {
      const name = clean(tool?.name);
      if (name && isMcp(name)) byName.set(name, activeToolForSurface(tool));
    }
    const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
    const next = catalog.filter((tool) => (
      session.deferredSurfaceMode !== 'readonly' || isReadonlySelectable(tool)
    ));
    const before = JSON.stringify((session.tools || []).map((tool) => activeToolForSurface(tool)));
    const after = JSON.stringify(next);
    session.deferredToolCatalog = catalog;
    session.tools.splice(0, session.tools.length, ...next);
    session.deferredCallableTools = next.map((tool) => clean(tool?.name)).filter(Boolean);
    if (before !== after) session.updatedAt = Date.now();
    return before === after ? null : session.deferredCallableTools;
  }
  const lateCatalog = Array.isArray(session.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [];
  const active = new Set((session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));

  const liveMcpByName = new Map();
  for (const tool of live) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name) || liveMcpByName.has(name)) continue;
    liveMcpByName.set(name, activeToolForSurface(tool));
  }

  // Rebuild the LATE pool only (boot catalog stays frozen). It holds live MCP
  // tools — INCLUDING ones whose name also exists in the boot catalog, so a
  // reconnect's fresher schema is reachable via deferredCatalogUnion (which
  // prefers the late entry). Keep an entry only while its server is still
  // connected OR the tool is already loaded (active). A disconnected server's
  // unloaded tool drops out; a loaded one stays on session.tools.
  const nextByName = new Map();
  for (const tool of lateCatalog) {
    const name = clean(tool?.name);
    if (!name || nextByName.has(name)) continue;
    if (!liveMcpByName.has(name) && !active.has(name)) continue;
    nextByName.set(name, tool);
  }
  for (const [name, tool] of liveMcpByName) nextByName.set(name, tool);
  session.deferredLateToolCatalog = sortedCatalogByMeasuredUsage([...nextByName.values()]);

  // A promoted (active) MCP tool survives its server disconnecting; on reconnect
  // re-link the active session.tools entry to the fresh server tool so its
  // schema/handler track the live connection. Swap ONLY when the serialized
  // surface actually changed, so a steady reconnect never perturbs the tools
  // request param or its cache hash.
  if (Array.isArray(session.tools)) {
    for (let i = 0; i < session.tools.length; i += 1) {
      const name = clean(session.tools[i]?.name);
      if (!name || !isMcp(name) || !liveMcpByName.has(name)) continue;
      const freshTool = liveMcpByName.get(name);
      if (JSON.stringify(freshTool) !== JSON.stringify(session.tools[i])) session.tools[i] = freshTool;
    }
  }

  const announced = new Set(Array.isArray(session.deferredAnnouncedTools) ? session.deferredAnnouncedTools : []);
  // Commit-based dedupe: a late tool counts as announced only once its reminder
  // actually LANDED in session.messages (the tail-append path lands immediately;
  // the enqueue path lands when the pending queue drains into the next user
  // turn). Fold those committed names in now and persist them so a later
  // transcript trim can never resurrect an already-delivered announcement. A
  // crash BETWEEN enqueue and drain leaves the name uncommitted, so the next
  // reconcile re-announces instead of silently dropping it; the scan is
  // idempotent, so a double-drain never double-marks.
  const lateMcpNames = session.deferredLateToolCatalog
    .map((tool) => clean(tool?.name))
    .filter((name) => name && isMcp(name));
  let announcedChanged = false;
  for (const name of committedAnnouncedLateTools(session, lateMcpNames)) {
    if (!announced.has(name)) { announced.add(name); announcedChanged = true; }
  }
  if (announcedChanged) session.deferredAnnouncedTools = sortedNamesByMeasuredUsage([...announced]);
  const fresh = [];
  for (const tool of session.deferredLateToolCatalog) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name)) continue;
    if (active.has(name) || announced.has(name)) continue;
    fresh.push({ name, description: lateAnnouncementDescription(tool?.description) });
  }
  if (!fresh.length) return null;

  const manifest = buildDeferredToolManifest(fresh);
  if (!manifest) return null;
  const reminder = `<system-reminder>\nTools from MCP servers that ${LATE_TOOL_ANNOUNCEMENT_SENTINEL} are now available. Call any tool listed below directly by name; it loads on first use.\n\n${manifest}\n</system-reminder>`;
  const delivery = deliverDeferredAnnouncement(session, reminder, options);
  if (!delivery) return null;
  // Only the tail-append path commits into session.messages synchronously, so
  // mark it announced now. Enqueued reminders are marked on the next reconcile's
  // transcript scan (post-drain) — never at enqueue time (crash-safety above).
  if (delivery === 'committed') {
    for (const entry of fresh) announced.add(entry.name);
    session.deferredAnnouncedTools = sortedNamesByMeasuredUsage([...announced]);
  }
  session.updatedAt = Date.now();
  return fresh.map((entry) => entry.name);
}

// Sentinel phrase carried in every late-tool reminder; used to recognise a
// delivered (committed) announcement inside session.messages regardless of
// whether the pending drain merged it with other queued user content.
// Single source of truth lives in session-text.mjs (imported above) so the
// hide-from-UI detection can never drift from the emitted reminder text.
const LATE_TOOL_REMINDER_SENTINEL = LATE_TOOL_ANNOUNCEMENT_SENTINEL;

function reminderMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n');
  }
  return '';
}

// Late-tool names whose reminder is already present in session.messages (either
// tail-appended directly or drained in from the pending queue). Idempotent.
function committedAnnouncedLateTools(session, lateNames) {
  const names = Array.isArray(lateNames) ? lateNames.filter(Boolean) : [];
  if (!names.length) return [];
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  const blob = msgs
    .filter((m) => m && m.role === 'user')
    .map((m) => reminderMessageText(m.content))
    .filter((t) => t.includes(LATE_TOOL_REMINDER_SENTINEL))
    .join('\n');
  if (!blob) return [];
  return names.filter((name) => blob.includes(name));
}

// Deliver the late-tool <system-reminder> without any '.' filler turn. Primary
// path: the pending-message queue (options.enqueue) — the SAME mechanism that
// carries tool-completion notifications. The queue drains AFTER the current
// turn's assistant terminal response (ask-session.mjs), so the reminder rides a
// fresh follow-up user turn that always follows an assistant turn; strict
// role-alternation holds and no wire-level same-role merge is needed (the
// Anthropic/OpenAI lowering never merges two plain user turns, and none occurs
// here). Returns 'enqueued' (commit deferred to drain) on that path.
// Fallback (queue unreachable, e.g. unit tests): append a user reminder ONLY
// when the transcript tail is an assistant turn — that commits synchronously
// ('committed'); otherwise defer to the next turn (null).
function deliverDeferredAnnouncement(session, reminder, options) {
  const enqueue = typeof options?.enqueue === 'function' ? options.enqueue : null;
  if (enqueue) {
    try { if (enqueue(reminder) === true) return 'enqueued'; }
    catch { /* fall through to the tail-append fallback */ }
  }
  const messages = session.messages;
  const tail = messages[messages.length - 1];
  if (tail && tail.role === 'assistant') {
    messages.push({ role: 'user', meta: 'hook', content: reminder });
    return 'committed';
  }
  return null;
}

export function selectDeferredTools(session, names, mode, options = {}) {
  // Resolve against the union of the boot-frozen catalog and the late-connected
  // MCP catalog so load_tool can load a late tool. Native providers register it
  // independently; canonical fallback providers already expose the full array.
  const union = deferredCatalogUnion(session);
  const catalog = union.length
    ? union
    : (Array.isArray(session?.tools) ? session.tools : []);
  const surfaceActive = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const active = new Set([...surfaceActive, ...parseToolSelection(session?.deferredCallableTools)]);
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
  const activateOnSurface = !native;
  const byName = new Map();
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, tool);
    byName.set(name.toLowerCase(), tool);
  }
  const added = [];
  const already = [];
  const blocked = [];
  const missing = [];
  for (const rawName of expandSelectionNames(names)) {
    const requestedName = clean(rawName);
    const tool = byName.get(requestedName) || byName.get(requestedName.toLowerCase());
    const name = clean(tool?.name);
    if (!tool) {
      missing.push(requestedName);
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (active.has(name) || (!activateOnSurface && discovered.has(name))) {
      already.push(name);
      continue;
    }
    if (activateOnSurface) {
      session.tools.push(tool);
      active.add(name);
      discovered.delete(name);
    } else {
      discovered.add(name);
      active.add(name);
    }
    added.push(name);
  }
  if (native) {
    session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage(
      [...discovered],
    );
    session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  } else {
    setDeferredToolState(session, active);
  }
  return { added, already, blocked, missing, native };
}

// Collect the exact deferred-tool names to load, honoring back-compat inputs:
//   names[]            → primary loader input
//   select / "select:" → legacy alias (parseToolSelection strips the prefix)
//   query "select:a,b" → legacy query-side loader
// A free-text `query` is NOT a search anymore: it yields no names, and the
// caller is steered back to names[].
export function parseLoadToolNames(args = {}) {
  const fromNames = parseToolSelection(args.names);
  if (fromNames.length) return fromNames;
  const fromSelect = parseToolSelection(args.select);
  if (fromSelect.length) return fromSelect;
  return parseToolSearchQuerySelection(args.query);
}

// Split live MCP servers into "still connecting" (pending) and "failed" so the
// loader can tell the model to retry next turn instead of treating a missing
// tool as a permanent zero result. `mcpStatus` is a getter plumbed from the
// runtime; absent in unit tests, where these lists are simply empty.
function pendingAndFailedMcpServers(mcpStatus) {
  const empty = { pending: [], failed: [] };
  let status = null;
  try {
    status = typeof mcpStatus === 'function' ? mcpStatus() : mcpStatus;
  } catch {
    return empty;
  }
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const pending = [];
  const failed = [];
  for (const row of servers) {
    const name = clean(row?.name);
    if (!name) continue;
    if (row?.status === 'disconnected') pending.push(name);
    else if (row?.status === 'failed') failed.push(name);
  }
  return { pending: [...new Set(pending)].sort(), failed: [...new Set(failed)].sort() };
}

// Pure loader (formerly a keyword search). Input is exact deferred-tool
// names/aliases; output reports loaded / already-active / missing / blocked
// tools PLUS pending/failed MCP servers. No listing, no ranking, no substring
// filter. `options.mcpStatus` is the runtime getter for per-server status.
export function renderToolSearch(args = {}, session, mode = 'full', options = {}) {
  const unionCatalog = deferredCatalogUnion(session);
  const catalog = unionCatalog.length
    ? unionCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const requestedNames = parseLoadToolNames(args);
  const { pending: pendingMcpServers, failed: failedMcpServers } = pendingAndFailedMcpServers(options?.mcpStatus);
  const mcpFields = {
    ...(pendingMcpServers.length ? { pendingMcpServers } : {}),
    ...(failedMcpServers.length ? { failedMcpServers } : {}),
  };

  if (!requestedNames.length) {
    const strayQuery = clean(args.query || args.q || args.text);
    return JSON.stringify({
      error: strayQuery
        ? `load_tool is a loader, not a search: "${strayQuery}" is not an exact tool name. Pass names:["exact_tool_name", ...] (deferred tool names/aliases). No keyword search.`
        : 'load_tool requires names:["exact_tool_name", ...] (deferred tool names/aliases).',
      loaded: [],
      alreadyActive: [],
      missing: [],
      ...mcpFields,
      activeTools: sortedNamesByMeasuredUsage((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean)),
      discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    }, null, 2);
  }

  // Native loads update only the callable registry and provider-native history
  // payload. Canonical fallback providers already carry the complete array.
  const toolSelection = selectDeferredTools(session, requestedNames, mode);
  const nextActiveNames = new Set([
    ...(session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session?.deferredCallableTools),
  ]);
  const loaded = toolSelection.added || [];
  const alreadyActive = toolSelection.already || [];
  const missing = toolSelection.missing || [];
  const blocked = toolSelection.blocked || [];
  const nativeToolSearchBase = toolSelection.native
    ? (toolSearchNativePayload(catalog, loaded, session?.provider) || {
        provider: clean(session?.provider).toLowerCase(),
        toolReferences: [],
        openaiTools: [],
        summary: '',
      })
    : null;
  const nativeSummary = [
    ...(loaded.length ? [`Loaded deferred tools: ${loaded.join(', ')}`] : []),
    ...(alreadyActive.length ? [`Already active: ${alreadyActive.join(', ')}`] : []),
  ].join('\n');
  const nativeToolSearch = nativeToolSearchBase
    ? { ...nativeToolSearchBase, summary: nativeSummary || nativeToolSearchBase.summary }
    : null;
  const notes = [];
  if (missing.length && pendingMcpServers.length) {
    notes.push('Some requested names may belong to an MCP server still connecting — retry next turn.');
  }
  if (missing.length && failedMcpServers.length) {
    notes.push('Some requested names may belong to a failed MCP server; those tools are unavailable.');
  }
  return JSON.stringify({
    // `selected` retained for back-compat consumers (mode is always 'select').
    selected: { mode: 'select', tools: toolSelection },
    ...(nativeToolSearch ? { nativeToolSearch } : {}),
    loaded,
    alreadyActive,
    missing,
    ...(blocked.length ? { blocked } : {}),
    ...mcpFields,
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }, null, 2);
}
