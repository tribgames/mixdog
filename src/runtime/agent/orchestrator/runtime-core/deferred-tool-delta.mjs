import { clean } from './session-text.mjs';
import { parseMcpToolName } from '../../../shared/tool-primitives.mjs';
import { mcpServerLines } from '../context/deferred-tools.mjs';

function compactDescription(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 240);
}

function addedEntry(entry) {
  const name = clean(entry?.name);
  return name ? { name, description: compactDescription(entry?.description) } : null;
}

function normalizedDelta(value) {
  const source = value && typeof value === 'object' ? value : {};
  const addedByName = new Map();
  for (const entry of Array.isArray(source.added) ? source.added : []) {
    const added = addedEntry(entry);
    if (added) addedByName.set(added.name, added);
  }
  const removed = new Set();
  // Removed tool name → its server, for removals that came with one.
  const removedServers = new Map(
    Object.entries(source.removedServers && typeof source.removedServers === 'object' ? source.removedServers : {})
  );
  for (const entry of Array.isArray(source.removed) ? source.removed : []) {
    const name = clean(typeof entry === 'string' ? entry : entry?.name);
    if (!name) continue;
    removed.add(name);
    if (typeof entry === 'object' && clean(entry?.server)) removedServers.set(name, clean(entry.server));
  }
  for (const name of addedByName.keys()) removed.delete(name);
  for (const name of [...removedServers.keys()]) if (!removed.has(name)) removedServers.delete(name);
  return {
    revision: Math.max(0, Number(source.revision) || 0),
    addedByName,
    removed,
    removedServers,
  };
}

export function mergePendingDeferredToolDelta(session, change = {}) {
  if (!session || typeof session !== 'object') return null;
  const current = normalizedDelta(session.pendingDeferredToolDelta);
  const nextRevision = Math.max(current.revision, Math.max(0, Number(session.deferredToolDeltaRevision) || 0)) + 1;
  for (const entry of Array.isArray(change.added) ? change.added : []) {
    const added = addedEntry(entry);
    if (!added) continue;
    if (current.removed.delete(added.name)) {
      current.removedServers.delete(added.name);
      continue;
    }
    current.addedByName.set(added.name, added);
  }
  for (const entry of Array.isArray(change.removed) ? change.removed : []) {
    const name = clean(typeof entry === 'string' ? entry : entry?.name);
    if (!name) continue;
    if (current.addedByName.delete(name)) continue;
    current.removed.add(name);
    if (typeof entry === 'object' && clean(entry?.server)) current.removedServers.set(name, clean(entry.server));
  }
  const added = [...current.addedByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const removed = [...current.removed].sort();
  if (!added.length && !removed.length) {
    session.deferredToolDeltaRevision = nextRevision;
    delete session.pendingDeferredToolDelta;
    return null;
  }
  session.deferredToolDeltaRevision = nextRevision;
  session.pendingDeferredToolDelta = {
    version: 1,
    type: 'deferred_tools_delta',
    revision: nextRevision,
    added,
    removed,
    ...(current.removedServers.size
      ? { removedServers: Object.fromEntries([...current.removedServers].sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  };
  session.updatedAt = Date.now();
  return session.pendingDeferredToolDelta;
}

// MCP changes render one line per affected server, like the BP2 manifest; the tool-level sets stay exact in the snapshot for acknowledgement.
// A tool's server comes from the session's catalog definitions (an added
// tool) or the server recorded when it was removed; only a name neither knows
// falls back to the recorded/`mcp__<server>__<tool>` parse. Other tools are
// listed one by one.
function deltaLines(session, added, removed, removedServers) {
  const catalogServer = new Map();
  for (const key of ['deferredToolCatalog', 'deferredLateToolCatalog', 'tools']) {
    for (const tool of Array.isArray(session?.[key]) ? session[key] : []) {
      const name = clean(tool?.name);
      const server = name && parseMcpToolName(tool)?.server;
      if (server) catalogServer.set(name, server);
    }
  }
  const serverOf = (name, hint) => hint || catalogServer.get(name) || parseMcpToolName(name)?.server || '';
  const items = [];

  const addedServers = new Map();
  for (const entry of added) {
    const server = serverOf(entry.name);
    if (!server) {
      items.push({ label: entry.name, line: entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}` });
    } else if (addedServers.has(server)) addedServers.get(server).push(entry);
    else addedServers.set(server, [entry]);
  }
  const addedLines = mcpServerLines(addedServers, session?.mcpServerInstructions);
  for (const line of addedLines) items.push({ label: line.label, line: `- ${line.label}: ${line.trigger}` });
  // A server whose name cannot be listed safely is listed by its tools.
  const listed = new Set(addedLines.map((line) => line.label));
  for (const [server, entries] of addedServers) {
    if (listed.has(`mcp__${server}`)) continue;
    for (const entry of entries) items.push({ label: entry.name, line: `- ${entry.name}` });
  }

  const connected = Array.isArray(session?.deferredMcpToolNames) ? session.deferredMcpToolNames : null;
  const liveServers = new Set((connected || []).map((name) => serverOf(clean(name))).filter(Boolean));
  const removedByServer = new Map();
  const removedItems = [];
  for (const name of removed) {
    const server = serverOf(name, removedServers.get(name));
    if (!server) {
      removedItems.push({ label: name, line: `- ${name}` });
      continue;
    }
    if (removedByServer.has(server)) removedByServer.get(server).push(name);
    else removedByServer.set(server, [name]);
  }
  // Gone only when the connected set is known and none of its tools is left.
  for (const [server, names] of removedByServer) {
    const label = `mcp__${server}`;
    const gone = connected && !liveServers.has(server);
    removedItems.push({
      label,
      line: gone ? `- ${label}` : `- ${label}: ${names.length} tool${names.length === 1 ? '' : 's'} removed`,
    });
  }

  const render = (list) => list.sort((a, b) => a.label.localeCompare(b.label)).map((item) => item.line);
  return { added: render(items), removed: render(removedItems) };
}

export function snapshotPendingDeferredToolDelta(session) {
  const current = normalizedDelta(session?.pendingDeferredToolDelta);
  const added = [...current.addedByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const removed = [...current.removed].sort();
  if (!added.length && !removed.length) return null;
  const rendered = deltaLines(session, added, removed, current.removedServers);
  const lines = ['<system-reminder>', '<deferred_tools_delta>'];
  if (rendered.added.length) lines.push('Added deferred tools:', ...rendered.added);
  if (rendered.removed.length) lines.push('Removed deferred tools:', ...rendered.removed);
  lines.push('</deferred_tools_delta>', '</system-reminder>');
  return {
    revision: current.revision,
    added,
    removed,
    content: lines.join('\n'),
  };
}

export function acknowledgePendingDeferredToolDelta(session, revision) {
  if (!session || typeof session !== 'object') return false;
  const current = normalizedDelta(session.pendingDeferredToolDelta);
  if (!current.revision || current.revision !== Number(revision)) return false;
  delete session.pendingDeferredToolDelta;
  session.updatedAt = Date.now();
  return true;
}
