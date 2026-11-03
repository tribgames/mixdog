/**
 * Durable registry of managed worktrees: <dataDir>/worktrees-v1/registry.json.
 *
 * One record per worktree, keyed by its slug (globally unique, so an entry id
 * alone addresses it). A record carries the public entry fields plus the
 * transaction ledger that makes creation rollback and deletion resumable:
 * which resources this transaction created ('pending' is written before a
 * resource is made, 'created' after), the deletion decision and any recovery
 * diagnostics. Writes are atomic (temp file + rename) under a file lock and keep
 * the replaced version as registry.json.bak. A damaged registry (NUL, truncated,
 * malformed) never blocks worktree operations: its bytes are kept aside as
 * registry.json.corrupt-<ts>, the last good copy is restored when there is one,
 * and otherwise the registry starts empty (worktree folders on disk are never
 * touched by that).
 */
import { join } from 'node:path';
import { readJsonState, readJsonStateSync, updateJsonAtomic } from '../atomic-file.mjs';
import { isPlainObject } from '../object.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { normalizeWorktreeEntry, WORKTREE_SNAPSHOT_KIND, WORKTREE_STORE_DIR } from './contract.mjs';

const REGISTRY_VERSION = 1;

function worktreeStoreDir() {
  return join(resolvePluginData(), WORKTREE_STORE_DIR);
}

export function registryPath() {
  return join(worktreeStoreDir(), 'registry.json');
}

function emptyDoc() {
  return { version: REGISTRY_VERSION, entries: {} };
}

const isRegistryDoc = (value) => isPlainObject(value) && isPlainObject(value.entries);

function validateDoc(value) {
  if (!isRegistryDoc(value)) throw new Error('Worktree registry is malformed.');
  return value;
}

/** Snapshot of every record (plain clones). */
export async function readRegistry() {
  return (await readJsonState(registryPath(), { validate: validateDoc })) ?? emptyDoc();
}

/** readRegistry for synchronous callers (the workspace admission gate). */
export function readRegistrySync() {
  return readJsonStateSync(registryPath(), { validate: validateDoc }) ?? emptyDoc();
}

/**
 * Locked read-modify-write. `mutate(doc)` edits doc.entries in place; its
 * return value is returned.
 * @template T
 * @param {(doc: { version: number, entries: Record<string, any> }) => T} mutate
 * @returns {Promise<T>}
 */
export async function mutateRegistry(mutate) {
  let result;
  await updateJsonAtomic(
    registryPath(),
    (current) => {
      const doc = isRegistryDoc(current) ? current : emptyDoc();
      result = mutate(doc);
      return doc;
    },
    { timeoutMs: 15_000, backup: true }
  );
  return result;
}

export async function getRecord(id) {
  const doc = await readRegistry();
  return Object.hasOwn(doc.entries, id) ? doc.entries[id] : null;
}

/** Insert a new record; false when the id is already taken. */
export function insertRecord(record) {
  return mutateRegistry((doc) => {
    if (Object.hasOwn(doc.entries, record.id)) return false;
    doc.entries[record.id] = { ...record, updatedAt: Date.now() };
    return true;
  });
}

export function putRecord(record) {
  return mutateRegistry((doc) => {
    doc.entries[record.id] = { ...record, updatedAt: Date.now() };
  });
}

export function deleteRecord(id) {
  return mutateRegistry((doc) => {
    delete doc.entries[id];
  });
}

/** Public shape: the contract entry plus the merge target and warnings. */
export function entryView(record) {
  return {
    ...normalizeWorktreeEntry(record),
    // Repository-relative folder of a subfolder Project ('' at the root).
    projectSubdir: typeof record.projectSubdir === 'string' ? record.projectSubdir : '',
    mergeTarget: record.mergeTarget ?? null,
    warnings: Array.isArray(record.warnings) ? [...record.warnings] : [],
    disposable: record.disposable === true,
    // The session whose turn made a snapshot (it is removed when that turn settles).
    ...(record.kind === WORKTREE_SNAPSHOT_KIND ? { holderSessionId: record.holderSessionId ?? null } : {}),
  };
}
