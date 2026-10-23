import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { writeFileAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { serializeFrontmatterDoc } from '../../runtime/shared/markdown-frontmatter.mjs';
import {
  normalizeWorkflowId,
  workflowIdFromName,
  availableWorkflowId,
  DEFAULT_WORKFLOW_ID,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { oneLine, resolveDataDir } from './shared.mjs';
import { absorbSaveEqualToShipped } from '../../runtime/shared/shipped-definitions.mjs';
import { STANDALONE_ROOT } from '../runtime-paths.mjs';

// Workflow packs: the catalog/active switch plus the editor surface (desktop
// Workflows page). User packs live at <dataDir>/workflows/<id>/WORKFLOW.md;
// saving a built-in id writes a user override, deleting the override reverts it.
export function createWorkflowPacksApi(deps) {
  const {
    getConfig,
    saveConfigAndAdopt,
    displayConfig,
    activeWorkflowId,
    listWorkflowPacks,
    loadWorkflowPack,
    workflowSummary,
  } = deps;

  const packExists = (dataDir, id) => {
    const existing = loadWorkflowPack(dataDir, id);
    return Boolean(existing && existing.id === id);
  };

  function saveActiveWorkflow(id) {
    const nextConfig = { ...getConfig() };
    nextConfig.workflow = { ...(nextConfig.workflow || {}), active: id };
    saveConfigAndAdopt(nextConfig);
  }

  function listWorkflows() {
    const currentConfig = displayConfig();
    const active = activeWorkflowId(currentConfig);
    return listWorkflowPacks(resolveDataDir(deps)).map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      source: workflow.source,
      ...(workflow.overridesBuiltIn ? { overridesBuiltIn: true } : {}),
      active: workflow.id === active,
    }));
  }

  // `{ scope: 'session' }` (the composer's selector in a session): a session
  // with a conversation switches alone from its next turn
  // (switchSessionWorkflow) and the configured workflow — the default for new
  // sessions — stays as it is. Without a conversation, and without the
  // scope, the choice becomes the configured workflow and an empty session
  // picks it up in place, as before.
  async function setWorkflow(workflowId, options = {}) {
    const requested = normalizeWorkflowId(workflowId, DEFAULT_WORKFLOW_ID);
    const id = requested === 'solo' ? DEFAULT_WORKFLOW_ID : requested;
    const pack = loadWorkflowPack(resolveDataDir(deps), id);
    if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
    if (options?.scope === 'session') {
      const switched = await deps.switchSessionWorkflow?.(id);
      if (switched) return { ...switched.workflow, ...switched };
    }
    saveActiveWorkflow(id);
    const applied = await deps.refreshEmptySessionToolPolicy?.();
    deps.invalidatePreSessionToolSurface?.();
    return { ...workflowSummary(pack), appliedToCurrentSession: applied?.appliedToCurrentSession !== false };
  }

  function getWorkflowPack(workflowId) {
    const id = normalizeWorkflowId(workflowId, '');
    if (!id) throw new Error(`unknown workflow "${workflowId}"`);
    const dataDir = resolveDataDir(deps);
    const pack = loadWorkflowPack(dataDir, id);
    if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
    // The user copy's file, so a part of a long body can be edited in place;
    // a shipped-only pack has none (its install copy is replaced on update).
    const file = join(dataDir, 'workflows', id, 'WORKFLOW.md');
    const userOverride = existsSync(file);
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      source: pack.source,
      body: pack.body,
      userOverride,
      ...(userOverride ? { path: file } : {}),
    };
  }

  async function saveWorkflowPack(payload = {}) {
    const id = normalizeWorkflowId(payload.id, '');
    if (!id) throw new Error('workflow id must contain letters/numbers (dashes and dots allowed)');
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('WORKFLOW.md body must not be empty');
    const name = oneLine(payload.name) || id;
    const description = oneLine(payload.description);
    const dataDir = resolveDataDir(deps);
    // Equal to the shipped pack: keep no copy so it follows the shipped version.
    const absorbed = absorbSaveEqualToShipped({
      rootDir: deps.rootDir ?? STANDALONE_ROOT,
      dataDir,
      dir: 'workflows',
      id,
      entry: 'WORKFLOW.md',
      files: ['WORKFLOW.md'],
      definition: { name, description, body },
    });
    if (!absorbed) {
      const dir = join(dataDir, 'workflows', id);
      mkdirSync(dir, { recursive: true });
      writeFileAtomicSync(
        join(dir, 'WORKFLOW.md'),
        serializeFrontmatterDoc({ id, name, ...(description ? { description } : {}) }, body),
        { backup: true, mode: 0o644 }
      );
    }
    return getWorkflowPack(id);
  }

  async function createWorkflow(payload = {}) {
    const dataDir = resolveDataDir(deps);
    const name = oneLine(payload.name);
    if (!name) throw new Error('workflow name must not be empty');
    const requestedId = normalizeWorkflowId(payload.id, '');
    if (requestedId) {
      if (packExists(dataDir, requestedId)) throw new Error(`workflow "${requestedId}" already exists`);
      return saveWorkflowPack({ ...payload, id: requestedId, name });
    }
    const id = availableWorkflowId(workflowIdFromName(name), (candidate) => packExists(dataDir, candidate));
    return saveWorkflowPack({ ...payload, id, name });
  }

  async function deleteWorkflow(workflowId) {
    const id = normalizeWorkflowId(workflowId, '');
    if (!id) throw new Error(`unknown workflow "${workflowId}"`);
    const dataDir = resolveDataDir(deps);
    if (!packExists(dataDir, id)) throw new Error(`workflow "${id}" not found`);
    const dir = join(dataDir, 'workflows', id);
    if (!existsSync(join(dir, 'WORKFLOW.md'))) {
      throw new Error(`workflow "${id}" is built-in and cannot be deleted`);
    }
    rmSync(dir, { recursive: true, force: true });
    const revertedToBuiltIn = packExists(dataDir, id);
    // A fully-removed pack must not stay active; fall back to Default.
    if (!revertedToBuiltIn && activeWorkflowId(getConfig()) === id) saveActiveWorkflow(DEFAULT_WORKFLOW_ID);
    return { id, deleted: true, revertedToBuiltIn };
  }

  return { listWorkflows, setWorkflow, getWorkflowPack, saveWorkflowPack, createWorkflow, deleteWorkflow };
}
