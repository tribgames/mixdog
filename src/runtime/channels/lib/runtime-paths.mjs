import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { ensureDir, readJsonFile, removeFileIfExists, writeJsonFile } from "./state-file.mjs";
import { updateJsonAtomicSync, withFileLockSync } from "../../shared/atomic-file.mjs";
import { resolvePluginData, mixdogRoot } from "../../shared/plugin-paths.mjs";
const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : join(tmpdir(), "mixdog");
const OWNER_DIR = join(RUNTIME_ROOT, "owners");
const ACTIVE_INSTANCE_FILE = join(RUNTIME_ROOT, "active-instance.json");
const RUNTIME_STALE_TTL = 24 * 60 * 60 * 1e3;
const STATUS_FILE_TTL = 6 * 60 * 60 * 1e3;
const TMP_FILE_TTL = 60 * 60 * 1e3;
function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function forEachFile(dirPath, visit) {
  try {
    for (const fileName of readdirSync(dirPath)) {
      visit(join(dirPath, fileName), fileName);
    }
  } catch {
  }
}
function ensureRuntimeDirs() {
  ensureDir(RUNTIME_ROOT);
  ensureDir(OWNER_DIR);
}
function makeInstanceId(pid = process.pid) {
  return String(pid);
}
function parsePositivePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
function getTerminalLeadPid() {
  return parsePositivePid(process.env.MIXDOG_SUPERVISOR_PID) ?? process.pid;
}
function getServerPid() {
  return parsePositivePid(process.env.MIXDOG_SERVER_PID) ?? (process.env.MIXDOG_WORKER_MODE === "1" ? null : process.pid);
}
function getActiveOwnerPid(state) {
  return parsePositivePid(state?.ownerLeadPid)
    ?? parsePositivePid(state?.terminalLeadPid)
    ?? parsePositivePid(state?.supervisor_pid)
    ?? parsePositivePid(state?.instanceId);
}
function isPidAlive(pid) {
  const n = parsePositivePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
const UI_HEARTBEAT_STALE_MS = 5 * 60 * 1e3;
function activeInstanceStaleReason(state) {
  const ownerPid = getActiveOwnerPid(state);
  if (!isPidAlive(ownerPid)) return `owner PID ${ownerPid ?? "unknown"} is dead`;
  const channelsPid = parsePositivePid(state?.channels_pid);
  if (channelsPid && !isPidAlive(channelsPid)) return `channels PID ${channelsPid} is dead`;
  const workerPid = parsePositivePid(state?.worker_pid);
  if (workerPid && !isPidAlive(workerPid)) return `worker PID ${workerPid} is dead`;
  const serverPid = parsePositivePid(state?.server_pid);
  if (serverPid && !isPidAlive(serverPid)) return `server PID ${serverPid} is dead`;
  // Zombie-Lead repro (2026-07-02): a Lead's owner/channels/worker/server
  // PIDs can all still be alive (process not killed) while the TUI's render
  // loop is dead in the water — no signal ever fires, so pid-only staleness
  // never trips. If the TUI is heartbeating (field present), treat a stale
  // heartbeat as stale ownership too. Backward-compat: state written by an
  // older/non-TUI process (or before the first heartbeat tick) simply omits
  // ui_heartbeat_at, so this branch is a no-op and pid-only judgment stands.
  const uiHeartbeatAt = Number(state?.ui_heartbeat_at);
  if (Number.isFinite(uiHeartbeatAt) && uiHeartbeatAt > 0) {
    const age = Date.now() - uiHeartbeatAt;
    if (age > UI_HEARTBEAT_STALE_MS) {
      return `ui heartbeat stale (${Math.round(age / 1000)}s since last tick)`;
    }
  }
  return null;
}
// Called from src/tui on a 30s timer while the render loop is alive. Only
// touches ui_heartbeat_at (and updatedAt) so it never races/clobbers the
// channels worker's own refreshActiveInstance() writes.
function touchUiHeartbeat(instanceId) {
  ensureRuntimeDirs();
  try {
    updateJsonAtomicSync(ACTIVE_INSTANCE_FILE, (curRaw) => {
      if (!curRaw) return undefined;
      if (instanceId && curRaw.instanceId !== instanceId) return undefined;
      return { ...curRaw, ui_heartbeat_at: Date.now(), updatedAt: Date.now() };
    }, { compact: true, fsync: false, fsyncDir: false, renameFallback: 'truncate', timeoutMs: 0 });
  } catch { /* best-effort try-once (timeoutMs:0): on lock contention we skip
               this tick without ever blocking the render loop on Atomics.wait;
               the next 30s tick catches up. */ }
}
function buildRuntimeIdentity() {
  const terminalLeadPid = getTerminalLeadPid();
  const serverPid = getServerPid();
  return {
    ownerLeadPid: terminalLeadPid,
    terminalLeadPid,
    supervisor_pid: terminalLeadPid,
    server_pid: serverPid,
    worker_pid: process.pid,
    ...process.env.MIXDOG_WORKER_MODE === "1" ? { channels_pid: process.pid } : {},
  };
}
function getTurnEndPath(instanceId) {
  return join(RUNTIME_ROOT, `turn-end-${sanitize(instanceId)}`);
}
function getStatusPath(instanceId) {
  return join(RUNTIME_ROOT, `status-${sanitize(instanceId)}.json`);
}
function getControlPath(instanceId) {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.json`);
}
function getControlResponsePath(instanceId) {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.response.json`);
}
function getPermissionResultPath(instanceId, uuid) {
  return join(RUNTIME_ROOT, `perm-${sanitize(instanceId)}-${sanitize(uuid)}.result`);
}
function getStopFlagPath(instanceId) {
  return join(RUNTIME_ROOT, `stop-${sanitize(instanceId)}.flag`);
}
function getChannelOwnerPath(channelId) {
  return join(OWNER_DIR, `${sanitize(channelId)}.json`);
}
function readActiveInstance() {
  let state = readJsonFile(ACTIVE_INSTANCE_FILE, null);
  if (!state) {
    // Transient read during an atomic rename may yield empty/partial content.
    // Retry once after 50 ms before giving up.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    state = readJsonFile(ACTIVE_INSTANCE_FILE, null);
    if (!state) return null;
  }
  const staleReason = activeInstanceStaleReason(state);
  if (staleReason) {
    // Owner is dead — but the file may carry process-independent runtime
    // state (memory_port, pg_*) that next callers want to preserve. Wiping
    // the whole file forced the next refresh to rebuild from {} and drop
    // memory_port, which broke the scheduler and MCP memory lookup
    // until the memory worker re-advertised. Instead, clear only the
    // owner-identity fields and keep the rest as a stale-but-useful prev
    // for the next refresh. refreshActiveInstance still treats the
    // returned state as "no live owner" via getActiveOwnerPid downstream.
    const {
      pinned: _stalePinned,
      instanceId: _staleId,
      ownerLeadPid: _staleOwner,
      terminalLeadPid: _staleTerm,
      supervisor_pid: _staleSup,
      server_pid: _staleServer,
      worker_pid: _staleWorker,
      channels_pid: _staleChannels,
      supervisor_started_at: _staleStart,
      server_started_at: _staleServerStart,
      httpPort: _staleHttpPort,
      backendReady: _staleBackendReady,
      turnEndFile: _staleTurnEnd,
      statusFile: _staleStatus,
    } = state ?? {};
    const ownerFieldsAlreadyEmpty = _staleId === undefined
      && _staleOwner === undefined
      && _staleTerm === undefined
      && _staleSup === undefined;
    if (!ownerFieldsAlreadyEmpty) {
      process.stderr.write(`mixdog: stale active-instance.json (${staleReason}), clearing owner fields\n`);
      try {
        updateJsonAtomicSync(ACTIVE_INSTANCE_FILE, (curRaw) => {
          if (!curRaw) return undefined;
          const liveReason = activeInstanceStaleReason(curRaw);
          if (!liveReason) return undefined;
          const {
            pinned: _stalePinned2,
            instanceId: _staleId2,
            ownerLeadPid: _staleOwner2,
            terminalLeadPid: _staleTerm2,
            supervisor_pid: _staleSup2,
            server_pid: _staleServer2,
            worker_pid: _staleWorker2,
            channels_pid: _staleChannels2,
            supervisor_started_at: _staleStart2,
            server_started_at: _staleServerStart2,
            httpPort: _staleHttpPort2,
            backendReady: _staleBackendReady2,
            turnEndFile: _staleTurnEnd2,
            statusFile: _staleStatus2,
            ...stableRestLocked
          } = curRaw ?? {};
          const ownerEmpty = _staleId2 === undefined
            && _staleOwner2 === undefined
            && _staleTerm2 === undefined
            && _staleSup2 === undefined;
          if (ownerEmpty) return undefined;
          return { ...stableRestLocked, updatedAt: Date.now() };
        }, { compact: true, fsync: false, fsyncDir: false, renameFallback: 'truncate' });
      } catch {}
    }
    return null;
  }
  return state;
}
function writeActiveInstance(state) {
  ensureRuntimeDirs();
  writeJsonFile(ACTIVE_INSTANCE_FILE, state);
}
// Non-blocking ownership probe for the periodic refresh/heartbeat tick. Reads
// active-instance WITHOUT taking the lock (never blocks). Distinguishes:
//   'absent'  — file does not exist            → seat is claimable
//   'stale'   — parseable but owner PID is dead → seat is claimable
//   'live'    — parseable, owner PID alive      → seat is held (state.instanceId)
//   'unknown' — file present but unreadable/partial (concurrent atomic rename)
//               → INDETERMINATE; callers must treat as busy and NEVER claim.
// This is the read-side guard for "locked/unreadable = busy/unknown owner,
// never claimable/no-owner": a torn read during another writer's rename must
// not be mistaken for an empty seat.
function probeActiveOwner() {
  try { statSync(ACTIVE_INSTANCE_FILE); } catch { return { status: 'absent', state: null }; }
  let raw = readJsonFile(ACTIVE_INSTANCE_FILE, null);
  if (!raw) {
    // Transient partial content during an atomic rename — retry once.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    raw = readJsonFile(ACTIVE_INSTANCE_FILE, null);
    if (!raw) {
      // Re-check existence to disambiguate a completed delete (absent) from a
      // still-unreadable file (unknown/busy).
      try { statSync(ACTIVE_INSTANCE_FILE); } catch { return { status: 'absent', state: null }; }
      return { status: 'unknown', state: null };
    }
  }
  const staleReason = activeInstanceStaleReason(raw);
  if (staleReason) return { status: 'stale', state: raw, staleReason };
  return { status: 'live', state: raw };
}
function buildActiveInstanceState(instanceId, meta) {
  const gatewayMeta = Object.fromEntries(
    Object.entries(meta || {}).filter(([k]) => k.startsWith('gateway_'))
  );
  return {
    instanceId,
    ...buildRuntimeIdentity(),
    supervisor_started_at: Date.now(),
    server_started_at: Date.now(),
    updatedAt: Date.now(),
    turnEndFile: getTurnEndPath(instanceId),
    statusFile: getStatusPath(instanceId),
    ...meta?.channelId ? { channelId: meta.channelId } : {},
      ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
      ...meta?.httpPort ? { httpPort: meta.httpPort } : {},
      ...meta?.memory_port ? { memory_port: meta.memory_port } : {},
      ...gatewayMeta,
      ...typeof meta?.backendReady === "boolean" ? { backendReady: meta.backendReady } : {}
  };
}
function refreshActiveInstance(instanceId, meta, options) {
  ensureRuntimeDirs();
  // Periodic refresh/heartbeat callers pass options.timeoutMs:0 (try-once) so
  // the ownership tick never blocks on the active-instance lock — contention
  // throws ELOCKCONTENDED, which the caller treats as "busy, skip this tick".
  const writeOpts = { compact: true, fsync: false, fsyncDir: false, renameFallback: 'truncate' };
  if (options && Number.isFinite(options.timeoutMs)) writeOpts.timeoutMs = options.timeoutMs;
  return updateJsonAtomicSync(ACTIVE_INSTANCE_FILE, (curRaw) => {
    const prevForPreserve = curRaw;
    const prev = activeInstanceStaleReason(curRaw) ? null : curRaw;
    // CAS guard (opt-in via options.onlyIfOwned): heartbeat/refresh ticks
    // check ownership OUTSIDE this lock, so a newer session can claim the
    // seat between that check and this locked update. Without this re-read,
    // the tick would overwrite the newer owner's instanceId (TOCTOU
    // re-steal -> ownership ping-pong / double backend connections).
    // Returning undefined aborts the update with no write. Explicit claims
    // (boot, claimBridgeOwnership) omit the option and stay last-wins.
    if (options?.onlyIfOwned && (!prev?.instanceId || prev.instanceId !== instanceId)) {
      return undefined;
    }
    // Drop stale fields (pid/startedAt) written by older server versions.
    const { pid: _legacyPid, startedAt: _legacyStartedAt, ...prevRest } = prev ?? {};
    const identity = buildRuntimeIdentity();
    // server_started_at tracks the CURRENT server_pid's start time so the
    // dev-sync barrier can verify the CHILD's freshness (the supervisor's
    // supervisor_started_at is stable across child respawns and cannot).
    // Preserve across refreshes when server_pid is unchanged; stamp fresh
    // when server_pid is new/changed or there is no prev advert.
    const prevServerPid = parsePositivePid(prevForPreserve?.server_pid);
    const prevServerStartedAt = Number(prevForPreserve?.server_started_at);
    const serverStartedAt = (
      prevServerPid !== null
      && identity.server_pid !== null
      && prevServerPid === identity.server_pid
      && Number.isFinite(prevServerStartedAt)
    ) ? prevServerStartedAt : Date.now();
    const gatewayMeta = Object.fromEntries(
      Object.entries(meta || {}).filter(([k]) => k.startsWith('gateway_'))
    );
    const next = {
      ...(prev?.instanceId === instanceId ? prevRest : buildActiveInstanceState(instanceId)),
      ...identity,
      server_started_at: serverStartedAt,
      updatedAt: Date.now(),
      ...meta?.channelId ? { channelId: meta.channelId } : {},
      ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
      ...meta?.httpPort ? { httpPort: meta.httpPort } : {},
      ...meta?.memory_port ? { memory_port: meta.memory_port } : {},
      ...gatewayMeta,
      ...typeof meta?.backendReady === "boolean" ? { backendReady: meta.backendReady } : {},
    };
    if (typeof meta?.transcriptPath === "string" && meta.transcriptPath) {
      const outgoing = prevForPreserve?.transcriptPath;
      if (typeof outgoing === "string" && outgoing) {
        const outBase = basename(outgoing, ".jsonl");
        const newBase = basename(meta.transcriptPath, ".jsonl");
        if (outBase !== newBase) next.priorTranscriptPath = outgoing;
      }
    }
    // Ownership is strict last-wins (no pin): the newest claim always takes
    // the seat. Drop any legacy `pinned` flag left by older versions — it was
    // written but never consumed by any takeover check.
    delete next.pinned;
    // I1: pg_* spreads FIRST so newFields above win on conflict.
    // prev.pg_port='A', meta.httpPort-adjacent pg_port='B' → result.pg_port='B'.
    // memory_port: preserve when the advertising memory worker is still alive
    // (sync process.kill(pid,0); ESRCH=dead). Same server_pid restart still
    // preserves; a live owner from another session must not be dropped on handoff.
    const preservedExtra = Object.fromEntries(
      Object.entries(prevForPreserve ?? {}).filter(([k]) => k.startsWith('pg_'))
    );
    const prevMemoryServerPid = parsePositivePid(prevForPreserve?.memory_server_pid);
    const prevMemoryOwnerAlive = (() => {
      if (prevMemoryServerPid === null) return false;
      try {
        process.kill(prevMemoryServerPid, 0);
        return true;
      } catch (e) {
        if (e && e.code === "ESRCH") return false;
        return true;
      }
    })();
    const sameMemoryAdvertiser =
      prevMemoryServerPid !== null &&
      identity.server_pid !== null &&
      prevMemoryServerPid === identity.server_pid;
    if (sameMemoryAdvertiser || prevMemoryOwnerAlive) {
      if (prevForPreserve && Object.prototype.hasOwnProperty.call(prevForPreserve, 'memory_port')) {
        preservedExtra.memory_port = prevForPreserve.memory_port;
        preservedExtra.memory_server_pid = prevMemoryServerPid;
      }
    }
    // gateway_port follows the same preservation rule as memory_port: the
    // gateway child advertises itself independently, and active-owner
    // heartbeats must not erase that discovery record while its owning
    // server-main process is still alive.
    const prevGatewayServerPid = parsePositivePid(prevForPreserve?.gateway_server_pid);
    const prevGatewayOwnerAlive = (() => {
      if (prevGatewayServerPid === null) return false;
      try {
        process.kill(prevGatewayServerPid, 0);
        return true;
      } catch (e) {
        if (e && e.code === "ESRCH") return false;
        return true;
      }
    })();
    const sameGatewayAdvertiser =
      prevGatewayServerPid !== null &&
      identity.server_pid !== null &&
      prevGatewayServerPid === identity.server_pid;
    if (sameGatewayAdvertiser || prevGatewayOwnerAlive) {
      if (prevForPreserve && Object.prototype.hasOwnProperty.call(prevForPreserve, 'gateway_port')) {
        for (const [key, value] of Object.entries(prevForPreserve)) {
          if (key.startsWith('gateway_')) preservedExtra[key] = value;
        }
        preservedExtra.gateway_server_pid = prevGatewayServerPid;
        // Clear session-scoped gateway metrics when the transcript changes —
        // a new CC session must not inherit the previous session's context
        // usage before the gateway re-advertises.
        const metricTranscript =
          typeof prevForPreserve?.gateway_transcript_path === 'string' && prevForPreserve.gateway_transcript_path
            ? prevForPreserve.gateway_transcript_path
            : typeof prevForPreserve?.transcriptPath === 'string' && prevForPreserve.transcriptPath
              ? prevForPreserve.transcriptPath
              : null;
        if (typeof meta?.transcriptPath === 'string' && meta.transcriptPath && metricTranscript !== meta.transcriptPath) {
          delete preservedExtra.gateway_context_used_pct;
          delete preservedExtra.gateway_last_usage;
          delete next.gateway_context_used_pct;
          delete next.gateway_last_usage;
        }
      }
    }
    // Worker-owned seat: when THIS process is the channels worker and it is
    // the seat owner (no distinct TUI/supervisor Lead — ownerLeadPid resolves
    // to our own pid), keep ui_heartbeat_at fresh. A headless worker never
    // runs the TUI render loop, so an inherited heartbeat (written by a prior
    // TUI session and carried forward in prevRest) would otherwise go stale at
    // UI_HEARTBEAT_STALE_MS and falsely flag a live worker-owned seat. A
    // TUI-owned seat has a distinct supervisor (ownerLeadPid !== our pid), so
    // this branch is a no-op there and TUI staleness is preserved.
    const workerOwnsSeat = process.env.MIXDOG_WORKER_MODE === "1"
      && identity.ownerLeadPid === process.pid;
    if (workerOwnsSeat) {
      next.ui_heartbeat_at = Date.now();
    }
    return { ...preservedExtra, ...next };
  }, writeOpts);
}
const SERVER_PID_FILE = join(
  RUNTIME_ROOT,
  `server-${sanitize(resolvePluginData() ?? "default")}.pid`
);
function looksLikeTribChannelsServer(pid) {
  const pidStr = String(pid);
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pidStr}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }).trim();
      if (!out || out.includes("No tasks")) return false;
      const lower = out.toLowerCase();
      return lower.includes("server.ts") && (lower.includes("node") || lower.includes("tsx") || lower.includes("mixdog"));
    } catch {
      // Transient probe failure: treat as unknown, not server (default-deny).
      return null;
    }
  }
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", pidStr], { encoding: "utf8", windowsHide: true }).trim();
    if (!cmd) return false;
    if (!cmd.includes("server.ts")) return false;
    const root = mixdogRoot();
    return cmd.includes("mixdog") || root && cmd.includes(root) || cmd.includes("tsx server.ts") || cmd.includes("node") && cmd.includes("server");
  } catch {
    return false;
  }
}
function notePreviousServerIfAny() {
  try {
    const oldPid = parseInt(readFileSync(SERVER_PID_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid && oldPid !== process.ppid) {
      try {
        process.kill(oldPid, 0);
      } catch {
        return;
      }
      if (looksLikeTribChannelsServer(oldPid) === true) {
        console.warn(`[singleton] previous server PID ${oldPid} is still alive; leaving it running`);
      }
    }
  } catch {
  }
}
function writeServerPid() {
  ensureRuntimeDirs();
  writeFileSync(SERVER_PID_FILE, String(process.pid));
}
function clearServerPid() {
  try {
    const current = readFileSync(SERVER_PID_FILE, "utf8").trim();
    if (current === String(process.pid)) removeFileIfExists(SERVER_PID_FILE);
  } catch {
  }
}
function cleanupStaleRuntimeFiles(now = Date.now()) {
  ensureRuntimeDirs();
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file === "owners" || file === "active-instance.json") return;
    try {
      const heartbeat = /^supervisor-heartbeat\.(\d+)\.json$/.exec(file);
      if (heartbeat) {
        const pid = Number(heartbeat[1]);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch { removeFileIfExists(fullPath); return; }
        }
      }
      if (/^server-.*\.pid$/.test(file)) {
        let pid = NaN;
        try { pid = Number(readFileSync(fullPath, "utf8").trim()); } catch {}
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch { removeFileIfExists(fullPath); return; }
        }
      }
      const age = now - statSync(fullPath).mtimeMs;
      // status snapshots and atomic-write .tmp leftovers churn quickly;
      // tighter TTLs keep dead-process residue from accumulating.
      let ttl = RUNTIME_STALE_TTL;
      if (/^status-.*\.json$/.test(file)) ttl = STATUS_FILE_TTL;
      else if (/\.tmp$/.test(file)) ttl = TMP_FILE_TTL;
      if (age > ttl) removeFileIfExists(fullPath);
    } catch {
    }
  });
  forEachFile(OWNER_DIR, (fullPath) => {
    try {
      // Owner liveness check beats mtime — a record pointing at a dead
      // instanceId is stale immediately regardless of when it was written.
      const owner = readJsonFile(fullPath, null);
      const ownerPid = Number(owner?.pid ?? owner?.instanceId);
      if (Number.isFinite(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); }
        catch { removeFileIfExists(fullPath); return; }
      }
      if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath);
    } catch {
    }
  });
}
function cleanupInstanceRuntimeFiles(instanceId) {
  const targets = [
    getTurnEndPath(instanceId),
    getStatusPath(instanceId),
    getControlPath(instanceId),
    getControlResponsePath(instanceId),
    getStopFlagPath(instanceId)
  ];
  for (const target of targets) {
    removeFileIfExists(target);
  }
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file.startsWith(`perm-${sanitize(instanceId)}-`)) {
      removeFileIfExists(fullPath);
    }
  });
}
function releaseOwnedChannelLocks(instanceId) {
  forEachFile(OWNER_DIR, (fullPath) => {
    const owner = readJsonFile(fullPath, null);
    if (owner?.instanceId === instanceId) removeFileIfExists(fullPath);
  });
}
function clearActiveInstance(instanceId) {
  withFileLockSync(`${ACTIVE_INSTANCE_FILE}.lock`, () => {
    const curRaw = readJsonFile(ACTIVE_INSTANCE_FILE, null);
    const prev = curRaw && !activeInstanceStaleReason(curRaw) ? curRaw : null;
    if (prev?.instanceId !== instanceId) return;
    removeFileIfExists(ACTIVE_INSTANCE_FILE);
  });
}
export {
  RUNTIME_ROOT,
  cleanupInstanceRuntimeFiles,
  cleanupStaleRuntimeFiles,
  clearActiveInstance,
  clearServerPid,
  ensureRuntimeDirs,
  getActiveOwnerPid,
  getChannelOwnerPath,
  getControlPath,
  getControlResponsePath,
  getPermissionResultPath,
  getTerminalLeadPid,
  getStatusPath,
  getTurnEndPath,
  notePreviousServerIfAny,
  makeInstanceId,
  readActiveInstance,
  probeActiveOwner,
  refreshActiveInstance,
  releaseOwnedChannelLocks,
  touchUiHeartbeat,
  writeServerPid
};
