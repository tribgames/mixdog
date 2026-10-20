// Launch/update record kept as a main-process file in the profile. The
// renderer's What's new mark lives in localStorage, which Chromium can lose (it
// recreates a missing or failing Local Storage database), and an empty mark
// otherwise reads as a fresh install that announces nothing. The record keeps
// the last launched version and, until the renderer acknowledges the notice
// was on screen, the update still waiting to be announced.
import { readFile } from 'node:fs/promises';

import { holdsNoData, writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { compareSemver } from '../../../../src/runtime/shared/semver.mjs';

export const LAUNCH_VERSION_FILE = 'last-launch-version';

interface LaunchRecord {
  lastLaunched: string;
  /** The update announced on the next launches until it is acknowledged. */
  pendingAnnouncement?: string;
}

type WriteFailure = (error: unknown) => void;

// The first form of the record: the bare version, e.g. `1.1.0`.
const BARE_VERSION = /^v?\d+\.\d+\.\d+[\w.+-]*$/;

async function readLaunchRecord(filePath: string): Promise<LaunchRecord | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  // A record a crash left empty or NUL-filled is no record: read as a version
  // it would be 0.0.0, and every launch after it would announce an update.
  if (holdsNoData(text)) return null;
  text = text.trim();
  try {
    const parsed = JSON.parse(text) as Partial<LaunchRecord> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.lastLaunched === 'string') {
      return {
        lastLaunched: parsed.lastLaunched,
        ...(typeof parsed.pendingAnnouncement === 'string' ? { pendingAnnouncement: parsed.pendingAnnouncement } : {}),
      };
    }
  } catch {
    /* the first form of the record was the bare version */
  }
  // Anything else (truncated JSON, junk) is no record either.
  return BARE_VERSION.test(text) ? { lastLaunched: text } : null;
}

async function writeLaunchRecord(filePath: string, record: LaunchRecord, onWriteFailure: WriteFailure): Promise<void> {
  try {
    await writeFileAtomicAsync(filePath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // The launch goes on; this only costs the announcement's retry evidence.
    onWriteFailure(error);
  }
}

/**
 * Records `version` as launched and reports whether its update is still to be
 * announced. An update is a strictly newer version than the recorded previous
 * launch (a downgrade announces nothing), or — with no record — an NSIS
 * relaunch after an update (app-builder-lib's StartApp passes `--updated`).
 * The pending announcement survives later launches until
 * `acknowledgeAnnouncement`, so a notice that failed to show is retried.
 *
 * Known limitation: the first upgrade from a build that predates this record,
 * on macOS or Linux (no `--updated` flag), whose localStorage was also lost
 * still looks like a fresh install; nothing durable says an older version ran.
 */
export async function recordLaunchVersion(
  filePath: string,
  version: string,
  argv: readonly string[],
  onWriteFailure: WriteFailure
): Promise<boolean> {
  const previous = await readLaunchRecord(filePath);
  const updated = previous ? compareSemver(version, previous.lastLaunched) > 0 : argv.includes('--updated');
  const pending = updated || previous?.pendingAnnouncement === version ? version : undefined;
  const next: LaunchRecord = { lastLaunched: version, ...(pending ? { pendingAnnouncement: pending } : {}) };
  if (previous?.lastLaunched !== next.lastLaunched || previous?.pendingAnnouncement !== next.pendingAnnouncement) {
    await writeLaunchRecord(filePath, next, onWriteFailure);
  }
  return pending !== undefined;
}

/** The renderer showed (or could never show) `version`'s notice: stop retrying it. */
export async function acknowledgeAnnouncement(
  filePath: string,
  version: string,
  onWriteFailure: WriteFailure
): Promise<void> {
  const record = await readLaunchRecord(filePath);
  if (!record || record.pendingAnnouncement !== version) return;
  await writeLaunchRecord(filePath, { lastLaunched: record.lastLaunched }, onWriteFailure);
}
