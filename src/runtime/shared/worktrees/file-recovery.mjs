/** Persistent file-host journal scopes. No payload is read or deleted here.
 * A retained record (even resolved) needs an explicit discard before its
 * workspace can be removed. An unreadable/symlinked store is never empty. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { worktreeError } from './contract.mjs';
import { isWithin } from './paths.mjs';

const fail = (record, root) => worktreeError('WORKTREE_FILE_RECOVERY', undefined, {
  entryId: record.id, path: record.path, recoveryRoot: root,
});
export function validateRecoveryScope(record, scope) {
  if (!scope || typeof scope.root !== 'string' || !isAbsolute(scope.root) ||
      typeof scope.directory !== 'string' || !isAbsolute(scope.directory) ||
      !isWithin(record.path, scope.root) || basename(dirname(scope.directory)) !== 'editor-recovery' ||
      basename(scope.directory) !== createHash('sha256').update(resolve(scope.root)).digest('hex'))
    throw fail(record, record.path);
  return scope;
}
export function recoveryScopes(record) {
  const scopes = record.editorRecoveryStores ?? [];
  if (!Array.isArray(scopes) || scopes.length > 64) throw fail(record, record.path);
  return scopes.map((scope) => validateRecoveryScope(record, scope));
}
async function recoveryStoreIsEmpty(scope) {
  try {
    // Check every existing ancestor of the private journal store; missing
    // stores are permitted because registration deliberately precedes mkdir.
    for (const directory of [dirname(dirname(scope.directory)), dirname(scope.directory), scope.directory]) {
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      // Use the same path spelling as the file host's store validation;
      // async/native realpath can expand Windows short names differently.
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== resolve(directory))
        return false;
    }
    let directory;
    try { directory = await opendir(scope.directory); }
    catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
    for await (const entry of directory) {
      // Also retain unknown/tampered entries, rather than guessing they are
      // expendable. No manifest or phase can authorize deleting the workspace.
      if (entry) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Call under the repository lock. Only descriptors for verifiably empty or
// missing stores may be pruned; this never removes storage or backup bytes.
export async function retainedRecoveryScopes(record) {
  const retained = [];
  for (const scope of recoveryScopes(record)) {
    if (!(await recoveryStoreIsEmpty(scope))) retained.push(scope);
  }
  return retained;
}

export async function assertRecoveryStoresClear(record) {
  for (const scope of recoveryScopes(record)) {
    if (!(await recoveryStoreIsEmpty(scope))) throw fail(record, scope.root);
  }
}
