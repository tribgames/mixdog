import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync, spawnSync } from "child_process";
import * as crypto from "crypto";
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
const _isCliOwnedMode = process.env.MIXDOG_CLI_OWNED === '1'
const _isChannelDaemonMode = process.env.MIXDOG_CHANNEL_DAEMON === '1'
const CHANNEL_DAEMON_IDLE_TTL_MS = Math.max(0, Number(process.env.MIXDOG_CHANNEL_IDLE_TTL_MS) || 60_000)
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
// 7-day TTL is safe because live bridge sessions touch their JSON file on
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
let _channelNotifyBusSeq = 0;
const CHANNEL_NOTIFY_BUS_FILE = path.join(RUNTIME_ROOT, 'channel-notifications.jsonl');
const CHANNEL_NOTIFY_BUS_MAX_BYTES = 5 * 1024 * 1024;

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

function publishChannelNotify(method, params) {
  try {
    fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
    try {
      const st = fs.statSync(CHANNEL_NOTIFY_BUS_FILE);
      if (st.size > CHANNEL_NOTIFY_BUS_MAX_BYTES) {
        try { fs.unlinkSync(CHANNEL_NOTIFY_BUS_FILE + '.1'); } catch {}
        try { fs.renameSync(CHANNEL_NOTIFY_BUS_FILE, CHANNEL_NOTIFY_BUS_FILE + '.1'); } catch {}
      }
    } catch {}
    const item = {
      id: `${Date.now()}-${process.pid}-${++_channelNotifyBusSeq}`,
      ts: Date.now(),
      pid: process.pid,
      method,
      params,
    };
    fs.appendFileSync(CHANNEL_NOTIFY_BUS_FILE, JSON.stringify(item) + '\n');
  } catch (err) {
    try { process.stderr.write(`mixdog channels: notify bus write failed: ${err && err.message || err}\n`); } catch {}
  }
}

function sendNotifyToParent(method, params) {
  // CC channel schema requires meta: Record<string,string> (channelNotification.ts).
  // Coerce every meta value to string so a non-string (e.g. a Discord
  // interaction.type number) can't fail zod and silently drop the notify.
  // silent_to_agent stays boolean — an internal routing flag the daemon
  // router / agentNotify consume (=== true) before the CC zod boundary.
  const outParams = normalizeChannelNotifyParams(method, params);
  publishChannelNotify(method, outParams);
  if (!process.send) {
    try { process.stderr.write(`mixdog channels: notify queued on bus (no IPC): ${method}\n`); } catch {}
    return;
  }
  try {
    process.send({ type: 'notify', method, params: outParams });
  } catch (err) {
    try { process.stderr.write(`mixdog channels: notify IPC send failed: ${err && err.message || err}\n`); } catch {}
  }
}

const recapState = { state: 'idle', running: false, startedAt: null, lastCompletedAt: null, updatedAt: null, errorMessage: null };
function sendRecapStateToParent() {
  if (!process.send) return;
  try {
    process.send({ type: 'recap_status', recap: { ...recapState } });
  } catch (err) {
    try { process.stderr.write(`mixdog channels: recap status IPC send failed: ${err && err.message || err}\n`); } catch {}
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
// non-owner / proxy process forward transcript output (duplicate Discord
// sends). The closure reads bridgeRuntimeConnected/proxyMode at call time.
forwarder.setOwnerGetter(() => bridgeRuntimeConnected && !proxyMode);
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
let channelDaemonIdleTimer = null;
let channelDaemonLastClientAt = Date.now();
let channelDaemonBackgroundLogAt = 0;
const CHANNEL_CLIENT_DIR = path.join(RUNTIME_ROOT, 'channel-clients');

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function countLiveChannelClients() {
  let live = 0;
  const now = Date.now();
  try {
    fs.mkdirSync(CHANNEL_CLIENT_DIR, { recursive: true });
    for (const file of fs.readdirSync(CHANNEL_CLIENT_DIR)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(CHANNEL_CLIENT_DIR, file);
      let item = null;
      let st = null;
      try {
        st = fs.statSync(full);
        item = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      const pid = Number(item?.pid ?? file.replace(/\.json$/, ''));
      const fresh = now - Math.max(Number(item?.updatedAt) || 0, st.mtimeMs) < 20_000;
      if (pidAlive(pid) && fresh) {
        live += 1;
      } else {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
  return live;
}

function hasChannelBackgroundWork() {
  if (!channelBridgeActive || !bridgeRuntimeConnected) return false;
  if (config.webhook?.enabled === true) return true;
  if (Array.isArray(config.events?.rules) && config.events.rules.length > 0) return true;
  if (Array.isArray(config.nonInteractive) && config.nonInteractive.length > 0) return true;
  if (Array.isArray(config.interactive) && config.interactive.length > 0) return true;
  return false;
}

function checkChannelDaemonIdle() {
  if (!_isChannelDaemonMode || CHANNEL_DAEMON_IDLE_TTL_MS <= 0) return;
  const liveClients = countLiveChannelClients();
  if (liveClients > 0) {
    channelDaemonLastClientAt = Date.now();
    return;
  }
  if (hasChannelBackgroundWork()) {
    const now = Date.now();
    if (now - channelDaemonBackgroundLogAt > 60_000) {
      channelDaemonBackgroundLogAt = now;
      try { process.stderr.write('[channels-worker] daemon idle: keeping alive for configured background work\n'); } catch {}
    }
    channelDaemonLastClientAt = Date.now();
    return;
  }
  if (Date.now() - channelDaemonLastClientAt < CHANNEL_DAEMON_IDLE_TTL_MS) return;
  try { process.stderr.write(`[channels-worker] daemon idle TTL elapsed (${CHANNEL_DAEMON_IDLE_TTL_MS}ms) — shutting down\n`); } catch {}
  stop()
    .then(() => process.exit(0))
    .catch((e) => {
      try { process.stderr.write(`[channels-worker] daemon idle shutdown failed: ${e?.message || e}\n`); } catch {}
      process.exit(1);
    });
}

function startChannelDaemonIdleMonitor() {
  if (!_isChannelDaemonMode || CHANNEL_DAEMON_IDLE_TTL_MS <= 0 || channelDaemonIdleTimer) return;
  channelDaemonLastClientAt = Date.now();
  channelDaemonIdleTimer = setInterval(checkChannelDaemonIdle, 5000);
  channelDaemonIdleTimer.unref?.();
}

function stopChannelDaemonIdleMonitor() {
  if (!channelDaemonIdleTimer) return;
  clearInterval(channelDaemonIdleTimer);
  channelDaemonIdleTimer = null;
}
// Owner gating here is multi-process runtime coordination: only the active
// bindingReady gates all send paths until the boot-time refreshBridgeOwnership
// ({ restoreBinding: true }) call completes. Without this, scheduler/webhook
// emissions fired within the first ~few hundred ms after restart drop because
// the Discord backend binding has not yet been established.
let bindingReadyStatus = "pending";
// Channel-flag detection result, stored at module scope so the worker-mode
// ready IPC can forward it to the daemon for caching across respawns.
let _channelFlagDetected = false;
let _bindingReadyResolve;
const bindingReady = new Promise((r) => { _bindingReadyResolve = r; });
dropTrace("bindingReady.create", { status: bindingReadyStatus });
// owner runs webhook/event ticks. It is not webhook HTTP authentication.
let proxyMode = false;
let ownerHttpPort = 0;
let ownerHttpServer = null;
const PROXY_PORT_MIN = 3460;
const PROXY_PORT_MAX = 3467;
// Per-owner-process auth secret. Generated once at HTTP server start and
// published into runtime/owner-secret-<instanceId>.json with 0o600 perms so
// only the owner UID can read it back. requireOwnerToken below checks THIS
// secret (not the public-by-/ping instanceId) so any local caller that
// scrapes /ping cannot forge owner-side calls. The file is keyed on the
// owner's INSTANCE_ID — the SAME identifier published into active-instance
// as `instanceId` and validated by requireOwnerToken's x-owner-instance
// header check — so proxy readers can resolve the path off readActiveInstance()
// without depending on getActiveOwnerPid(), which prefers ownerLeadPid/
// terminalLeadPid/supervisor_pid and would diverge from process.pid in
// supervisor-backed sessions.
let OWNER_SECRET = "";
function getOwnerSecretPath(instanceId) {
  return path.join(RUNTIME_ROOT, `owner-secret-${String(instanceId)}.json`);
}
function publishOwnerSecret(secret) {
  const file = getOwnerSecretPath(INSTANCE_ID);
  try { ensureDir(RUNTIME_ROOT); } catch {}
  // Best-effort restrictive write: O_CREAT|O_TRUNC|O_WRONLY with mode 0o600.
  // On Windows mode bits are largely ignored, but the file still lives in
  // the per-user tmp dir; an attacker without the same UID cannot read it.
  try { fs.unlinkSync(file); } catch {}
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ instanceId: INSTANCE_ID, pid: process.pid, secret, updatedAt: Date.now() }));
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}
function clearOwnerSecret() {
  try { fs.unlinkSync(getOwnerSecretPath(INSTANCE_ID)); } catch {}
}
function readOwnerSecretFor(ownerInstanceId) {
  if (!ownerInstanceId) return "";
  try {
    const raw = fs.readFileSync(getOwnerSecretPath(ownerInstanceId), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.secret === "string" ? parsed.secret : "";
  } catch {
    return "";
  }
}
async function proxyRequest(endpoint, method, body) {
  return new Promise((resolve) => {
    const url = new URL(`http://127.0.0.1:${ownerHttpPort}${endpoint}`);
    // Auth: read the owner's per-process secret from the restricted
    // owner-secret file (0o600). The instanceId header is kept only as a
    // secondary diagnostic — requireOwnerToken on the owner side checks
    // the secret, not the instanceId.
    const active = readActiveInstance();
    const ownerInstanceId = active?.instanceId || INSTANCE_ID;
    // Key the secret-file lookup on the owner's published instanceId — the
    // SAME identifier the owner used when writing owner-secret-<instanceId>.json
    // (publishOwnerSecret above) and what requireOwnerToken's x-owner-instance
    // header check compares against. Do NOT route this through
    // getActiveOwnerPid(active): that helper prefers ownerLeadPid /
    // terminalLeadPid / supervisor_pid, which in a supervisor-backed session
    // diverge from the owner-HTTP process.pid (== owner's INSTANCE_ID),
    // causing the proxy to read owner-secret-<supervisorPid>.json while the
    // owner wrote owner-secret-<process.pid>.json → empty secret → 401.
    const ownerSecret = readOwnerSecretFor(ownerInstanceId);
    if (!ownerSecret) {
      resolve({ ok: false, error: "owner secret unavailable (file missing or unreadable)" });
      return;
    }
    const reqOpts = {
      hostname: "127.0.0.1",
      port: ownerHttpPort,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "x-owner-token": ownerSecret,
        "x-owner-instance": ownerInstanceId,
      },
      timeout: 3e4
    };
    const req = http.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, data: parsed, error: parsed.error });
        } catch {
          resolve({ ok: false, error: `invalid response from owner: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: `proxy request failed: ${err.message}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "proxy request timed out" });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function pingOwner(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/ping",
      method: "GET",
      timeout: 3e3
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
function tryListenPort(server, port) {
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}
// Owner-token auth gate. Compares x-owner-token against the per-process
// OWNER_SECRET generated at startOwnerHttpServer time. The secret is NOT
// returned by /ping (only the public instanceId is) so a local caller that
// scrapes /ping still cannot forge owner-side calls. Constant-time compare
// to avoid trivial timing leakage on the local socket. Optional secondary
// instanceId check via x-owner-instance: when present it must match this
// process's INSTANCE_ID, catching stale clients targeting an old owner.
function requireOwnerToken(req, res) {
  const token = req.headers["x-owner-token"];
  if (!OWNER_SECRET || typeof token !== "string" || token.length !== OWNER_SECRET.length) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized: x-owner-token required" }));
    return false;
  }
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(OWNER_SECRET));
  } catch {
    ok = false;
  }
  if (!ok) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized: x-owner-token required" }));
    return false;
  }
  const instanceHeader = req.headers["x-owner-instance"];
  if (instanceHeader && instanceHeader !== INSTANCE_ID) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized: instance mismatch" }));
    return false;
  }
  return true;
}
// Per-route handler table. Each handler matches the original switch-case
// behavior byte-for-byte (auth checks, status codes, response shapes); the
// outer dispatch loop just looks up the entry instead of running a long
// switch. `methods` mirrors any pre-existing 405 guard.
const OWNER_ROUTES = {
  "/ping": async (req, res /*, body, url*/) => {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, instanceId: INSTANCE_ID, pid: process.pid }));
  },
  "/send": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    // Pre/post-send activity bumps keep idle gating consistent across
    // slow network / attachment / rate-limited sends; double bump is
    // harmless.
    scheduler.noteActivity();
    const sendResult = await backend.sendMessage(body.chatId, body.text, body.opts);
    scheduler.noteActivity();
    res.writeHead(200);
    res.end(JSON.stringify({ sentIds: sendResult.sentIds }));
  },
  "/react": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    await backend.react(body.chatId, body.messageId, body.emoji);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  },
  "/edit": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    const editId = await backend.editMessage(body.chatId, body.messageId, body.text, body.opts);
    res.writeHead(200);
    res.end(JSON.stringify({ id: editId }));
  },
  "/fetch": async (req, res, body, url) => {
    if (!requireOwnerToken(req, res)) return;
    const channelId = url.searchParams.get("channel") ?? "";
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const msgs = await backend.fetchMessages(channelId, limit);
    recordFetchedMessages(channelId, labelForChannelId(channelId), msgs);
    res.writeHead(200);
    res.end(JSON.stringify({ messages: msgs }));
  },
  "/download": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    const files = await backend.downloadAttachment(body.chatId, body.messageId);
    res.writeHead(200);
    res.end(JSON.stringify({ files }));
  },
  "/typing/start": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    backend.startTyping(body.channelId);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  },
  "/typing/stop": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    backend.stopTyping(body.channelId);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  },
  "/inject": async (req, res, body) => {
    // Require owner-token header to prevent unauthenticated local injection.
    if (!requireOwnerToken(req, res)) return;
    const content = body.content;
    if (!content) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "content required" }));
      return;
    }
    const source = body.source || "mixdog-agent";
    const injMeta = { user: source, user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() };
    if (body.instruction) injMeta.instruction = body.instruction;
    if (body.type) injMeta.type = body.type;
    sendNotifyToParent("notifications/claude/channel", { content, meta: injMeta });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  },
  "/trigger-schedule": async (req, res, body) => {
    // Native fallback for `mcp__trigger_schedule` so out-of-band
    // verification works when the MCP stdio bridge is down (Claude Code
    // disconnected, supervisor restart pending, etc.). Same authz as
    // /inject — x-owner-token must equal INSTANCE_ID.
    if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
    if (!requireOwnerToken(req, res)) return;
    const triggerName = body.name;
    if (!triggerName) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "name required" }));
      return;
    }
    try {
      const r = await scheduler.triggerManual(triggerName);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result: r ?? null }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e?.message || String(e) }));
    }
  },
  "/schedule-status": async (req, res) => {
    // Owner-side schedule_status so standby/proxy sessions read the LIVE
    // scheduler instead of their own stale local state. Mirrors the MCP
    // schedule_status handler's formatting (kept byte-identical via the
    // shared scheduleStatusResult() helper).
    if (!requireOwnerToken(req, res)) return;
    try {
      const r = scheduleStatusResult();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result: r }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e?.message || String(e) }));
    }
  },
  "/schedule-control": async (req, res, body) => {
    // Owner-side schedule_control so standby/proxy sessions mutate the LIVE
    // scheduler (defer/skip_today) instead of their own stale local state.
    // Validation lives here because the proxy side's scheduler.nonInteractive/
    // interactive lists are not authoritative.
    if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
    if (!requireOwnerToken(req, res)) return;
    try {
      const r = scheduleControlResult(body || {});
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result: r }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e?.message || String(e) }));
    }
  },
  "/bridge": async (req, res, body) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
    if (!requireOwnerToken(req, res)) return;
    const bridgeFile = body.file;
    const bridgePrompt = body.prompt;
    const bridgeRef = body.ref;
    const bridgeRole = body.role;
    const bridgeContext = body.context;
    let bridgePromptFinal = bridgePrompt;
    if (!bridgePromptFinal && bridgeFile) {
      try { bridgePromptFinal = fs.readFileSync(bridgeFile, "utf-8").trim(); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: `Cannot read file: ${e.message}` })); return;
      }
    }
    if (!bridgePromptFinal && !bridgeRef) { res.writeHead(400); res.end(JSON.stringify({ error: "prompt, file, or ref required" })); return; }
    try {
      const agentMod = await import(pathToFileURL(path.join(path.dirname(import.meta.url.replace("file:///", "").replace(/\//g, path.sep)), "..", "agent", "index.mjs")).href);
      if (agentMod.init) await agentMod.init();
      const toolArgs = {};
      if (bridgePromptFinal) toolArgs.prompt = bridgePromptFinal;
      if (bridgeRef) toolArgs.ref = bridgeRef;
      if (bridgeRole) toolArgs.role = bridgeRole;
      if (bridgeContext) toolArgs.context = bridgeContext;
      const notifyFn = (text, extraMeta) => {
        sendNotifyToParent("notifications/claude/channel", {
          content: text,
          meta: {
            user: "mixdog-agent",
            user_id: "system",
            ts: new Date().toISOString(),
            ...(extraMeta || {})
          }
        });
      };
      const BRIDGE_HTTP_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
      const bridgeAbort = new AbortController();
      const bridgeTimer = setTimeout(() => bridgeAbort.abort(new Error("bridge HTTP timeout")), BRIDGE_HTTP_TIMEOUT_MS);
      const onReqClose = () => bridgeAbort.abort(new Error("client disconnected"));
      req.on("close", onReqClose);
      let result;
      try {
        result = await Promise.race([
          agentMod.handleToolCall("bridge", toolArgs, { notifyFn, requestSignal: bridgeAbort.signal }),
          new Promise((_, reject) => bridgeAbort.signal.addEventListener("abort", () => reject(bridgeAbort.signal.reason), { once: true })),
        ]);
      } finally {
        clearTimeout(bridgeTimer);
        req.removeListener("close", onReqClose);
      }
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return;
    }
  },
  "/bridge/activate": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    const active = Boolean(body.active);
    const wasActive = channelBridgeActive;
    channelBridgeActive = active;
    writeBridgeState(active);
    if (!active && wasActive) {
      // Mirror the MCP activate_channel_bridge deactivate path: tear down
      // owner-side runtime (Discord/scheduler/webhook/event/owner-HTTP/
      // heartbeat) so a deactivated bridge doesn't keep running and this
      // owner can't later proxyMode against its own port.
      stopServerTyping();
      try { await stopOwnedRuntime("bridge deactivated"); } catch (e) {
        process.stderr.write(`mixdog: stopOwnedRuntime on deactivate failed: ${e?.message || e}\n`);
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, active: channelBridgeActive }));
  },
  "/mcp": async (req, res, body) => {
    if (req.method === "POST") {
      // Require owner-token header to prevent unauthenticated local MCP dispatch.
      if (!requireOwnerToken(req, res)) return;
      const httpMcp = createHttpMcpServer();
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: void 0,
        enableJsonResponse: true
      });
      res.on("close", () => {
        httpTransport.close();
        void httpMcp.close();
      });
      await httpMcp.connect(httpTransport);
      await httpTransport.handleRequest(req, res, body);
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  },
  "/recap/reset": async (req, res /*, body*/) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
    if (!requireOwnerToken(req, res)) return;
    // Called by hooks/session-start.cjs on `/clear` (matcher startup|clear).
    // The session-start hook runs in a separate cjs process with no IPC
    // handle to this forked channels child, so it can't drop recap
    // status directly. Reset to an `empty` baseline so the statusline
    // doesn't carry the prior session's `injected`/`error` recap badge
    // into the cleared session.
    const now = Date.now();
    recapState.state = 'empty';
    recapState.running = false;
    recapState.startedAt = null;
    recapState.lastCompletedAt = now;
    recapState.updatedAt = now;
    recapState.errorMessage = null;
    sendRecapStateToParent();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  },
  "/cycle1": async (req, res, body) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ ok: false, reason: "method-not-allowed", error: "POST required" })); return; }
    if (!requireOwnerToken(req, res)) return;
    const tCycleEntry = Date.now();
    const timeoutMs = Number(body?.timeout_ms) > 0 ? Math.min(60000, Number(body.timeout_ms)) : 15000;
    // IPC timer must outlive the worker-side deadline so a graceful
    // {timedOutWaiting:true} resolve has time to traverse IPC before
    // the channel timer rejects with memory-timeout. Without the
    // buffer, the worker resolves at deadline-0ms and the local
    // setTimeout fires at deadline+0ms in the same tick — race won by
    // whichever scheduler ordering wins, turning intended 200 flags
    // into 503 responses.
    const ipcTimeoutMs = timeoutMs + 2000;
    try {
      // Carry the caller deadline through to the memory worker so a
      // pending cycle1 in-flight is awaited under the same budget.
      // Without this, when the previous cycle1's LLM call lives past
      // 60s, every later SessionStart slot stacks another full 60s
      // wait behind the same zombie promise.
      const result = await callMemoryAction(
        'cycle1',
        { ...(body?.args || {}), _callerDeadlineMs: timeoutMs },
        ipcTimeoutMs,
      );
      // A successful IPC round-trip can still carry a nested MCP error
      // envelope ({ isError: true }) when the memory worker served the
      // call but the action failed — e.g. a promoted fork-proxy whose
      // local `db` is still null. Surfacing that as outer { ok: true }
      // masks the failure and makes session-start log a phantom success.
      // Return a transient 503 so the hook's 503-retry path (which gates
      // only on statusCode===503) re-polls instead of trusting it.
      if (result && typeof result === 'object' && result.isError === true) {
        const nestedText = Array.isArray(result.content)
          ? result.content.map(c => (c && c.text) || '').join(' ').trim()
          : '';
        try { process.stderr.write(`[cycle1-time] route ms=${Date.now() - tCycleEntry} nestedError=1\n`); } catch {}
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, reason: 'memory-not-ready', error: nestedText || 'memory cycle1 returned isError' }));
      } else {
        try { process.stderr.write(`[cycle1-time] route ms=${Date.now() - tCycleEntry}\n`); } catch {}
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      }
    } catch (e) {
      // Classify transient/unavailable failures so the session-start hook
      // (and other 503-retry callers) can distinguish boot-time races from
      // IPC-layer faults and timeouts. All four reasons stay on 503 to
      // preserve the hook retry contract (hooks/session-start.cjs:516
      // gates only on statusCode===503); only the `reason` label changes.
      //
      // Source → reason mapping (upstream messages from server.mjs
      // callWorker at 457-490 and local callMemoryAction at 169-187):
      //   server.mjs:470 "not ready (still booting)"       → memory-not-ready
      //   server.mjs:464/467 "not available (...)"         → worker-unavailable
      //   server.mjs:435 "exited unexpectedly"             → worker-unavailable
      //   local "not a worker process" guard               → worker-unavailable
      //   server.mjs:483 "IPC channel full or closed"      → ipc-error
      //   server.mjs:488 "send failed: ..."                → ipc-error
      //   server.mjs:475 "worker ... call ... timed out"   → memory-timeout
      //   local "memory_call <action> timed out after Nms" → memory-timeout
      const msg = e?.message || String(e);
      let reason;
      if (/worker memory not ready/i.test(msg)) {
        reason = 'memory-not-ready';
      } else if (/worker memory (IPC channel|send failed)/i.test(msg)) {
        reason = 'ipc-error';
      } else if (/timed out/i.test(msg)) {
        reason = 'memory-timeout';
      } else if (msg.includes('restart cap exceeded') || msg.includes('degraded')) {
        // Permanent degraded state: restart cap hit or boot-time init failure.
        // Use a distinct reason so callers can fail-fast without retrying.
        // NOTE: checked before 'not available' — the error message
        // "worker memory not available (restart cap exceeded)" contains both
        // substrings and must land in 'memory-degraded', not 'worker-unavailable'.
        reason = 'memory-degraded';
      } else if (msg.includes('worker memory not available') || msg.includes('worker memory exited unexpectedly') || msg.includes('not a worker process')) {
        reason = 'worker-unavailable';
      }
      const transient = Boolean(reason);
      res.writeHead(transient ? 503 : 500);
      res.end(JSON.stringify({ ok: false, reason, error: msg }));
    }
  },
  "/rebind": async (req, res, body) => {
    if (!requireOwnerToken(req, res)) return;
    const channelId = statusState.read().channelId;
    if (!channelId) {
      res.writeHead(200);
      res.end(JSON.stringify({ rebound: false, reason: "no channelId" }));
      return;
    }
    const previousPath = getPersistedTranscriptPath();
    const explicitTranscriptPath = typeof body?.transcriptPath === "string" ? body.transcriptPath.trim() : "";
    const bound = await rebindTranscriptContext(channelId, {
      previousPath,
      persistStatus: true,
      catchUp: true,
      ...(explicitTranscriptPath ? { transcriptPath: explicitTranscriptPath } : {})
    });
    const reboundChanged = Boolean(bound) && bound !== previousPath;
    res.writeHead(200);
    res.end(JSON.stringify({ rebound: reboundChanged, path: bound || null }));
  },
};
const BACKEND_DEPENDENT_PATHS = new Set([
  "/send",
  "/react",
  "/edit",
  "/fetch",
  "/download",
  "/typing/start",
  "/typing/stop",
  "/mcp"
]);
async function ownerRequestHandler(req, res) {
    res.setHeader("Content-Type", "application/json");
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const rawBody = Buffer.concat(chunks).toString();
        body = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (BACKEND_DEPENDENT_PATHS.has(url.pathname) && !bridgeRuntimeConnected) {
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, reason: "backend-not-ready" }));
        return;
      }
      const handler = OWNER_ROUTES[url.pathname];
      if (handler) {
        await handler(req, res, body, url);
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
    }
}
async function startOwnerHttpServer() {
  if (ownerHttpServer) return ownerHttpServer.address().port;
  // Generate a fresh cryptographic owner-secret BEFORE the listener accepts
  // traffic so requireOwnerToken always has a real secret to compare. Stored
  // in a 0o600 sidecar file (owner-secret-<pid>.json) under RUNTIME_ROOT so
  // only the same UID + same active owner pid can read it back. /ping does
  // NOT return this value — only the public instanceId.
  if (!OWNER_SECRET) {
    OWNER_SECRET = crypto.randomBytes(32).toString("hex");
    try { publishOwnerSecret(OWNER_SECRET); }
    catch (e) {
      process.stderr.write(`mixdog: failed to publish owner secret: ${e?.message || e}\n`);
    }
  }
  const server = http.createServer(ownerRequestHandler);
  for (let port = PROXY_PORT_MIN; port <= PROXY_PORT_MAX; port++) {
    if (await tryListenPort(server, port)) {
      ownerHttpServer = server;
      process.stderr.write(`mixdog: owner HTTP server listening on 127.0.0.1:${port}
`);
      return port;
    }
    server.removeAllListeners("error");
  }
  throw new Error(`no available port in range ${PROXY_PORT_MIN}-${PROXY_PORT_MAX}`);
}
function stopOwnerHttpServer() {
  if (!ownerHttpServer) return;
  ownerHttpServer.close();
  ownerHttpServer = null;
  // Drop the per-process secret + sidecar file. A future startOwnerHttpServer()
  // call regenerates a fresh one, so a stale standby that read the old secret
  // before the restart cannot authenticate against the new owner.
  OWNER_SECRET = "";
  try { clearOwnerSecret(); } catch {}
  globalThis.__mixdogBeaconRealHandler = null;
  globalThis.__mixdogBeacon = null;
}
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
    owned: active?.instanceId === INSTANCE_ID || getActiveOwnerPid(active) === TERMINAL_LEAD_PID
  };
}
function getBridgeOwnershipSnapshot() {
  return currentOwnerState();
}
// MIXDOG_PIN_OWNER=1 in the owning process writes `pinned:true` into
// active-instance.json. Pinned owners ignore the 10 s stale window — they
// only relinquish ownership when their OS process actually dies. Set per
// session (env var on the Claude Code shell) to lock that Lead as the
// schedule/webhook receiver across multi-session use.
function canStealOwnership(active) {
  if (!active) return true;
  if (active.instanceId === INSTANCE_ID || getActiveOwnerPid(active) === TERMINAL_LEAD_PID) return true;
  if (active.pinned) {
    const pinnedPid = getActiveOwnerPid(active);
    if (!pinnedPid) return true;
    try { process.kill(pinnedPid, 0); return false; }
    catch { return true; }
  }
  if (Date.now() - active.updatedAt > ACTIVE_OWNER_STALE_MS) return true;
  const ownerPid = getActiveOwnerPid(active);
  try {
    if (!ownerPid) throw new Error("missing owner pid");
    process.kill(ownerPid, 0);
    return false;
  } catch {
    return true;
  }
}
function claimBridgeOwnership(reason) {
  refreshActiveInstance(INSTANCE_ID);
  logOwnership(`claimed owner (${reason})`);
}
function noteStartupHandoff(previous) {
  if (!previous) return;
  if (previous.instanceId === INSTANCE_ID) return;
  if (getActiveOwnerPid(previous) === TERMINAL_LEAD_PID) return;
  logOwnership(`startup handoff from ${previous.instanceId}`);
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
  // Advertise active-instance.json BEFORE backend connect so peers can
  // discover this owner (httpPort) immediately. backendReady=false marks
  // the partial state until backend.connect() succeeds.
  let httpPort;
  try {
    httpPort = await startOwnerHttpServer();
  } catch (e) {
    process.stderr.write(`mixdog: HTTP server start failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
  }
  refreshActiveInstance(INSTANCE_ID, { ...httpPort ? { httpPort } : {}, backendReady: false });
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
    try { stopOwnerHttpServer(); } catch {}
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
    refreshActiveInstance(INSTANCE_ID, { ...httpPort ? { httpPort } : {}, backendReady: true });
    proxyMode = false;
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
    // HTTP server, heartbeat, and active-instance entry. Without this cleanup
    // stopOwnedRuntime() at shutdown will short-circuit on !bridgeRuntimeConnected
    // and leave the port bound + active-instance.json stale.
    try { stopOwnerHttpServer(); } catch {}
    try { stopOwnerHeartbeat(); } catch {}
    try { releaseOwnedChannelLocks(INSTANCE_ID); } catch {}
    try { clearActiveInstance(INSTANCE_ID); } catch {}
  } finally {
    bridgeRuntimeStarting = false;
  }
}
async function startCliOwnedRuntime(options = {}) {
  if (bridgeRuntimeConnected) return;
  if (bridgeRuntimeStarting) return;
  if (!channelBridgeActive) return;
  const startedAt = performance.now();
  bootProfile("cli-owned:start");
  bridgeRuntimeStarting = true;
  _ownedRuntimeStopRequested = false;
  try {
    const backendStartedAt = performance.now();
    await backend.connect();
    bootProfile("backend:connected", { ms: (performance.now() - backendStartedAt).toFixed(1), backend: backend.name });
    if (_ownedRuntimeStopRequested) {
      try { await backend.disconnect(); } catch {}
      bridgeRuntimeConnected = false;
      _ownedRuntimeStopRequested = false;
      return;
    }
    bridgeRuntimeConnected = true;
    proxyMode = false;
    ownerHttpPort = 0;
    try {
      const providersStartedAt = performance.now();
      const agentCfg = loadAgentConfig();
      await initProviders(agentCfg.providers || {});
      bootProfile("providers:ready", { ms: (performance.now() - providersStartedAt).toFixed(1) });
    } catch (e) {
      bootProfile("providers:failed", { error: e instanceof Error ? e.message : String(e) });
      process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    }
    if (_ownedRuntimeStopRequested) {
      await stopOwnedRuntime("cli-owned start cancelled");
      return;
    }
    scheduler.start();
    startSnapshotWriter(scheduler);
    bootProfile("scheduler:started");
    syncOwnedWebhookAndEventRuntime();
    bootProfile("webhook-event:ready");
    if (options.restoreBinding !== false) bindPersistedTranscriptIfAny().catch((e) => {
      process.stderr.write(`mixdog: bindPersistedTranscriptIfAny failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    });
    bootProfile("cli-owned:ready", { ms: (performance.now() - startedAt).toFixed(1) });
    process.stderr.write(`mixdog: running with ${backend.name} backend (cli-owned)\n`);
  } catch (e) {
    bootProfile("cli-owned:failed", { ms: (performance.now() - startedAt).toFixed(1), error: e instanceof Error ? e.message : String(e) });
    process.stderr.write(`mixdog: backend connect failed (non-fatal, cli-owned): ${e instanceof Error ? e.message : String(e)}\n`);
    try { await stopOwnedRuntime("cli-owned start failed"); } catch {}
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
  stopOwnerHttpServer();
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
    try { refreshActiveInstance(INSTANCE_ID); }
    catch (e) {
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
    if (!channelBridgeActive) {
      const { active: active2 } = currentOwnerState();
      if (active2?.httpPort && !proxyMode) {
        const alive = await pingOwner(active2.httpPort);
        if (alive) {
          proxyMode = true;
          ownerHttpPort = active2.httpPort;
          logOwnership(`non-channel session \u2014 proxy mode via ${active2.instanceId}`);
        }
      }
      return;
    }
    const { active, owned } = currentOwnerState();
    const activeHttpPort = Number(active?.httpPort) || 0;
    let activeHttpChecked = false;
    let activeHttpAlive = false;
    const checkActiveHttp = async () => {
      if (!activeHttpPort) return false;
      if (!activeHttpChecked) {
        activeHttpAlive = await pingOwner(activeHttpPort);
        activeHttpChecked = true;
      }
      return activeHttpAlive;
    };
    const enterProxyMode = (note) => {
      proxyMode = true;
      ownerHttpPort = activeHttpPort;
      if (note) logOwnership(note);
    };
    if (proxyMode && !owned && activeHttpPort) {
      const alive = await checkActiveHttp();
      if (!alive) {
        process.stderr.write(`[ownership] owner ping failed, attempting takeover
`);
        proxyMode = false;
        ownerHttpPort = 0;
        claimBridgeOwnership(`owner ${active.instanceId} unreachable`);
        const next2 = currentOwnerState();
        if (next2.owned) {
          refreshActiveInstance(INSTANCE_ID);
          await startOwnedRuntime(options);
        }
        return;
      }
      // Active owner is alive but may have rebound to a new port since the
      // previous refresh (owner restart on a different PROXY_PORT). Sync
      // ownerHttpPort so subsequent proxyRequest() hits the new port instead
      // of the stale value cached at proxy-mode entry.
      if (ownerHttpPort !== activeHttpPort) {
        ownerHttpPort = activeHttpPort;
        logOwnership(`proxy mode via owner ${active.instanceId} port ${activeHttpPort}`);
      }
      return;
    }
    if (!owned && activeHttpPort) {
      const alive = await checkActiveHttp();
      if (alive) {
        enterProxyMode(`proxy mode via owner ${active.instanceId} port ${activeHttpPort}`);
        return;
      }
      const updatedAt = Number(active?.updatedAt);
      const activeAgeMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
      if (active?.backendReady === true || activeAgeMs > ACTIVE_OWNER_STALE_MS) {
        logOwnership(`owner ${active.instanceId} port ${activeHttpPort} unreachable`);
        claimBridgeOwnership(`owner ${active.instanceId} unreachable`);
      }
    }
    if (!owned && canStealOwnership(active)) {
      claimBridgeOwnership(active ? `takeover from ${active.instanceId}` : "startup");
    }
    const next = currentOwnerState();
    if (next.owned) {
      refreshActiveInstance(INSTANCE_ID);
      await startOwnedRuntime(options);
      return;
    }
    if (bridgeRuntimeConnected) {
      const reason = next.active?.instanceId ? `newer server ${next.active.instanceId}` : "no active owner";
      await stopOwnedRuntime(reason);
      return;
    }
    if (next.active?.httpPort && !proxyMode) {
      const alive = await pingOwner(next.active.httpPort);
      if (alive) {
        proxyMode = true;
        ownerHttpPort = next.active.httpPort;
        logOwnership(`proxy mode via owner ${next.active.instanceId} port ${next.active.httpPort}`);
        return;
      }
    }
    if (next.active?.instanceId) {
      logOwnership(`standby under owner ${next.active.instanceId}`);
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
  // self-corrects, but bridge roles commonly echo them and we don't want them
  // surfacing in Discord / Lead channel push.
  if (typeof content === 'string') content = stripSoftWarns(content);
  // Skip-protocol guard: agents (webhook-handler / scheduler-task)
  // prefix `[meta:silent]` on the first line to opt out
  // of Lead inject for genuine no-op results (label-only events, dedup,
  // "nothing to report"). The body still goes to Discord for audit; only
  // the Lead-context inject is suppressed. See rules/bridge/20-skip-protocol.md.
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
      // Webhook skip protocol: when the bridge worker emits a `[meta:silent]`
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
  // owner process. Standby / proxy instances see bridgeRuntimeConnected=false
  // or proxyMode=true and will skip the tick even if an errant start() slipped
  // through.
  eventQueue.setOwnerGetter(() => bridgeRuntimeConnected && !proxyMode);
  forwarder.setOwnerGetter(() => bridgeRuntimeConnected && !proxyMode);
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
        // bridge role hook (or other consumer) gets a chance to claim it.
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
  // Emit notifications/claude/channel/permission back to Claude Code; the race
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
// Each helper transparently routes through proxyRequest() when this instance
// is in proxyMode (non-owner), or through the local backend otherwise. The
// MCP-result formatting (text shape, cache invalidation, isError flag) is
// shared so both branches produce byte-identical output.
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
  if (proxyMode) {
    const proxyResult = await proxyRequest("/send", "POST", {
      chatId: args.chat_id,
      text: args.text,
      opts: sendOpts
    });
    if (!proxyResult.ok) {
      return { content: [{ type: "text", text: `proxy reply failed: ${proxyResult.error}` }], isError: true };
    }
    ids = proxyResult.data?.sentIds ?? [];
  } else {
    // Pre-send activity bump keeps idle gating consistent during the await.
    scheduler.noteActivity();
    const sendResult = await backend.sendMessage(args.chat_id, args.text, sendOpts);
    // Lead-originated reply via proxy-mode MCP — bump activity.
    scheduler.noteActivity();
    ids = sendResult.sentIds;
  }
  const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`;
  return { content: [{ type: "text", text }] };
}
async function dispatchFetch(args) {
  const channelId = resolveChannelLabel(config.channelsConfig, args.channel);
  const limit = args.limit ?? 20;
  let msgs;
  if (proxyMode) {
    const proxyResult = await proxyRequest(`/fetch?channel=${encodeURIComponent(channelId)}&limit=${limit}`, "GET");
    if (!proxyResult.ok) {
      return { content: [{ type: "text", text: `proxy fetch failed: ${proxyResult.error}` }], isError: true };
    }
    msgs = proxyResult.data?.messages ?? [];
    // recordFetchedMessages already ran on the owner side (/fetch route).
  } else {
    msgs = await backend.fetchMessages(channelId, limit);
    recordFetchedMessages(channelId, args.channel !== channelId ? args.channel : labelForChannelId(channelId), msgs);
  }
  const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
    const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
    return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
  }).join("\n");
  return { content: [{ type: "text", text }] };
}
async function dispatchReact(args) {
  if (proxyMode) {
    const proxyResult = await proxyRequest("/react", "POST", {
      chatId: args.chat_id,
      messageId: args.message_id,
      emoji: args.emoji
    });
    if (!proxyResult.ok) {
      return { content: [{ type: "text", text: `proxy react failed: ${proxyResult.error}` }], isError: true };
    }
  } else {
    await backend.react(args.chat_id, args.message_id, args.emoji);
  }
  return { content: [{ type: "text", text: "reacted" }] };
}
async function dispatchEditMessage(args) {
  const opts = { embeds: args.embeds ?? [], components: args.components ?? [] };
  let id;
  if (proxyMode) {
    const proxyResult = await proxyRequest("/edit", "POST", {
      chatId: args.chat_id,
      messageId: args.message_id,
      text: args.text,
      opts
    });
    if (!proxyResult.ok) {
      return { content: [{ type: "text", text: `proxy edit failed: ${proxyResult.error}` }], isError: true };
    }
    id = proxyResult.data?.id;
  } else {
    id = await backend.editMessage(args.chat_id, args.message_id, args.text, opts);
  }
  return { content: [{ type: "text", text: `edited (id: ${id})` }] };
}
async function dispatchDownloadAttachment(args) {
  let files;
  if (proxyMode) {
    const proxyResult = await proxyRequest("/download", "POST", {
      chatId: args.chat_id,
      messageId: args.message_id
    });
    if (!proxyResult.ok) {
      return { content: [{ type: "text", text: `proxy download failed: ${proxyResult.error}` }], isError: true };
    }
    files = proxyResult.data?.files ?? [];
  } else {
    files = await backend.downloadAttachment(args.chat_id, args.message_id);
  }
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
          if (proxyMode) {
            const proxyResult = await proxyRequest("/schedule-status", "GET");
            if (!proxyResult.ok) {
              result = { content: [{ type: "text", text: `proxy schedule_status failed: ${proxyResult.error}` }], isError: true };
              break;
            }
            result = proxyResult.data?.result ?? { content: [{ type: "text", text: "no schedules configured" }] };
          } else {
            result = scheduleStatusResult();
          }
          break;
        }
      case "trigger_schedule": {
          if (proxyMode) {
            const proxyResult = await proxyRequest("/trigger-schedule", "POST", { name: args.name });
            if (!proxyResult.ok) {
              result = { content: [{ type: "text", text: `proxy trigger_schedule failed: ${proxyResult.error}` }], isError: true };
              break;
            }
            const triggerResult = proxyResult.data?.result;
            result = { content: [{ type: "text", text: triggerResult == null ? "" : String(triggerResult) }] };
          } else {
            const triggerResult = await scheduler.triggerManual(args.name);
            result = { content: [{ type: "text", text: triggerResult }] };
          }
          break;
        }
      case "schedule_control": {
          if (proxyMode) {
            const proxyResult = await proxyRequest("/schedule-control", "POST", {
              name: args.name,
              action: args.action,
              minutes: args.minutes
            });
            if (!proxyResult.ok) {
              result = { content: [{ type: "text", text: `proxy schedule_control failed: ${proxyResult.error}` }], isError: true };
              break;
            }
            result = proxyResult.data?.result ?? { content: [{ type: "text", text: `unknown action: ${args.action}` }], isError: true };
          } else {
            result = scheduleControlResult(args);
          }
          break;
        }
      case "activate_channel_bridge": {
          if (proxyMode) {
            const proxyRes = await proxyRequest("/bridge/activate", "POST", { active: args.active === true });
            if (!proxyRes.ok) {
              result = { content: [{ type: "text", text: `proxy bridge activate failed: ${proxyRes.error}` }], isError: true };
            } else {
              channelBridgeActive = Boolean(args.active);
              writeBridgeState(channelBridgeActive);
              // Remote owner just deactivated and is tearing its owner-HTTP
              // server down. Drop our proxy pointer so subsequent direct
              // tool calls don't route through proxyRequest() to a port
              // about to close (ECONNREFUSED) or stripped of auth (401).
              if (!args.active) {
                proxyMode = false;
                ownerHttpPort = 0;
              }
              result = { content: [{ type: "text", text: `channel bridge ${args.active ? "activated" : "deactivated"}` }] };
            }
          } else {
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
              // event-pipeline/owner-HTTP/heartbeat don't keep running on a
              // deactivated bridge (and to prevent this owner from later
              // entering proxyMode against its own port).
              try { await stopOwnedRuntime("bridge deactivated"); } catch (e) {
                process.stderr.write(`mixdog: stopOwnedRuntime on deactivate failed: ${e?.message || e}\n`);
              }
              // Also clear proxyMode/ownerHttpPort. Without this, a session
              // that was acting as proxy when deactivate landed keeps the
              // stale flag + port set; later direct tool calls then route
              // through proxyRequest() to a port whose owner has just been
              // stopped or stripped of auth, returning ECONNREFUSED/401.
              if (proxyMode) {
                proxyMode = false;
                ownerHttpPort = 0;
              }
            }
            result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
          }
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
          const ALLOW = new Set(["reload-plugins", "clear"]);
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
  if (BACKEND_TOOLS.has(toolName) && !bridgeRuntimeConnected && !proxyMode) {
    if (_isCliOwnedMode) {
      await startCliOwnedRuntime({ restoreBinding: true });
      if (!bridgeRuntimeConnected) {
        return {
          content: [{ type: "text", text: `Channel runtime is not connected. Check token and network.` }],
          isError: true
        };
      }
    } else {
    // Do NOT pre-claim ownership here. claimBridgeOwnership() overwrites the
    // active-instance advert immediately, which kicks a live owner offline if
    // refreshBridgeOwnership() would have otherwise discovered them via
    // pingOwner() and entered proxyMode. Let refreshBridgeOwnership() below
    // ping/proxy the existing owner first and only fall through to a takeover
    // when the live owner is unreachable.
    for (let i = 0; i < 2 && !bridgeRuntimeConnected && !proxyMode; i++) {
      try {
        await refreshBridgeOwnership();
      } catch {
      }
      if (!bridgeRuntimeConnected && !proxyMode) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bridgeRuntimeConnected && !proxyMode) {
      return {
        content: [{ type: "text", text: `Discord auto-connect failed after retries. Check token and network.` }],
        isError: true
      };
    }
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
  startChannelDaemonIdleMonitor();
  channelBridgeActive = true;
  writeBridgeState(true);
  if (_isCliOwnedMode) {
    await startCliOwnedRuntime({ restoreBinding: true });
  } else {
  await refreshBridgeOwnership({ restoreBinding: true });
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
  stopChannelDaemonIdleMonitor();
  try { await stopVoiceWhisperServer(); } catch {}
  await stopOwnedRuntime("unified server stop");
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
  if (bridgeOwnershipTimer) {
    clearInterval(bridgeOwnershipTimer);
    bridgeOwnershipTimer = null;
  }
  if (turnEndWatcher) {
    try { turnEndWatcher.close(); } catch {}
    turnEndWatcher = null;
  }
}
if (process.env.MIXDOG_CHANNELS_AUTO_BOOT !== '0') {
  let detectChannelFlag = function() {
    const isWin = process.platform === "win32";
    const flagRe = /--channels\b|--dangerously-load-development-channels\b/;
    if (process.env.MIXDOG_CHANNEL_FLAG === "1") return true;
    if (process.env.MIXDOG_CHANNEL_FLAG === "0") return false;
    if (isWin) {
      // Single CIM snapshot + in-process chain walk: one powershell.exe spawn
      // instead of up to 12 synchronous wmic/powershell spawns. Snapshots all
      // processes into a map, walks from process.ppid up to 6 ancestors
      // (closest first), and emits each ancestor CommandLine on its own line
      // for the same flagRe test below. Any failure returns false.
      try {
        const ps = [
          '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine;',
          '$map = @{};',
          'foreach ($p in $procs) { $map[[int]$p.ProcessId] = $p }',
          `$cur = ${Number(process.ppid)};`,
          'for ($i = 0; $i -lt 6; $i++) {',
          '  if (-not $cur -or $cur -le 1) { break }',
          '  $p = $map[[int]$cur]; if ($null -eq $p) { break }',
          '  [Console]::WriteLine($p.CommandLine);',
          '  $next = [int]$p.ParentProcessId;',
          '  if ($next -eq [int]$cur -or $next -le 1) { break }',
          '  $cur = $next',
          '}',
        ].join(" ");
        const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
          encoding: "utf8",
          timeout: 5e3,
          windowsHide: true,
        });
        const out = String(r.stdout || "");
        for (const line of out.split(/\r?\n/)) {
          if (flagRe.test(line)) return true;
        }
      } catch {}
      return false;
    }
    let pid = process.ppid;
    for (let depth = 0; pid && pid > 1 && depth < 6; depth++) {
      try {
        const cmdLine = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8", timeout: 3e3, windowsHide: true });
        if (flagRe.test(cmdLine)) return true;
        pid = parseInt(execSync(`ps -p ${pid} -o ppid=`, { encoding: "utf8", timeout: 3e3, windowsHide: true }).trim(), 10);
      } catch {
        break;
      }
    }
    return false;
  };
  _channelFlagDetected = detectChannelFlag();
  if (isMixdogDebug()) {
    fs.appendFileSync(_bootLog, `[${localTimestamp()}] channelFlag: ${_channelFlagDetected}\n`);
    if (_channelFlagDetected) {
      fs.appendFileSync(_bootLog, `[${localTimestamp()}] channel mode detected — bridge auto-activated\n`);
    }
  }
  if (_channelFlagDetected) {
    channelBridgeActive = true;
  }
  writeBridgeState(channelBridgeActive);
  const previousOwner = readActiveInstance();
  noteStartupHandoff(previousOwner);
  // Do not claim ownership just because this terminal is channel-capable.
  // refreshBridgeOwnership() below pings/proxies a live owner first and only
  // claims when there is no reachable active owner or the record is stale.
  const _bindingReadyStart = Date.now();
  void refreshBridgeOwnership({ restoreBinding: true }).then(
    (v) => {
      bindingReadyStatus = "resolved";
      dropTrace("bindingReady.resolve", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus });
      _bindingReadyResolve(v);
    },
    (e) => {
      bindingReadyStatus = "rejected";
      dropTrace("bindingReady.reject", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus, err: String(e) });
      _bindingReadyResolve(e);
    }
  );
  bridgeOwnershipTimer = setInterval(() => {
    refreshBridgeOwnershipSafe();
  }, 3e3);
  // Hook/statusline IPC is owned by the MCP parent process so it is available
  // before channels finishes bridge ownership and backend startup.
  const configPath = path.join(DATA_DIR, "mixdog-config.json");
  let reloadDebounce = null;
  let configWatcher = null;
  try {
    configWatcher = fs.watch(configPath, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        reloadRuntimeConfig().catch(() => {});
      }, 500);
    });
  } catch {
  }
  process.on("exit", () => {
    if (configWatcher) { try { configWatcher.close(); } catch {} }
    if (bridgeOwnershipTimer) { clearInterval(bridgeOwnershipTimer); }
  });
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
    // Claude Code permission request → Discord Allow/Deny prompt.
    // Parent (server.mjs) receives notifications/claude/channel/permission_request
    // from Claude Code and forwards the params here. We post a buttoned message;
    // button clicks are handled in backend.onInteraction and sent back to CC as
    // notifications/claude/channel/permission via sendNotifyToParent.
    if (msg && msg.type === 'permission_request_inbound') {
      try {
        const { request_id, tool_name, description, input_preview } = msg.params || {};
        // tool_input arrives via the passthrough() schema in server.mjs when
        // Claude Code includes it in the permission_request notification.
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
      process.send({ type: 'ready', channelFlag: _channelFlagDetected })
    } catch (e) {
      bootProfile("worker:failed", { ms: (performance.now() - startedAt).toFixed(1), error: e?.message || String(e) })
      process.stderr.write(`[channels-worker] start() failed: ${e && (e.message || e)}\n`)
      process.send({ type: 'ready', channelFlag: _channelFlagDetected, degraded: true, error: e?.message || String(e) })
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
