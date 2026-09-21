// Deferred-pool and MCP-instruction manifests injected into BP2.

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

const DEFERRED_TOOLS_BLOCK_RE = /(\n\n---\n*)?<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>\s*/gi;
const MCP_INSTRUCTIONS_BLOCK_RE = /(\n\n---\n*)?<mcp-instructions>[\s\S]*?<\/mcp-instructions>\s*/gi;
const DEFERRED_TOOL_NAME_SAFE_RE = /^[A-Za-z0-9_.:-]+$/;
const MCP_SERVER_NAME_SAFE_RE = /^[A-Za-z0-9_.:-]+$/;
const MCP_INSTRUCTION_MAX_CHARS = 600;

function sanitizeDeferredToolManifestName(name) {
  const text = String(name || '').trim();
  if (!text || text.includes('<') || text.includes('>')) return '';
  if (!DEFERRED_TOOL_NAME_SAFE_RE.test(text)) return '';
  return text;
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
    /<mcp-instructions>[\s\S]*?<\/mcp-instructions>/i.test(raw)
  );
}

/**
 * Skill-style manifest for tools in the deferred pool (catalog minus active
 * wire tools). Each entry is either a bare name string or `{ name, description }`;
 * output lines are `- name: description` (description omitted when absent),
 * mirroring the available-skills manifest so the model calls deferred tools
 * directly. Descriptions are compacted and stripped of `<`/`>`.
 * Empty pool → '' (caller omits the block).
 */
export function buildDeferredToolManifest(entries) {
  const list = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawName = typeof entry === 'string' ? entry : entry?.name;
    const name = sanitizeDeferredToolManifestName(rawName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof entry === 'string'
        ? ''
        : compactPromptManifestText(String(entry?.description || '').replace(/[<>]/g, ''), 100);
    list.push({ name, description });
  }
  if (!list.length) return '';
  list.sort((a, b) => a.name.localeCompare(b.name));
  return [
    '<available-deferred-tools>',
    'Deferred tool names and purposes; schemas load on demand.',
    ...list.map((entry) => (entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)),
    '</available-deferred-tools>',
  ].join('\n');
}

function sanitizeMcpManifestServerName(name) {
  const text = String(name || '').trim();
  if (!text || text.includes('<') || text.includes('>')) return '';
  if (!MCP_SERVER_NAME_SAFE_RE.test(text)) return '';
  return text;
}

function sanitizeMcpInstructionText(text, max = MCP_INSTRUCTION_MAX_CHARS) {
  const stripped = String(text || '')
    .replace(/[<>]/g, '')
    .trim();
  if (!stripped) return '';
  const cap = Math.max(1, Number(max) || MCP_INSTRUCTION_MAX_CHARS);
  return stripped.length > cap ? `${stripped.slice(0, Math.max(1, cap - 3))}...` : stripped;
}

/**
 * Per-server MCP initialize instructions for deferred-pool tools only.
 * Empty when no instructions or no matching deferred MCP tools → omit block.
 * Emits ONLY the server heading + instruction body: the per-server tool names
 * are deliberately NOT repeated here — every pool tool is already listed once
 * (with its description) in <available-deferred-tools>, and re-listing ~30
 * names per server doubled the MCP share of the BP2 prefix (2026-08-05 audit).
 * Server membership stays evident from the mcp__<server>__ name prefix.
 */
function buildMcpInstructionsManifest(mcpServerInstructions, poolNames) {
  const map = mcpServerInstructions && typeof mcpServerInstructions === 'object' ? mcpServerInstructions : {};
  const pool = [
    ...new Set(
      (Array.isArray(poolNames) ? poolNames : []).map((name) => sanitizeDeferredToolManifestName(name)).filter(Boolean)
    ),
  ];
  const deferredServers = new Set();
  for (const name of pool) {
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match) continue;
    deferredServers.add(match[1]);
  }
  const servers = [...deferredServers]
    .filter((server) => sanitizeMcpManifestServerName(server) && sanitizeMcpInstructionText(map[server]))
    .sort((a, b) => a.localeCompare(b));
  if (!servers.length) return '';
  const lines = ['<mcp-instructions>'];
  for (const server of servers) {
    const safeServer = sanitizeMcpManifestServerName(server);
    const body = sanitizeMcpInstructionText(map[server]);
    lines.push(`## ${safeServer}`, body);
  }
  lines.push('</mcp-instructions>');
  return lines.join('\n');
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
// manifest, agent rules, …) is reordered or dropped. The fresh manifest already
// carries the mcp-instructions companion, so any pre-existing standalone one is
// removed first to avoid duplication.
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

function deferredManifestEntries(session, pool) {
  const descByName = new Map();
  for (const tool of Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    const name = String(tool?.name || '').trim();
    if (name && !descByName.has(name)) descByName.set(name, String(tool?.description || ''));
  }
  const skillRoutedNames = skillRoutedToolNames(session.messages);
  return pool.map((name) => ({
    name,
    description: skillRoutedNames.has(String(name).trim()) ? '' : descByName.get(String(name).trim()) || '',
  }));
}

function composeDeferredBp2Manifest(session, pool) {
  const parts = [];
  const deferredManifest = buildDeferredToolManifest(deferredManifestEntries(session, pool));
  if (deferredManifest) parts.push(deferredManifest);
  const mcpManifest = buildMcpInstructionsManifest(session.mcpServerInstructions, pool);
  if (mcpManifest) parts.push(mcpManifest);
  return parts.join('\n\n');
}

function markDeferredBp2Applied(session) {
  session.deferredToolBp2Applied = true;
  delete session.deferredToolBp1Applied;
}

function clearDeferredManifestBlocks(session) {
  for (const message of session.messages) {
    if (message?.role === 'system' && typeof message.content === 'string') {
      message.content = stripDeferredToolManifestBlock(message.content);
    }
  }
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

function writeDeferredManifestAt(session, idx, manifest, rebuild) {
  for (let i = 0; i < session.messages.length; i++) {
    if (i === idx || session.messages[i]?.role !== 'system' || typeof session.messages[i].content !== 'string')
      continue;
    session.messages[i].content = stripDeferredToolManifestBlock(session.messages[i].content);
  }
  const raw = typeof session.messages[idx].content === 'string' ? session.messages[idx].content : '';
  if (rebuild && hasDeferredToolManifestBlock(raw)) {
    session.messages[idx].content = rebuildDeferredToolManifestBlock(raw, manifest);
    return;
  }
  const base = stripDeferredToolManifestBlock(raw);
  session.messages[idx].content = base ? `${base}\n\n---\n\n${manifest}` : manifest;
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
