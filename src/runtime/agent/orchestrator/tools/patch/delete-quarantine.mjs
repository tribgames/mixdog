// Atomic delete for targets whose bytes are never snapshotted (binary,
// oversized, or past the snapshot budget). Such a target is not unlinked at its
// normal position: once every other operation of the batch succeeded it is
// renamed to a collision-safe sibling quarantine name, which a rollback renames
// back (exact bytes, no read). The batch owner unlinks the quarantine copies
// after commit. A rename that fails (e.g. a locked file on Windows) fails the
// batch — there is never an unprotected unlink fallback.
import { randomBytes } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readBoundedFile } from '../../../../shared/bounded-file-read.mjs';
import { clearReadSnapshotForPath, invalidateBuiltinResultCache, normalizeOutputPath } from '../builtin.mjs';
import { isSpecialFileStat } from '../builtin/device-paths.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';
import { countLabel } from './dispatch/native-report.mjs';
import { pathKey, specialFilePatchMessage } from './paths.mjs';

/** `omittedKeys`: pathKeys whose rollback snapshot is omitted (budget included). */
export function createDeleteQuarantine() {
  return { moved: [], omittedKeys: new Set() };
}

export function markQuarantineOmittedSnapshots(quarantine, snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot?.omitted) quarantine.omittedKeys.add(pathKey(snapshot.fullPath));
  }
}

/** Whether deleting `fullPath` must go through the quarantine: its bytes are
 *  (or would be) omitted from the rollback snapshot. */
export function deleteNeedsQuarantine(fullPath, quarantine = null) {
  if (quarantine?.omittedKeys.has(pathKey(fullPath))) return true;
  try {
    return readBoundedFile(fullPath, { classifyOnly: true }).state === 'omitted';
  } catch {
    return false; // special/unreadable: the normal delete path reports it
  }
}

function quarantinePathFor(fullPath) {
  const dir = dirname(fullPath);
  const name = basename(fullPath).slice(0, 80);
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = join(dir, `.${name}.mixdog-delete-${randomBytes(8).toString('hex')}`);
    try {
      lstatSync(candidate);
    } catch (err) {
      if (err?.code === 'ENOENT') return candidate;
      throw err;
    }
  }
  throw new Error('no free quarantine name');
}

function invalidatePaths(paths, readStateScope) {
  if (paths.length === 0) return;
  invalidateBuiltinResultCache(paths);
  markCodeGraphDirtyPaths(paths);
  for (const fullPath of paths) clearReadSnapshotForPath(fullPath, readStateScope);
}

// Rename quarantined items back, newest first. Returns `display — reason` rows.
function restoreMoved(items, readStateScope) {
  const errors = [];
  const restored = [];
  for (const item of [...items].reverse()) {
    const display = normalizeOutputPath(item.displayPath || item.fullPath);
    try {
      let occupied = true;
      try {
        lstatSync(item.fullPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        occupied = false;
      }
      if (occupied) throw new Error('the path was re-created meanwhile');
      renameSync(item.quarantinePath, item.fullPath);
      restored.push(item.fullPath);
    } catch (err) {
      errors.push(
        `${display} — could not restore from quarantine (${err?.code || err?.message || String(err)}); original bytes kept at ${item.quarantinePath}`
      );
    }
  }
  invalidatePaths(restored, readStateScope);
  return errors;
}

/** Move every entry aside, all or nothing. Throws (after renaming this call's
 *  earlier moves back) when any rename fails; the caller rolls back the rest. */
export function quarantineDeleteTargets(quarantine, entries, { readStateScope } = {}) {
  const movedHere = [];
  for (const entry of entries) {
    const display = normalizeOutputPath(entry.displayPath || entry.fullPath);
    try {
      const stat = lstatSync(entry.fullPath);
      if (isSpecialFileStat(stat)) throw new Error(specialFilePatchMessage(display));
      const quarantinePath = quarantinePathFor(entry.fullPath);
      renameSync(entry.fullPath, quarantinePath);
      const item = { fullPath: entry.fullPath, displayPath: display, quarantinePath };
      movedHere.push(item);
      quarantine.moved.push(item);
    } catch (err) {
      const restoreErrors = restoreMoved(movedHere, readStateScope);
      quarantine.moved = quarantine.moved.filter((item) => !movedHere.includes(item));
      throw new Error(
        `apply_patch: Delete File ${display} failed — it could not be moved aside for an atomic delete ` +
          `(${err?.code || err?.message || String(err)}); the file was left in place` +
          (restoreErrors.length > 0 ? `; rollback incomplete: ${restoreErrors.join('; ')}` : '')
      );
    }
  }
  invalidatePaths(
    movedHere.map((item) => item.fullPath),
    readStateScope
  );
}

/** Undo every quarantine move (batch failure). Returns restore error rows. */
export function rollbackDeleteQuarantine(quarantine, readStateScope) {
  if (quarantine.moved.length === 0) return [];
  const errors = restoreMoved(quarantine.moved, readStateScope);
  quarantine.moved = [];
  return errors;
}

/** Commit: unlink the quarantine copies. Returns the ones that stayed. */
export function commitDeleteQuarantine(quarantine) {
  const leftovers = [];
  for (const item of quarantine.moved) {
    try {
      unlinkSync(item.quarantinePath);
    } catch (err) {
      leftovers.push({ ...item, code: err?.code || err?.message || String(err) });
    }
  }
  quarantine.moved = [];
  return leftovers;
}

export function formatQuarantineLeftovers(leftovers) {
  return leftovers
    .map(
      (item) =>
        `  WARN ${item.displayPath} was deleted, but its quarantine copy could not be removed: ${item.quarantinePath} (${item.code})`
    )
    .join('\n');
}

export function formatQuarantinedDeletes(entries, leftovers = []) {
  const lines = [`Applied ${countLabel(entries.length, 'File')} (JS)`];
  for (const entry of entries) lines.push(`  OK Delete ${normalizeOutputPath(entry.displayPath || entry.fullPath)}`);
  const warnings = formatQuarantineLeftovers(leftovers);
  return warnings ? `${lines.join('\n')}\n${warnings}` : lines.join('\n');
}
