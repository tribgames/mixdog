// Pre-patch snapshot of every path this operation may touch: the bytes and
// mode of each existing target, or an "absent" marker. Restoring them undoes
// the whole batch. Hostile concurrent replacement of a path between capture
// and restore is out of scope.
//
// A binary or oversized target (or one past the transaction's byte budget) is
// never read: its snapshot is the explicit omitted state
// { existed: true, content: null, omitted: true, size, mode }. Omitted is not
// empty content — restore never writes it, and only reports it untouched when
// the file provably still is.
import { chmodSync, existsSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
import { createSnapshotBudget, describeOmittedFile, readBoundedFile } from '../../../../shared/bounded-file-read.mjs';
import { clearReadSnapshotForPath, invalidateBuiltinResultCache, normalizeOutputPath } from '../builtin.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';

export function capturePatchRollbackState(paths, { budget = createSnapshotBudget() } = {}) {
  return paths.map((fullPath) => {
    let read;
    try {
      read = readBoundedFile(fullPath, { budget });
    } catch (err) {
      if (err?.code === 'ENOTREGULAR') {
        throw new Error(
          `apply_patch: rollback snapshot target is not a regular file: ${normalizeOutputPath(fullPath)}`
        );
      }
      throw new Error(
        `apply_patch: rollback snapshot target unreadable: ${normalizeOutputPath(fullPath)} (${err?.code || err?.message || String(err)})`
      );
    }
    if (read.state === 'absent') return { fullPath, existed: false, content: null, mode: null };
    if (read.state === 'omitted') {
      return {
        fullPath,
        existed: true,
        content: null,
        omitted: true,
        omittedReason: read.reason,
        size: read.size,
        statSize: read.statSize,
        mtimeMs: read.mtimeMs,
        mode: read.mode,
      };
    }
    return { fullPath, existed: true, content: read.content, mode: read.mode };
  });
}

// An omitted snapshot holds no bytes, so it can only be confirmed untouched.
function omittedSnapshotIssue(snapshot) {
  const what = `pre-patch content was not captured (${describeOmittedFile({ reason: snapshot.omittedReason, size: snapshot.size })})`;
  let stat;
  try {
    stat = statSync(snapshot.fullPath);
  } catch (err) {
    return `${what}; the file is ${err?.code === 'ENOENT' ? 'missing' : `unreadable (${err?.code || err?.message})`} and cannot be restored`;
  }
  if (stat.isFile() && stat.size === snapshot.statSize && stat.mtimeMs === snapshot.mtimeMs) return null;
  return `${what}; the file changed and cannot be restored`;
}

export function restorePatchRollbackState(snapshots, readStateScope) {
  const errors = [];
  const paths = [];
  for (const snapshot of snapshots) {
    const display = normalizeOutputPath(snapshot.fullPath);
    if (snapshot.omitted) {
      const issue = omittedSnapshotIssue(snapshot);
      if (issue) errors.push(`${display} — ${issue}`);
      continue;
    }
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
