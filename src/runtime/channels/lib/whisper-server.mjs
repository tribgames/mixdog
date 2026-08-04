// whisper-server.mjs
//
// State-machine manager for ONE long-lived whisper-server.exe process.
//
// Invariant model (NOT a try-a-few-things model):
//   There is at most ONE managed whisper-server child, identified by an exact
//   runtime contract (serverCmd / modelPath / threadCount / host). ensureReady()
//   guarantees that — when it resolves — a child matching the CURRENT contract is
//   bound to the fixed port and has loaded its model. Any deviation (contract
//   change, child death, port stolen) is repaired by deterministically tearing
//   down and recreating the SAME contract. There is NO fallback to a CLI binary,
//   to python, to another executable, or to another model. If the contract cannot
//   be satisfied, the operation FAILS.
//
// States: STOPPED → STARTING → READY → STOPPING → STOPPED, plus DEAD on child exit.
//
// Why a FIXED port (not `--port 0`):
//   whisper-server 1.8.4 does not support OS-assigned ephemeral bind. Passing
//   `--port 0` makes it print `listening at http://127.0.0.1:0` and never bind a
//   usable port. So we bind a single deterministic port and FAIL CLOSED when it is
//   occupied by a process we do not positively own. We NEVER scan a port range.
//
// Readiness detection:
//   The server prints `... listening at http://<host>:<port>` AFTER the model is
//   loaded, but that line is block-buffered when stdout is a pipe and may not flush
//   promptly. So readiness is gated on an active TCP connect to the fixed port
//   (the socket is bound only after model load completes). When the listening line
//   IS observed, the parsed port is asserted to equal the fixed port (contract
//   invariant); a mismatch is fatal.
//
// PID metadata (<dataDir>/voice/whisper-server.pid.json) exists ONLY for cleanup
// across process restarts. We kill a stale child ONLY when it is positively owned
// (recorded pid is alive AND its image is whisper-server). A foreign process on the
// port is never killed — we fail closed instead.

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// ── Tunables (deterministic; no ranges) ──────────────────────────────────────
const IS_WIN = process.platform === 'win32';
// Single deterministic port. Override only via env for operator control; never
// auto-scanned. Fail closed if occupied by a non-owned process.
const FIXED_PORT = (() => {
  const raw = process.env.MIXDOG_WHISPER_SERVER_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8771;
})();
const READY_TIMEOUT_MS = 120_000;   // model load + bind budget
const READY_POLL_MS = 250;          // TCP probe cadence
const PROBE_CONNECT_MS = 1_000;     // per TCP-connect attempt
const STOP_GRACE_MS = 5_000;        // SIGTERM → SIGKILL escalation window
const INFERENCE_PATH = '/inference'; // whisper-server default --inference-path

const STATE = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  READY: 'READY',
  STOPPING: 'STOPPING',
  DEAD: 'DEAD',
});

// ── Singleton manager state ───────────────────────────────────────────────────
const mgr = {
  state: STATE.STOPPED,
  child: null,          // ChildProcess handle (non-detached)
  port: null,           // bound port (== FIXED_PORT when READY)
  host: null,
  runtimeKey: null,     // exact contract fingerprint
  contract: null,       // { serverCmd, modelPath, threadCount, host }
  startPromise: null,   // in-flight ensureReady() start
  inflight: new Set(),  // active transcribe AbortControllers
  logTail: '',          // recent stdout/stderr for diagnostics
};

function runtimeKeyOf({ serverCmd, modelPath, threadCount, host }) {
  return JSON.stringify([serverCmd, modelPath, threadCount, host]);
}

function pidMetaPath() {
  // Co-located with the model store; serverCmd lives under <dataDir>/voice-runtime
  // and the model under <dataDir>/voice/models, so derive the voice dir from cwd
  // of the server binary's data root is brittle — instead key off serverCmd's
  // runtime root. We persist next to a stable per-user temp path derived from the
  // serverCmd so cleanup survives a manager-process restart.
  const base = mgr.contract?.serverCmd
    ? path.join(path.dirname(mgr.contract.serverCmd), '..', '..')
    : process.cwd();
  return path.join(base, 'whisper-server.pid.json');
}

function writePidMeta() {
  if (!mgr.child) return;
  const meta = {
    pid: mgr.child.pid,
    serverCmd: mgr.contract.serverCmd,
    modelPath: mgr.contract.modelPath,
    threadCount: mgr.contract.threadCount,
    host: mgr.contract.host,
    port: mgr.port,
    runtimeKey: mgr.runtimeKey,
    startedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(pidMetaPath()), { recursive: true });
    fs.writeFileSync(pidMetaPath(), JSON.stringify(meta), 'utf8');
  } catch { /* metadata is advisory cleanup state; non-fatal */ }
}

function clearPidMeta() {
  try { fs.rmSync(pidMetaPath(), { force: true }); } catch { /* non-fatal */ }
}

function readPidMeta() {
  try {
    return JSON.parse(fs.readFileSync(pidMetaPath(), 'utf8'));
  } catch { return null; }
}

// Read the live process command line for `pid`. This is the proof-of-ownership
// query: a recorded pid being alive with the right image is NOT sufficient (pids
// are reused; another whisper-server could be unrelated). We must confirm the
// running process was launched against OUR contract.
//   win32: query Win32_Process.CommandLine via wmic at a DETERMINISTIC System32
//          path (never resolved through PATH, which an attacker/shadow binary
//          could hijack).
//   posix: `ps -o args= -p <pid>` prints the full argument vector.
// Returns '' on any failure → callers MUST treat '' as "cannot prove" and fail
// closed (never kill, never reuse).
function readProcessCommandLine(pid) {
  if (IS_WIN) {
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C\u003a\\Windows';
    const wmic = path.join(sysRoot, 'System32', 'wbem', 'wmic.exe');
    try {
      const r = spawnSync(
        wmic,
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/FORMAT:LIST'],
        { encoding: 'utf8', windowsHide: true },
      );
      return r.stdout || '';
    } catch { return ''; }
  }
  try {
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
    return r.stdout || '';
  } catch { return ''; }
}

// Positive ownership check: the recorded pid must be alive AND its image must be
// whisper-server AND its live command line must reference OUR contract — i.e. it
// must contain our modelPath OR our `--port <port>`. Image + alive alone is not
// proof (pids are reused, and an unrelated whisper-server could be running), so
// we additionally bind ownership to the running command line via an OS query.
// Any inability to prove the command-line match → return false (fail closed);
// only a positive match licenses killing the stale child.
function isOwnedWhisperServer(pid, { modelPath, port } = {}) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); } catch { return false; } // not alive / not ours
  // 1) Image identity.
  let imageOk = false;
  if (IS_WIN) {
    try {
      const r = spawnSync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true },
      );
      imageOk = /whisper-server\.exe/i.test(r.stdout || '');
    } catch { return false; }
  } else {
    try {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true });
      imageOk = /whisper-server/i.test(r.stdout || '');
    } catch { return false; }
  }
  if (!imageOk) return false;
  // 2) Command-line contract proof. Fail closed if we cannot read the cmdline.
  const cmdline = readProcessCommandLine(pid);
  if (!cmdline) return false;
  const modelMatch = Boolean(modelPath) && cmdline.includes(modelPath);
  const portMatch = Number.isInteger(port)
    && new RegExp(`--port(?:\\s+|=)${port}(?!\\d)`).test(cmdline);
  return modelMatch || portMatch;
}

function killPid(pid, force) {
  if (!pid) return;
  if (IS_WIN) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try { spawnSync('taskkill', args, { windowsHide: true }); } catch { /* best-effort */ }
    return;
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* best-effort */ }
}

// Single TCP-connect probe. Resolves true when the socket accepts a connection
// (whisper-server binds only after the model is fully loaded).
function probePort(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(PROBE_CONNECT_MS);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function appendLog(buf) {
  mgr.logTail = (mgr.logTail + buf.toString()).slice(-4000);
}

// Advisory: lower the child to Windows IDLE priority exactly once. Failure is
// non-fatal (matches os.setPriority best-effort usage elsewhere) and never blocks
// readiness — priority is not part of the transcription contract.
async function applyLowPriorityOnce(child) {
  if (!IS_WIN || !child?.pid) return;
  try {
    const mod = await import('node-windows-process-info');
    const api = mod.default ?? mod;
    const setPriority = api.setPriority ?? api.setProcessPriority;
    if (typeof setPriority === 'function') {
      // IDLE_PRIORITY_CLASS === 0x40 (64); pass both the symbolic and numeric
      // forms to tolerate the package's accepted argument shape.
      try { setPriority(child.pid, 'idle'); }
      catch { setPriority(child.pid, 0x40); }
    }
  } catch { /* package/API absent → priority stays default; non-fatal */ }
}

function detachChildHandlers() {
  if (!mgr.child) return;
  try { mgr.child.removeAllListeners(); } catch {}
  try { mgr.child.stdout?.removeAllListeners(); } catch {}
  try { mgr.child.stderr?.removeAllListeners(); } catch {}
}

// Deterministic teardown of the current child. Used both for STOPPING and for a
// contract change. Escalates SIGTERM → SIGKILL after a grace window.
async function teardown(reason) {
  const child = mgr.child;
  const pid = child?.pid;
  // Abort all in-flight transcribe requests first.
  for (const ctrl of mgr.inflight) { try { ctrl.abort(new Error(`whisper-server stopping: ${reason}`)); } catch {} }
  mgr.inflight.clear();
  if (child && pid) {
    detachChildHandlers();
    const exited = new Promise((resolve) => { try { child.once('exit', resolve); } catch { resolve(); } });
    killPid(pid, false);
    const raced = await Promise.race([exited, delay(STOP_GRACE_MS, 'timeout')]);
    if (raced === 'timeout') {
      killPid(pid, true); // escalate
      await Promise.race([exited, delay(STOP_GRACE_MS, 'timeout')]);
    }
  }
  mgr.child = null;
  mgr.port = null;
  mgr.host = null;
  mgr.runtimeKey = null;
  mgr.contract = null;
  clearPidMeta();
}

function wireChildExit() {
  const child = mgr.child;
  if (!child) return;
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);
  child.once('error', () => {
    // Spawn/runtime error → the contract is unsatisfied.
    mgr.state = STATE.DEAD;
  });
  child.once('exit', () => {
    // Child death is an invariant violation. Mark DEAD then settle to STOPPED so
    // the next ensureReady() recreates the SAME contract (invariant repair).
    for (const ctrl of mgr.inflight) { try { ctrl.abort(new Error('whisper-server exited')); } catch {} }
    mgr.inflight.clear();
    detachChildHandlers();
    mgr.state = STATE.DEAD;
    mgr.child = null;
    mgr.port = null;
    mgr.runtimeKey = null;
    mgr.contract = null;
    clearPidMeta();
    mgr.state = STATE.STOPPED;
  });
}

async function startServer(contract) {
  const { serverCmd, modelPath, threadCount, host } = contract;
  mgr.state = STATE.STARTING;
  mgr.contract = contract;
  mgr.runtimeKey = runtimeKeyOf(contract);
  mgr.host = host;
  mgr.port = FIXED_PORT;

  // ── Pre-spawn: reclaim a positively-owned stale child, else fail closed. ──
  const meta = readPidMeta();
  // Prove ownership against OUR contract (modelPath OR --port) before killing.
  // Prefer the recorded meta's own contract fields; fall back to the contract we
  // are about to start. A non-positive match → never kill (fail closed).
  const ownArgs = { modelPath: meta?.modelPath ?? modelPath, port: meta?.port ?? FIXED_PORT };
  if (meta && isOwnedWhisperServer(meta.pid, ownArgs)) {
    killPid(meta.pid, false);
    await delay(500);
    if (isOwnedWhisperServer(meta.pid, ownArgs)) { killPid(meta.pid, true); await delay(500); }
    clearPidMeta();
  }
  if (await probePort(host, FIXED_PORT)) {
    // Port held by a process we do NOT positively own → never scan a range,
    // never kill a foreign process; fail closed.
    mgr.state = STATE.STOPPED;
    throw new Error(
      `whisper-server: fixed port ${FIXED_PORT} on ${host} is occupied by a non-owned process; refusing to start (fail closed)`,
    );
  }

  // ── Spawn ONCE: non-detached, cwd = dirname(serverCmd) for Windows DLL load. ──
  const args = [
    '--model', modelPath,
    '--host', host,
    '--port', String(FIXED_PORT),
    '-t', String(threadCount),
  ];
  const child = spawn(serverCmd, args, {
    cwd: path.dirname(serverCmd), // resolve co-located CUDA/runtime DLLs
    detached: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mgr.child = child;
  wireChildExit();
  writePidMeta();
  await applyLowPriorityOnce(child); // advisory, once

  // ── Wait for READY: TCP bind + (when flushed) listening-line port assertion. ──
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (mgr.state === STATE.DEAD || !mgr.child) {
      throw new Error(`whisper-server died during startup:\n${mgr.logTail.slice(-1000)}`);
    }
    // Assert the printed bound port matches the fixed contract port when seen.
    const m = mgr.logTail.match(/listening at https?:\/\/[^\s:/]+:(\d+)/i);
    if (m) {
      const printed = Number.parseInt(m[1], 10);
      if (printed !== FIXED_PORT) {
        await teardown('port-contract-mismatch');
        mgr.state = STATE.DEAD;
        throw new Error(
          `whisper-server bound port ${printed} but contract requires ${FIXED_PORT}`,
        );
      }
    }
    if (await probePort(host, FIXED_PORT)) {
      mgr.port = FIXED_PORT;
      mgr.state = STATE.READY;
      return;
    }
    await delay(READY_POLL_MS);
  }
  // Timed out: tear down deterministically and fail (no fallback).
  await teardown('readiness-timeout');
  mgr.state = STATE.DEAD;
  throw new Error(`whisper-server did not become ready within ${READY_TIMEOUT_MS}ms`);
}

/**
 * Ensure a READY whisper-server matching the exact contract. Spawns once; on a
 * contract change deterministically stops the old child and starts the new one.
 * Resolves only when the port is bound and the model is loaded.
 */
export async function ensureReady({ serverCmd, modelPath, threadCount, host = '127.0.0.1' }) {
  if (!serverCmd) throw new Error('ensureReady: serverCmd is required');
  if (!modelPath) throw new Error('ensureReady: modelPath is required');
  if (!Number.isInteger(threadCount) || threadCount < 1) {
    throw new Error(`ensureReady: threadCount must be a positive integer (got ${threadCount})`);
  }
  const contract = { serverCmd, modelPath, threadCount, host };
  const key = runtimeKeyOf(contract);

  // Already READY on the same contract with a live child → done.
  if (mgr.state === STATE.READY && mgr.runtimeKey === key && mgr.child) {
    return;
  }
  // A start is already in flight for the SAME contract → await it.
  if (mgr.startPromise && mgr.runtimeKey === key && mgr.state === STATE.STARTING) {
    return mgr.startPromise;
  }
  // Contract changed (or stale/dead) → tear down anything current first.
  if (mgr.child || mgr.state === STATE.STARTING) {
    mgr.state = STATE.STOPPING;
    await teardown('contract-change');
    mgr.state = STATE.STOPPED;
  }

  mgr.startPromise = startServer(contract).finally(() => { mgr.startPromise = null; });
  return mgr.startPromise;
}

/**
 * Transcribe a WAV via POST <host:port>/inference (multipart). Returns the text.
 * On ANY failure the request fails AND the server is marked DEAD (the next
 * ensureReady recreates the contract). There is NO fallback.
 */
export async function transcribe(wavPath, { language } = {}) {
  if (mgr.state !== STATE.READY || !mgr.child || !mgr.port) {
    throw new Error(`transcribe: whisper-server not READY (state=${mgr.state})`);
  }
  const host = mgr.host;
  const port = mgr.port;
  const ctrl = new AbortController();
  mgr.inflight.add(ctrl);
  try {
    const data = await fs.promises.readFile(wavPath);
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'audio/wav' }), path.basename(wavPath));
    form.append('response_format', 'json'); // → { "text": "..." }
    if (language) form.append('language', String(language));

    const res = await fetch(`http://${host}:${port}${INFERENCE_PATH}`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`whisper-server /inference HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (typeof json?.text !== 'string') {
      throw new Error(`whisper-server /inference returned no text field: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json.text;
  } catch (err) {
    // Request failed → tear the child down and settle to ONE resting state. No fallback.
    mgr.inflight.delete(ctrl);
    if (mgr.state === STATE.READY || mgr.state === STATE.STARTING) {
      // Deterministic teardown → single resting state. This is NOT a contradiction:
      //   DEAD    = transient "death detected" marker. An /inference failure means
      //             the contract is no longer satisfiable on the current child, so
      //             we record the death and abort/kill it via teardown().
      //   STOPPED = the durable resting state once teardown completes. teardown()
      //             nulls mgr.child/contract/runtimeKey and clears pid metadata, so
      //             STOPPED here is "awaiting recreate", indistinguishable from a
      //             clean stop. ensureReady() treats STOPPED-with-no-child as
      //             recreate-eligible (its READY/STARTING fast-paths fail and it
      //             falls through to startServer), so the NEXT ensureReady() rebuilds
      //             the SAME contract. There is no stuck-in-DEAD path: DEAD is only
      //             ever a momentary marker that always resolves to STOPPED.
      mgr.state = STATE.DEAD;                       // transient: death detected
      try { await teardown('transcribe-failure'); } catch {}
      mgr.state = STATE.STOPPED;                    // resting: awaiting recreate
    }
    throw err;
  } finally {
    mgr.inflight.delete(ctrl);
  }
}

/**
 * Stop the managed server: abort in-flight requests, terminate the child with
 * deterministic SIGTERM → SIGKILL escalation, and settle to STOPPED.
 */
export async function stopVoiceWhisperServer() {
  if (mgr.state === STATE.STOPPED && !mgr.child) return;
  mgr.state = STATE.STOPPING;
  try { await teardown('explicit-stop'); } finally { mgr.state = STATE.STOPPED; }
}
