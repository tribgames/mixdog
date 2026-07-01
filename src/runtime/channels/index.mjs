import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { pathToFileURL } from "url";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
import { loadConfig, createBackend, loadProfileConfig, DATA_DIR } from "./lib/config.mjs";
import { resolveVoiceRuntime } from "./lib/voice-runtime-fetcher.mjs";
import { ensureReady, transcribe, stopVoiceWhisperServer } from "./lib/whisper-server.mjs";
import { loadConfig as loadAgentConfig } from "../agent/orchestrator/config.mjs";
import { captureOriginalUserCwd, readLastSessionCwd } from "../shared/user-cwd.mjs";
import { managedLaunchId, enqueueLauncherCommand } from "../shared/launcher-control.mjs";
import { initProviders } from "../agent/orchestrator/providers/registry.mjs";
import { Scheduler } from "./lib/scheduler.mjs";
import { startSnapshotWriter, stopSnapshotWriter, recordFetchedMessages } from "./lib/status-snapshot.mjs";
import { hasPending as dispatchHasPending } from "../agent/orchestrator/dispatch-persist.mjs";
import { setListener as setActivityBusListener } from "../agent/orchestrator/activity-bus.mjs";
import { stripSoftWarns } from "../agent/orchestrator/tool-loop-guard.mjs";
import { invalidatePrefetchCache } from "../agent/orchestrator/session/cache/prefetch-cache.mjs";
import { WebhookServer } from "./lib/webhook.mjs";
import { EventPipeline } from "./lib/event-pipeline.mjs";
import { startCliWorker } from "./lib/cli-worker-host.mjs";
import {
  OutputForwarder,
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime
} from "./lib/output-forwarder.mjs";
import { controlClaudeSession } from "./lib/session-control.mjs";
import { JsonStateFile, ensureDir, removeFileIfExists, writeTextFile } from "./lib/state-file.mjs";
import {
  buildModalRequestSpec,
  PendingInteractionStore
} from "./lib/interaction-workflows.mjs";
import {
  ensureRuntimeDirs,
  makeInstanceId,
  getTurnEndPath,
  getStatusPath,
  getPermissionResultPath,
  getChannelOwnerPath,
  getActiveOwnerPid,
  getTerminalLeadPid,
  readActiveInstance,
  refreshActiveInstance,
  cleanupStaleRuntimeFiles,
  cleanupInstanceRuntimeFiles,
  releaseOwnedChannelLocks,
  clearActiveInstance,
  notePreviousServerIfAny,
  writeServerPid,
  clearServerPid,
  RUNTIME_ROOT
} from "./lib/runtime-paths.mjs";
import { getDiscordToken } from "./lib/config.mjs";
const memoryClientModulePath = new URL("./lib/memory-client.mjs", import.meta.url).href;
const {
  appendEntry: memoryAppendEntry,
  ingestTranscript: memoryIngestTranscript,
} = await import(memoryClientModulePath);
const DEFAULT_PLUGIN_VERSION = "0.0.1";
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ""));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());
function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `channels:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, "_")}`);
  }
  try { process.stderr.write(`${parts.join(" ")}\n`); } catch {}
}
function localTimestamp() {
  return (/* @__PURE__ */ new Date()).toLocaleString("sv-SE", { hour12: false });
}
function readPluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return pkg.version || DEFAULT_PLUGIN_VERSION;
  } catch {
    return DEFAULT_PLUGIN_VERSION;
  }
}
const PLUGIN_VERSION = readPluginVersion();
let crashLogging = false;
let _channelsDegraded = false;
let _stderrBroken = false;
function isChannelsDegraded() { return _channelsDegraded; }

// stderr can break when the parent stdio pipe closes. Node then emits an
// async 'error' on process.stderr, which sync try/catch around write() does
// not catch — without a listener, that error becomes uncaughtException and
// re-enters logCrash, looping until the disk fills. Register a suppressor
// once at load time and stop writing to stderr after the first EPIPE so the
// loop cannot start.
try {
  process.stderr.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || /EPIPE/.test(String(e.message || '')))) {
      _stderrBroken = true;
      _channelsDegraded = true;
    }
  });
} catch {}

// Crash log guards: dedup repeated identical errors (a single broken handler
// can fire thousands of times per minute) and rotate at a 10 MB cap so the
// file cannot grow unbounded. One .old generation is kept; older rolls drop.
const CRASH_LOG_MAX_BYTES = 10 * 1024 * 1024;
let _lastCrashSig = "";
let _crashRepeatCount = 0;

function _writeCrashLine(crashLog, line) {
  try {
    let size = 0;
    try { size = fs.statSync(crashLog).size; } catch {}
    if (size + line.length > CRASH_LOG_MAX_BYTES) {
      try { fs.renameSync(crashLog, crashLog + ".old"); } catch {}
    }
    fs.appendFileSync(crashLog, line);
  } catch {}
}

function logCrash(label, err) {
  if (crashLogging) return;
  crashLogging = true;
  const msg = `[${localTimestamp()}] mixdog: ${label}: ${err}
${err instanceof Error ? err.stack : ""}
`;
  if (!_stderrBroken) {
    try { process.stderr.write(msg); } catch (e) {
      if (e && (e.code === 'EPIPE' || /EPIPE/.test(String(e.message || '')))) {
        _stderrBroken = true;
      }
    }
  }
  const sig = `${label}|${err && err.message ? err.message : String(err)}`;
  const crashLog = path.join(DATA_DIR, "crash.log");
  if (sig === _lastCrashSig) {
    // Same error repeating — count it but skip the disk write. The next
    // distinct error (or EPIPE branch below) flushes the suppressed total.
    _crashRepeatCount += 1;
  } else {
    if (_crashRepeatCount > 0) {
      _writeCrashLine(crashLog, `[${localTimestamp()}] mixdog: previous error repeated ${_crashRepeatCount} more time(s)\n`);
      _crashRepeatCount = 0;
    }
    _lastCrashSig = sig;
    _writeCrashLine(crashLog, msg);
  }
  if (err instanceof Error && err.message.includes("EPIPE")) {
    _channelsDegraded = true;
    _stderrBroken = true;
  }
  crashLogging = false;
}
process.on("unhandledRejection", (err) => logCrash("unhandled rejection", err));
process.on("uncaughtException", (err) => logCrash("uncaught exception", err));
if (process.env.MIXDOG_CHANNELS_NO_CONNECT) {
  process.exit(0);
}
const _isWorkerMode = process.env.MIXDOG_WORKER_MODE === '1'
const _bootLogEarly = path.join(
  DATA_DIR || path.join(os.tmpdir(), "mixdog"),
  "boot.log"
);
const {
  isMixdogDebugEnabled: isMixdogDebug,
  pruneStalePluginDataLogSiblings,
  appendSessionStartCriticalLog,
  DEFAULT_STALE_LOG_SIBLING_MAX,
} = _require("../../lib/mixdog-debug.cjs");
// One-shot log rotation at worker boot (10 MB threshold, .1 suffix overwrite).
if (isMixdogDebug()) {
  try { if (fs.statSync(_bootLogEarly).size > 10 * 1024 * 1024) fs.renameSync(_bootLogEarly, _bootLogEarly + '.1') } catch {}
  fs.appendFileSync(_bootLogEarly, `[${localTimestamp()}] bootstrap start pid=${process.pid}
`);
}
const _bootLog = path.join(DATA_DIR, "boot.log");
let config = loadConfig();
let backend = createBackend(config);
const INSTANCE_ID = makeInstanceId();
const TERMINAL_LEAD_PID = getTerminalLeadPid();
// ── drop-trace instrumentation ──────────────────────────────────────────────
const _dropTraceLog = path.join(DATA_DIR, "drop-trace.log");
const DROP_TRACE_ENABLED =
  process.env.MIXDOG_DROP_TRACE === "1" ||
  process.env.MIXDOG_DROP_TRACE === "true" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "1" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "true";
// One-shot rotation for drop-trace.log at worker boot.
if (DROP_TRACE_ENABLED) {
  try { if (fs.statSync(_dropTraceLog).size > 10 * 1024 * 1024) fs.renameSync(_dropTraceLog, _dropTraceLog + '.1') } catch {}
}
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

// ── Buffered drop-trace writer (channels/index) ──────────────────────────────
// Flushes every 1 s OR when buffer reaches 64 KB — whichever fires first.
// Drains on process exit so no log lines are lost.
let _dtIdxBuf = "";
let _dtIdxBytes = 0;
let _dtIdxFlushTimer = null;
let _dtIdxStream = null;
function _dtIdxGetStream() {
  if (!_dtIdxStream) _dtIdxStream = fs.createWriteStream(_dropTraceLog, { flags: "a" });
  return _dtIdxStream;
}
async function _dtIdxFlush() {
  if (_dtIdxFlushTimer) { clearTimeout(_dtIdxFlushTimer); _dtIdxFlushTimer = null; }
  if (!_dtIdxBuf) return;
  const stream = _dtIdxGetStream();
  const buf = _dtIdxBuf;
  _dtIdxBuf = "";
  _dtIdxBytes = 0;
  try {
    const ok = stream.write(buf);
    if (!ok) { const { once } = await import("node:events"); await once(stream, "drain").catch(() => {}); }
  } catch {}
}
function _dtIdxScheduleFlush() {
  if (_dtIdxFlushTimer) return;
  _dtIdxFlushTimer = setTimeout(() => { void _dtIdxFlush(); }, 1000);
  if (_dtIdxFlushTimer.unref) _dtIdxFlushTimer.unref();
}
function _dtIdxAppend(line) {
  _dtIdxBuf += line;
  _dtIdxBytes += Buffer.byteLength(line);
  if (_dtIdxBytes >= 65536) { void _dtIdxFlush(); return; }
  _dtIdxScheduleFlush();
}
process.on("exit", () => { void _dtIdxFlush(); });
// SIGTERM: flush the drop-trace buffer, but do NOT exit here. In worker
// mode the graceful `_channelsShutdownHandler` below owns shutdown
// (stop() → cleanup → process.exit). In non-worker mode no SIGTERM
// handler was previously installed beyond this one; defer to default
// termination so process.on('exit') hooks still run.
process.on("SIGTERM", () => {
  void _dtIdxFlush();
  if (!_isWorkerMode) process.exit(0);
});

function preview(text) {
  if (!text) return "";
  const s = String(text).replace(/\n/g, "\\n");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
function dropTrace(event, fields) {
  if (!DROP_TRACE_ENABLED) return;
  try {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const loc = `[${ts}][pid=${process.pid}] ${event}`;
    const kv = fields ? " " + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    _dtIdxAppend(loc + kv + "\n");
  } catch {}
}
// ────────────────────────────────────────────────────────────────────────────
ensureRuntimeDirs();
cleanupStaleRuntimeFiles();
if (!_isWorkerMode) {
  notePreviousServerIfAny();
  writeServerPid();
  // Publish owner identity immediately so the SessionStart shim's
  // owner_lead_alive() sees a live owner and uses the full connect budget
  // instead of the 5s no-owner grace (fixes missing recap/core on restart).
  // backendReady intentionally omitted — readiness stays gated until connect.
  refreshActiveInstance(INSTANCE_ID);
  startCliWorker();
}
const INSTRUCTIONS = "";

// ── Parent notification helper ───────────────────────────────────────
// This worker has no MCP transport of its own. All notifications flow
// through IPC to the parent (server.mjs), which owns the single connected
// MCP `Server` instance. The parent's IPC message handler translates
// `{type:'notify', method, params}` into `server.notification({method, params})`.
//
// Before v0.6.7 the worker had its own orphan `Server` instance that was
// never `connect()`ed to any transport, so `.notification()` silently
// threw 'Not connected' inside the SDK and every call was dropped by an
// outer `.catch(() => {})`. That regression is what this path replaces.
function normalizeChannelNotifyParams(method, params) {
  if (method === 'notifications/claude/channel' && params && params.meta) {
    const m = {};
    for (const [k, v] of Object.entries(params.meta)) {
      if (v === undefined || v === null) continue;
      m[k] = k === 'silent_to_agent' ? (v === true || v === 'true') : String(v);
    }
    return { ...params, meta: m };
  }
  return params;
}

function sendNotifyToParent(method, params) {
  // CC channel schema requires meta: Record<string,string> (channelNotification.ts).
  // Coerce every meta value to string so a non-string (e.g. a Discord
  // interaction.type number) can't fail zod and silently drop the notify.
  // silent_to_agent stays boolean — an internal routing flag the daemon
  // router / agentNotify consume (=== true) before the CC zod boundary.
  const outParams = normalizeChannelNotifyParams(method, params);
  if (!process.send) {
    try { process.stderr.write(`mixdog channels: notify dropped (no IPC channel): ${method}\n`); } catch {}
    return;
  }
  try {
    process.send({ type: 'notify', method, params: outParams });
  } catch (err) {
    try { process.stderr.write(`mixdog channels: notify IPC send failed: ${err && err.message || err}\n`); } catch {}
  }
}

// ── Memory worker bridge (worker → parent → memory) ─────────────────
// The channels worker does not own the memory worker handle. To trigger
// memory tool actions (e.g. cycle1) we send `memory_call_request` to the
// parent, which routes through callWorker('memory', ...) and ships the
// result back as `memory_call_response`. The response listener is
// integrated into the main IPC handler below (not a second listener).
const _memoryCallPending = new Map();
let _memoryCallSeq = 0;

function callMemoryAction(action, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('not a worker process'));
    const callId = `mc_${INSTANCE_ID}_${++_memoryCallSeq}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      _memoryCallPending.delete(callId);
      reject(new Error(`memory_call ${action} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _memoryCallPending.set(callId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      process.send({ type: 'memory_call_request', callId, action, args: args || {} });
    } catch (e) {
      _memoryCallPending.delete(callId);
      clearTimeout(timer);
      reject(e);
    }
  });
}
function resolveChannelLabel(channelsConfig, label) {
  if (!label || !channelsConfig) return label;
  const entry = channelsConfig[label];
  if (entry?.channelId) return entry.channelId;
  return label;
}
let channelBridgeActive = false;
function writeBridgeState(active) {
  try {
    const stateFile = path.join(os.tmpdir(), "mixdog", "bridge-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ active, ts: Date.now() }));
  } catch {
  }
}
function isChannelBridgeActive() {
  return channelBridgeActive;
}
let typingChannelId = null;
const pendingSetup = new PendingInteractionStore();
function startServerTyping(channelId) {
  if (typingChannelId && typingChannelId !== channelId) {
    backend.stopTyping(typingChannelId);
  }
  typingChannelId = channelId;
  backend.startTyping(channelId);
}
function stopServerTyping() {
  if (typingChannelId) {
    backend.stopTyping(typingChannelId);
    typingChannelId = null;
  }
}
const TURN_END_FILE = getTurnEndPath(INSTANCE_ID);
const TURN_END_BASENAME = path.basename(TURN_END_FILE);
const TURN_END_DIR = path.dirname(TURN_END_FILE);
let turnEndWatcher = null;
// Config hot-reload watcher (installed by start(); torn down by stop()).
let _configWatcher = null;
let _reloadDebounce = null;
if (!_isWorkerMode) {
  removeFileIfExists(TURN_END_FILE);
  turnEndWatcher = fs.watch(TURN_END_DIR, async (_event, filename) => {
    if (filename !== TURN_END_BASENAME) return;
    try {
      const stat = fs.statSync(TURN_END_FILE);
      if (stat.size > 0) {
        stopServerTyping();
        await forwarder.forwardFinalText();
        removeFileIfExists(TURN_END_FILE);
      }
    } catch {
    }
  });
}
const STATUS_FILE = getStatusPath(INSTANCE_ID);
const statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
function sessionIdFromTranscriptPath(transcriptPath) {
  const base = path.basename(transcriptPath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : "";
}
function getPersistedTranscriptPath() {
  const state = statusState.read();
  if (typeof state.transcriptPath === "string" && state.transcriptPath) return state.transcriptPath;
  return readActiveInstance()?.transcriptPath ?? "";
}
function pickUsableTranscriptPath(bound, previousPath) {
  if (bound?.exists) return bound.transcriptPath;
  if (!previousPath) return "";
  if (!bound?.sessionId) return previousPath;
  return sessionIdFromTranscriptPath(previousPath) === bound.sessionId ? previousPath : "";
}
const forwarder = new OutputForwarder({
  send: async (ch, text) => {
    if (!channelBridgeActive) {
      throw new Error("send() called while channel bridge is inactive");
    }
    await backend.sendMessage(ch, text);
  },
  recordAssistantTurn: async () => {
  },
  react: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.react(ch, mid, emoji);
  },
  removeReaction: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.removeReaction(ch, mid, emoji);
  }
}, statusState);
forwarder.setOnIdle(() => {
  stopServerTyping();
  void forwarder.forwardFinalText();
});
// Wire the forwarder ownership probe unconditionally. wireEventQueueHandlers()
// also sets this, but that path only runs when the event pipeline starts
// (webhook enabled or event rules present). Without an event pipeline the
// forwarder's ownerGetter stayed null and _isOwner() failed open, letting a
// non-owner process forward transcript output (duplicate Discord sends).
// The closure reads bridgeRuntimeConnected at call time.
forwarder.setOwnerGetter(() => bridgeRuntimeConnected);
function applyTranscriptBinding(channelId, transcriptPath, options = {}) {
  if (!transcriptPath) return;
  forwarder.setContext(channelId, transcriptPath, { replayFromStart: options.replayFromStart, catchUpFromPersisted: options.catchUpFromPersisted });
  const boundTranscriptPath = forwarder.transcriptPath || transcriptPath;
  forwarder.startWatch();
  void memoryIngestTranscript(boundTranscriptPath, { cwd: options.cwd });
  refreshActiveInstance(INSTANCE_ID, { channelId, transcriptPath: boundTranscriptPath });
  if (options.persistStatus !== false) {
    statusState.update((state) => {
      state.channelId = channelId;
      state.transcriptPath = boundTranscriptPath;
      state.lastFileSize = forwarder.lastFileSize;
      state.sentCount = forwarder.sentCount;
      state.lastSentHash = forwarder.lastHash;
      state.lastSentTime = 0;
      state.sessionIdle = false;
      state.sessionCwd = options.cwd ?? null;
    });
  }
}
async function rebindTranscriptContext(channelId, options = {}) {
  const previousPath = options.previousPath ?? "";
  const mode = options.mode ?? "same";
  const explicitTranscriptPath = typeof options.transcriptPath === "string" ? options.transcriptPath.trim() : "";
  if (explicitTranscriptPath) {
    let explicitExists = false;
    try {
      explicitExists = fs.statSync(explicitTranscriptPath).isFile();
    } catch {
      explicitExists = false;
    }
    if (explicitExists) {
      applyTranscriptBinding(channelId, explicitTranscriptPath, {
        replayFromStart: Boolean(options.catchUp),
        catchUpFromPersisted: options.catchUpFromPersisted,
        persistStatus: options.persistStatus
      });
      if (options.catchUp || options.catchUpFromPersisted) {
        await forwarder.forwardNewText();
      }
      return explicitTranscriptPath;
    }
  }
  let sawPendingTranscript = false;
  let pendingSessionId = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bound = discoverSessionBoundTranscript();
    if (bound?.exists) {
      const acceptable = mode === "same" || !previousPath || bound.transcriptPath !== previousPath;
      if (acceptable) {
        const replayFromStart = Boolean(
          options.catchUp && !previousPath && sawPendingTranscript && pendingSessionId === bound.sessionId
        );
        applyTranscriptBinding(channelId, bound.transcriptPath, {
          replayFromStart,
          catchUpFromPersisted: options.catchUpFromPersisted,
          persistStatus: options.persistStatus,
          cwd: bound.sessionCwd,
        });
        if (replayFromStart || options.catchUpFromPersisted) {
          await forwarder.forwardNewText();
        }
        return bound.transcriptPath;
      }
    } else if (bound?.sessionId) {
      sawPendingTranscript = true;
      pendingSessionId = bound.sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (previousPath) {
    applyTranscriptBinding(channelId, previousPath, { catchUpFromPersisted: true, cwd: statusState.read().sessionCwd });
    await forwarder.forwardNewText();
    process.stderr.write(`mixdog: rebind fallback: bound previous transcript ${previousPath}\n`);
    return previousPath;
  }
  process.stderr.write(`mixdog: rebind failed: no transcript found and no previous path to fall back to\n`);
  return "";
}
const scheduler = new Scheduler(
  config.nonInteractive ?? [],
  config.interactive ?? [],
  // channelsConfig kept for channel-label resolution (resolveChannel)
  // only — quiet/schedules now come from the top-level config.
  config.channelsConfig,
  // 0.1.62: top-level normalized config carries quiet/schedules.
  config
);
// Register the pending-dispatch probe so the scheduler treats an in-flight
// bridge dispatch as "active" regardless of user-inbound silence.
scheduler.setPendingCheck(() => {
  try {
    return dispatchHasPending(DATA_DIR);
  } catch {
    return false;
  }
});
// Bridge the orchestrator-side activity notifier into the scheduler so
// events like `addPending` can bump lastActivity without importing the
// scheduler instance directly (avoids module cycles).
setActivityBusListener(() => scheduler.noteActivity());
let webhookServer = null;
let eventPipeline = null;
let bridgeRuntimeConnected = false;
let bridgeRuntimeStarting = false;
// Stop-requested signal: set by stopOwnedRuntime() when it runs during the
// startOwnedRuntime() in-flight window (bridgeRuntimeStarting=true). Checked
// by startOwnedRuntime() right after backend.connect() resolves so the
// in-flight start does not revive owner state after the stop already tore
// the partial-start state down.
let _ownedRuntimeStopRequested = false;
let bridgeOwnershipRefreshInFlight = null;
let bridgeOwnershipTimer = null;
let lastOwnershipNote = "";
const ACTIVE_OWNER_STALE_MS = 1e4;
// Owner heartbeat: keep active-instance.json fresh so other sessions cannot
// steal the seat after 10 s of channel-action silence. unref'd interval —
// never blocks process exit. Single JSON atomic write, no measurable load.
const OWNER_HEARTBEAT_INTERVAL_MS = 5e3;
let ownerHeartbeatTimer = null;
// Owner gating here is multi-process runtime coordination: only the active
// bindingReady gates all send paths until the boot-time refreshBridgeOwnership
// ({ restoreBinding: true }) call completes. Without this, scheduler/webhook
// emissions fired within the first ~few hundred ms after restart drop because
// the Discord backend binding has not yet been established.
let bindingReadyStatus = "pending";
let _bindingReadyResolve;
const bindingReady = new Promise((r) => { _bindingReadyResolve = r; });
dropTrace("bindingReady.create", { status: bindingReadyStatus });
function logOwnership(note) {
  if (lastOwnershipNote === note) return;
  lastOwnershipNote = note;
  process.stderr.write(`[ownership] ${note}
`);
}
function currentOwnerState() {
  const active = readActiveInstance();
  return {
    active,
    // Strict last-wins: this process owns the bridge ONLY when active-instance
    // names exactly this INSTANCE_ID. A newer remote session that claims the
    // seat overwrites instanceId, so the old owner immediately reads owned=false
    // and disconnects on its next refresh tick. No PID/terminal fallback —
    // that used to let a co-terminal worker wrongly self-claim.
    owned: active?.instanceId === INSTANCE_ID
  };
}
function getBridgeOwnershipSnapshot() {
  return currentOwnerState();
}
function claimBridgeOwnership(reason) {
  refreshActiveInstance(INSTANCE_ID);
  logOwnership(`claimed owner (${reason})`);
}
async function bindPersistedTranscriptIfAny() {
  // Resolve channelId first from persisted status; fall back to the most
  // recent status-*.json snapshot, then to the configured main channel when
  // the bridge is active. No exists-gate here — once we have a channelId,
  // hand off to rebindTranscriptContext(), which owns the 30-attempt retry
  // for transcripts that are not yet on disk at boot/activate time.
  let currentStatus = statusState.read();
  if (!currentStatus.channelId) {
    try {
      const files = fs.readdirSync(RUNTIME_ROOT).filter((f) => f.startsWith("status-") && f.endsWith(".json")).map((f) => {
        const full = path.join(RUNTIME_ROOT, f);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      for (const { path: fp } of files) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (data.channelId) {
            statusState.update((state) => {
              Object.assign(state, data);
            });
            currentStatus = statusState.read();
            process.stderr.write(`mixdog: restored status from ${fp}
`);
            break;
          }
        } catch {
        }
      }
    } catch {
    }
  }
  if (!currentStatus.channelId && channelBridgeActive) {
    const chCfg = config.channelsConfig;
    const mainLabel = config.mainChannel ?? "main";
    const mainEntry = chCfg?.[mainLabel];
    const mainId = mainEntry?.channelId;
    if (mainId) {
      statusState.update((state) => {
        state.channelId = mainId;
      });
      currentStatus = statusState.read();
      process.stderr.write(`mixdog: auto-bound to main channel ${mainId}
`);
    }
  }
  if (!currentStatus.channelId) return;
  const bound = await rebindTranscriptContext(currentStatus.channelId, {
    previousPath: getPersistedTranscriptPath(),
    persistStatus: true,
    catchUpFromPersisted: true
  });
  if (bound) {
    process.stderr.write(`mixdog: initial transcript bind: ${bound}
`);
  }
}
function shouldStartEventPipelineRuntime() {
  return config.webhook?.enabled === true || (Array.isArray(config.events?.rules) && config.events.rules.length > 0);
}
function ensureEventPipelineRuntime() {
  if (!eventPipeline) {
    eventPipeline = new EventPipeline(config.events, config.channelsConfig);
    wireEventQueueHandlers(eventPipeline.getQueue());
  }
  return eventPipeline;
}
function ensureWebhookServerRuntime() {
  if (!webhookServer) {
    // Pass top-level normalized config so the webhook gate reads the new
    // top-level `quiet` subtree (and `webhook.respectQuiet`) introduced in
    // 0.1.62. See applyDefaults() in lib/config.mjs.
    webhookServer = new WebhookServer(config.webhook, { quiet: config.quiet ?? null });
  }
  wireWebhookHandlers();
  return webhookServer;
}
async function stopWebhookAndEventRuntime() {
  if (webhookServer) {
    await webhookServer.stop();
    webhookServer = null;
  }
  if (eventPipeline) {
    eventPipeline.stop();
    eventPipeline = null;
  }
}
function syncOwnedWebhookAndEventRuntime({ reload = false } = {}) {
  if (shouldStartEventPipelineRuntime()) {
    const pipeline = ensureEventPipelineRuntime();
    if (reload) {
      pipeline.reloadConfig(config.events, config.channelsConfig);
      wireEventQueueHandlers(pipeline.getQueue());
    }
    pipeline.start();
  } else if (eventPipeline) {
    eventPipeline.stop();
    eventPipeline = null;
  }

  if (config.webhook?.enabled === true) {
    const server = ensureWebhookServerRuntime();
    if (reload) {
      // server.reloadConfig is async (it awaits the current server's
      // close() before re-listening). Chain start() onto its resolution
      // so we don't race the bound port — calling start() synchronously
      // here would re-listen before close() finishes and surface
      // EADDRINUSE on the same port.
      server.reloadConfig(config.webhook, { quiet: config.quiet ?? null }, {
        autoStart: false
      }).then(() => {
        // A stopWebhookAndEventRuntime() / deactivate landing during the async
        // close()+reload window nulls out webhookServer (and webhook.enabled may
        // have flipped off). Without this guard the resolved continuation would
        // re-listen and resurrect an orphan listener that no teardown tracks.
        if (webhookServer !== server || config.webhook?.enabled !== true) {
          try { server.stop(); } catch {}
          return;
        }
        wireWebhookHandlers();
        server.start();
      }).catch((err) => {
        process.stderr.write(`mixdog channels: webhook reload failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    } else {
      server.start();
    }
  } else if (webhookServer) {
    webhookServer.stop();
    webhookServer = null;
  }
}
async function startOwnedRuntime(options = {}) {
  if (bridgeRuntimeConnected) return;
  if (bridgeRuntimeStarting) return;
  if (!channelBridgeActive) return;
  bridgeRuntimeStarting = true;
  _ownedRuntimeStopRequested = false;
  // Advertise active-instance.json BEFORE backend connect so a newer remote
  // session's last-wins claim is visible immediately. backendReady=false
  // marks the partial state until backend.connect() succeeds.
  refreshActiveInstance(INSTANCE_ID, { backendReady: false });
  startOwnerHeartbeat();
  // Re-check after each post-connect await so a stopOwnedRuntime() landing
  // mid-start cannot be overridden by the resuming start (scheduler/snapshot/
  // webhook/binding launches below would revive owner state after stop).
  // Idempotent: stop's sync teardown already ran; re-running disconnect +
  // teardown is safe and covers both the pre-connected window (stop could
  // not disconnect an in-flight backend) and the post-connected window
  // (stop did disconnect; redo to be defensive).
  const bailIfStopRequested = async () => {
    if (!_ownedRuntimeStopRequested) return false;
    try { await backend.disconnect(); } catch {}
    try { stopOwnerHeartbeat(); } catch {}
    try { releaseOwnedChannelLocks(INSTANCE_ID); } catch {}
    try { clearActiveInstance(INSTANCE_ID); } catch {}
    bridgeRuntimeConnected = false;
    _ownedRuntimeStopRequested = false;
    return true;
  };
  // Await backend.connect() so callers (and bindingReady) only resolve after
  // the Discord binding is real. Previously this was fire-and-forget and
  // refreshBridgeOwnership returned immediately, letting bindingReady fire
  // before backend listeners were attached.
  try {
    await backend.connect();
    if (await bailIfStopRequested()) return;
    bridgeRuntimeConnected = true;
    refreshActiveInstance(INSTANCE_ID, { backendReady: true });
    // initProviders must complete before scheduler.start() — otherwise the
    // scheduler's first fire can land before the registry is populated and
    // return `Provider "<name>" not found or not enabled`. The previous
    // fire-and-forget call let scheduler.start() race ahead of init.
    try {
      const agentCfg = loadAgentConfig();
      await initProviders(agentCfg.providers || {});
    } catch (e) {
      process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    }
    if (await bailIfStopRequested()) return;
    scheduler.start();
    startSnapshotWriter(scheduler);
    syncOwnedWebhookAndEventRuntime();
    if (options.restoreBinding !== false) bindPersistedTranscriptIfAny().catch((e) => {
      process.stderr.write(`mixdog: bindPersistedTranscriptIfAny failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    });
    process.stderr.write(`mixdog: running with ${backend.name} backend\n`);
    logOwnership(`active owner lead=${TERMINAL_LEAD_PID} pid=${process.pid}`);
  } catch (e) {
    process.stderr.write(`mixdog: backend connect failed (non-fatal, cycle1/MCP still up): ${e instanceof Error ? e.message : String(e)}\n`);
    // Roll back partial owner-side state advertised before connect() ran:
    // heartbeat and active-instance entry.
    try { stopOwnerHeartbeat(); } catch {}
    try { releaseOwnedChannelLocks(INSTANCE_ID); } catch {}
    try { clearActiveInstance(INSTANCE_ID); } catch {}
  } finally {
    bridgeRuntimeStarting = false;
  }
}
async function stopOwnedRuntime(reason) {
  // startOwnedRuntime() advertises owner HTTP/heartbeat/active-instance and
  // claims channel locks BEFORE awaiting backend.connect(). If shutdown lands
  // during that window (bridgeRuntimeStarting=true, bridgeRuntimeConnected
  // still false) we still need to tear that partial state down — otherwise
  // the port stays bound and active-instance.json stays stale.
  if (!bridgeRuntimeConnected && !bridgeRuntimeStarting) return;
  // If a start is in flight (bridgeRuntimeStarting=true), signal the in-flight
  // startOwnedRuntime() to abort right after its backend.connect() resolves.
  // Without this the in-flight start re-marks connected and re-launches
  // scheduler/webhook/heartbeat after we tear them down here.
  if (bridgeRuntimeStarting) _ownedRuntimeStopRequested = true;
  const wasConnected = bridgeRuntimeConnected;
  stopServerTyping();
  // Release the transcript fs.watch handle plus the forwarder's debounce/retry
  // timers on standby. Without this the watcher keeps firing scheduleWatchFlush
  // and the drain/retry timers stay live after ownership is dropped, leaking a
  // file handle + timers for the rest of the process lifetime.
  try { forwarder.stopWatch(); } catch {}
  stopOwnerHeartbeat();
  scheduler.stop();
  stopSnapshotWriter();
  await stopWebhookAndEventRuntime();
  releaseOwnedChannelLocks(INSTANCE_ID);
  clearActiveInstance(INSTANCE_ID);
  try {
    // Only disconnect the backend when connect() actually completed; calling
    // disconnect() mid-connect races the connect promise.
    if (wasConnected) await backend.disconnect();
  } finally {
    bridgeRuntimeConnected = false;
    logOwnership(`standby: ${reason}`);
  }
}
function refreshBridgeOwnershipSafe(options = {}) {
  refreshBridgeOwnership(options).catch(err => process.stderr.write(`[channels] refreshBridgeOwnership rejected: ${err?.message || err}\n`));
}
function startOwnerHeartbeat() {
  if (ownerHeartbeatTimer) return;
  ownerHeartbeatTimer = setInterval(() => {
    try {
      // Last-wins guard: only refresh the seat if we STILL own it. If a newer
      // remote session claimed active-instance.json since our last tick, do
      // NOT overwrite it back — that would re-steal ownership and cause
      // ping-pong / double backend connections. The bridgeOwnershipTimer's
      // refreshBridgeOwnership() will observe owned=false and disconnect us.
      if (currentOwnerState().owned) refreshActiveInstance(INSTANCE_ID);
    } catch (e) {
      process.stderr.write(`[ownership] heartbeat refresh failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }, OWNER_HEARTBEAT_INTERVAL_MS);
  ownerHeartbeatTimer.unref?.();
}
function stopOwnerHeartbeat() {
  if (!ownerHeartbeatTimer) return;
  clearInterval(ownerHeartbeatTimer);
  ownerHeartbeatTimer = null;
}
async function refreshBridgeOwnership(options = {}) {
  // Coalesce concurrent callers onto the in-flight refresh so backend tool
  // calls landing during normal login wait for the same connect attempt
  // instead of returning early and observing spurious auto-connect failure.
  if (bridgeOwnershipRefreshInFlight) return bridgeOwnershipRefreshInFlight;
  bridgeOwnershipRefreshInFlight = (async () => {
    // Opt-in remote, single-owner, last-wins. Only a remote session with an
    // active bridge participates. If this instance is the active owner (its
    // INSTANCE_ID is the one advertised in active-instance.json) it ensures
    // the owned runtime is up. If a newer remote session has since claimed
    // ownership (last-wins overwrite), this instance is no longer owner and
    // quietly tears its backend down on the next tick. No proxy, no steal.
    if (!channelBridgeActive) {
      if (bridgeRuntimeConnected) await stopOwnedRuntime("bridge inactive");
      return;
    }
    const { active, owned } = currentOwnerState();
    if (owned) {
      refreshActiveInstance(INSTANCE_ID);
      await startOwnedRuntime(options);
      return;
    }
    // Not the owner. Two sub-cases:
    //   (a) A live remote session holds the seat (active-instance names a
    //       different, non-stale instance) → last-wins: we lost, go quiet
    //       (disconnect if we were connected).
    //   (b) There is NO live owner (active is null/stale — e.g. our own entry
    //       was cleared after a backend-connect failure or a bridge
    //       deactivate/reactivate) → this remote session claims the empty seat
    //       and starts the owned runtime. Without this, a remote session could
    //       never (re)acquire ownership once its active entry was cleared.
    if (active && active.instanceId && active.instanceId !== INSTANCE_ID) {
      if (bridgeRuntimeConnected) {
        await stopOwnedRuntime("ownership lost (newer remote session)");
      }
      return;
    }
    // No live owner — claim the empty seat and start.
    claimBridgeOwnership("no active owner");
    if (currentOwnerState().owned) {
      await startOwnedRuntime(options);
    }
  })();
  try {
    return await bridgeOwnershipRefreshInFlight;
  } finally {
    bridgeOwnershipRefreshInFlight = null;
  }
}

async function reloadRuntimeConfig() {
  const previousBackend = backend;
  const previousBackendName = previousBackend?.name || "";
  config = loadConfig();
  scheduler.reloadConfig(
    config.nonInteractive ?? [],
    config.interactive ?? [],
    // channelsConfig: channel-label resolution only.
    config.channelsConfig,
    // 0.1.62: top-level normalized config (quiet/schedules).
    config,
    { restart: bridgeRuntimeConnected }
  );
  const nextBackend = createBackend(config);
  const backendChanged = (nextBackend?.name || "") !== previousBackendName;
  if (backendChanged) {
    const shouldRestart = bridgeRuntimeConnected || bridgeRuntimeStarting;
    if (shouldRestart) await stopOwnedRuntime("backend config changed");
    backend = nextBackend;
    if (shouldRestart) refreshBridgeOwnershipSafe({ restoreBinding: false });
  } else if (nextBackend !== previousBackend) {
    try { await nextBackend.disconnect?.(); } catch {}
  }
  if (bridgeRuntimeConnected) {
    syncOwnedWebhookAndEventRuntime({ reload: true });
  } else {
    await stopWebhookAndEventRuntime();
  }
}
function injectAndRecord(channelId, name, content, options) {
  // Strip soft-warn marker blocks (Tool-loop / Repeated-input / legacy
  // Repeated-tool / Mixed-tool / Tool-budget / Same-file multi-chunk /
  // Bash file-lookup / Iteration / 0-match advisory) from anywhere in the
  // outbound body. Markers are
  // intentionally prepended onto tool RESULTS upstream (tool-loop-guard.mjs
  // build*Warn) so the model
  // self-corrects, but agent roles commonly echo them and we don't want them
  // surfacing in Discord / Lead channel push.
  if (typeof content === 'string') content = stripSoftWarns(content);
  // Skip-protocol guard: agents (webhook-handler / scheduler-task)
  // prefix `[meta:silent]` on the first line to opt out
  // of Lead inject for genuine no-op results (label-only events, dedup,
  // "nothing to report"). The body still goes to Discord for audit; only
  // the Lead-context inject is suppressed. See rules/agent/20-skip-protocol.md.
  if (typeof content === 'string') {
    const m = content.match(/^\s*\[meta:silent\][^\n]*\n?([\s\S]*)$/);
    if (m) {
      content = m[1];
      options = { ...(options || {}), silent_to_agent: true };
    }
  }
  const ts = new Date().toISOString();
  const now = new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = { chat_id: channelId, user: sourceLabel, user_id: "system", ts };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  // `silent_to_agent` — lifecycle status pings (worker/iter/started echoes)
  // surface on Discord but should NOT land in Lead's context window. When
  // set, skip the parent-notify hop but keep the Discord-forward + event-log
  // record. The meta flag is also propagated downstream so consumers that
  // still see the notification (e.g. Lead itself if emission changes later)
  // can recognise and drop it. Default is false → legacy behaviour preserved.
  if (options?.silent_to_agent) meta.silent_to_agent = true;
  const silent = options?.silent_to_agent === true;
  if (!silent) {
    sendNotifyToParent("notifications/claude/channel", { content, meta });
  } else {
    forwardLifecycleToDiscord(channelId, content);
  }
}

// Best-effort direct Discord emission for silent-to-agent lifecycle pings.
// Only used when the parent-notify hop is skipped, so the user still sees
// the status on Discord even though Lead will never echo it through the
// transcript-tail forwarder. Falls back to a no-op when no channel is
// resolvable — lifecycle pings are non-critical.
function forwardLifecycleToDiscord(channelId, content) {
  try {
    // Skip rather than guess: lifecycle callers pass the channelId they own;
    // falling back to statusState.channelId can route to a stale/unrelated
    // channel when the caller did not supply one intentionally.
    const target = channelId || null;
    dropTrace("send.lifecycle.entry", { channelId: target || "(none)", bindingReadyStatus, backendPresent: !!backend?.sendMessage, preview: preview(content) });
    if (!target || !backend?.sendMessage) return;
    void bindingReady.then(() =>
      backend.sendMessage(target, content)
        .then(() => dropTrace("send.lifecycle.ok", { channelId: target }))
        .catch((err) => dropTrace("send.lifecycle.err", { channelId: target, err: String(err) }))
    ).catch(() => {});
  } catch { /* best-effort */ }
}
scheduler.setInjectHandler((channelId, name, content, options) => {
  injectAndRecord(channelId, name, content, options);
});
scheduler.setSendHandler(async (channelId, text) => {
  // Skip protocol: a scheduler-task emitting `[meta:silent]` has nothing to
  // report — suppress the channel send entirely (no noise). Mirrors the
  // webhook delegate drop and injectAndRecord's silent handling.
  if (typeof text === "string" && /^\s*\[meta:silent\]/.test(text)) {
    dropTrace("send.scheduler.silent", { channelId });
    return;
  }
  dropTrace("send.scheduler.entry", { channelId, preview: preview(text) });
  await bindingReady;
  dropTrace("send.scheduler.ready", { channelId });
  try {
    await backend.sendMessage(channelId, text);
    dropTrace("send.scheduler.ok", { channelId });
  } catch (err) {
    dropTrace("send.scheduler.err", { channelId, err: String(err) });
    throw err;
  }
});
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
  webhookServer.setBridgeDispatch(async ({ role, preset, prompt, cwd, context }) => {
    // Delegate-mode webhook → bridge orchestrator. Each bridge progress /
    // final event is forwarded to the Lead via the same channel-notify
    // path used by schedule & event-queue (injectAndRecord). Silent
    // lifecycle pings keep routing only to Discord.
    const agentMod = await import("../agent/index.mjs");
    const channelId = resolveWebhookChannelId(context?.channel);
    const endpoint = context?.endpoint || "unknown";
    const event = context?.event || null;
    const deliveryId = context?.deliveryId || null;
    const label = `webhook:${endpoint}`;
    const instruction = `Webhook review from role=${role} on endpoint "${endpoint}"`
      + (event ? ` (event=${event})` : "")
      + (deliveryId ? ` (delivery=${deliveryId})` : "")
      + ". Relay the finding to the user naturally — summarize clearly, call out any issues, and note what needs a decision.";
    const notifyFn = (text, meta = {}) => {
      if (!text) return;
      // Webhook skip protocol: when the agent worker emits a `[meta:silent]`
      // marker (optionally behind model/role tag prefixes), the event is a
      // no-op (label-only, dedup, "nothing to report"). Drop the message
      // entirely — neither Lead inject nor Discord forward — instead of the
      // partial `silent_to_agent` semantics that still audit to Discord.
      const raw = String(text);
      if (/^\s*(?:\[[^\]\n]+\]\s*)*\[meta:silent\]/.test(raw)) return;
      // Deterministic findings-count drop. Code-review handlers emit a
      // structured `[[findings:N]]` token (N = number of issues). The RELAY —
      // not the worker's prose — decides: N==0 => clean review, drop entirely
      // (no Lead inject, no Discord forward). Token absent => fail-safe forward
      // so a real finding is never silently dropped if the worker omits it.
      const fc = raw.match(/\[\[findings:(\d+)\]\]/i);
      if (fc && Number(fc[1]) === 0) return;
      // Lifecycle pings (started / iter echoes, marked silent_to_agent) are
      // channel noise for an automated webhook review — drop them entirely so
      // a skip stays fully silent and only the final answer reaches the
      // channel. The final [meta:silent] skip result is already dropped above.
      if (meta?.silent_to_agent === true) return;
      // Strip the verdict token before surfacing (findings present, N>0).
      const surfaced = raw.replace(/\[\[findings:\d+\]\]/gi, "").replace(/[^\S\n]{2,}/g, " ").trim();
      injectAndRecord(channelId, label, surfaced || raw, {
        type: "webhook",
        instruction,
      });
    };
    // Per-terminal cwd under the daemon's single channels worker. A webhook
    // result is injected to ownerConn() — the connection whose session.leadPid
    // equals active-instance ownerLeadPid — so the worker must run in THAT
    // owner terminal's cwd. Read the sentinel keyed by ownerLeadPid; cwd-tool
    // writes session-cwd-<leadPid>.txt per connection, so write and read meet
    // on the same leadPid key no matter which terminal holds the owner seat.
    // Falls back to the session entry position; never the plugin CACHE root.
    const ownerPid = getActiveOwnerPid(readActiveInstance());
    const ownerCwd = (ownerPid && readLastSessionCwd(ownerPid)) || captureOriginalUserCwd();
    return agentMod.handleToolCall(
      "bridge",
      { role, preset, prompt, cwd: cwd || ownerCwd },
      { notifyFn },
    );
  });
}
function resolveWebhookChannelId(channelLabel) {
  // Fail closed: route only to channels explicitly present in config —
  // the endpoint's owner-configured `channel`, else the `main` channel.
  // Runtime / persisted-status fallbacks are never used (they could route
  // a delivery to an arbitrary or stale channel). The endpoint channel is
  // owner-authored config, not attacker payload, so honoring it is safe.
  const channels = config?.channelsConfig || {};
  if (channelLabel && channels[channelLabel]?.channelId) return channels[channelLabel].channelId;
  return channels.main?.channelId || "";
}
function wireEventQueueHandlers(eventQueue) {
  if (!eventQueue) return;
  eventQueue.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
  // Defensive ownership probe: the queue tick should only run in the active
  // owner process. Non-owner instances see bridgeRuntimeConnected=false and
  // will skip the tick even if an errant start() slipped through.
  eventQueue.setOwnerGetter(() => bridgeRuntimeConnected);
  forwarder.setOwnerGetter(() => bridgeRuntimeConnected);
}
function editDiscordMessage(channelId, messageId, label) {
  // Behavior-preserving: route through the backend abstraction (which uses
  // discord.js under the hood) instead of issuing a raw REST PATCH. Errors
  // are swallowed to stderr to match the prior fire-and-forget shape — the
  // call site never awaited the HTTPS request either.
  if (!getDiscordToken()) return;
  const text = `\u{1F510} **Permission Request** \u2014 ${label}`;
  void backend.editMessage(channelId, messageId, text, { components: [] }).catch((err) => {
    process.stderr.write(`mixdog: editDiscordMessage failed: ${err}
`);
  });
}
backend.onModalRequest = async (rawInteraction) => {
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import("discord.js");
  const customId = rawInteraction.customId;
  const channelId = rawInteraction.channelId ?? "";
  pendingSetup.rememberMessage(rawInteraction.user.id, channelId, rawInteraction.message?.id);
  const modalSpec = buildModalRequestSpec(
    customId,
    pendingSetup.get(rawInteraction.user.id, channelId),
    loadProfileConfig()
  );
  if (!modalSpec) return;
  const modal = new ModalBuilder().setCustomId(modalSpec.customId).setTitle(modalSpec.title);
  const rows = modalSpec.fields.map(
    (field) => new ActionRowBuilder().addComponents((() => {
      const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(TextInputStyle.Short).setRequired(field.required);
      if (field.value) input.setValue(field.value);
      return input;
    })())
  );
  modal.addComponents(...rows);
  await rawInteraction.showModal(modal);
};
const pendingPermRequests = new Map();
const TOOL_EXEC_CONSUMER_MARKER = path.join(RUNTIME_ROOT, '.tool-exec-consumer');
function refreshToolExecConsumerMarker() {
  try {
    if (pendingPermRequests.size > 0) {
      fs.writeFileSync(TOOL_EXEC_CONSUMER_MARKER, String(Date.now()));
    } else {
      try { fs.unlinkSync(TOOL_EXEC_CONSUMER_MARKER); } catch {}
    }
  } catch {}
}
// Watch for terminal-approved tool executions. The PostToolUse hook writes a
// signal file per tool call; when we see one, find the oldest pending perm
// request with a matching tool name and mark its Discord message as
// "Allowed (terminal)" so users don't see stale active buttons.
try {
  try { if (!fs.existsSync(RUNTIME_ROOT)) fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
  const SIGNAL_RE = /^tool-exec-\d+-[0-9a-f]+\.signal$/;
  fs.watch(RUNTIME_ROOT, { persistent: false }, (eventType, filename) => {
    if (!filename || !SIGNAL_RE.test(filename)) return;
    setTimeout(() => {
      try {
        const signalPath = path.join(RUNTIME_ROOT, filename);
        let raw;
        try { raw = fs.readFileSync(signalPath, 'utf8'); } catch { return; }
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        const toolName = payload?.toolName;
        if (!toolName) return;
        const sigFilePath = payload?.filePath || '';
        let oldestKey = null;
        let oldestEntry = null;
        for (const [k, v] of pendingPermRequests) {
          if (v.toolName !== toolName) continue;
          // Bind on filePath too. If both sides are empty (non-file tools
          // like Bash), toolName alone is the match. Otherwise both must
          // equal — prevents two concurrent Edit/Write requests from
          // cross-approving each other.
          const vFilePath = v.filePath || '';
          if (vFilePath || sigFilePath) {
            if (vFilePath !== sigFilePath) continue;
          }
          if (!oldestEntry || v.createdAt < oldestEntry.createdAt) {
            oldestKey = k;
            oldestEntry = v;
          }
        }
        // No matching pending request — leave the signal on disk so a
        // agent role hook (or other consumer) gets a chance to claim it.
        if (!oldestKey || !oldestEntry) return;
        if (oldestEntry.channelId && oldestEntry.messageId) {
          try {
            editDiscordMessage(oldestEntry.channelId, oldestEntry.messageId, 'Allowed (terminal)');
          } catch (err) {
            try { process.stderr.write(`mixdog channels: tool-exec signal edit failed: ${err && err.message || err}\n`); } catch {}
          }
        }
        pendingPermRequests.delete(oldestKey);
        refreshToolExecConsumerMarker();
        // Only unlink once we've confirmed the match and handled it.
        try { fs.unlinkSync(signalPath); } catch {}
      } catch (err) {
        try { process.stderr.write(`mixdog channels: tool-exec signal handler error: ${err && err.message || err}\n`); } catch {}
      }
    }, 50);
  });
  // Stale-signal sweeper: any signal file older than 60s is removed so
  // unclaimed files don't accumulate on disk. Runs every 30s.
  setInterval(() => {
    try {
      const now = Date.now();
      const entries = fs.readdirSync(RUNTIME_ROOT);
      for (const name of entries) {
        if (!SIGNAL_RE.test(name)) continue;
        const p = path.join(RUNTIME_ROOT, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > 60_000) {
            try { fs.unlinkSync(p); } catch {}
          }
        } catch {}
      }
    } catch {}
  }, 30_000)?.unref?.();
} catch (err) {
  try { process.stderr.write(`mixdog channels: tool-exec signal watcher setup failed: ${err && err.message || err}\n`); } catch {}
}

backend.onInteraction = (interaction) => {
  // Channel-route permission reply. Custom_id format: perm-ch-{request_id}-{allow|session|deny}.
  // request_id is the 5-letter short ID CC generates via shortRequestId().
  // Emit notifications/claude/channel/permission back to the MCP host; the race
  // logic in interactiveHandler.ts resolves the pending request and dismisses
  // every other racer (local dialog, bridge, hook, classifier).
  if (interaction.customId?.startsWith("perm-ch-")) {
    const match = interaction.customId.match(/^perm-ch-([a-km-z]{5})-(allow|session|deny)$/);
    if (!match) return;
    const [, requestId, action] = match;
    const access = config.access;
    if (access?.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm-ch button rejected — user ${interaction.userId} not in allowFrom\n`);
      return;
    }
    const pending = pendingPermRequests.get(requestId);
    pendingPermRequests.delete(requestId);
    refreshToolExecConsumerMarker();
    const params = { request_id: requestId };
    if (action === 'deny') {
      params.behavior = 'deny';
    } else if (action === 'session') {
      params.behavior = 'allow';
      const toolName = pending?.toolName;
      if (toolName) {
        params.updatedPermissions = [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      }
    } else {
      params.behavior = 'allow';
    }
    sendNotifyToParent('notifications/claude/channel/permission', params);
    const labels = { allow: 'Approved', session: 'Session Approved', deny: 'Denied' };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (interaction.customId?.startsWith("perm-")) {
    const match = interaction.customId.match(/^perm-([0-9a-f]{32})-(allow|session|deny)$/);
    if (!match) return;
    const [, uuid, action] = match;
    const access = config.access;
    if (!access) {
      const _permDropLine = `[${localTimestamp()}] perm interaction dropped: no access config\n`;
      if (isMixdogDebug()) {
        fs.appendFileSync(_bootLog, _permDropLine);
      } else {
        appendSessionStartCriticalLog(DATA_DIR, `[channels] ${_permDropLine}`);
      }
      return;
    }
    if (access.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm button rejected \u2014 user ${interaction.userId} not in allowFrom
`);
      return;
    }
    const resultPaths = [getPermissionResultPath(INSTANCE_ID, uuid)];
    const leadInstanceId = String(TERMINAL_LEAD_PID);
    if (leadInstanceId && leadInstanceId !== INSTANCE_ID) {
      resultPaths.push(getPermissionResultPath(leadInstanceId, uuid));
    }
    for (const resultPath of resultPaths) {
      try {
        fs.writeFileSync(resultPath, action, { flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") {
          process.stderr.write(`mixdog: writePermissionResult failed: ${e.message}\n`);
        }
      }
    }
    const labels = { allow: "Approved", session: "Session Approved", deny: "Denied" };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  scheduler.noteActivity();
  if (interaction.customId === "stop_task") {
    controlClaudeSession(INSTANCE_ID, { type: "interrupt" })
      .catch(err => process.stderr.write(`[channels] controlClaudeSession rejected: ${err?.message || err}\n`));
    writeTextFile(TURN_END_FILE, String(Date.now()));
    return;
  }
  sendNotifyToParent("notifications/claude/channel", {
    content: `[interaction] ${interaction.type}: ${interaction.customId}${interaction.values ? " values=" + interaction.values.join(",") : ""}`,
    meta: {
      chat_id: interaction.channelId,
      user: `interaction:${interaction.type}`,
      user_id: interaction.userId,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      interaction_type: interaction.type,
      custom_id: interaction.customId,
      ...interaction.values ? { values: interaction.values.join(",") } : {},
      ...interaction.message ? { message_id: interaction.message.id } : {}
    }
  });
};
function isVoiceAttachment(contentType) {
  if (typeof contentType !== 'string') return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith("audio/") || ct.startsWith("application/ogg");
}
function runCmd(cmd, args, capture = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
      windowsHide: true
    });
    let out = "";
    if (capture && proc.stdout) proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}`)));
    proc.on("error", reject);
  });
}
let resolvedWhisperLanguage = null;
function normalizeWhisperLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  if (raw.startsWith("ko")) return "ko";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("de")) return "de";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("it")) return "it";
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("ru")) return "ru";
  return raw;
}
function detectDeviceLanguage() {
  if (resolvedWhisperLanguage) return resolvedWhisperLanguage;
  const candidates = [
    process.env.MIXDOG_CHANNELS_WHISPER_LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhisperLanguage(candidate);
    if (normalized) {
      resolvedWhisperLanguage = normalized;
      return normalized;
    }
  }
  resolvedWhisperLanguage = "auto";
  return resolvedWhisperLanguage;
}
// ── voice.transcription concurrency queue (max=1 by default, config-driven) ──
const _voiceTranscriptionQueue = (() => {
  let running = 0;
  const pending = [];
  function drain() {
    const limit = config.voice?.transcription?.maxConcurrency ?? 1;
    while (running < limit && pending.length > 0) {
      const { fn, resolve, reject } = pending.shift();
      running++;
      fn().then(resolve, reject).finally(() => { running--; drain(); });
    }
  }
  return function enqueue(fn) {
    return new Promise((resolve, reject) => { pending.push({ fn, resolve, reject }); drain(); });
  };
})();

// ── wav + transcript cache keyed by attachment id ──
const _voiceWavCache = new Map();        // attachmentId → wavPath
const _voiceTranscriptCache = new Map(); // attachmentId → transcript string
const _voiceInflight = new Map();        // attachmentId → Promise<string|null>
const _voiceFfmpegInflight = new Map();  // attachmentId|wavPath → Promise<void> single-flight ffmpeg

async function _probeAudioDurationSec(filePath) {
  try {
    const ffprobePath = (() => { try { return _require('ffprobe-static').path; } catch { return 'ffprobe'; } })();
    return await new Promise((resolve, reject) => {
      const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
      let out = '';
      const proc = spawn(ffprobePath, args, { windowsHide: true });
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('close', (code) => { code === 0 ? resolve(parseFloat(out.trim()) || null) : reject(new Error(`ffprobe exit ${code}`)); });
      proc.on('error', reject);
    });
  } catch {
    return null;
  }
}

async function transcribeVoice(audioPath, { attachmentId } = {}) {
  // ── size gate (config: voice.transcription.maxFileSizeMB) ──
  const maxSizeBytes = (config.voice?.transcription?.maxFileSizeMB ?? 0) * 1024 * 1024;
  if (maxSizeBytes > 0) {
    try {
      const stat = await fs.promises.stat(audioPath);
      if (stat.size > maxSizeBytes) {
        process.stderr.write(`mixdog: voice.transcription skipped — file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${config.voice.transcription.maxFileSizeMB} MB): ${audioPath}\n`);
        return null;
      }
    } catch { /* stat failure: proceed */ }
  }
  // ── duration gate (config: voice.transcription.maxDurationSec) ──
  const maxDurationSec = config.voice?.transcription?.maxDurationSec ?? 0;
  if (maxDurationSec > 0) {
    const dur = await _probeAudioDurationSec(audioPath);
    if (dur !== null && dur > maxDurationSec) {
      process.stderr.write(`mixdog: voice.transcription skipped — audio too long (${Math.floor(dur)}s > ${maxDurationSec}s): ${audioPath}\n`);
      return null;
    }
  }
  // ── transcript cache hit ──
  if (attachmentId && _voiceTranscriptCache.has(attachmentId)) {
    process.stderr.write(`mixdog: voice.transcription cache hit (${attachmentId})\n`);
    return _voiceTranscriptCache.get(attachmentId);
  }
  if (attachmentId && _voiceInflight.has(attachmentId)) {
    return _voiceInflight.get(attachmentId);
  }
  const p = _voiceTranscriptionQueue(() => _doTranscribeVoice(audioPath, attachmentId));
  if (attachmentId) {
    _voiceInflight.set(attachmentId, p);
    p.catch((err) => {
      try { process.stderr.write(`mixdog: voice.transcription inflight rejection: ${err?.stack || err}\n`); } catch {}
    }).finally(() => _voiceInflight.delete(attachmentId));
  }
  return p;
}

async function _doTranscribeVoice(audioPath, attachmentId) {
  try {
    const runtime = resolveVoiceRuntime(DATA_DIR);
    if (!runtime?.installed) {
      const missing = [runtime?.binary ? null : 'binary', runtime?.model ? null : 'model', runtime?.ffmpeg ? null : 'ffmpeg'].filter(Boolean).join(' + ');
      throw new Error(`voice runtime not installed (missing: ${missing}) — open the setup wizard and click "Install voice"`);
    }
    const whisperCmd = runtime.whisperCmd;
    const modelPath = runtime.modelPath;
    const ffmpegPath = runtime.ffmpegPath;
    const lang = normalizeWhisperLanguage(config.voice?.language) ?? detectDeviceLanguage();
    const _cpuCount = (() => { try { return os.cpus().length; } catch { return 2; } })();
    const threadCount = config.voice?.transcription?.threadCount ?? Math.max(1, Math.ceil(_cpuCount / 4));
    // ── wav cache keyed by attachment id ──
    let wavPath;
    if (attachmentId && _voiceWavCache.has(attachmentId)) {
      wavPath = _voiceWavCache.get(attachmentId);
      if (!fs.existsSync(wavPath)) {
        _voiceWavCache.delete(attachmentId);
        wavPath = undefined;
      } else {
        process.stderr.write(`mixdog: voice.transcription wav cache hit (${attachmentId})\n`);
      }
    }
    if (!wavPath) {
      wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
      const sampleRate = config.voice?.transcription?.sampleRate ?? 16000;
      const channels = config.voice?.transcription?.channels ?? 1;
      // Single-flight: parallel callers for the same key share one ffmpeg spawn.
      const _ffmpegKey = attachmentId || wavPath;
      if (_voiceFfmpegInflight.has(_ffmpegKey)) {
        await _voiceFfmpegInflight.get(_ffmpegKey);
      } else {
        const _ffmpegPromise = runCmd(ffmpegPath, ["-i", audioPath, "-ar", String(sampleRate), "-ac", String(channels), "-threads", String(threadCount), "-y", wavPath]);
        _voiceFfmpegInflight.set(_ffmpegKey, _ffmpegPromise);
        try {
          await _ffmpegPromise;
          if (attachmentId) _voiceWavCache.set(attachmentId, wavPath);
        } finally {
          _voiceFfmpegInflight.delete(_ffmpegKey);
        }
      }
    }
    process.stderr.write(`mixdog: voice.transcription start runtime=${runtime.kind} cmd=${path.basename(whisperCmd)}\n`);
    await ensureReady({ serverCmd: runtime.serverCmd, modelPath, threadCount, host: '127.0.0.1' });
    const text = await transcribe(wavPath, { language: lang });
    const result = text.trim() || null;
    if (attachmentId && result) _voiceTranscriptCache.set(attachmentId, result);
    return result;
  } catch (err) {
    if (err?.message?.startsWith('voice runtime not installed')) throw err; // propagate setup errors; caller posts user-visible failure
    process.stderr.write(`mixdog: voice.transcription failed: ${err}\n`);
    return null;
  }
}
import { TOOL_DEFS } from './tool-defs.mjs';
function createHttpMcpServer() {
  const s = new Server(
    { name: "mixdog", version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = req.params.arguments ?? {};
    return handleToolCallWithBridgeRetry(toolName, args);
  });
  return s;
}
// Tool dispatch in worker mode goes through the IPC `call` handler at the
// bottom of this file (parent's `callWorker` → `handleToolCall`). The HTTP
// MCP path uses its own short-lived `Server` instance built by
// `createHttpMcpServer()` above. There is no orphan worker-level Server.
const BACKEND_TOOLS = /* @__PURE__ */ new Set(["reply", "fetch", "react", "edit_message", "download_attachment", "trigger_schedule"]);
// ── Backend-tool dispatch helpers ───────────────────────────────────────────
// Each helper dispatches through the local backend (this process is always the
// owner in opt-in remote mode). The MCP-result formatting (text shape, cache
// invalidation, isError flag) is kept here so results stay consistent.
// schedule_status / schedule_control share their result-formatting between
// the local (owner) MCP case handlers and the owner-side HTTP routes that
// serve proxied standby sessions. Keeping the body here makes both paths
// byte-identical and reads the LIVE scheduler.
function scheduleStatusResult() {
  const statuses = scheduler.getStatus();
  if (statuses.length === 0) {
    return { content: [{ type: "text", text: "no schedules configured" }] };
  }
  const lines = statuses.map((s) => {
    const state = s.running ? " [RUNNING]" : "";
    const last = s.lastFired ? ` (last: ${s.lastFired})` : "";
    return `  ${s.name}  ${s.time} ${s.days} (${s.type})${state}${last}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
function scheduleControlResult(args) {
  const scName = args.name;
  const action = args.action;
  // Validate that the named schedule actually exists.
  const _scAll = [...(scheduler.nonInteractive || []), ...(scheduler.interactive || [])];
  const _scKnown = _scAll.some(s => s.name === scName);
  if (!_scKnown) {
    return { content: [{ type: "text", text: `schedule_control: unknown schedule "${scName}" — use schedule_status to list valid names` }], isError: true };
  }
  if (action === "defer") {
    const minutes = args.minutes ?? 30;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      return { content: [{ type: "text", text: `schedule_control: minutes must be a positive number, got ${JSON.stringify(minutes)}` }], isError: true };
    }
    scheduler.defer(scName, minutes);
    return { content: [{ type: "text", text: `deferred "${scName}" for ${minutes} minutes` }] };
  } else if (action === "skip_today") {
    scheduler.skipToday(scName);
    return { content: [{ type: "text", text: `skipped "${scName}" for today` }] };
  }
  return { content: [{ type: "text", text: `unknown action: ${action}` }], isError: true };
}
async function dispatchReply(args) {
  const sendOpts = {
    replyTo: args.reply_to,
    files: args.files ?? [],
    embeds: args.embeds ?? [],
    components: args.components ?? []
  };
  let ids;
  // Pre-send activity bump keeps idle gating consistent during the await.
  scheduler.noteActivity();
  const sendResult = await backend.sendMessage(args.chat_id, args.text, sendOpts);
  scheduler.noteActivity();
  ids = sendResult.sentIds;
  const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`;
  return { content: [{ type: "text", text }] };
}
async function dispatchFetch(args) {
  const channelId = resolveChannelLabel(config.channelsConfig, args.channel);
  const limit = args.limit ?? 20;
  let msgs;
  msgs = await backend.fetchMessages(channelId, limit);
  recordFetchedMessages(channelId, args.channel !== channelId ? args.channel : labelForChannelId(channelId), msgs);
  const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
    const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
    return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
  }).join("\n");
  return { content: [{ type: "text", text }] };
}
async function dispatchReact(args) {
  await backend.react(args.chat_id, args.message_id, args.emoji);
  return { content: [{ type: "text", text: "reacted" }] };
}
async function dispatchEditMessage(args) {
  const opts = { embeds: args.embeds ?? [], components: args.components ?? [] };
  let id;
  id = await backend.editMessage(args.chat_id, args.message_id, args.text, opts);
  return { content: [{ type: "text", text: `edited (id: ${id})` }] };
}
async function dispatchDownloadAttachment(args) {
  let files;
  files = await backend.downloadAttachment(args.chat_id, args.message_id);
  if (files.length === 0) {
    return { content: [{ type: "text", text: "message has no attachments" }] };
  }
  const lines = files.map(
    (f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(f.size / 1024).toFixed(0)}KB)`
  );
  // Each downloaded file lands on the local FS; if any of them
  // had a stale prefetch entry from a prior session, drop it so
  // the next prefetch sees the fresh contents.
  for (const f of files) {
    if (f && typeof f.path === "string" && f.path) {
      invalidatePrefetchCache(f.path);
    }
  }
  return { content: [{ type: "text", text: `downloaded ${files.length} attachment(s):
${lines.join("\n")}` }] };
}
async function handleToolCall(name, args, _signal) {
  if (_channelsDegraded) {
    return { content: [{ type: 'text', text: `[channels degraded] ${name} unavailable — restart MCP to recover` }], isError: true }
  }
  let result;
  try {
    switch (name) {
      case "reply":
        result = await dispatchReply(args);
        break;
      case "fetch":
        result = await dispatchFetch(args);
        break;
      case "react":
        result = await dispatchReact(args);
        break;
      case "edit_message":
        result = await dispatchEditMessage(args);
        break;
      case "download_attachment":
        result = await dispatchDownloadAttachment(args);
        break;
      case "schedule_status": {
          result = scheduleStatusResult();
          break;
        }
      case "trigger_schedule": {
          const triggerResult = await scheduler.triggerManual(args.name);
          result = { content: [{ type: "text", text: triggerResult }] };
          break;
        }
      case "schedule_control": {
          result = scheduleControlResult(args);
          break;
        }
      case "activate_channel_bridge": {
          const active = args.active === true;
          const wasActive = channelBridgeActive;
          channelBridgeActive = active;
          writeBridgeState(active);
          if (active && !wasActive) {
            refreshBridgeOwnershipSafe({ restoreBinding: true });
          }
          if (!active && wasActive) {
            stopServerTyping();
            // Tear down the owner-side runtime so Discord/scheduler/webhook/
            // event-pipeline don't keep running on a deactivated bridge.
            try { await stopOwnedRuntime("bridge deactivated"); } catch (e) {
              process.stderr.write(`mixdog: stopOwnedRuntime on deactivate failed: ${e?.message || e}\n`);
            }
          }
          result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
          break;
        }
      case "reload_config": {
          await reloadRuntimeConfig();
          // Extend reload to the agent module so providers/presets/maintenance
          // hot-reload on the same call (dynamic import: agent/index.mjs does not
          // import channels, so this stays acyclic and tolerant of load order).
          let agentReloadMsg = "";
          if (process.env.MIXDOG_STANDALONE !== '1') {
            try {
              const { reloadAgentConfig } = await import("../agent/index.mjs");
              await reloadAgentConfig("reload_config tool");
              agentReloadMsg = ", agent providers/presets/maintenance";
            } catch (err) {
              process.stderr.write(`[reload_config] agent reload failed: ${err?.message || String(err)}\n`);
            }
          }
          result = { content: [{ type: "text", text: `config reloaded — schedules, webhooks, events${agentReloadMsg} re-registered` }] };
          break;
        }
      case "inject_command": {
          const cmd = String(args?.command || "").trim();
          const ALLOW = new Set(["clear"]);
          if (!ALLOW.has(cmd)) {
            result = { content: [{ type: "text", text: `inject_command: '${cmd}' not in allow-list (${[...ALLOW].join(", ")})` }], isError: true };
            break;
          }
          // Unified managed-launcher control path (cross-platform). The
          // command is delivered to the `mixdog`-launched child's stdin by the
          // launcher that owns it — no OS/terminal keystroke injection, no new
          // window. Only sessions with an engaged native managed-launch bridge
          // are addressable; anything else gets a clear not-managed error
          // rather than a silent no-op.
          try {
            const launchId = managedLaunchId();
            if (!launchId) {
              result = { content: [{ type: "text", text: "inject_command: this session is not a managed `mixdog` launch (MIXDOG_LAUNCH_ID unset). Managed input delivery requires the native mixdog-launch PTY/ConPTY bridge." }], isError: true };
              break;
            }
            enqueueLauncherCommand(launchId, `/${cmd}`);
            result = { content: [{ type: "text", text: `queued /${cmd} for managed launcher (launchId=${launchId})` }] };
          } catch (err) {
            result = { content: [{ type: "text", text: `inject_command error: ${err?.message || err}` }], isError: true };
          }
          break;
        }
      // memory — handled by memory-service.mjs MCP
      default:
          result = {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true
          };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      content: [{ type: "text", text: `${name} failed: ${msg}` }],
      isError: true
    };
  }
  return result;
}
// Bridge auto-connect retry + forwarder-aware tool dispatch wrapper. Used by
// both the HTTP MCP path (createHttpMcpServer's CallTool handler can call this)
// and the worker IPC handler at the bottom of this file. The pre-v0.6.7 code
// registered this on the orphan worker-level `Server`, which never had a
// transport, so the wrapper never actually fired. Centralised here for reuse.
// Last timestamp a forwardNewText() call was dispatched (debounce for item 4).
let _lastForwardMs = 0;

async function handleToolCallWithBridgeRetry(toolName, args, signal) {
  // Debounce: only forward when ≥250 ms have elapsed since the last forward,
  // to avoid one HTTP roundtrip per tool call on rapid-fire sequences.
  const now = Date.now();
  if (now - _lastForwardMs >= 250) {
    _lastForwardMs = now;
    await forwarder.forwardNewText();
  }
  if (BACKEND_TOOLS.has(toolName) && !bridgeRuntimeConnected) {
    // Remote-owner startup: ensure this owner's backend is connected.
    for (let i = 0; i < 2 && !bridgeRuntimeConnected; i++) {
      try {
        await refreshBridgeOwnership();
      } catch {
      }
      if (!bridgeRuntimeConnected) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bridgeRuntimeConnected) {
      return {
        content: [{ type: "text", text: `Discord auto-connect failed after retries. Check token and network.` }],
        isError: true
      };
    }
  }
  const result = await handleToolCall(toolName, args, signal);
  const toolLine = OutputForwarder.buildToolLine(toolName, args);
  if (toolLine) {
    // Distinct from the dispatch-log ok line (server-main.mjs): this forwards
    // a human-readable tool summary to Discord for the user, not operator stdout.
    void forwarder.forwardToolLog(toolLine, toolName, args);
  }
  return result;
}
const INBOUND_DEDUP_TTL = 5 * 6e4;
const inboundSeen = /* @__PURE__ */ new Map();
const INBOUND_DEDUP_DIR = path.join(os.tmpdir(), "mixdog-inbound");
ensureDir(INBOUND_DEDUP_DIR);
function writeChannelOwner(channelId) {
  const ownerPath = getChannelOwnerPath(channelId);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ instanceId: INSTANCE_ID, pid: process.pid, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
function shouldDropDuplicateInbound(msg) {
  const key = `${msg.chatId}:${msg.messageId}`;
  const now = Date.now();
  if (inboundSeen.has(key) && now - inboundSeen.get(key) < INBOUND_DEDUP_TTL) return true;
  inboundSeen.set(key, now);
  const marker = path.join(INBOUND_DEDUP_DIR, key.replace(/:/g, "_"));
  try {
    fs.writeFileSync(marker, String(now), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        const stat = fs.statSync(marker);
        if (now - stat.mtimeMs < INBOUND_DEDUP_TTL) return true;
      } catch {}
    }
  }
  if (Math.random() < 0.1) {
    try {
      for (const f of fs.readdirSync(INBOUND_DEDUP_DIR)) {
        const fp = path.join(INBOUND_DEDUP_DIR, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > INBOUND_DEDUP_TTL) removeFileIfExists(fp);
        } catch {
        }
      }
    } catch {
    }
  }
  for (const [k, t] of inboundSeen) {
    if (now - t > INBOUND_DEDUP_TTL) inboundSeen.delete(k);
  }
  return false;
}
function resolveInboundRoute(chatId, parentChatId) {
  const main = config.channelsConfig?.main;
  const findEntry = (id) => {
    if (!id || !config.channelsConfig) return null;
    if (typeof main === "object" && main !== null && main.channelId === id) {
      return { label: "main", entry: main };
    }
    for (const [label, entry] of Object.entries(config.channelsConfig)) {
      if (typeof entry === "object" && entry !== null && entry.channelId === id) {
        return { label, entry };
      }
    }
    return null;
  };
  // Prefer a direct channelsConfig match on the thread/channel id; fall back
  // to the parent channel id so thread messages inherit the parent's label
  // and mode (e.g. monitor) instead of being routed as untagged interactive.
  const direct = findEntry(chatId);
  if (direct) {
    const mode = direct.entry.mode === "monitor" ? "monitor" : (direct.entry.mode || "interactive");
    return { targetChatId: chatId, sourceChatId: chatId, sourceLabel: direct.label, sourceMode: mode };
  }
  if (parentChatId) {
    const viaParent = findEntry(parentChatId);
    if (viaParent) {
      const mode = viaParent.entry.mode === "monitor" ? "monitor" : (viaParent.entry.mode || "interactive");
      return { targetChatId: chatId, sourceChatId: parentChatId, sourceLabel: viaParent.label, sourceMode: mode };
    }
  }
  return { targetChatId: chatId, sourceChatId: chatId, sourceLabel: undefined, sourceMode: "interactive" };
}
const inboundQueue = (() => {
  let tail = Promise.resolve();
  let _iqDepth = 0;
  const _IQ_MAX_DEPTH = 1000;
  return (fn) => {
    if (_iqDepth >= _IQ_MAX_DEPTH) {
      try { process.stderr.write(`mixdog: inboundQueue overflow (depth=${_iqDepth}), dropping message\n`); } catch {}
      return;
    }
    _iqDepth++;
    tail = Promise.resolve(tail).then(fn).catch((err) => {
      try { process.stderr.write(`mixdog: inboundQueue error: ${err && err.message || err}\n`); } catch {}
    }).finally(() => { _iqDepth--; });
  };
})();
// ── Reverse-lookup channelId → human label from channelsConfig ──────────────
function labelForChannelId(channelId) {
  if (!channelId || !config.channelsConfig) return channelId;
  for (const [label, entry] of Object.entries(config.channelsConfig)) {
    if (entry?.channelId === channelId) return label;
  }
  return channelId;
}

backend.onMessage = (msg) => {
  const receivedAtMs = Number.isFinite(msg.receivedAtMs) ? msg.receivedAtMs : Date.now();
  const onMessageAtMs = Date.now();
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  if (!channelBridgeActive) return;
  if (shouldDropDuplicateInbound(msg)) return;
  recordFetchedMessages(msg.chatId, labelForChannelId(msg.chatId), [{ id: msg.messageId }], { markRead: true });
  if (!writeChannelOwner(msg.chatId)) return;
  const route = resolveInboundRoute(msg.chatId, msg.parentChatId);
  scheduler.noteActivity();
  startServerTyping(route.targetChatId);
  backend.resetSendCount();
  // Pin the prior turn's bound channel before this fire-and-forget flush so the
  // imminent rebind below (which mutates forwarder.channelId synchronously)
  // cannot redirect the previous turn's final output to the new channel.
  const priorForwardChannelId = forwarder.channelId || null;
  void forwarder.forwardFinalText(0, priorForwardChannelId).catch((err) => {
    try { process.stderr.write(`mixdog: forwardFinalText rejection: ${err?.stack || err}\n`); } catch {}
  }).finally(() => forwarder.reset());
  const previousPath = getPersistedTranscriptPath();
  let boundTranscript = null;
  let transcriptPath = forwarder.hasBinding() ? forwarder.transcriptPath : "";
  if (transcriptPath) {
    boundTranscript = {
      sessionId: sessionIdFromTranscriptPath(transcriptPath),
      sessionCwd: statusState.read().sessionCwd ?? null,
      transcriptPath,
      exists: true
    };
  } else {
    boundTranscript = discoverSessionBoundTranscript();
    transcriptPath = pickUsableTranscriptPath(boundTranscript, previousPath);
    // Only fall back to latest-by-mtime when discovery did NOT produce a
    // confident, existing current-session transcript. detectCurrentSessionTranscript()
    // already weighs mtime (with a 30s decisive threshold) against active-pid /
    // cwd affinity, so overriding a real detected binding with the raw newest
    // file would clobber the current session with an unrelated, more-recently
    // touched transcript (wrong-session forward).
    if (!boundTranscript?.exists) {
      const latestByMtime = findLatestTranscriptByMtime(boundTranscript?.sessionCwd);
      if (latestByMtime && latestByMtime !== transcriptPath) {
        transcriptPath = latestByMtime;
      }
    }
  }
  if (transcriptPath) {
    applyTranscriptBinding(route.targetChatId, transcriptPath, { cwd: boundTranscript?.sessionCwd });
  } else {
    refreshActiveInstance(INSTANCE_ID, { channelId: route.targetChatId });
  }
  void (async () => {
    try {
      await backend.react(msg.chatId, msg.messageId, "\u{1F914}");
    } catch {
    }
    statusState.update((state) => {
      state.channelId = route.targetChatId;
      state.userMessageId = msg.messageId;
      state.emoji = "\u{1F914}";
      state.sentCount = 0;
      state.sessionIdle = false;
      if (transcriptPath) state.transcriptPath = transcriptPath;
      else delete state.transcriptPath;
      state.sessionCwd = boundTranscript?.sessionCwd ?? null;
    });
    if (!boundTranscript?.exists) {
      await rebindTranscriptContext(route.targetChatId, {
        previousPath: transcriptPath,
        catchUp: true,
        persistStatus: true
      });
    }
  })();
  const queuedAtMs = Date.now();
  const preQueueMs = queuedAtMs - onMessageAtMs;
  const gatewayToQueueMs = queuedAtMs - receivedAtMs;
  if (preQueueMs > 250 || gatewayToQueueMs > 500) {
    process.stderr.write(`mixdog: inbound latency prequeue=${preQueueMs}ms gateway_to_queue=${gatewayToQueueMs}ms channel=${route.targetChatId}\n`);
  }
  inboundQueue(() => handleInbound(msg, route, {
    sessionId: boundTranscript?.sessionId ?? sessionIdFromTranscriptPath(transcriptPath),
    receivedAtMs,
    queuedAtMs
  }).catch((err) => {
    process.stderr.write(`mixdog: handleInbound error: ${err}
`);
  }).finally(() => {
    stopServerTyping();
  }));
};
async function handleInbound(msg, route, options = {}) {
  const handleStartMs = Date.now();
  let text = msg.text;
  const voiceAtts = msg.attachments.filter((a) => isVoiceAttachment(a.contentType));
  if (voiceAtts.length > 0) {
    try {
      const files = await backend.downloadAttachment(msg.chatId, msg.messageId);
      // concurrency handled inside transcribeVoice queue; loop is sequential so last att wins
      for (const f of voiceAtts.map(a => files.find(df => df.id === a.id) ?? null).filter(Boolean)) {
        const _t0 = Date.now();
        const transcript = await transcribeVoice(f.path, { attachmentId: f.id });
        const _elapsed = Date.now() - _t0;
        if (transcript) {
          text = transcript;
          process.stderr.write(`mixdog: voice.transcription ok (${f.name}, ${_elapsed}ms): ${transcript.slice(0, 50)}\n`);
        } else {
          process.stderr.write(`mixdog: voice.transcription empty (${f.name})\n`);
          text = text || "[voice message \u2014 transcription failed]";
        }
      }
    } catch (err) {
      process.stderr.write(`mixdog: voice.transcription error: ${err}\n`);
      text = text || `[voice message \u2014 transcription error: ${err?.message || err}]`;
    }
  }
  const hasVoiceAtt = voiceAtts.length > 0;
  const attMeta = msg.attachments.length > 0 && !hasVoiceAtt ? {
    attachment_count: String(msg.attachments.length),
    attachments: msg.attachments.map((a) => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join("; ")
  } : {};
  const messageBody = route.sourceMode === "monitor" && route.sourceLabel ? `[monitor:${route.sourceLabel}] ${text}` : text;
  const now = (/* @__PURE__ */ new Date()).toLocaleString();
  const notificationMeta = {
    chat_id: route.targetChatId,
    message_id: msg.messageId,
    user: msg.user,
    user_id: msg.userId,
    ts: msg.ts,
    ...route.sourceMode === "monitor" ? {
      source_chat_id: route.sourceChatId,
      source_mode: route.sourceMode,
      ...route.sourceLabel ? { source_label: route.sourceLabel } : {}
    } : {},
    ...attMeta,
    ...msg.imagePath ? { image_path: msg.imagePath } : {}
  };
  const notificationContent = `[${now}]
${messageBody}`;
  sendNotifyToParent("notifications/claude/channel", {
    content: notificationContent,
    meta: notificationMeta
  });
  const notifiedAtMs = Date.now();
  const receivedAtMs = Number.isFinite(options.receivedAtMs) ? options.receivedAtMs : handleStartMs;
  const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : handleStartMs;
  const queueMs = handleStartMs - queuedAtMs;
  const handleMs = notifiedAtMs - handleStartMs;
  const totalMs = notifiedAtMs - receivedAtMs;
  if (queueMs > 250 || handleMs > 250 || totalMs > 500) {
    process.stderr.write(`mixdog: inbound latency delivered total=${totalMs}ms queue=${queueMs}ms handle=${handleMs}ms channel=${route.targetChatId} attachments=${msg.attachments.length}\n`);
  }
  void memoryAppendEntry({
    ts: msg.ts,
    role: "user",
    content: messageBody,
    sourceRef: `discord:${route.targetChatId}#${msg.messageId}`,
    sessionId: `discord:${route.targetChatId}`,
    cwd: statusState.read().sessionCwd,
  });
}
async function init(_sharedMcp) {
  // _sharedMcp is no longer used. Notifications now flow via IPC to the parent
  // (sendNotifyToParent above). The parameter is retained for backward
  // compatibility with any caller that still passes a Server reference.
  scheduler.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
}
async function start() {
  channelBridgeActive = true;
  writeBridgeState(true);
  // Opt-in remote, single-owner, last-wins. Claim the seat immediately so a
  // later `mixdog --remote` session overwrites us and we drop on our next
  // refresh tick. Then connect the owned runtime and arm the ownership timer
  // that keeps checking whether a newer session has taken over.
  claimBridgeOwnership("remote start");
  const _bindingReadyStart = Date.now();
  try {
    await refreshBridgeOwnership({ restoreBinding: true });
    bindingReadyStatus = "resolved";
    dropTrace("bindingReady.resolve", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus });
    _bindingReadyResolve(true);
  } catch (e) {
    bindingReadyStatus = "rejected";
    dropTrace("bindingReady.reject", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus, err: String(e) });
    _bindingReadyResolve(e);
  }
  // Ownership timer: keep checking whether a newer remote session has taken
  // over (last-wins) so a superseded owner disconnects promptly.
  if (!bridgeOwnershipTimer) {
    bridgeOwnershipTimer = setInterval(() => {
      refreshBridgeOwnershipSafe();
    }, 3e3);
    bridgeOwnershipTimer.unref?.();
  }
  // Hot-reload config on file change (schedules/webhooks/events).
  if (!_configWatcher) {
    try {
      _configWatcher = fs.watch(path.join(DATA_DIR, "mixdog-config.json"), () => {
        if (_reloadDebounce) clearTimeout(_reloadDebounce);
        _reloadDebounce = setTimeout(() => { reloadRuntimeConfig().catch(() => {}); }, 500);
      });
    } catch {}
  }
  // Pre-warm the whisper-server manager once at owner startup so the first
  // voice transcription does not pay cold-start cost. Non-blocking: failures
  // (e.g. runtime not installed) are swallowed; per-request ensureReady retries.
  void (async () => {
    try {
      const runtime = resolveVoiceRuntime(DATA_DIR);
      if (!runtime?.installed) return;
      const _cpuCount = (() => { try { return os.cpus().length; } catch { return 2; } })();
      const threadCount = config.voice?.transcription?.threadCount ?? Math.max(1, Math.ceil(_cpuCount / 4));
      await ensureReady({ serverCmd: runtime.serverCmd, modelPath: runtime.modelPath, threadCount, host: '127.0.0.1' });
    } catch (err) {
      try { process.stderr.write(`mixdog: voice.transcription pre-warm skipped: ${err}\n`); } catch {}
    }
  })();
}
async function stop() {
  try { await stopVoiceWhisperServer(); } catch {}
  await stopOwnedRuntime("unified server stop");
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
  if (bridgeOwnershipTimer) {
    clearInterval(bridgeOwnershipTimer);
    bridgeOwnershipTimer = null;
  }
  if (_reloadDebounce) { clearTimeout(_reloadDebounce); _reloadDebounce = null; }
  if (_configWatcher) { try { _configWatcher.close(); } catch {} _configWatcher = null; }
  if (turnEndWatcher) {
    try { turnEndWatcher.close(); } catch {}
    turnEndWatcher = null;
  }
}
// ── IPC worker mode ──────────────────────────────────────────────
if (_isWorkerMode && process.send) {
  // SIGTERM/SIGINT/IPC shutdown handler — mirrors src/memory/index.mjs pattern.
  // Cleans up in-progress webhook/scheduler state, removes runtime files, then exits.
  let _channelsStopInFlight = false
  let _channelsForceExitTimer = null
  const _channelsShutdownHandler = async (sig) => {
    if (_channelsStopInFlight) {
      process.stderr.write(`[channels-worker] ${sig} — shutdown already in flight, ignoring\n`)
      return
    }
    _channelsStopInFlight = true
    process.stderr.write(`[channels-worker] received ${sig} — shutting down cleanly\n`)
    _channelsForceExitTimer = setTimeout(() => {
      process.stderr.write(`[channels-worker] stop() timed out after 6000ms — forcing exit(2)\n`)
      process.exit(2)
    }, 6000)
    try { await stopVoiceWhisperServer() } catch (e) {
      process.stderr.write(`[channels-worker] stopVoiceWhisperServer() error on ${sig}: ${e && (e.message || e)}\n`)
    }
    try { await stop() } catch (e) {
      process.stderr.write(`[channels-worker] stop() error on ${sig}: ${e && (e.message || e)}\n`)
    }
    if (_channelsForceExitTimer) clearTimeout(_channelsForceExitTimer)
    try { cleanupInstanceRuntimeFiles(INSTANCE_ID) } catch {}
    try { clearServerPid() } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', () => _channelsShutdownHandler('SIGTERM'))
  process.on('SIGINT',  () => _channelsShutdownHandler('SIGINT'))

  // Map of callId → AbortController for in-flight IPC calls.
  const _inFlightChannelCalls = new Map()

  process.on('message', async (msg) => {
    // Parent-initiated graceful shutdown — mirrors memory worker IPC pattern.
    if (msg && msg.type === 'shutdown') {
      process.stderr.write('[channels-worker] received IPC shutdown — calling stop()\n')
      _channelsShutdownHandler('IPC:shutdown')
      return
    }
    // Silent-to-agent lifecycle forward — parent (server.mjs) asks the
    // channels worker to post status pings to the active bridge Discord
    // channel without the Lead-notify hop. Best-effort: unknown channel or
    // backend failure is swallowed; lifecycle pings are non-critical.
    if (msg && msg.type === 'forward_to_discord') {
      try {
        const target = msg.channelId
          || (statusState?.read?.().channelId)
          || null;
        if (target && backend?.sendMessage && typeof msg.content === 'string' && msg.content) {
          await backend.sendMessage(target, msg.content).catch(() => {});
        }
      } catch { /* best-effort */ }
      return;
    }
    // Host permission request → Discord Allow/Deny prompt.
    // Parent (server.mjs) receives notifications/claude/channel/permission_request
    // from the MCP host and forwards the params here. We post a buttoned message;
    // button clicks are handled in backend.onInteraction and sent back to CC as
    // notifications/claude/channel/permission via sendNotifyToParent.
    if (msg && msg.type === 'permission_request_inbound') {
      try {
        const { request_id, tool_name, description, input_preview } = msg.params || {};
        // tool_input arrives via the passthrough() schema in server.mjs when
        // The host includes it in the permission_request notification.
        // Used to bind the pendingPermRequest to a specific file so two
        // concurrent Edit/Write requests cannot cross-approve via the
        // terminal signal.
        const toolInputParam = (msg.params && (msg.params.tool_input || msg.params.toolInput)) || {};
        const filePathParam = toolInputParam.file_path || '';
        if (!request_id || !tool_name) return;
        if (pendingPermRequests.size > 100) {
          const cutoff = Date.now() - 30 * 60 * 1000;
          for (const [k, v] of pendingPermRequests) {
            if (v.createdAt < cutoff) pendingPermRequests.delete(k);
          }
          refreshToolExecConsumerMarker();
        }
        const mainLabel = config?.mainChannel || 'main';
        const target = (statusState?.read?.().channelId)
          || resolveChannelLabel(config?.channelsConfig, mainLabel)
          || null;
        if (!target || !backend?.sendMessage) {
          process.stderr.write(`mixdog channels: permission_request dropped, no target channel (request_id=${request_id})\n`);
          return;
        }
        const lines = [`🔐 **Permission Request**`, `Tool: \`${tool_name}\``];
        if (description) lines.push(description);
        if (input_preview) lines.push('```\n' + String(input_preview).slice(0, 800) + '\n```');
        const content = lines.join('\n');
        const components = [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Allow', custom_id: `perm-ch-${request_id}-allow` },
            { type: 2, style: 1, label: 'Session Allow', custom_id: `perm-ch-${request_id}-session` },
            { type: 2, style: 4, label: 'Deny', custom_id: `perm-ch-${request_id}-deny` },
          ],
        }];
        let sentIds = null;
        try {
          const sendResult = await backend.sendMessage(target, content, { components });
          sentIds = sendResult?.sentIds;
        } catch (err) {
          process.stderr.write(`mixdog channels: permission_request Discord send failed: ${err && err.message || err}\n`);
          return;
        }
        const messageId = Array.isArray(sentIds) && sentIds.length > 0 ? sentIds[0] : null;
        pendingPermRequests.set(request_id, {
          toolName: tool_name,
          filePath: filePathParam,
          createdAt: Date.now(),
          channelId: target,
          messageId,
        });
        refreshToolExecConsumerMarker();
      } catch (err) {
        try { process.stderr.write(`mixdog channels: permission_request handler error: ${err && err.message || err}\n`); } catch {}
      }
      return;
    }
    if (msg && msg.type === 'memory_call_response' && msg.callId) {
      // Response side of the worker → parent → memory bridge. Routed into
      // this existing listener (instead of a second process.on('message'))
      // to keep IPC dispatch in one place.
      const pending = _memoryCallPending.get(msg.callId);
      if (!pending) return;
      _memoryCallPending.delete(msg.callId);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || 'memory_call failed'));
      return;
    }
    if (msg.type === 'cancel' && msg.callId) {
      const entry = _inFlightChannelCalls.get(msg.callId)
      if (entry) {
        entry.abort()
        _inFlightChannelCalls.delete(msg.callId)
      }
      process.send({ type: 'result', callId: msg.callId, error: 'cancelled' })
      return
    }
    if (msg.type !== 'call' || !msg.callId) return
    try {
      const ac = new AbortController()
      _inFlightChannelCalls.set(msg.callId, ac)
      let result
      try {
        result = await handleToolCallWithBridgeRetry(msg.name, msg.args || {}, ac.signal)
      } finally {
        _inFlightChannelCalls.delete(msg.callId)
      }
      process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      process.send({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  void (async () => {
    const startedAt = performance.now()
    try {
      await start()
      bootProfile("worker:ready", { ms: (performance.now() - startedAt).toFixed(1) })
      process.send({ type: 'ready' })
    } catch (e) {
      bootProfile("worker:failed", { ms: (performance.now() - startedAt).toFixed(1), error: e?.message || String(e) })
      process.stderr.write(`[channels-worker] start() failed: ${e && (e.message || e)}\n`)
      process.send({ type: 'ready', degraded: true, error: e?.message || String(e) })
    }
  })()
}

export {
  TOOL_DEFS,
  handleToolCall,
  handleToolCallWithBridgeRetry,
  init,
  INSTRUCTIONS as instructions,
  isChannelBridgeActive,
  isChannelsDegraded,
  start,
  stop
};
