/**
 * doctor-session-log.mjs — the /doctor row for the json → log session
 * migration. Reads the migration's progress file and the session folder's
 * names; reports completion, the sessions still to migrate and the skipped
 * ones with their reason. Names, counts and reason codes only: a skip's
 * message can carry paths and is never shown.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MIGRATION_SKIP,
  legacyIdsWithoutLog,
  readMigrationProgress,
  sessionLogMigrationProgressPath,
} from '../../runtime/agent/orchestrator/session/store/session-log-migration.mjs';
import { SESSION_LOG_SUFFIX } from '../../runtime/agent/orchestrator/session/store/session-log-format.mjs';

const LISTED_SKIPS = 5;

async function listNames(dir) {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readSessionLogMigration(dataDir) {
  let progress;
  try {
    progress = await readMigrationProgress(sessionLogMigrationProgressPath(dataDir));
  } catch {
    return { unreadable: true };
  }
  const names = await listNames(join(dataDir, 'sessions'));
  const skipped = Object.entries(progress.skipped).map(([id, skip]) => ({ id, reason: skip.reason }));
  const permanent = new Set(skipped.filter((skip) => skip.reason !== MIGRATION_SKIP.BUSY).map((skip) => skip.id));
  return {
    complete: progress.complete,
    started: progress.updatedAt > 0,
    logs: names.filter((name) => name.endsWith(SESSION_LOG_SUFFIX)).length,
    pending: legacyIdsWithoutLog(names).filter((id) => !permanent.has(id)).length,
    skipped,
  };
}

export function reportSessionLogMigration(status, row) {
  if (status.unreadable) {
    row('warn', 'progress file unreadable', { hint: `remove ${basename(sessionLogMigrationProgressPath(''))} to restart the migration` });
    return;
  }
  const { started, logs, pending, skipped } = status;
  // A legacy session added after the recorded completion is still pending.
  const complete = status.complete && pending === 0;
  const parts = [];
  if (complete) parts.push(`complete · ${logs} session ${logs === 1 ? 'log' : 'logs'}`);
  else if (!started) parts.push(`not started · ${pending} pending`);
  else parts.push(`in progress · ${pending} pending`);
  if (skipped.length) {
    const shown = skipped.slice(0, LISTED_SKIPS).map((skip) => `${skip.id} (${skip.reason})`);
    const more = skipped.length > shown.length ? ` +${skipped.length - shown.length} more` : '';
    parts.push(`${skipped.length} skipped: ${shown.join(', ')}${more}`);
  }
  const detail = parts.join(' · ');
  if (complete && !skipped.length) row('ok', detail);
  else if (!complete && !started && !pending) row('ok', 'nothing to migrate');
  else if (!complete) row('warn', detail, { hint: 'pending sessions are migrated at startup' });
  else row('warn', detail, { hint: 'skipped sessions stay in the old format and are retried when their file changes' });
}
