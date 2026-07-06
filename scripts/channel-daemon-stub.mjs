// Stub channels daemon for the flip smoke: same lifecycle contract as
// src/standalone/channel-daemon.mjs (pid-verified singleton claim, HTTP+SSE
// transport, discovery file, ready handshake, client-grace self-shutdown) but
// with a STUB runtime instead of worker-main — no Discord token needed. The
// real channel-worker.mjs spawn-or-attach path forks THIS via
// MIXDOG_CHANNEL_DAEMON_ENTRY, so the flip is exercised end to end.
process.env.MIXDOG_WORKER_MODE = process.env.MIXDOG_WORKER_MODE || '1';

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { claimSingletonOwner, releaseSingletonOwner } from '../src/runtime/shared/singleton-owner.mjs';
import { createChannelDaemonTransport } from '../src/standalone/channel-daemon-transport.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}
const RUNTIME_ROOT = runtimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR ? path.resolve(process.env.MIXDOG_DATA_DIR) : RUNTIME_ROOT;
const DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'channel-daemon.json');
const OWNER_PATH = path.join(DATA_DIR, 'channel-daemon-owner.json');

function log(line) { if (process.env.DAEMON_SMOKE_VERBOSE) process.stderr.write(`[stub-daemon] ${line}\n`); }

let transport = null;
let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await transport?.stop?.(); } catch {}
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  process.exit(code);
}

async function main() {
  try { mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
  const claim = claimSingletonOwner(OWNER_PATH, { kind: 'channel-runtime-daemon', pid: process.pid, meta: { cwd: process.cwd() } });
  if (!claim.owned) { process.exit(0); } // race loser → spawner attaches to winner
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });

  // Stub runtime: echo the call + caller identity, and (for 'fetch') emit a
  // notify AFTER responding so the smoke can assert targeted routing.
  const handleCall = async (name, args, ctx) => {
    if (name === 'fetch') {
      setTimeout(() => { try { transport.notify('notifications/claude/channel', { content: 'ping-from-stub' }); } catch {} }, 20);
    }
    return { ok: true, name, args, leadPid: ctx.leadPid };
  };

  transport = createChannelDaemonTransport({
    handleCall,
    discoveryPath: DISCOVERY_PATH,
    clientGraceMs: 250,
    sweepMs: 1000,
    log,
    onClientsEmpty: () => { void shutdown('no live clients'); },
  });
  const { port, token } = await transport.start();
  if (process.send) { try { process.send({ type: 'ready', port, token }); } catch {} }
  log(`ready port=${port} pid=${process.pid}`);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('message', (msg) => { if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown'); });

main().catch((err) => { log(`fatal: ${err?.stack || err}`); void shutdown('fatal', 2); });
