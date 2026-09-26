// Agent role discovery and AGENT.md loading. Custom agents include shipped
// starter roles and user-authored roles; a data-dir tombstone suppresses a
// shipped starter after the user deletes it, so package updates do not
// silently resurrect the role.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { clean } from '../session-text.mjs';
import { readJsonSafe, readTextSafe } from '../fs-utils.mjs';
import { SHARED_SCAN_REVALIDATE_MS, createSharedScanCache } from './shared-scan-cache.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';
import { isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import {
  AGENT_DELETED_MARKER,
  AGENT_ROLE_IDS,
  BUILTIN_SLOT_AGENT_IDS,
  FIXED_AGENT_SLOTS,
  STARTER_AGENT_ORDER,
  agentDefinitionCache,
  normalizeAgentId,
  normalizeWorkflowId,
  setAgentDefinitionCache,
} from '../workflow-ids.mjs';

// Yields its fs requests; see shared-scan-cache.mjs.
function* scanCustomAgentIds(userRoot, shippedRoot) {
  const ids = new Set();
  for (const root of [userRoot, shippedRoot]) {
    const entries = yield { op: 'readdir', path: root };
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = normalizeWorkflowId(entry.name);
      if (!id || AGENT_ROLE_IDS.has(id) || isHiddenAgent(id)) continue;
      if (root !== userRoot && (yield { op: 'exists', path: join(userRoot, id, AGENT_DELETED_MARKER) })) continue;
      if (!(yield { op: 'exists', path: join(root, entry.name, 'AGENT.md') })) continue;
      ids.add(id);
    }
  }
  return [...ids].sort((left, right) => {
    const leftRank = STARTER_AGENT_ORDER.get(left);
    const rightRank = STARTER_AGENT_ORDER.get(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
}

// Every session's 2 s status pulse resolves the delegatable agent list, so
// the scan result is shared process-wide per (user, shipped) agents-root pair
// and revalidated in the background (shared-scan-cache.mjs); an agent added,
// removed or tombstoned on disk shows up within AGENT_LIST_REVALIDATE_MS plus
// one background scan. listCustomAgentIds (editor/onboarding) always scans
// fresh and republishes, so editor writes are visible immediately.
export const AGENT_LIST_REVALIDATE_MS = SHARED_SCAN_REVALIDATE_MS;
const agentListCache = createSharedScanCache();

export function createWorkflowAgents({ rootDir, dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone }) {
  function agentSourceDirs(dir, id) {
    const userDir = join(dir || dataDir, 'agents', id);
    if (existsSync(join(userDir, AGENT_DELETED_MARKER))) return [userDir];
    return [userDir, join(rootDir, 'agents', id)];
  }

  function listCustomAgentIds(dir) {
    const userRoot = join(dir || dataDir, 'agents');
    const shippedRoot = join(rootDir, 'agents');
    return [
      ...agentListCache.fresh(`${userRoot}\n${shippedRoot}`, () => scanCustomAgentIds(userRoot, shippedRoot)),
    ];
  }

  // Agents the Lead may actually delegate to: on disk, not hidden, not a
  // slot-backed built-in, and not switched off by the user. The shared scan
  // already drops hidden agents.
  function delegatableAgentIds(config, dir) {
    const userRoot = join(dir || dataDir, 'agents');
    const shippedRoot = join(rootDir, 'agents');
    return agentListCache
      .shared(`${userRoot}\n${shippedRoot}`, () => scanCustomAgentIds(userRoot, shippedRoot))
      .filter((id) => !BUILTIN_SLOT_AGENT_IDS.has(id) && !isAgentDisabled(config, id));
  }

  function loadAgentDefinition(dir, id) {
    const agentId = normalizeAgentId(id) || normalizeWorkflowId(id);
    if (!agentId) return null;
    const cacheKey = `${dir || dataDir}\n${agentId}`;
    if (agentDefinitionCache.has(cacheKey)) return agentDefinitionCache.get(cacheKey);
    const slot = FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId);
    for (const d of agentSourceDirs(dir, agentId)) {
      const manifest = readJsonSafe(join(d, 'agent.json')) || {};
      const entry = clean(manifest.entry) || 'AGENT.md';
      const doc = readMarkdownDocument(readTextSafe(join(d, entry)));
      const body = doc.body;
      if (!body) continue;
      const definition = {
        id: agentId,
        name: clean(manifest.name) || slot?.label || agentId,
        description: clean(manifest.description) || slot?.description || '',
        permission: normalizeAgentPermissionOrNone(doc.frontmatter.permission),
        frontmatter: doc.frontmatter,
        body,
      };
      setAgentDefinitionCache(cacheKey, definition);
      return definition;
    }
    // Every shipped and user role lives at agents/<id>/AGENT.md; there is no
    // flat agents/<id>.md layout left to fall back to.
    setAgentDefinitionCache(cacheKey, null);
    return null;
  }

  return { listCustomAgentIds, delegatableAgentIds, loadAgentDefinition };
}
