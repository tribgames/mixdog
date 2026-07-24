// Machine-global channels daemon entry.
//
// One process per machine hosts the channels runtime (worker-main) and exposes
// it to many TUIs over a local HTTP + SSE transport (see
// channel-daemon-transport.mjs) instead of the old per-TUI fork + node-IPC.
// Spawned (or attached-to) by createStandaloneChannelWorker; ownership is a
// pid-verified singleton lock (singleton-owner.mjs) — NOT the try-once
// active-instance lock that starved under 6 contending workers. A stale daemon
// (dead owner pid) is reclaimed by the next claim; a live peer that wins the
// race makes this process exit(0) so the spawner attaches to the winner.
//
// Boot order matters: MIXDOG_CHANNEL_DAEMON must be set BEFORE importing the
// channels runtime so worker-main skips its parent-IPC loop (runWorkerIpc) and
// lets this entry own start()/stop() + the transport.
process.env.MIXDOG_CHANNEL_DAEMON = '1';
process.env.MIXDOG_WORKER_MODE = process.env.MIXDOG_WORKER_MODE || '1';

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { claimSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { setChannelNotifySink } from '../runtime/channels/lib/parent-bridge.mjs';
import { setOwnerContext } from '../runtime/channels/lib/runtime-paths.mjs';
import { createChannelDaemonTransport } from './channel-daemon-transport.mjs';
import { createStandaloneMemoryRuntime } from './memory-runtime-proxy.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

const RUNTIME_ROOT = runtimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR ? path.resolve(process.env.MIXDOG_DATA_DIR) : RUNTIME_ROOT;
const CWD = process.cwd();
const DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'channel-daemon.json');
// Owner-election lock, separate from the channels seat/bridge state. Reused
// pid-verified claim primitive with real claim-lock retry inside.
const OWNER_PATH = path.join(DATA_DIR, 'channel-daemon-owner.json');
// Memory runtime is folded into the daemon: the ONE machine-global process is
// responsible for starting BOTH the channels runtime and the memory runtime.
// The memory proxy is spawn-or-attach + singleton (memory-runtime-owner lock)
// and advertises memory_port to active-instance.json exactly as before, so
// external readers / memory-client.mjs discovery is UNCHANGED.
const MEMORY_ENTRY = fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url));

// The spawning TUI mirrors our stderr into this file ONLY until it sees our
// 'ready' message; after that its pipe consumer dies on parent exit and later
// lines would be lost. So once ready we append here ourselves (fileLogging on),
// keyed to the SAME ready event the spawner detaches on — no loss, no dup.
const LOG_PATH = path.join(DATA_DIR, 'channels-worker-standalone.log');
let fileLogging = false;
function log(line) {
  const text = `[channel-daemon] ${line}`;
  // Exactly ONE sink per line: before ready the spawner mirrors our stderr into
  // the log, so write stderr only; after ready we own the file, so write the
  // file only — never both (no duplicate around the ready handoff).
  if (!fileLogging) {
    try { process.stderr.write(`${text}\n`); } catch {}
    return;
  }
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}

// Redirect raw process.stderr/stdout writes and console.* from ANY module in
// this process to the daemon log file. Installed at the ready boundary (same
// point fileLogging flips) so pre-ready lines still reach the spawner mirror.
function installDaemonLogRedirect() {
  if (process.env.MIXDOG_DAEMON_ALLOW_STDERR === '1') return;
  const file = (chunk) => {
    try {
      const text = String(chunk ?? '').trimEnd();
      if (text) {
        mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
      }
    } catch { /* logging must never fail the daemon */ }
  };
  const patch = (stream) => {
    stream.write = ((chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      file(chunk);
      if (typeof done === 'function') { try { done(); } catch {} }
      return true;
    });
  };
  patch(process.stderr);
  patch(process.stdout);
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[m] = (...args) => file(`[console.${m}] ${args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ')}`);
  }
}

let channels = null;
let transport = null;
let memoryRuntime = null;
let shuttingDown = false;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try { setChannelNotifySink(null); } catch {}
  try { await channels?.stop?.(); } catch (e) { log(`channels.stop failed: ${e?.message || e}`); }
  // Detach the memory client (never hard-kills the shared memory daemon).
  try { await memoryRuntime?.stop?.(); } catch (e) { log(`memory.stop failed: ${e?.message || e}`); }
  try { await transport?.stop?.(); } catch (e) { log(`transport.stop failed: ${e?.message || e}`); }
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  process.exit(code);
}

async function main() {
  const startedAt = performance.now();
  try { mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}

  // Pid-verified singleton claim (claimSingletonOwner reclaims a dead-pid owner
  // file and refuses only a LIVE peer). Loser exits so the spawner attaches to
  // the winner instead of running a second daemon.
  const claim = claimSingletonOwner(OWNER_PATH, { kind: 'channel-runtime-daemon', pid: process.pid, meta: { cwd: CWD } });
  if (!claim.owned) {
    log(`live peer holds owner lock (pid=${claim.owner?.pid}) — exiting for attach`);
    process.exit(0);
  }
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });

  // Import the channels runtime AFTER the daemon env is set so worker-main
  // skips runWorkerIpc; this triggers its boot side effects (config/backend).
  channels = await import('../runtime/channels/index.mjs');

  // Pointer-move tools re-point active-instance owner/cwd at the binding TUI
  // (mirrors the transport's routing pointer) so external readers see the
  // pointer TUI, not the daemon's spawner.
  const POINTER_TOOLS = new Set(['activate_channel_bridge', 'rebind_current_transcript']);
  const handleCall = (name, args, ctx) => {
    if (ctx && POINTER_TOOLS.has(name)) {
      try { setOwnerContext({ leadPid: ctx.leadPid, cwd: ctx.cwd }); } catch {}
    }
    return channels.handleToolCallWithBridgeRetry(name, args || {});
  };
  transport = createChannelDaemonTransport({
    handleCall,
    // Failover re-dispatch of the survivor's stored bind intent goes through the
    // SAME handleCall + setOwnerContext path a POINTER_TOOLS /call uses, so the
    // output forwarder rebinds to the survivor's transcript on pointer death.
    dispatchBind: (name, args, ctx) => handleCall(name, args, ctx),
    discoveryPath: DISCOVERY_PATH,
    log,
    // Self-shutdown when the last attached TUI leaves (reuses the SSE/client
    // registry as the liveness signal — mirrors the memory daemon grace).
    onClientsEmpty: () => { void shutdown('no live clients'); },
  });
  setChannelNotifySink((method, params) => transport.notify(method, params));
  const { port, token } = await transport.start();

  // Ready handshake for the spawner FIRST (mirrors the memory daemon's ready
  // port). Transport is already listening; signal ready before the heavy
  // Discord connect so the spawner's ready wait never blocks on backend I/O.
  // Take over file logging from the spawner at the ready boundary. No rotate
  // here: the spawner already bounds the file at its own boot (channel-worker
  // rotateBoundedLog), and rotating now would race other processes' buffered
  // appends into the same log.
  fileLogging = true;
  // Global stderr/console redirect: runtime modules hosted in this daemon
  // (session sweeps, scheduler, inbound handlers, providers…) write raw
  // process.stderr lines. With the current pipe stdio those bytes die with the
  // spawner, and a daemon inherited from an older spawn path prints them into
  // whatever terminal originally launched it — the "[session-sweep] …" text
  // observed inside the TUI composer. Route EVERY stderr/console line to the
  // daemon log so no spawn mode can ever reach a user terminal.
  installDaemonLogRedirect();
  // Guard the ready handshake against a dead/closing parent pipe. process.send
  // delivery is async: if the spawner TUI already exited, the write fails with
  // an async 'error' (EPIPE) that a sync try/catch cannot catch — it would
  // surface as uncaughtException and (pre-fix) flip the daemon degraded
  // forever. process.connected gates the obvious-dead case; the send callback
  // swallows the async delivery error so it never reaches uncaughtException.
  if (process.connected && process.send) {
    try { process.send({ type: 'ready', port, token }, undefined, () => {}); } catch {}
  }
  log(`ready port=${port} pid=${process.pid} in ${(performance.now() - startedAt).toFixed(0)}ms`);

  // Boot messaging only for an explicit/auto remote request. Automation may
  // spawn the shared daemon with no remote intent; keep schedules/webhooks live
  // without connecting the channel backend until a Remote claim arrives.
  const remoteIntent = String(process.env.MIXDOG_REMOTE_INTENT || '');
  const messaging = remoteIntent === 'explicit' || remoteIntent === 'auto';
  void Promise.resolve().then(() => channels.start({ messaging }))
    .catch((e) => log(`channels.start failed (non-fatal): ${e?.message || e}`));

  // Fold memory startup in: eagerly ensure the memory runtime is up under the
  // daemon's lifecycle (spawn-or-attach singleton). Fire-and-forget — memory
  // boot is heavy (DB/embeddings) and must NOT delay the ready handshake below
  // (the spawner's ready wait would time out); the proxy publishes memory_port
  // to active-instance.json when ready and memory-client buffers until then.
  try {
    memoryRuntime = createStandaloneMemoryRuntime({ entry: MEMORY_ENTRY, dataDir: DATA_DIR, cwd: CWD });
    void memoryRuntime.start().catch((e) => log(`memory.start failed (non-fatal): ${e?.message || e}`));
  } catch (e) { log(`memory.start setup failed (non-fatal): ${e?.message || e}`); }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown');
});

main().catch((err) => {
  log(`fatal boot error: ${err?.stack || err?.message || err}`);
  void shutdown('fatal boot error', 2);
});
