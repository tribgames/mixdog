// Pre-patch snapshot of every path this operation may touch: the bytes and
// mode of each existing target, or an "absent" marker. Restoring them undoes
// the whole batch. Hostile concurrent replacement of a path between capture
// and restore is out of scope.
import { chmodSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
import { clearReadSnapshotForPath, invalidateBuiltinResultCache, normalizeOutputPath } from '../builtin.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';

export function capturePatchRollbackState(paths) {
  return paths.map((fullPath) => {
    let stat;
    try {
      stat = statSync(fullPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return { fullPath, existed: false, content: null, mode: null };
      throw new Error(
        `apply_patch: rollback snapshot target unreadable: ${normalizeOutputPath(fullPath)} (${err?.code || err?.message || String(err)})`
      );
    }
    if (!stat.isFile())
      throw new Error(`apply_patch: rollback snapshot target is not a regular file: ${normalizeOutputPath(fullPath)}`);
    return { fullPath, existed: true, content: readFileSync(fullPath), mode: stat.mode };
  });
}

export function restorePatchRollbackState(snapshots, readStateScope) {
  const errors = [];
  const paths = [];
  for (const snapshot of snapshots) {
    const display = normalizeOutputPath(snapshot.fullPath);
    try {
      if (snapshot.existed) {
        mkdirSync(pathDirname(snapshot.fullPath), { recursive: true });
        writeFileSync(snapshot.fullPath, snapshot.content);
        if (snapshot.mode != null) chmodSync(snapshot.fullPath, snapshot.mode);
      } else if (existsSync(snapshot.fullPath)) {
        rmSync(snapshot.fullPath, { force: true });
      } else {
        continue; // nothing written, nothing to undo
      }
      paths.push(snapshot.fullPath);
    } catch (err) {
      errors.push(`${display} — ${err?.message || String(err)}`);
    }
  }
  invalidateBuiltinResultCache(paths);
  markCodeGraphDirtyPaths(paths);
  for (const fullPath of paths) clearReadSnapshotForPath(fullPath, readStateScope);
  return errors;
}
