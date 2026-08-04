import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "./config.mjs";
import { _dtIdxFlush } from "./index-drop-trace.mjs";
import {
  ensureRuntimeDirs,
  cleanupStaleRuntimeFiles,
  notePreviousServerIfAny,
  writeServerPid,
  refreshActiveInstance,
} from "./runtime-paths.mjs";
import { startCliWorker } from "./cli-worker-host.mjs";
// Worker boot maintenance extracted from channels/index.mjs (behavior-
// preserving): worker-log rotation + stale worker-log/session GC + plugin-data
// sibling prune, the SIGTERM drop-trace flush handler, runtime-dir init, and the
// non-worker-mode owner-identity publish + CLI worker start.
export function runWorkerBootstrap({
  instanceId,
  isWorkerMode,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
}) {
// Rotate additional worker logs (10 MB threshold).
for (const _rotLog of ["channels-worker.log", "schedule.log", "event.log", "memory-worker.log", "mcp-debug.log", "webhook.log", "pg.log", "session-start.log"]) {
  const _rotPath = path.join(DATA_DIR, _rotLog);
  try { if (fs.statSync(_rotPath).size > 10 * 1024 * 1024) fs.renameSync(_rotPath, _rotPath + ".1") } catch {}
}
// GC per-worker scoped sibling logs (`<name>-worker.<leadPid>.<workerPid>.log`).
// Master logs above rotate live; scoped siblings are opened once per worker
// process and never reopened, so age-based removal is the only reliable
// cleanup signal. 7-day TTL keeps recent crash forensics while bounding leak.
const _STALE_WORKER_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
try {
  const _now = Date.now();
  for (const _f of fs.readdirSync(DATA_DIR)) {
    if (!/^(channels|memory)-worker\.\d+\.\d+\.log$/.test(_f)
      && !/^mcp-debug\.\d+\.\d+\.log$/.test(_f)
      && !/^supervisor\.\d+\.log$/.test(_f)) continue;
    const _p = path.join(DATA_DIR, _f);
    try { if (_now - fs.statSync(_p).mtimeMs > _STALE_WORKER_LOG_TTL_MS) fs.unlinkSync(_p); } catch {}
  }
} catch {}
// GC stale ephemeral session files. closeSession plants a closed=true
// tombstone, but bench / smoke / probe drivers historically created sessions
// without ever calling closeSession, leaving 175-byte placeholders behind.
// 7-day TTL is safe because live agent sessions touch their JSON file on
// every ask iteration, so any file older than 7 days is provably abandoned.
const _SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const _STALE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
try {
  const _now = Date.now();
  for (const _f of fs.readdirSync(_SESSIONS_DIR)) {
    if (!_f.endsWith('.json')) continue;
    const _p = path.join(_SESSIONS_DIR, _f);
    try { if (_now - fs.statSync(_p).mtimeMs > _STALE_SESSION_TTL_MS) fs.unlinkSync(_p); } catch {}
  }
} catch {}
// Count-based cap: drop oldest *.log siblings when plugin-data accumulates
// hundreds of per-process files (doctor warns above 300).
try {
  pruneStalePluginDataLogSiblings(DATA_DIR, DEFAULT_STALE_LOG_SIBLING_MAX);
} catch {}
// SIGTERM: flush the drop-trace buffer, but do NOT exit here. In worker
// mode the graceful `_channelsShutdownHandler` below owns shutdown
// (stop() → cleanup → process.exit). In non-worker mode no SIGTERM
// handler was previously installed beyond this one; defer to default
// termination so process.on('exit') hooks still run.
process.on("SIGTERM", () => {
  void _dtIdxFlush();
  if (!isWorkerMode) process.exit(0);
});
// ────────────────────────────────────────────────────────────────────────────
ensureRuntimeDirs();
cleanupStaleRuntimeFiles();
if (!isWorkerMode) {
  notePreviousServerIfAny();
  writeServerPid();
  // Publish owner identity immediately so the SessionStart shim's
  // owner_lead_alive() sees a live owner and uses the full connect budget
  // instead of the 5s no-owner grace (fixes missing recap/core on restart).
  // backendReady intentionally omitted — readiness stays gated until connect.
  try {
    refreshActiveInstance(instanceId);
  } catch (e) {
    const code = e?.code;
    const transient =
      code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOENT";
    if (!transient) throw e;
    try {
      process.stderr.write(
        `mixdog channels: refreshActiveInstance at startup failed (non-fatal, ${code}): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    } catch {}
  }
  startCliWorker();
}
}
