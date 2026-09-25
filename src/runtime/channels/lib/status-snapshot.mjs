/**
 * Writes <DATA_DIR>/channels/status-snapshot.json every 10 seconds so that
 * setup-server can read cross-process state (cron next-fire, deferred count,
 * relay hook URL) without IPC.
 *
 * Atomic write: tmp → rename so readers never see a partial file.
 *
 * Usage: startSnapshotWriter(scheduler) once the scheduler exists.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { writeJsonAtomicSync } from '../../shared/atomic-file.mjs';
import { readHookPublicBase } from './webhook/relay-tunnel.mjs';

const SNAPSHOT_DIR = path.join(DATA_DIR, 'channels');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'status-snapshot.json');
const INTERVAL_MS = 10_000;
const HEARTBEAT_MS = 60_000; // force-write even when content is unchanged

let _lastSnapshotJson = null;
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
// The next fire instant of a node-cron task. v4 exposes getNextRun(); older
// aliases are retained for persisted installations on an earlier runtime.
// null when the task reports none or the node-cron version mismatches.
function cronTaskNextFireAt(task) {
  try {
    const nd =
      (typeof task.getNextRun === 'function' ? task.getNextRun() : null) ??
      (typeof task.nextDate === 'function' ? task.nextDate() : null) ??
      (typeof task.getNextDate === 'function' ? task.getNextDate() : null);
    if (!nd) return null;
    const fireAt = nd instanceof Date ? nd.getTime() : Number(nd);
    return Number.isFinite(fireAt) ? fireAt : null;
  } catch {
    return null;
  }
}

// Every armed schedule's next fire: cron tasks via node-cron, when_at
// one-shots from the loaded schedule def (the timer handle carries no fireAt).
function* armedScheduleFires(scheduler) {
  for (const [name, task] of scheduler.cronJobs || []) {
    if (scheduler.shouldSkip?.(name)) continue;
    const fireAt = cronTaskNextFireAt(task);
    if (fireAt !== null) yield { name, fireAt, kind: 'cron' };
  }
  const defs = [...(scheduler.nonInteractive || []), ...(scheduler.interactive || [])];
  for (const name of (scheduler.oneShotTimers || new Map()).keys()) {
    if (scheduler.shouldSkip?.(name)) continue;
    const def = defs.find((s) => s.name === name);
    if (!def?.whenAt) continue;
    const fireAt = new Date(def.whenAt).getTime();
    if (Number.isFinite(fireAt)) yield { name, fireAt, kind: 'one-shot' };
  }
}

function nextScheduleFire(scheduler) {
  let next = null;
  for (const candidate of armedScheduleFires(scheduler)) {
    if (!next || candidate.fireAt < next.fireAt) next = candidate;
  }
  return next;
}

function activeDeferred(scheduler, now) {
  const deferred = [];
  for (const [name, until] of scheduler.deferred || []) {
    if (until > now) deferred.push({ name, until });
  }
  return deferred;
}

export async function computeSnapshot(scheduler) {
  const now = Date.now();
  const nextSchedule = scheduler ? nextScheduleFire(scheduler) : null;
  const deferred = scheduler ? activeDeferred(scheduler, now) : [];
  // Relay hook URL (identity file read; assigned on first tunnel start).
  const hookPublicUrl = readHookPublicBase();

  return {
    writtenAt: now,
    schedules: {
      next: nextSchedule ? { name: nextSchedule.name, fireAt: nextSchedule.fireAt, kind: nextSchedule.kind } : null,
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
    if (json === _lastSnapshotJson && now - _lastSnapshotWrite < HEARTBEAT_MS) {
      return; // unchanged within heartbeat window — skip disk write
    }
    _lastSnapshotJson = json;
    _lastSnapshotWrite = now;
    writeJsonAtomicSync(SNAPSHOT_PATH, snap, { lock: false, fsync: false, fsyncDir: false });
  } catch (err) {
    // Non-fatal — statusline degrades gracefully when snapshot is absent.
    process.stderr.write(`mixdog status-snapshot: write failed: ${err?.message ?? err}\n`);
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
  try {
    fs.unlinkSync(SNAPSHOT_PATH);
  } catch {}
}
