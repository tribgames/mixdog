import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './config.mjs';
import {
  ensureRuntimeDirs,
  cleanupStaleRuntimeFiles,
  notePreviousServerIfAny,
  writeServerPid,
  refreshActiveInstance,
} from './runtime-paths.mjs';
// Worker boot maintenance: worker-log rotation + stale worker-log/session GC + plugin-data
// sibling prune, the SIGTERM handler, runtime-dir init, and the
// non-worker-mode owner-identity publish + CLI worker start.
const ROTATED_WORKER_LOGS = [
  'channels-worker.log',
  'schedule.log',
  'event.log',
  'memory-worker.log',
  'mcp-debug.log',
  'webhook.log',
  'pg.log',
  'session-start.log',
];
const STALE_WORKER_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Rotate additional worker logs (10 MB threshold).
function rotateWorkerLogs() {
  for (const name of ROTATED_WORKER_LOGS) {
    const logPath = path.join(DATA_DIR, name);
    try {
      if (fs.statSync(logPath).size > 10 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.1`);
    } catch {}
  }
}

// GC per-worker scoped sibling logs (`<name>-worker.<leadPid>.<workerPid>.log`).
// Master logs rotate live; scoped siblings are opened once per worker
// process and never reopened, so age-based removal is the only reliable
// cleanup signal. 7-day TTL keeps recent crash forensics while bounding leak.
function pruneStaleScopedLogs() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (
        !/^(channels|memory)-worker\.\d+\.\d+\.log$/.test(name) &&
        !/^mcp-debug\.\d+\.\d+\.log$/.test(name) &&
        !/^supervisor\.\d+\.log$/.test(name)
      )
        continue;
      const filePath = path.join(DATA_DIR, name);
      try {
        if (now - fs.statSync(filePath).mtimeMs > STALE_WORKER_FILE_TTL_MS) fs.unlinkSync(filePath);
      } catch {}
    }
  } catch {}
}

// GC stale ephemeral session files. closeSession plants a closed=true
// tombstone, but bench / smoke / probe drivers historically created sessions
// without ever calling closeSession, leaving 175-byte placeholders behind.
// 7-day TTL is safe because live agent sessions touch their JSON file on
// every ask iteration, so any file older than 7 days is provably abandoned.
function pruneStaleSessionFiles() {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(sessionsDir, name);
      try {
        if (now - fs.statSync(filePath).mtimeMs > STALE_WORKER_FILE_TTL_MS) fs.unlinkSync(filePath);
      } catch {}
    }
  } catch {}
}

export function runWorkerBootstrap({
  instanceId,
  isWorkerMode,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
}) {
  rotateWorkerLogs();
  pruneStaleScopedLogs();
  pruneStaleSessionFiles();
  // Count-based cap: drop oldest *.log siblings when plugin-data accumulates
  // hundreds of per-process files (doctor warns above 300).
  try {
    pruneStalePluginDataLogSiblings(DATA_DIR, DEFAULT_STALE_LOG_SIBLING_MAX);
  } catch {}
  // SIGTERM: do NOT exit here in worker mode — the graceful shutdown handler in
  // worker-ipc.mjs owns shutdown (stop() → cleanup → process.exit). In
  // non-worker mode exit explicitly so process.on('exit') hooks still run.
  process.on('SIGTERM', () => {
    if (!isWorkerMode) process.exit(0);
  });
  ensureRuntimeDirs();
  cleanupStaleRuntimeFiles();
  if (!isWorkerMode) {
    notePreviousServerIfAny();
    writeServerPid();
    // Publish owner identity immediately so the SessionStart shim's
    // owner_lead_alive() sees a live owner and uses the full connect budget
    // instead of the 5s no-owner grace (fixes missing recap/core on restart).
    try {
      refreshActiveInstance(instanceId);
    } catch (e) {
      const code = e?.code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOENT';
      if (!transient) throw e;
      try {
        process.stderr.write(
          `mixdog channels: refreshActiveInstance at startup failed (non-fatal, ${code}): ${e instanceof Error ? e.message : String(e)}\n`
        );
      } catch {}
    }
  }
}
