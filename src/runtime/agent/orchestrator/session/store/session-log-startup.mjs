/**
 * The startup migration of this data dir's legacy sessions to logs
 * (session-log-migration.mjs), started once after the daemon's boot. Only the
 * daemon owner runs it (a short-lived in-process run converts a session at
 * its first write instead): each session is published under its writer
 * claim, so a session another process holds is a `busy` skip retried at the
 * next start.
 */
import { join } from 'node:path';
import { readSingletonOwner } from '../../../../shared/singleton-owner.mjs';
import { dataDir } from '../store-summary-locations.mjs';
import { getStoreDir } from './session-paths.mjs';
import { LEGACY_SESSION_LOADER } from './legacy-session.mjs';
import { migrateLegacySessions, sessionLogMigrationProgressPath } from './session-log-migration.mjs';
import {
  claimSessionWriter,
  releaseSessionWriter,
  sessionWriterHeldHere,
  sessionWriterRefusalError,
} from './session-writer-claim.mjs';

let _started = null;

/** The migration's claimFor (session-log-migration.mjs): `id`'s writer claim,
 *  taken here unless another process holds it. */
export function claimFor(id) {
  let taken;
  try {
    taken = claimSessionWriter(id);
  } catch {
    return { held: false };
  }
  if (!taken.held) return { held: false };
  return {
    held: true,
    claim: {
      assertHeld() {
        if (!sessionWriterHeldHere(id)) throw sessionWriterRefusalError({ id, reason: 'changed' });
      },
    },
    // A claim this run took goes again; one the session already had stays.
    release: () => (taken.fresh ? void releaseSessionWriter(id) : undefined),
  };
}

/** Starts the migration (once per process); resolves with its report, or
 *  null when this process is not the live daemon owner or the start failed.
 *  Never throws or rejects: a failure of any step (the store folder cannot be
 *  made on a full disk included) is logged, leaves the progress file as it
 *  was — so Doctor's "Session log" row keeps counting the sessions as pending —
 *  and the migration runs again at the next start. */
export function startSessionLogMigration() {
  if (_started) return _started;
  _started = (async () => {
    try {
      const dir = dataDir();
      const { owner, alive } = readSingletonOwner(join(dir, 'daemon-owner.json'));
      if (!alive || Number(owner?.pid) !== process.pid) return null;
      const report = await migrateLegacySessions({
        storeDir: getStoreDir(),
        progressPath: sessionLogMigrationProgressPath(dir),
        loader: LEGACY_SESSION_LOADER,
        claimFor,
        log: (line) => process.stderr.write(`[session-log-migration] ${line}\n`),
      });
      process.stderr.write(
        `[session-log-migration] migrated=${report.migrated} converted=${report.converted} total=${report.total} ` +
          `skipped=${JSON.stringify(report.skipped)} complete=${report.complete} ms=${report.ms}\n`
      );
      return report;
    } catch (err) {
      process.stderr.write(`[session-log-migration] failed: ${err?.message || err}\n`);
      return null;
    }
  })();
  return _started;
}
