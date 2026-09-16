import { assessChunkQuality } from './memory-chunk-quality.mjs';

// Entries are immutable source rows, including the original body on each root.
// Legacy sentinel rows remain standalone RAW; they are not completed chunks.
export function collectChunkRoots(entries) {
  const roots = new Map();
  const ids = new Set();
  for (const entry of entries) {
    const id = String(entry.id);
    if (ids.has(id)) throw new Error(`duplicate source entry ${id}`);
    ids.add(id);
    if (Number(entry.is_root) === 1) roots.set(id, { ...entry, members: [] });
  }
  for (const entry of entries) {
    roots.get(String(entry.chunk_root))?.members.push(entry);
  }
  for (const root of roots.values()) {
    root.members.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id));
  }
  return [...roots.values()];
}

export function auditChunkEntries(entries) {
  const chunks = collectChunkRoots(entries).map((root) => ({
    id: root.id,
    memberCount: root.members.length,
    ...assessChunkQuality(root),
  }));
  const reasons = {};
  for (const chunk of chunks) {
    for (const reason of chunk.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    entryCount: entries.length,
    chunkCount: chunks.length,
    reusable: chunks.filter((chunk) => chunk.usable).length,
    rawFallback: chunks.filter((chunk) => !chunk.usable).length,
    legacyDeferredRows: entries.filter(
      (entry) =>
        Number(entry.is_root) === 0 &&
        String(entry.chunk_root) === String(entry.id) &&
        String(entry.content ?? '').trim()
    ).length,
    reasons,
    chunks,
  };
}
