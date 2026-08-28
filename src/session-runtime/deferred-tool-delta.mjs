import { clean } from './session-text.mjs';

function compactDescription(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 240);
}

function normalizedDelta(value) {
  const source = value && typeof value === 'object' ? value : {};
  const addedByName = new Map();
  for (const entry of Array.isArray(source.added) ? source.added : []) {
    const name = clean(entry?.name);
    if (name) addedByName.set(name, { name, description: compactDescription(entry?.description) });
  }
  const removed = new Set(
    (Array.isArray(source.removed) ? source.removed : [])
      .map((entry) => clean(typeof entry === 'string' ? entry : entry?.name))
      .filter(Boolean),
  );
  for (const name of addedByName.keys()) removed.delete(name);
  return {
    revision: Math.max(0, Number(source.revision) || 0),
    addedByName,
    removed,
  };
}

export function mergePendingDeferredToolDelta(session, change = {}) {
  if (!session || typeof session !== 'object') return null;
  const current = normalizedDelta(session.pendingDeferredToolDelta);
  const nextRevision = Math.max(
    current.revision,
    Math.max(0, Number(session.deferredToolDeltaRevision) || 0),
  ) + 1;
  for (const entry of Array.isArray(change.added) ? change.added : []) {
    const name = clean(entry?.name);
    if (!name) continue;
    if (current.removed.delete(name)) continue;
    current.addedByName.set(name, {
      name,
      description: compactDescription(entry?.description),
    });
  }
  for (const entry of Array.isArray(change.removed) ? change.removed : []) {
    const name = clean(typeof entry === 'string' ? entry : entry?.name);
    if (!name) continue;
    if (current.addedByName.delete(name)) continue;
    current.removed.add(name);
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
  };
  session.updatedAt = Date.now();
  return session.pendingDeferredToolDelta;
}

export function snapshotPendingDeferredToolDelta(session) {
  const current = normalizedDelta(session?.pendingDeferredToolDelta);
  const added = [...current.addedByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const removed = [...current.removed].sort();
  if (!added.length && !removed.length) return null;
  const lines = ['<system-reminder>', '<deferred_tools_delta>'];
  if (added.length) {
    lines.push('Added deferred tools:');
    for (const entry of added) {
      lines.push(entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`);
    }
  }
  if (removed.length) {
    lines.push('Removed deferred tools:');
    for (const name of removed) lines.push(`- ${name}`);
  }
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
