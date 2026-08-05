// Machine-global ENGINE daemon entry.
//
// One process per machine owns every live session engine; the terminal TUI and
// the desktop app attach over engine-daemon-transport.mjs and act as views.
// Ownership is the same pid-verified singleton claim the channels daemon uses:
// a stale owner (dead pid) is reclaimed, a live peer makes this process exit(0)
// so the spawner attaches to the winner.
//
// Boot order matters: MIXDOG_ENGINE_DAEMON_HOST is set BEFORE importing the
// engine module so createEngineSession builds REAL engines here instead of
// recursing into a remote proxy.
process.env.MIXDOG_ENGINE_DAEMON_HOST = '1';

try {
  const { enableCompileCache } = await import('node:module');
  enableCompileCache?.();
} catch { /* launch-speed optimization only */ }

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { claimSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { createEngineDaemonTransport } from './engine-daemon-transport.mjs';
import { createEngineDaemonService } from './engine-daemon-service.mjs';
import { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } from './engine-daemon-protocol.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

const RUNTIME_ROOT = runtimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR ? path.resolve(process.env.MIXDOG_DATA_DIR) : RUNTIME_ROOT;
const DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'engine-daemon.json');
const OWNER_PATH = path.join(DATA_DIR, 'engine-daemon-owner.json');
const LOG_PATH = path.join(DATA_DIR, 'engine-daemon.log');

let fileLogging = false;
function log(line) {
  const text = `[engine-daemon] ${line}`;
  // Exactly ONE sink per line: the spawner mirrors our stderr until ready, then
  // we own the file (no loss around the handoff, no duplicates after it).
  if (!fileLogging) {
    try { process.stderr.write(`${text}\n`); } catch {}
    return;
  }
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}

let transport = null;
let service = null;
let shuttingDown = false;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try { await service?.stop?.(reason); } catch (e) { log(`service.stop failed: ${e?.message || e}`); }
  try { await transport?.stop?.(); } catch (e) { log(`transport.stop failed: ${e?.message || e}`); }
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  process.exit(code);
}

async function main() {
  try { mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

  const claim = claimSingletonOwner(OWNER_PATH, {
    kind: 'engine-runtime-daemon',
    pid: process.pid,
    meta: { cwd: process.cwd() },
  });
  if (!claim.owned) {
    log(`live peer holds owner lock (pid=${claim.owner?.pid}) — exiting for attach`);
    process.exit(0);
  }
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });

  // The engine module IS the runtime graph (session manager, providers, tools).
  // Importing it here is what makes this process the single writer.
  const engineModule = await import('../tui/engine.mjs');
  service = createEngineDaemonService({
    createEngine: (options) => engineModule.createEngineSession(options),
    onFrame: (frame) => transport?.broadcast(frame),
    log,
  });
  transport = createEngineDaemonTransport({
    handleCall: (name, args) => service.handleCall(name, args),
    discoveryPath: DISCOVERY_PATH,
    log,
    // Views negotiate against this: an older daemon is drained and replaced by
    // a newer client, a newer daemon makes the older client stay in-process.
    getStatus: () => ({
      engines: service.size,
      protocol: ENGINE_DAEMON_PROTOCOL,
      version: engineRuntimeVersion(),
    }),
    // Self-shutdown once the last view leaves. Engines are re-openable from the
    // session store, so an idle daemon is pure cost.
    onClientsEmpty: () => { void shutdown('no live clients'); },
  });
  const { port, token } = await transport.start();
  fileLogging = true;
  log(`ready port=${port} pid=${process.pid}`);
  try { process.send?.({ type: 'ready', port, token, pid: process.pid }); } catch {}
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

main().catch((err) => {
  log(`boot failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
