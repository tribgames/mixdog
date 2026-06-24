import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { ensureDir, readJsonFile, removeFileIfExists, writeJsonFile } from "./state-file.mjs";
import { updateJsonAtomicSync, withFileLockSync } from "../../shared/atomic-file.mjs";
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
// Pinned-owner default: ON. The first session to claim ownership auto-pins
// itself and keeps the seat until its PID dies. Opt out per session with
// MIXDOG_PIN_OWNER=0 (or false/no/off) when you want the legacy 10 s stale-
// window takeover behavior — e.g. throwaway shells that should never become
// the sticky main.
function isOwnerPinEnabled() {
  const v = process.env.MIXDOG_PIN_OWNER;
  if (v === undefined || v === null || v === "") return true;
  const low = String(v).toLowerCase();
  return !(low === "0" || low === "false" || low === "no" || low === "off");
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
function activeInstanceStaleReason(state) {
  const ownerPid = getActiveOwnerPid(state);
  if (!isPidAlive(ownerPid)) return `owner PID ${ownerPid ?? "unknown"} is dead`;
  const channelsPid = parsePositivePid(state?.channels_pid);
  if (channelsPid && !isPidAlive(channelsPid)) return `channels PID ${channelsPid} is dead`;
  const workerPid = parsePositivePid(state?.worker_pid);
  if (workerPid && !isPidAlive(workerPid)) return `worker PID ${workerPid} is dead`;
  const serverPid = parsePositivePid(state?.server_pid);
  if (serverPid && !isPidAlive(serverPid)) return `server PID ${serverPid} is dead`;
  return null;
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
        }, { compact: true, fsyncDir: true });
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
function refreshActiveInstance(instanceId, meta) {
  ensureRuntimeDirs();
  return updateJsonAtomicSync(ACTIVE_INSTANCE_FILE, (curRaw) => {
    const prevForPreserve = curRaw;
    const prev = activeInstanceStaleReason(curRaw) ? null : curRaw;
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
    // Pinned ownership (default ON): each refresh reasserts the pinned flag
    // from the current process's env. Other processes refreshing carry their
    // own env, so the flag never outlives the pinned process. Set
    // MIXDOG_PIN_OWNER=0 to opt out and revert to stale-window takeover.
    if (isOwnerPinEnabled()) next.pinned = true;
    else delete next.pinned;
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
    return { ...preservedExtra, ...next };
  }, { compact: true, fsyncDir: true });
}
const SERVER_PID_FILE = join(
  RUNTIME_ROOT,
  `server-${sanitize(process.env.CLAUDE_PLUGIN_DATA ?? "default")}.pid`
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
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "";
    if (!cmd.includes("server.ts")) return false;
    return cmd.includes("mixdog") || pluginRoot && cmd.includes(pluginRoot) || cmd.includes("tsx server.ts") || cmd.includes("node") && cmd.includes("server");
  } catch {
    return false;
  }
}
function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // Use a short synchronous pause via a tiny Atomics spin on a shared buffer
    // so the event loop is not fully starved. Kept synchronous because callers
    // (killSinglePid) are sync; 100 ms sleep via Atomics.wait on a 1-element buffer.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}
function killSinglePid(pid) {
  if (process.platform === "win32") {
    // Capture creation time before kill to guard against PID reuse.
    let _pidCreation = null;
    try {
      const _wmic = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/VALUE"], { encoding: "utf8", timeout: 3e3, windowsHide: true }).trim();
      const _m = _wmic.match(/CreationDate=(\S+)/);
      if (_m) _pidCreation = _m[1];
    } catch { /* wmic unavailable — skip start_time guard */ }
    if (_pidCreation !== null) {
      // Re-verify: if a new process has already taken the PID, abort.
      try {
        const _check = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/VALUE"], { encoding: "utf8", timeout: 3e3, windowsHide: true }).trim();
        const _cm = _check.match(/CreationDate=(\S+)/);
        if (!_cm || _cm[1] !== _pidCreation) {
          console.warn(`[singleton] PID ${pid} creation time changed — aborting kill (PID reuse detected)`);
          return;
        }
      } catch { /* process gone — nothing to kill */ return; }
    }
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8", timeout: 5e3, windowsHide: true });
    } catch (err) {
      console.warn(`[singleton] taskkill failed for PID ${pid}:`, err.message);
    }
  } else {
    // Capture start time before kill to guard against PID reuse.
    let _pidStart = null;
    try {
      _pidStart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", windowsHide: true }).trim();
    } catch { /* ps unavailable — skip start_time guard */ }
    if (_pidStart) {
      try {
        const _cs = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", windowsHide: true }).trim();
        if (_cs !== _pidStart) {
          console.warn(`[singleton] PID ${pid} start time changed — aborting kill (PID reuse detected)`);
          return;
        }
      } catch { return; }
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
    if (!waitForExit(pid, 2e3)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
      if (!waitForExit(pid, 1e3)) {
        console.warn(`[singleton] failed to kill previous server PID ${pid}`);
      }
    }
  }
}
function killAllPreviousServers() {
  try {
    const oldPid = parseInt(readFileSync(SERVER_PID_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid && oldPid !== process.ppid) {
      try {
        process.kill(oldPid, 0);
      } catch {
        return;
      }
      if (looksLikeTribChannelsServer(oldPid) === true) {
        killSinglePid(oldPid);
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
  ACTIVE_INSTANCE_FILE,
  OWNER_DIR,
  RUNTIME_ROOT,
  RUNTIME_STALE_TTL,
  buildActiveInstanceState,
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
  getStopFlagPath,
  getTurnEndPath,
  killAllPreviousServers,
  makeInstanceId,
  readActiveInstance,
  refreshActiveInstance,
  releaseOwnedChannelLocks,
  writeActiveInstance,
  writeServerPid
};
