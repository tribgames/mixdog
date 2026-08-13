// Stub channel service for the flip smoke: same lifecycle contract as
// src/standalone/daemon.mjs (pid-verified singleton claim, HTTP+SSE
// transport, discovery file, ready handshake, client-grace self-shutdown) but
// with a STUB runtime instead of worker-main — no Discord token needed. The
// real channel-worker.mjs spawn-or-attach path forks THIS via
// MIXDOG_DAEMON_ENTRY, so the flip is exercised end to end.
process.env.MIXDOG_WORKER_MODE = process.env.MIXDOG_WORKER_MODE || '1';

import os from 'node:os';
import path from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { writeJsonAtomicSync } from '../src/runtime/shared/atomic-file.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../src/runtime/shared/runtime-root.mjs';
import { claimSingletonOwner, releaseSingletonOwner } from '../src/runtime/shared/singleton-owner.mjs';
import { safeIpcSend } from '../src/runtime/shared/safe-ipc-send.mjs';
import { createChannelTransport } from '../src/standalone/channel-transport.mjs';

const RUNTIME_ROOT = resolveRuntimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR ? path.resolve(process.env.MIXDOG_DATA_DIR) : RUNTIME_ROOT;
const DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'daemon.json');
const OWNER_PATH = path.join(DATA_DIR, 'daemon-owner.json');

function log(line) { if (process.env.DAEMON_SMOKE_VERBOSE) process.stderr.write(`[stub-daemon] ${line}\n`); }

let transport = null;
let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await transport?.stop?.(); } catch {}
  try { rmSync(DISCOVERY_PATH, { force: true }); } catch {}
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  process.exit(code);
}

async function main() {
  ensurePrivateRuntimeRoot(RUNTIME_ROOT);
  const claim = claimSingletonOwner(OWNER_PATH, { kind: 'mixdog-daemon', pid: process.pid, meta: { cwd: process.cwd() } });
  if (!claim.owned) { process.exit(0); } // race loser → spawner attaches to winner
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });

  // Optional env dump for the tool smoke: proves daemonEnv() spawned us with
  // the host-mode flags (MIXDOG_DAEMON_HOST=1, MIXDOG_CLI_OWNED=0).
  if (process.env.SMOKE_CHANNEL_ENV_OUT) {
    try {
      writeFileSync(process.env.SMOKE_CHANNEL_ENV_OUT, JSON.stringify({
        cliOwned: process.env.MIXDOG_CLI_OWNED,
        host: process.env.MIXDOG_DAEMON_HOST,
        supervisorPid: process.env.MIXDOG_SUPERVISOR_PID,
      }));
    } catch { /* smoke-only, best-effort */ }
  }

  // Stub runtime: echo the call + caller identity, and (for 'fetch') emit a
  // notify AFTER responding so the smoke can assert targeted routing.
  const handleCall = async (name, args, ctx) => {
    if (name === 'fetch') {
      setTimeout(() => { try { transport.notify('notifications/claude/channel', { content: 'ping-from-stub' }); } catch {} }, 20);
    }
    return { ok: true, name, args, leadPid: ctx.leadPid };
  };

  transport = createChannelTransport({
    handleCall,
    clientGraceMs: 250,
    sweepMs: 1000,
    log,
    onClientsEmpty: () => { void shutdown('no live clients'); },
  });
  const { port, token } = await transport.start();
  writeJsonAtomicSync(DISCOVERY_PATH, {
    pid: process.pid,
    startedAt: Date.now(),
    endpoints: { channel: { port, token } },
  }, { compact: true, secret: true });
  safeIpcSend(process, { type: 'ready', port, token });
  log(`ready port=${port} pid=${process.pid}`);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('message', (msg) => { if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown'); });

main().catch((err) => { log(`fatal: ${err?.stack || err}`); void shutdown('fatal', 2); });
