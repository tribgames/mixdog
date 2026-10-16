import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  requiredProjectRecoveryRequest,
  recoveryStorageError,
  ProjectRecoveryError,
  type ProjectRecoveryDetail,
  type ProjectRecoveryResponse,
} from '../shared/project-recovery';
import { projectEntryPathIn, replaceProjectFileBytes } from './project-files';
import { withProjectMutationPaths } from './project-mutation-queue';
import {
  claimRecoveryDirectory,
  RECOVERY_MAX_RECORDS,
  RECOVERY_MAX_BYTES,
  listRecoveryRecords,
  readRecoveryPayload,
  readRecoveryRecord,
  recoveryDigest,
  recoveryIdentity,
  recoveryIsActive,
  recoveryLocation,
  recoveryReadBytes,
  releaseRecoveryDirectory,
  sameRecoveryIdentity,
  writeRecoveryState,
  inspectRecoveryStorage,
  recoveryStorageInventory,
  recoveryIsRetired,
  recoverySettledPhase,
  retireRecoveryDirectory,
  removeRecoveryDirectory,
  type RecoveryFile,
  type RecoveryManifest,
} from './project-recovery-store';

function validateTarget(root: string, manifest: RecoveryManifest, entry: RecoveryFile): string {
  if (realpathSync(root) !== manifest.root || !sameRecoveryIdentity(recoveryIdentity(root), manifest.rootIdentity)) {
    throw new Error('Project root changed.');
  }
  const file = projectEntryPathIn(root, entry.relPath);
  const parent = realpathSync(dirname(file));
  if (
    join(parent, basename(file)) !== entry.destination ||
    !sameRecoveryIdentity(recoveryIdentity(parent), entry.parent)
  ) {
    throw new Error('Project directory changed.');
  }
  return file;
}

// The manifest root is the writer's canonical root; a deleted root keeps the
// spelling the store was keyed by.
function recoveryBelongsTo(root: string, manifest: RecoveryManifest): boolean {
  if (manifest.root === resolve(root)) return true;
  try {
    return realpathSync(root) === manifest.root;
  } catch {
    return false;
  }
}

async function inspectDirectory(root: string, directory: string, leased = false): Promise<ProjectRecoveryDetail> {
  if (recoveryIsRetired(directory)) return inspectRecoveryStorage(directory, leased);
  let record: Awaited<ReturnType<typeof readRecoveryRecord>>;
  try {
    record = await readRecoveryRecord(directory);
  } catch {
    return inspectRecoveryStorage(directory, leased);
  }
  const { manifest, state, fingerprint } = record;
  const busy = !leased && recoveryIsActive(directory);
  const files: ProjectRecoveryDetail['files'] = [];
  // The record itself (directory identity and full store inventory) is part
  // of the approval, not only its manifest: discard removes all of it.
  const observations: string[] = [
    fingerprint,
    JSON.stringify([recoveryIdentity(directory), await recoveryStorageInventory(directory)]),
  ];
  for (let index = 0; index < manifest.files.length; index++) {
    const entry = manifest.files[index];
    try {
      const file = validateTarget(root, manifest, entry);
      // Verify both backup bodies before making an entry available for restore.
      await readRecoveryPayload(directory, entry, index, 'before');
      await readRecoveryPayload(directory, entry, index, 'after');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Target is not a regular file.');
      const bytes = await recoveryReadBytes(file, Math.max(entry.before.size, entry.after.size));
      validateTarget(root, manifest, entry);
      const digest = recoveryDigest(bytes);
      observations.push(
        JSON.stringify([entry.relPath, digest, info.dev, info.ino, info.mode, info.mtimeMs, info.ctimeMs])
      );
      let status: 'restored' | 'original' | 'written' | 'external' = 'external';
      if (bytes.length === entry.before.size && digest === entry.before.sha256) {
        status = state?.restored.includes(entry.relPath) ? 'restored' : 'original';
      } else if (bytes.length === entry.after.size && digest === entry.after.sha256) {
        status = 'written';
      }
      files.push({ relPath: entry.relPath, status });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const status = code === 'ENOENT' ? 'missing' : 'unavailable';
      // An unreadable/oversized/replaced target is not evidence of unchanged
      // batch bytes. Keep it out of restoration rather than guessing content.
      observations.push(JSON.stringify([entry.relPath, status]));
      files.push({
        relPath: entry.relPath,
        status,
        reason: error instanceof Error ? error.message.slice(0, 512) : 'Inspection failed.',
      });
    }
  }
  const again = await readRecoveryRecord(directory);
  if (again.fingerprint !== fingerprint)
    throw new ProjectRecoveryError('RECOVERY_CHANGED', 'Recovery record changed while inspecting. Refresh it.');
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    phase: busy ? 'active' : recoverySettledPhase(state),
    active: busy,
    revision: recoveryDigest(JSON.stringify(observations)),
    files,
    ...(state?.message ? { message: state.message } : {}),
  };
}

async function recoveryOverview(userDataPath: string, root: string): Promise<ProjectRecoveryResponse> {
  const records = await listRecoveryRecords(userDataPath, root);
  let rootAvailable = false;
  try {
    rootAvailable = (await lstat(root)).isDirectory() && realpathSync(root) === root;
  } catch {
    /* Observational only. */
  }
  const resolved = records.filter((record) => ['completed', 'recovered', 'retired'].includes(record.phase)).length;
  return {
    records,
    rootAvailable,
    storage: {
      usedRecords: records.length,
      maxRecords: RECOVERY_MAX_RECORDS,
      unresolvedRecords: records.length - resolved,
      resolvedRecords: resolved,
      payloadBytes: records.reduce((sum, record) => sum + (record.payloadBytes ?? 0), 0),
      unknownSizeRecords: records.filter((record) => record.payloadBytes === undefined).length,
      maxBatchBytes: RECOVERY_MAX_BYTES,
      maxBatchFiles: 100,
    },
  };
}

/** The caller must resolve root through the project registry on every request.
 * No renderer path or backup body is ever accepted as restoration authority. */
async function executeProjectRecovery(
  userDataPath: string,
  root: string,
  input: unknown
): Promise<ProjectRecoveryResponse> {
  const request = requiredProjectRecoveryRequest(input);
  if (request.action === 'list') return recoveryOverview(userDataPath, root);
  const directory = await recoveryLocation(userDataPath, root, request.id);
  if (request.action === 'inspect') {
    const detail = await inspectDirectory(root, directory);
    return { ...(await recoveryOverview(userDataPath, root)), detail };
  }
  let owned = await claimRecoveryDirectory(directory);
  let removed = false;
  let primaryError: unknown;
  try {
    if (request.action === 'discard') {
      const approved = await inspectDirectory(root, owned, true);
      if (approved.revision !== request.revision)
        throw new ProjectRecoveryError(
          'RECOVERY_CHANGED',
          'Files or recovery data changed since inspection. Inspect and confirm again.'
        );
      if (!recoveryIsRetired(owned)) {
        const manifest = await readRecoveryRecord(owned).then(
          (record) => record.manifest,
          () => null
        );
        // A readable manifest of another project root is not this scope's
        // journal. Never delete it as if it were; leave it for manual inspection.
        if (manifest && !recoveryBelongsTo(root, manifest))
          throw new ProjectRecoveryError(
            'RECOVERY_MANUAL_INSPECTION',
            'Recovery record belongs to another project root. Inspect the host recovery folder manually.'
          );
      }
      owned = await retireRecoveryDirectory(owned);
      await removeRecoveryDirectory(owned);
      removed = true;
    } else {
      if (recoveryIsRetired(owned)) {
        throw new ProjectRecoveryError(
          'RECOVERY_NOT_RESTORABLE',
          'This record cannot restore files; recovery is not an undo command.'
        );
      }
      const { manifest, state } = await readRecoveryRecord(owned).catch((cause) => {
        throw new ProjectRecoveryError(
          'RECOVERY_NOT_RESTORABLE',
          'This record cannot restore files; recovery is not an undo command.',
          { cause }
        );
      });
      if (state?.phase === 'complete')
        throw new ProjectRecoveryError(
          'RECOVERY_NOT_RESTORABLE',
          'This batch completed successfully; recovery is not an undo command.'
        );
      // Journal ownership prevents concurrent recovery/discard. The project claim
      // also serializes this restore against the existing editor mutation queue.
      const paths = manifest.files.flatMap((entry) => {
        try {
          const file = validateTarget(root, manifest, entry);
          return [file, entry.destination];
        } catch {
          // Inspection below will mark an invalid target unavailable. Never
          // claim or write an arbitrary stale destination from the manifest.
          return [];
        }
      });
      await withProjectMutationPaths(paths, async () => {
        const approved = await inspectDirectory(root, owned, true);
        if (approved.revision !== request.revision)
          throw new ProjectRecoveryError(
            'RECOVERY_CHANGED',
            'Files or recovery data changed since inspection. Inspect and confirm again.'
          );
        if (['invalid', 'retired', 'completed'].includes(approved.phase))
          throw new ProjectRecoveryError('RECOVERY_NOT_RESTORABLE', 'Recovery record is no longer restorable.');
        const restored = new Set(
          approved.files.filter((file) => file.status === 'restored').map((file) => file.relPath)
        );
        const failures: string[] = [];
        await writeRecoveryState(owned, { phase: 'restoring', message: '', restored: [...restored] });
        for (let index = manifest.files.length - 1; index >= 0; index--) {
          const entry = manifest.files[index];
          if (approved.files[index].status !== 'written') continue;
          try {
            const file = validateTarget(root, manifest, entry);
            const before = await readRecoveryPayload(owned, entry, index, 'before');
            const after = await readRecoveryPayload(owned, entry, index, 'after');
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('Target is not a regular file.');
            await replaceProjectFileBytes(
              file,
              before,
              after,
              info.mode,
              () => restored.add(entry.relPath),
              () => {
                if (validateTarget(root, manifest, entry) !== file) throw new Error('Recovery destination changed.');
              }
            );
          } catch (error) {
            failures.push(
              `${JSON.stringify(entry.relPath)}: ${error instanceof Error ? error.message : 'Restore failed.'}`
            );
          }
        }
        const skipped = approved.files.filter((file) =>
          ['external', 'missing', 'unavailable'].includes(file.status)
        ).length;
        await writeRecoveryState(owned, {
          phase: failures.length || skipped ? 'failed' : 'recovered',
          restored: [...restored],
          message:
            failures.length || skipped
              ? `${failures.length} restoration failures; ${skipped} changed or unavailable files were left untouched. ${failures.join('; ')}`
              : 'Original bytes restored. No changed, missing or unavailable file was overwritten.',
        });
      });
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await releaseRecoveryDirectory(owned);
  } catch (error) {
    if (primaryError)
      throw new AggregateError(
        [primaryError, error],
        'Recovery failed and its retained record could not be published.'
      );
    throw error;
  }
  if (primaryError) throw primaryError;
  const overview = await recoveryOverview(userDataPath, root);
  if (removed) return overview;
  return { ...overview, detail: await inspectDirectory(root, await recoveryLocation(userDataPath, root, request.id)) };
}

export async function projectRecoveryIn(
  userDataPath: string,
  root: string,
  input: unknown
): Promise<ProjectRecoveryResponse> {
  try {
    return await executeProjectRecovery(userDataPath, root, input);
  } catch (error) {
    throw recoveryStorageError(error);
  }
}
