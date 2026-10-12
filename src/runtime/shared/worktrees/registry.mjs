/**
 * Durable registry of managed worktrees: <dataDir>/worktrees-v1/registry.json.
 *
 * One record per worktree, keyed by its slug (globally unique, so an entry id
 * alone addresses it). A record carries the public entry fields plus the
 * transaction ledger that makes creation rollback and deletion resumable:
 * which resources this transaction created ('pending' is written before a
 * resource is made, 'created' after), the deletion decision and any recovery
 * diagnostics. Writes are atomic (temp file + rename) under a file lock; an
 * unreadable registry is an error, never silently replaced.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonText, withFileLock, writeJsonAtomicAsync } from '../atomic-file.mjs';
import { isPlainObject } from '../object.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { normalizeWorktreeEntry, WORKTREE_STORE_DIR } from './contract.mjs';

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

async function readDoc(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDoc();
    throw error;
  }
  const value = parseJsonText(text);
  if (!isPlainObject(value) || !isPlainObject(value.entries)) {
    throw new Error(`Worktree registry ${path} is malformed.`);
  }
  return value;
}

/** Snapshot of every record (plain clones). */
export async function readRegistry() {
  return readDoc(registryPath());
}

/**
 * Locked read-modify-write. `mutate(doc)` edits doc.entries in place; its
 * return value is returned.
 * @template T
 * @param {(doc: { version: number, entries: Record<string, any> }) => T} mutate
 * @returns {Promise<T>}
 */
export async function mutateRegistry(mutate) {
  const path = registryPath();
  return withFileLock(
    `${path}.lock`,
    async () => {
      const doc = await readDoc(path);
      const result = mutate(doc);
      await writeJsonAtomicAsync(path, doc, { lock: false });
      return result;
    },
    { timeoutMs: 15_000 }
  );
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
  };
}
