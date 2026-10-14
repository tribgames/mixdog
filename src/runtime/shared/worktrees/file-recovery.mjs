/** Persistent file-host journal scopes. No payload is read or deleted here.
 * A retained record (even resolved) needs an explicit discard before its
 * workspace can be removed. An unreadable/symlinked store is never empty. */
import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
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
export async function assertRecoveryStoresClear(record) {
  for (const scope of recoveryScopes(record)) {
    try {
      // Check every existing ancestor of the private journal store; missing
      // stores are permitted because registration deliberately precedes mkdir.
      for (const directory of [dirname(dirname(scope.directory)), dirname(scope.directory), scope.directory]) {
        let info;
        try { info = await lstat(directory); }
        catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== resolve(directory))
          throw fail(record, scope.root);
      }
      let directory;
      try { directory = await opendir(scope.directory); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      for await (const entry of directory) {
        // Also retain unknown/tampered entries, rather than guessing they are
        // expendable. No manifest or phase can authorize deleting the workspace.
        if (entry) throw fail(record, scope.root);
      }
    } catch (error) {
      if (error?.code === 'WORKTREE_FILE_RECOVERY') throw error;
      throw fail(record, scope.root);
    }
  }
}
