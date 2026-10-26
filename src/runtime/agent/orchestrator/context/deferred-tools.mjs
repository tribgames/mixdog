// Deferred-pool manifest injected into BP2. MCP server instruction bodies are
// not injected: a server's one-line entry is its when-to-use trigger (accounts
// one line per server), and its instructions arrive with its tools
// on load_tool. The <mcp-instructions> block is still recognized so older
// prompts can shed it.
import { connectorTrigger } from '../../../shared/connector-triggers.mjs';
import { parseMcpToolName, titleCaseMcpServer } from '../../../shared/tool-primitives.mjs';
import { SKILL_TRIGGER_LISTING_MAX } from '../../../shared/skill-document.mjs';
import { isToolBridgeEnabled, TOOL_BRIDGE_GUIDANCE } from '../runtime-core/tool-exposure.mjs';

export function compactPromptManifestText(value, max = 250) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(1, Math.floor(max));
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.max(1, limit - 1));
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.floor(limit * 0.6) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,.;:!?/-]+$/, '')}...`;
}

// The native deferred-pool manifest and the static bridge guidance occupy the
// same BP2 slot: one replaces the other when the exposure changes.
const DEFERRED_TOOLS_BLOCK_RE =
  /(\n\n---\n*)?<(available-deferred-tools|tool-bridge)>[\s\S]*?<\/(?:available-deferred-tools|tool-bridge)>\s*/gi;
const MCP_INSTRUCTIONS_BLOCK_RE = /(\n\n---\n*)?<mcp-instructions>[\s\S]*?<\/mcp-instructions>\s*/gi;
// Tool and MCP server names enter the manifests only as plain identifiers
// (no markup can be smuggled into the prompt through a name).
const MANIFEST_NAME_SAFE_RE = /^[A-Za-z0-9_.:-]+$/;

function sanitizeManifestName(name) {
  const text = String(name || '').trim();
  return MANIFEST_NAME_SAFE_RE.test(text) ? text : '';
}

const MCP_INSTRUCTION_MAX_CHARS = 600;

/** A server's instruction text without markup, capped at MCP_INSTRUCTION_MAX_CHARS. */
export function sanitizeMcpInstructionText(text, max = MCP_INSTRUCTION_MAX_CHARS) {
  const stripped = String(text || '')
    .replace(/[<>]/g, '')
    .trim();
  if (!stripped) return '';
  const cap = Math.max(1, Number(max) || MCP_INSTRUCTION_MAX_CHARS);
  return stripped.length > cap ? `${stripped.slice(0, Math.max(1, cap - 3))}...` : stripped;
}

function skillRoutedToolNames(messages) {
  const names = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'system' || typeof message.content !== 'string') continue;
    for (const block of message.content.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)) {
      // Use only routes actually visible to this session, not the global
      // skill catalog (which may include disabled or omitted skills).
      for (const route of block[1].matchAll(/^- [^:\r\n]+:\s+\S[^\r\n]* \[tools: ([^\]\r\n]+)\]$/gm)) {
        for (const name of route[1].split(',').map((value) => value.trim())) {
          // MCP dependencies name servers, not individual tools.
          if (/^[A-Za-z0-9_]+$/.test(name) && !name.startsWith('mcp__')) names.add(name);
        }
      }
    }
  }
  return names;
}

function hasDeferredToolManifestBlock(text) {
  const raw = String(text || '');
  return (
    /<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/i.test(raw) ||
    /<tool-bridge>[\s\S]*?<\/tool-bridge>/i.test(raw) ||
    /<mcp-instructions>[\s\S]*?<\/mcp-instructions>/i.test(raw)
  );
}

/**
 * Skill-style manifest for tools in the deferred pool (catalog minus active
 * wire tools). Each entry is either a bare name string or `{ name, description }`;
 * output lines are `- name: description` (description omitted when absent),
 * mirroring the available-skills manifest so the model calls deferred tools
 * directly. Descriptions are compacted to the skill listing's trigger cap
 * (skill-document.mjs SKILL_TRIGGER_LISTING_MAX) and stripped of `<`/`>`.
 * Empty pool → '' (caller omits the block).
 */
export function buildDeferredToolManifest(entries) {
  const list = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawName = typeof entry === 'string' ? entry : entry?.name;
    const name = sanitizeManifestName(rawName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof entry === 'string'
        ? ''
        : compactPromptManifestText(String(entry?.description || '').replace(/[<>]/g, ''), SKILL_TRIGGER_LISTING_MAX);
    list.push({ name, description });
  }
  if (!list.length) return '';
  list.sort((a, b) => a.name.localeCompare(b.name));
  return [
    '<available-deferred-tools>',
    'Deferred tool names and selection triggers; schemas load on demand.',
    ...list.map((entry) => (entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)),
    '</available-deferred-tools>',
  ].join('\n');
}

export function stripDeferredToolManifestBlock(text) {
  return String(text || '')
    .replace(DEFERRED_TOOLS_BLOCK_RE, '')
    .replace(MCP_INSTRUCTIONS_BLOCK_RE, '')
    .replace(/\n\n---\n*$/, '')
    .trimEnd();
}

// Rebuild path: replace the FIRST previously-injected <available-deferred-tools>
// block (with its leading `---` separator) with the fresh manifest IN PLACE, so
// the block keeps its original position and no sibling BP2 block (skills
// manifest, agent rules, …) is reordered or dropped. A legacy <mcp-instructions>
// block left by older sessions is removed first.
function rebuildDeferredToolManifestBlock(text, manifest) {
  let out = String(text || '').replace(MCP_INSTRUCTIONS_BLOCK_RE, '');
  let replaced = false;
  out = out.replace(DEFERRED_TOOLS_BLOCK_RE, (_match, sep) => {
    if (replaced) return '';
    replaced = true;
    return `${sep || ''}${manifest}`;
  });
  if (!replaced) {
    const base = out.trimEnd();
    out = base ? `${base}\n\n---\n\n${manifest}` : manifest;
  }
  return out;
}

function catalogByName(session) {
  const byName = new Map();
  for (const tool of Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    const name = String(tool?.name || '').trim();
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  return byName;
}

// MCP tools are listed once per server: load_tool loads every tool of
// `mcp__<server>`. Tool definitions carry their server (shortened names
// cannot be parsed).
const mcpServerOf = (byName, name) => parseMcpToolName(byName.get(String(name).trim()) || name)?.server || '';
const mcpServerLineName = (server) => `mcp__${server}`;
const firstSentence = (text) => {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return (flat.split(/(?<=[.!?])\s/, 1)[0] || flat).replace(/[.!?]+$/, '');
};

// A catalog connector's curated when-to-use trigger; else the first sentence
// of the server's MCP instructions; else its tools' leading descriptions (name
// order); else its name. Never the account: that is part of the instruction
// text delivered when the server's tools are loaded. Derived lines are
// compacted to at most 98 characters, ellipsis included.
function mcpServerTrigger(server, tools, instructions) {
  const curated = connectorTrigger(server);
  if (curated) return curated;
  // The account sentence ("Account: <address>. …", connector-accounts.mjs) is
  // not a use line; it reaches the model with the loaded server's instructions.
  const instruction = String(instructions?.[server] || '')
    .replace(/[<>]/g, '')
    .replace(/^\s*Account: \S+?\.\s+/, '');
  const described = [...tools]
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
    .map((tool) => firstSentence(String(tool?.description || '').replace(/[<>]/g, '')))
    .filter(Boolean)
    .join('; ');
  const derived = firstSentence(instruction) || described;
  return derived ? compactPromptManifestText(derived, 98) : `${titleCaseMcpServer(server)} MCP server tools.`;
}

// `mcp__<server>` as the manifest names it, or '' for an unsafe server name.
export const mcpServerManifestLabel = (server) => sanitizeManifestName(mcpServerLineName(server));

/**
 * One `{ label: 'mcp__<server>', trigger }` line per server of `servers` (Map
 * server → its tools). The BP2 manifest and the deferred-tool delta both
 * render these; a server with an unsafe name gets none.
 */
export function mcpServerLines(servers, instructions) {
  const lines = [];
  for (const [server, tools] of servers) {
    const label = mcpServerManifestLabel(server);
    if (!label) continue;
    const trigger = compactPromptManifestText(
      String(mcpServerTrigger(server, tools, instructions)).replace(/[<>]/g, ''),
      SKILL_TRIGGER_LISTING_MAX
    );
    lines.push({ label, trigger });
  }
  return lines;
}

function deferredManifestEntries(session, pool) {
  const byName = catalogByName(session);
  const skillRoutedNames = skillRoutedToolNames(session.messages);
  const entries = [];
  const servers = new Map();
  for (const name of pool) {
    const key = String(name).trim();
    const tool = byName.get(key);
    const server = mcpServerOf(byName, name);
    if (server) {
      if (!servers.has(server)) servers.set(server, []);
      servers.get(server).push(tool || { name: key });
      continue;
    }
    // Skill-style selection trigger when the tool declares one; else its description.
    entries.push({
      name,
      description: skillRoutedNames.has(key) ? '' : String(tool?.trigger || tool?.description || ''),
    });
  }
  for (const line of mcpServerLines(servers, session.mcpServerInstructions)) {
    entries.push({ name: line.label, description: line.trigger });
  }
  return entries;
}

/** The pool names `rendered` lists: by their own line, or their MCP server's. */
export function listedDeferredToolNames(session, poolNames, rendered) {
  const byName = catalogByName(session);
  const text = String(rendered || '');
  return (Array.isArray(poolNames) ? poolNames : []).filter((name) => {
    const server = mcpServerOf(byName, name);
    return text.includes(server ? `- ${mcpServerLineName(server)}: ` : name);
  });
}

function composeDeferredBp2Manifest(session, pool) {
  // Bridge exposure gets the native roster (the pool is
  // already limited to what the session's policy lets it run), followed by
  // the static bridge guidance. A tool-free bridge session gets nothing.
  const bridge = isToolBridgeEnabled(session);
  if (bridge && !(session.tools || []).some((tool) => tool?.name === 'call_tool')) return '';
  const parts = [];
  const deferredManifest = buildDeferredToolManifest(deferredManifestEntries(session, pool));
  if (deferredManifest) parts.push(deferredManifest);
  if (bridge) parts.push(TOOL_BRIDGE_GUIDANCE);
  return parts.join('\n\n');
}

function markDeferredBp2Applied(session) {
  session.deferredToolBp2Applied = true;
  delete session.deferredToolBp1Applied;
}

// Replace, never mutate: session-store delta saves treat stable message
// references as an unchanged prefix, so a rewritten prompt block must be a
// fresh object for the next save to persist it.
function setSystemContent(session, index, content) {
  const message = session.messages[index];
  if (message.content !== content) session.messages[index] = { ...message, content };
}

function clearDeferredManifestBlocks(session) {
  session.messages.forEach((message, index) => {
    if (message?.role === 'system' && typeof message.content === 'string') {
      setSystemContent(session, index, stripDeferredToolManifestBlock(message.content));
    }
  });
  session.messages = session.messages.filter(
    (message) => message?.role !== 'system' || String(message.content || '').trim()
  );
}

function resolveDeferredBp2Index(session) {
  const systemIndexes = session.messages
    .map((message, index) => (message?.role === 'system' ? index : -1))
    .filter((index) => index >= 0);
  if (!systemIndexes.length) return -1;
  const tier3Index = systemIndexes.find((index) => session.messages[index]?.cacheTier === 'tier3');
  let idx = systemIndexes.length >= 2 && systemIndexes[1] !== tier3Index ? systemIndexes[1] : -1;
  if (idx >= 0) return idx;
  idx = tier3Index >= 0 ? tier3Index : systemIndexes[0] + 1;
  session.messages.splice(idx, 0, { role: 'system', content: '' });
  return idx;
}

/**
 * Give BP2 `stableContext` (profile meta + skill manifest) and no deferred
 * manifest. The caller re-applies that manifest
 * (applyInitialDeferredToolManifestToBp2 with `rebuild`), which appends it
 * after the stable part exactly as session creation laid it out.
 */
export function resetBp2StableContext(session, stableContext) {
  if (!Array.isArray(session?.messages)) return;
  const idx = resolveDeferredBp2Index(session);
  if (idx >= 0) setSystemContent(session, idx, String(stableContext || ''));
}

function writeDeferredManifestAt(session, idx, manifest, rebuild) {
  for (let i = 0; i < session.messages.length; i++) {
    if (i === idx || session.messages[i]?.role !== 'system' || typeof session.messages[i].content !== 'string')
      continue;
    setSystemContent(session, i, stripDeferredToolManifestBlock(session.messages[i].content));
  }
  const raw = typeof session.messages[idx].content === 'string' ? session.messages[idx].content : '';
  if (rebuild && hasDeferredToolManifestBlock(raw)) {
    setSystemContent(session, idx, rebuildDeferredToolManifestBlock(raw, manifest));
    return;
  }
  const base = stripDeferredToolManifestBlock(raw);
  setSystemContent(session, idx, base ? `${base}\n\n---\n\n${manifest}` : manifest);
}

/**
 * Inject the skill-style deferred pool (name + description) into BP2 at session
 * start. Normally once; with `{ rebuild: true }` it strips any existing
 * <available-deferred-tools>/<mcp-instructions> block and re-injects the fresh
 * pool in place (used by the first-turn MCP refresh, before the prompt renders,
 * so late-connected MCP tools land in the INITIAL manifest — never duplicated).
 */
export function applyInitialDeferredToolManifestToBp2(session, poolNames, options = {}) {
  const rebuild = options?.rebuild === true;
  if (!session || !Array.isArray(session.messages)) return false;
  if (session.deferredToolBp2Applied && !rebuild) return false;
  const pool = Array.isArray(poolNames) ? poolNames : [];
  const manifest = composeDeferredBp2Manifest(session, pool);
  if (!manifest) {
    clearDeferredManifestBlocks(session);
    markDeferredBp2Applied(session);
    session.updatedAt = Date.now();
    return true;
  }

  const existingMessage = session.messages.find(
    (message) =>
      message?.role === 'system' && typeof message.content === 'string' && hasDeferredToolManifestBlock(message.content)
  );
  const idx = resolveDeferredBp2Index(session);
  if (idx < 0) return false;
  if (existingMessage === session.messages[idx] && !rebuild) {
    markDeferredBp2Applied(session);
    return true;
  }
  writeDeferredManifestAt(session, idx, manifest, rebuild);
  markDeferredBp2Applied(session);
  session.updatedAt = Date.now();
  return true;
}
