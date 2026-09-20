import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { serializeFrontmatterDoc } from '../../runtime/shared/markdown-frontmatter.mjs';
import { normalizeWorkflowId, workflowIdFromName, availableWorkflowId, DEFAULT_WORKFLOW_ID } from '../workflow.mjs';
import { oneLine, resolveDataDir } from './shared.mjs';

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
      active: workflow.id === active,
    }));
  }

  async function setWorkflow(workflowId) {
    const requested = normalizeWorkflowId(workflowId, DEFAULT_WORKFLOW_ID);
    const id = requested === 'solo' ? DEFAULT_WORKFLOW_ID : requested;
    const pack = loadWorkflowPack(resolveDataDir(deps), id);
    if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
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
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      source: pack.source,
      body: pack.body,
      userOverride: existsSync(join(dataDir, 'workflows', id, 'WORKFLOW.md')),
    };
  }

  async function saveWorkflowPack(payload = {}) {
    const id = normalizeWorkflowId(payload.id, '');
    if (!id) throw new Error('workflow id must contain letters/numbers (dashes and dots allowed)');
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('WORKFLOW.md body must not be empty');
    const name = oneLine(payload.name) || id;
    const description = oneLine(payload.description);
    const dir = join(resolveDataDir(deps), 'workflows', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'WORKFLOW.md'),
      serializeFrontmatterDoc({ id, name, ...(description ? { description } : {}) }, body)
    );
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
