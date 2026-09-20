/**
 * memory-action-handlers/core-actions.mjs — `core`: user-curated core memory
 * add / edit / delete / list against the core store, with the
 * session-injection snapshot republished after every mutation.
 */
import { addCore, editCore, deleteCore, normalizeCoreInput, normalizeCoreOp } from '../core-memory-store.mjs';
import { resolveProjectScope } from '../project-id-resolver.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { listManagedMemories, formatManagedMemories } from '../core-memory-management.mjs';
import { publicCoreMemoryIdentity, resolveCoreMemoryIndex } from '../core-memory-index.mjs';

const CORE_OPS = ['add', 'edit', 'delete', 'list'];

// An explicit project_id wins. Otherwise infer from the active cwd/session and
// fall back to COMMON.
function coreProjectId(args) {
  const hasProjectIdKey = Object.hasOwn(args, 'project_id');
  const projectIdText = typeof args.project_id === 'string' ? args.project_id.trim() : '';
  if (!hasProjectIdKey || !projectIdText) return resolveProjectScope(args.cwd);
  if (projectIdText.toLowerCase() === 'common') return null;
  return projectIdText;
}

// Category is intentionally absent from the public memory schema. New direct
// entries use normalizeCoreInput's internal compatibility default; edits omit
// the field so editCore preserves the stored value.
function normalizedWriteArgs(args, op, projectId) {
  const categoryFreeArgs = { ...args };
  delete categoryFreeArgs.category;
  const normalized = normalizeCoreInput(categoryFreeArgs, {
    requireElement: true,
    requireSummary: true,
    requireCategory: false,
  });
  const errors = [...normalized.errors];
  if (op === 'add' && projectId === '*') {
    errors.unshift('project_id "*" only valid for op="list"');
  }
  if (errors.length) return { error: `core ${op}: ${errors.join('; ')}` };
  return {
    args: {
      ...categoryFreeArgs,
      element: normalized.element,
      summary: normalized.summary,
      ...(op === 'add' ? { category: normalized.category } : {}),
    },
  };
}

function editTargetProjectId(args, projectId) {
  if (Object.hasOwn(args, 'target_project_id')) {
    const value = String(args.target_project_id ?? '').trim();
    return !value || value.toLowerCase() === 'common' ? null : value;
  }
  if (typeof args.target_cwd === 'string' && args.target_cwd) return resolveProjectScope(args.target_cwd);
  return projectId;
}

export function createCoreActions({
  getDb,
  dataDir,
  addCoreImpl = addCore,
  editCoreImpl = editCore,
  deleteCoreImpl = deleteCore,
  refreshCoreMemoryFile = async () => {},
}) {
  const describe = async (entry) =>
    `(${await publicCoreMemoryIdentity(getDb(), entry)}): ${entry.element} — ${entry.summary.slice(0, 200)}`;

  const ops = {
    async list(_coreDataDir, args, projectId) {
      const page = await listManagedMemories(getDb(), projectId, args);
      return { text: args.format === 'json' ? JSON.stringify(page) : formatManagedMemories(page), ...page };
    },
    async add(coreDataDir, args, projectId) {
      const entry = await addCoreImpl(coreDataDir, args, projectId);
      await refreshCoreMemoryFile('core-add');
      return { text: `core added ${await describe(entry)}` };
    },
    async edit(coreDataDir, args, projectId) {
      const targetProjectId = editTargetProjectId(args, projectId);
      const recordId = await resolveCoreMemoryIndex(getDb(), projectId, args.id, args.index_revision);
      const entry = await editCoreImpl(coreDataDir, recordId, {
        ...args,
        expectedProjectId: projectId,
        targetProjectId,
      });
      await refreshCoreMemoryFile('core-edit');
      return { text: `core edited ${await describe(entry)}` };
    },
    async delete(coreDataDir, args, projectId) {
      const recordId = await resolveCoreMemoryIndex(getDb(), projectId, args.id, args.index_revision);
      const removed = await deleteCoreImpl(coreDataDir, recordId, { expectedProjectId: projectId });
      await refreshCoreMemoryFile('core-delete');
      return {
        text: `core deleted (project=${projectId ?? 'COMMON'} id=${args.id}): ${removed.element}. Remaining indices were compacted; list memories before the next write.`,
      };
    },
  };

  return async function core(rawArgs) {
    let args = rawArgs;
    const op = normalizeCoreOp(args.op);
    if (!CORE_OPS.includes(op)) {
      return { text: 'core requires op: add | edit | delete | list', isError: true };
    }
    const coreDataDir = typeof dataDir === 'string' ? dataDir : resolvePluginData();
    if (!coreDataDir) return { text: 'core: memory data dir is not initialized', isError: true };
    const projectId = coreProjectId(args);
    try {
      if (args.source && args.source !== 'curated') {
        return { text: 'memory manages user-curated entries only; use recall for generated history.', isError: true };
      }
      if (op === 'add' || op === 'edit') {
        const normalized = normalizedWriteArgs(args, op, projectId);
        if (normalized.error) return { text: normalized.error, isError: true };
        args = normalized.args;
      }
      if (projectId === '*' && op !== 'list') {
        return { text: `core ${op}: project_id "*" only valid for op="list"`, isError: true };
      }
      return await ops[op](coreDataDir, args, projectId);
    } catch (e) {
      return { text: `core ${op} failed: ${e.message}`, isError: true };
    }
  };
}
