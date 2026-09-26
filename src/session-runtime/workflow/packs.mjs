// WORKFLOW.md pack discovery: built-in packs under <root>/workflows and user
// packs under <data>/workflows, the user copy winning; hidden packs never list.
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { clean } from '../session-text.mjs';
import { readDirEntriesSafe, readTextSafe } from '../fs-utils.mjs';
import { DEFAULT_WORKFLOW_ID, normalizeWorkflowId } from '../workflow-ids.mjs';
import { createSharedScanCache } from './shared-scan-cache.mjs';

const WORKFLOW_ENTRY = 'WORKFLOW.md';
// Resolved packs shared process-wide, one cache per markdown parser so
// loaders built with different parsers never see each other's results.
const packCaches = new Map();

export function createWorkflowPacks({ rootDir, dataDir, readMarkdownDocument }) {
  if (!packCaches.has(readMarkdownDocument)) packCaches.set(readMarkdownDocument, createSharedScanCache());
  const packCache = packCaches.get(readMarkdownDocument);
  const workflowSourceDirs = (dir) => [
    { root: join(rootDir, 'workflows'), source: 'built-in' },
    { root: join(dir || dataDir, 'workflows'), source: 'user' },
  ];

  function parseWorkflowPack(text, source, dirName) {
    const doc = readMarkdownDocument(text);
    const body = doc.body;
    if (!body) return null;
    const fm = doc.frontmatter || {};
    const id = normalizeWorkflowId(clean(fm.id) || dirName);
    if (!id) return null;
    return {
      id,
      name: clean(fm.name) || id,
      description: clean(fm.description),
      entry: WORKFLOW_ENTRY,
      hidden:
        String(fm.hidden ?? '')
          .trim()
          .toLowerCase() === 'true',
      body,
      source,
    };
  }

  function readWorkflowPackFromDir(dir, source = 'built-in', dirName = '') {
    return parseWorkflowPack(readTextSafe(join(dir, WORKFLOW_ENTRY)), source, dirName || basename(dir));
  }

  // User copy first, then built-in, then the built-in default pack. Yields its
  // file reads; see shared-scan-cache.mjs.
  function* resolveWorkflowPack(dir, wanted) {
    for (const { root, source } of workflowSourceDirs(dir).reverse()) {
      const text = yield { op: 'readText', path: join(root, wanted, WORKFLOW_ENTRY) };
      const pack = parseWorkflowPack(text, source, wanted);
      if (pack) return pack;
    }
    const fallback = yield { op: 'readText', path: join(rootDir, 'workflows', DEFAULT_WORKFLOW_ID, WORKFLOW_ENTRY) };
    return parseWorkflowPack(fallback, 'built-in', DEFAULT_WORKFLOW_ID);
  }

  function wantedWorkflowId(id) {
    const normalized = normalizeWorkflowId(id, DEFAULT_WORKFLOW_ID);
    return normalized === 'solo' ? DEFAULT_WORKFLOW_ID : normalized;
  }

  const packKey = (dir, wanted) => `${rootDir}\n${dir || dataDir}\n${wanted}`;

  function listWorkflowPacks(dir) {
    const byId = new Map();
    for (const { root, source } of workflowSourceDirs(dir)) {
      for (const entry of readDirEntriesSafe(root)) {
        if (!entry.isDirectory()) continue;
        const d = join(root, entry.name);
        if (!existsSync(join(d, 'WORKFLOW.md'))) continue;
        const pack = readWorkflowPackFromDir(d, source, entry.name);
        if (pack && !pack.hidden) byId.set(pack.id, pack);
      }
    }
    const weight = (pack) => (pack.id === DEFAULT_WORKFLOW_ID ? 0 : 1);
    return [...byId.values()].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));
  }

  function activeWorkflowId(config) {
    const id = normalizeWorkflowId(config?.workflow?.active, DEFAULT_WORKFLOW_ID);
    return id === 'solo' ? DEFAULT_WORKFLOW_ID : id;
  }

  // Fresh read for explicit callers (workflow editor, session create,
  // automation). The app's writers read the pack back through here after a
  // save/delete/switch, which republishes it for sharedWorkflowPack at once.
  function loadWorkflowPack(dir, id) {
    const wanted = wantedWorkflowId(id);
    return packCache.fresh(packKey(dir, wanted), () => resolveWorkflowPack(dir, wanted));
  }

  // Per-tick read for the status pulse: shared across sessions, revalidated
  // in the background at most once per SHARED_SCAN_REVALIDATE_MS, so an
  // out-of-app edit shows up within that interval plus one background read.
  function sharedWorkflowPack(dir, id) {
    const wanted = wantedWorkflowId(id);
    return packCache.shared(packKey(dir, wanted), () => resolveWorkflowPack(dir, wanted));
  }

  return { listWorkflowPacks, activeWorkflowId, loadWorkflowPack, sharedWorkflowPack };
}
