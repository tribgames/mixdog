// Agent role discovery and AGENT.md loading. Custom agents include shipped
// starter roles and user-authored roles; a data-dir tombstone suppresses a
// shipped starter after the user deletes it, so package updates do not
// silently resurrect the role.
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { clean } from '../session-text.mjs';
import { defaultDirResolver, readJsonSafe, readTextSafe } from '../fs-utils.mjs';
import { SHARED_SCAN_REVALIDATE_MS, createSharedScanCache } from './shared-scan-cache.mjs';
import { isHiddenAgent } from '../../internal-agents.mjs';
import { isAgentDisabled } from '../../../../shared/agent-route-config.mjs';
import { agentDefinitionKind } from '../../../../shared/agent-kind.mjs';
import {
  BOTS_DIR,
  MIXY_BOT_ID,
  botStoreActive,
  isStoreBot,
  migratedBotIds,
  userDefinitionDir,
} from '../../../../shared/agent-store.mjs';
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

// Yields its fs requests; see shared-scan-cache.mjs. With the bot store
// active, bots/ is scanned too and the agents/ originals of the ids the split
// copied are skipped (agent-store.mjs).
function* scanCustomAgentIds(userRoot, shippedRoot, botsRoot = null, migrated = new Set()) {
  const ids = new Set();
  for (const root of [...(botsRoot ? [botsRoot] : []), userRoot, shippedRoot]) {
    const entries = yield { op: 'readdir', path: root };
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = normalizeWorkflowId(entry.name);
      // `lead` is the Lead's own folder, `mixy` Mixy's: neither is an agent.
      if (!id || id === 'lead' || AGENT_ROLE_IDS.has(id) || isHiddenAgent(id)) continue;
      if (root === botsRoot && id === MIXY_BOT_ID) continue;
      if (root === userRoot && migrated.has(id)) continue;
      if (root === botsRoot && entry.name !== id) continue;
      if (root === shippedRoot && (yield { op: 'exists', path: join(userRoot, id, AGENT_DELETED_MARKER) })) continue;
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

// mtime+size of each file ("-" when absent). loadAgentDefinition runs per
// agent on every status pulse and prompt build; a handful of stats is cheap.
function fileSignature(files) {
  return files
    .map((file) => {
      try {
        const st = statSync(file);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

export function createWorkflowAgents({ rootDir, dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone }) {
  const defaultDir = defaultDirResolver(dataDir);
  function agentSourceDirs(dir, id) {
    // A store bot reads only its own folder (agent-store.mjs).
    if (isStoreBot(dir || defaultDir(), id)) return [userDefinitionDir(dir || defaultDir(), id)];
    const userDir = join(dir || defaultDir(), 'agents', id);
    if (existsSync(join(userDir, AGENT_DELETED_MARKER))) return [userDir];
    return [userDir, join(rootDir, 'agents', id)];
  }

  function agentScan(dir) {
    const base = dir || defaultDir();
    const userRoot = join(base, 'agents');
    const shippedRoot = join(rootDir, 'agents');
    const store = botStoreActive(base);
    const migrated = store ? migratedBotIds(base) : new Set();
    const botsRoot = store ? join(base, BOTS_DIR) : null;
    return {
      key: `${userRoot}\n${shippedRoot}\n${botsRoot || ''}\n${[...migrated].join(',')}`,
      makeScan: () => scanCustomAgentIds(userRoot, shippedRoot, botsRoot, migrated),
    };
  }

  function listCustomAgentIds(dir) {
    const { key, makeScan } = agentScan(dir);
    return [...agentListCache.fresh(key, makeScan)];
  }

  // Agents the Lead may actually delegate to: on disk, not hidden, not a
  // slot-backed built-in, and not switched off by the user. The shared scan
  // already drops hidden agents.
  function delegatableAgentIds(config, dir) {
    const { key, makeScan } = agentScan(dir);
    return agentListCache
      .shared(key, makeScan)
      .filter((id) => !BUILTIN_SLOT_AGENT_IDS.has(id) && !isAgentDisabled(config, id));
  }

  function loadAgentDefinition(dir, id) {
    const agentId = normalizeAgentId(id) || normalizeWorkflowId(id);
    if (!agentId) return null;
    const cacheKey = `${dir || defaultDir()}\n${agentId}`;
    const cached = agentDefinitionCache.get(cacheKey);
    // A hit is trusted only while the files it was built from are unchanged,
    // so a direct edit of AGENT.md/agent.json/PERSONA.md shows without a restart.
    if (cached && fileSignature(cached.files) === cached.signature) return cached.definition;
    const slot = FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId);
    const files = [];
    const remember = (definition) => {
      setAgentDefinitionCache(cacheKey, { definition, files, signature: fileSignature(files) });
      return definition;
    };
    for (const d of agentSourceDirs(dir, agentId)) {
      const manifest = readJsonSafe(join(d, 'agent.json')) || {};
      const entry = clean(manifest.entry) || 'AGENT.md';
      // Shipped files change only with an install update (a restart).
      if (d !== join(rootDir, 'agents', agentId)) {
        files.push(join(d, 'agent.json'), join(d, entry), join(d, 'PERSONA.md'), join(d, AGENT_DELETED_MARKER));
      }
      const doc = readMarkdownDocument(readTextSafe(join(d, entry)));
      const body = doc.body;
      if (!body) continue;
      const definition = {
        id: agentId,
        name: clean(manifest.name) || slot?.label || agentId,
        description: clean(manifest.description) || slot?.description || '',
        permission: normalizeAgentPermissionOrNone(doc.frontmatter.permission),
        frontmatter: doc.frontmatter,
        // bot | agent | null, decided read-only (shared/agent-kind.mjs).
        kind: agentDefinitionKind({
          frontmatterKind: doc.frontmatter.kind,
          ...(d !== join(rootDir, 'agents', agentId)
            ? { dataDir: dir || defaultDir(), shippedRoot: rootDir, id: agentId, manifest, body }
            : {}),
        }),
        body,
        // Optional PERSONA.md beside AGENT.md (same dir, same cache entry).
        persona: (readTextSafe(join(d, 'PERSONA.md')) || '').trim(),
      };
      return remember(definition);
    }
    // Every shipped and user role lives at agents/<id>/AGENT.md; there is no
    // flat agents/<id>.md layout left to fall back to.
    return remember(null);
  }

  return { listCustomAgentIds, delegatableAgentIds, loadAgentDefinition };
}
