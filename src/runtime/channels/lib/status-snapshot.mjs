/**
 * status-snapshot.mjs — v0.1.19
 *
 * Writes <DATA_DIR>/channels/status-snapshot.json every 10 seconds so that
 * setup-server can read cross-process state (cron next-fire, deferred count,
 * relay hook URL) without IPC.
 *
 * Atomic write: tmp → rename so readers never see a partial file.
 *
 * Usage (from channels/index.mjs):
 *   import { startSnapshotWriter } from './lib/status-snapshot.mjs';
 *   startSnapshotWriter(scheduler, provider, webhookServer);
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './config.mjs';
import { writeJsonAtomicSync } from '../../shared/atomic-file.mjs';
import { readHookPublicBase } from './webhook/relay-tunnel.mjs';

const SNAPSHOT_DIR  = path.join(DATA_DIR, 'channels');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'status-snapshot.json');
const INTERVAL_MS   = 10_000;
const HEARTBEAT_MS  = 60_000; // force-write even when content is unchanged

let _lastSnapshotJson  = null;
let _lastSnapshotWrite = 0;

function stableSnapshotJson(snapshot) {
  const { writtenAt: _writtenAt, ...stable } = snapshot || {};
  return JSON.stringify(stable, null, 2);
}

// ── Snapshot computation ─────────────────────────────────────────────────────
// The legacy HH:MM / everyNm / hourly next-fire fallback was removed: the
// scheduler accepts cron expressions exclusively (scheduler.mjs:68), so the
// fallback could only produce stale next-fire timestamps for entries that
// never actually fire under the cron-only scheduler.
export async function computeSnapshot(scheduler) {
  const now = Date.now();

  // ── Schedules ──────────────────────────────────────────────────────────────
  let nextSchedule = null;   // { name, fireAt, kind }
  const deferred  = [];

  if (scheduler) {
    // Cron-expression next-fire via node-cron ScheduledTask.nextDate().
    if (scheduler.cronJobs && scheduler.cronJobs.size > 0) {
      for (const [name, task] of scheduler.cronJobs) {
        if (scheduler.shouldSkip && scheduler.shouldSkip(name)) continue;
        try {
          // node-cron v4 exposes getNextRun(); retain older aliases for
          // compatibility with persisted installations on an earlier runtime.
          const nd =
            (typeof task.getNextRun === 'function' ? task.getNextRun() : null) ??
            (typeof task.nextDate  === 'function' ? task.nextDate()  : null) ??
            (typeof task.getNextDate === 'function' ? task.getNextDate() : null);
          if (!nd) continue;
          const fireAt = nd instanceof Date ? nd.getTime() : Number(nd);
          if (!isFinite(fireAt)) continue;
          if (!nextSchedule || fireAt < nextSchedule.fireAt) {
            nextSchedule = { name, fireAt, kind: 'cron' };
          }
        } catch { /* node-cron version mismatch — skip */ }
      }
    }

    // Armed when_at one-shots: next-fire is the entry's whenAt instant. The
    // timer handle carries no fireAt, so read it from the loaded schedule def.
    if (scheduler.oneShotTimers && scheduler.oneShotTimers.size > 0) {
      const defs = [...(scheduler.nonInteractive || []), ...(scheduler.interactive || [])];
      for (const name of scheduler.oneShotTimers.keys()) {
        if (scheduler.shouldSkip && scheduler.shouldSkip(name)) continue;
        const def = defs.find((s) => s.name === name);
        if (!def || !def.whenAt) continue;
        const fireAt = new Date(def.whenAt).getTime();
        if (!isFinite(fireAt)) continue;
        if (!nextSchedule || fireAt < nextSchedule.fireAt) {
          nextSchedule = { name, fireAt, kind: 'one-shot' };
        }
      }
    }

    // Deferred entries
    if (scheduler.deferred) {
      for (const [name, until] of scheduler.deferred) {
        if (until > now) deferred.push({ name, until });
      }
    }
  }

  // ── Relay hook URL (identity file read; assigned on first tunnel start) ────
  const hookPublicUrl = readHookPublicBase();

  return {
    writtenAt: now,
    schedules: {
      next: nextSchedule
        ? { name: nextSchedule.name, fireAt: nextSchedule.fireAt, kind: nextSchedule.kind }
        : null,
      deferred,
      deferredCount: deferred.length,
    },
    hook: {
      publicUrl: hookPublicUrl,
    },
  };
}

// ── Atomic writer ────────────────────────────────────────────────────────────
async function writeSnapshot(scheduler) {
  try {
    const snap = await computeSnapshot(scheduler);
    const json = stableSnapshotJson(snap);
    const now = Date.now();
    if (json === _lastSnapshotJson && (now - _lastSnapshotWrite) < HEARTBEAT_MS) {
      return; // unchanged within heartbeat window — skip disk write
    }
    _lastSnapshotJson  = json;
    _lastSnapshotWrite = now;
    writeJsonAtomicSync(SNAPSHOT_PATH, snap, { lock: false, fsync: false, fsyncDir: false });
  } catch (err) {
    // Non-fatal — statusline degrades gracefully when snapshot is absent.
    process.stderr.write(
      `mixdog status-snapshot: write failed: ${err?.message ?? err}\n`
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
let _scheduler = null;
let _snapshotTimer = null;

/**
 * Start the snapshot writer.
 * Call once from channels/index.mjs after the scheduler is created.
 * Re-entrant: calling again replaces the scheduler reference.
 */
export function startSnapshotWriter(scheduler) {
  _scheduler = scheduler;

  // Write immediately on startup
  void writeSnapshot(_scheduler);

  // Then every 10 seconds
  if (!_snapshotTimer) {
    _snapshotTimer = setInterval(() => {
      void writeSnapshot(_scheduler);
    }, INTERVAL_MS);
    // Don't prevent process exit
    if (_snapshotTimer.unref) _snapshotTimer.unref();
  }
}

/** Stop the writer and remove the snapshot file. */
export function stopSnapshotWriter() {
  if (_snapshotTimer) {
    clearInterval(_snapshotTimer);
    _snapshotTimer = null;
  }
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch {}
}
