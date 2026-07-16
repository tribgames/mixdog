/**
 * status-snapshot.mjs — v0.1.19
 *
 * Writes <DATA_DIR>/channels/status-snapshot.json every 10 seconds so that
 * setup-server can read cross-process state (cron next-fire, deferred count,
 * Discord unread, ngrok tunnel URL) without IPC.
 *
 * Atomic write: tmp → rename so readers never see a partial file.
 *
 * Usage (from channels/index.mjs):
 *   import { startSnapshotWriter } from './lib/status-snapshot.mjs';
 *   startSnapshotWriter(scheduler, backend, webhookServer);
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { DATA_DIR } from './config.mjs';
import { writeJsonAtomicSync } from '../../shared/atomic-file.mjs';

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

// ── In-memory Discord unread tracking ────────────────────────────────────────
// Key: channelId  Value: { label, latestSeenId, unseenCount }
// No persistence across restarts — clean start is fine for v1.
const _discordUnread = new Map();
const DISCORD_UNREAD_MAX_CHANNELS = 500;

/**
 * Called whenever the backend observes messages for a channelId.
 * `messages` is the array returned by backend.fetchMessages().
 * We record the most-recently-seen message id and count messages
 * received since the last call as "unread since last fetch".
 * Pass { markRead: true } for live gateway messages that were already
 * delivered into the bridge.
 */
export function recordFetchedMessages(channelId, channelLabel, messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const prev = _discordUnread.get(channelId);
  const prevLatestId = prev?.latestSeenId ?? null;
  const newLatestId  = messages[messages.length - 1]?.id ?? null;

  // Count messages newer than the last seen id (BigInt-compare Discord snowflakes).
  let unseenCount = 0;
  if (options.markRead === true) {
    unseenCount = 0;
  } else if (prevLatestId) {
    for (const m of messages) {
      try {
        if (BigInt(m.id) > BigInt(prevLatestId)) unseenCount++;
      } catch { unseenCount++; }
    }
  }
  // First call: zero unread (baseline, not retroactive).

  // Retain the most recently observed channels only. Channel ids originate from
  // inbound traffic and ad-hoc fetches, so an unbounded process-wide registry
  // would otherwise grow for the worker lifetime.
  if (_discordUnread.has(channelId)) {
    _discordUnread.delete(channelId);
  } else if (_discordUnread.size >= DISCORD_UNREAD_MAX_CHANNELS) {
    _discordUnread.delete(_discordUnread.keys().next().value);
  }
  _discordUnread.set(channelId, {
    label: channelLabel ?? channelId,
    latestSeenId: newLatestId,
    unseenCount,
  });
}

// ── Ngrok tunnel URL probe ───────────────────────────────────────────────────
async function probeNgrokUrl() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { req && req.destroy(); } catch {} resolve(null); }, 400);
    let req;
    try {
      req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        clearTimeout(timer);
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const tunnel = (parsed.tunnels || []).find(t => t.public_url);
            resolve(tunnel ? tunnel.public_url : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => { clearTimeout(timer); resolve(null); });
      req.setTimeout(400, () => { clearTimeout(timer); try { req.destroy(); } catch {} resolve(null); });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

// ── Snapshot computation ─────────────────────────────────────────────────────
// The legacy HH:MM / everyNm / hourly next-fire fallback was removed: the
// scheduler accepts cron expressions exclusively (scheduler.mjs:68), so the
// fallback could only produce stale next-fire timestamps for entries that
// never actually fire under the cron-only scheduler.
async function computeSnapshot(scheduler) {
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
          // node-cron ScheduledTask exposes nextDate() / getNextDate()
          // depending on the installed version; try both.
          const nd =
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

  // ── Discord unread ─────────────────────────────────────────────────────────
  const unreadList = [];
  let totalUnread  = 0;
  for (const [channelId, entry] of _discordUnread) {
    unreadList.push({
      channelId,
      channelLabel: entry.label,
      count: entry.unseenCount,
    });
    totalUnread += entry.unseenCount;
  }

  // ── Ngrok tunnel URL ───────────────────────────────────────────────────────
  const tunnelUrl = await probeNgrokUrl();

  return {
    writtenAt: now,
    schedules: {
      next: nextSchedule
        ? { name: nextSchedule.name, fireAt: nextSchedule.fireAt, kind: nextSchedule.kind }
        : null,
      deferred,
      deferredCount: deferred.length,
    },
    discord: {
      unread: unreadList,
      totalUnread,
    },
    ngrok: {
      tunnelUrl,
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
