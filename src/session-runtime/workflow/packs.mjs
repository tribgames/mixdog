// WORKFLOW.md pack discovery: built-in packs under <root>/workflows and user
// packs under <data>/workflows, the user copy winning; hidden packs never list.
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { clean } from '../session-text.mjs';
import { readDirEntriesSafe, readTextSafe } from '../fs-utils.mjs';
import { DEFAULT_WORKFLOW_ID, normalizeWorkflowId } from '../workflow-ids.mjs';

export function createWorkflowPacks({ rootDir, dataDir, readMarkdownDocument }) {
  const workflowSourceDirs = (dir) => [
    { root: join(rootDir, 'workflows'), source: 'built-in' },
    { root: join(dir || dataDir, 'workflows'), source: 'user' },
  ];

  function readWorkflowPackFromDir(dir, source = 'built-in', dirName = '') {
    const entry = 'WORKFLOW.md';
    const doc = readMarkdownDocument(readTextSafe(join(dir, entry)));
    const body = doc.body;
    if (!body) return null;
    const fm = doc.frontmatter || {};
    const id = normalizeWorkflowId(clean(fm.id) || dirName || basename(dir));
    if (!id) return null;
    return {
      id,
      name: clean(fm.name) || id,
      description: clean(fm.description),
      entry,
      hidden:
        String(fm.hidden ?? '')
          .trim()
          .toLowerCase() === 'true',
      body,
      source,
    };
  }

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

  function loadWorkflowPack(dir, id) {
    const normalized = normalizeWorkflowId(id, DEFAULT_WORKFLOW_ID);
    const wanted = normalized === 'solo' ? DEFAULT_WORKFLOW_ID : normalized;
    for (const { root, source } of workflowSourceDirs(dir).reverse()) {
      const pack = readWorkflowPackFromDir(join(root, wanted), source, wanted);
      if (pack) return pack;
    }
    return readWorkflowPackFromDir(join(rootDir, 'workflows', DEFAULT_WORKFLOW_ID), 'built-in', DEFAULT_WORKFLOW_ID);
  }

  return { listWorkflowPacks, activeWorkflowId, loadWorkflowPack };
}
