// Usage (from apps/desktop; prefer `dev:isolated --phone-relay` so the relay lives inside the instance supervisor):
//   node scripts/probes/phone-relay.mjs --name <tag> [--skip-build] [--renderer-dir=<dir>]
//     [--idle-minutes=7] [--owner-pid=<pid|none>]
// Prints one JSON line {"relayUrl","bundle","dataDir"}.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { detectSessionScratchDir, findPersistentOwnerPid, watchProcessExit } from '../dev-isolated-job.mjs';
import { DEFAULT_IDLE_MS, listProcesses } from '../dev-isolated.mjs';

const desktopDir = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'renderer-dir': { type: 'string' },
    'idle-minutes': { type: 'string', default: String(DEFAULT_IDLE_MS / 60_000) },
    'owner-pid': { type: 'string' },
  },
});
if (!/^[a-z0-9][a-z0-9-]{0,47}$/i.test(values.name ?? ''))
  throw new Error('--name <tag> is required (letters, digits, hyphens).');
const idleMinutes = Number(values['idle-minutes']);
if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
  throw new Error('--idle-minutes must be 0 (disabled) or a positive number.');
}
const idleMs = idleMinutes * 60_000;

const scratch = join(tmpdir(), values.name);
const bundle = join(scratch, 'bundle');
const dataDir = join(scratch, 'relay-data');
const rendererDir = values['renderer-dir'] ? resolve(values['renderer-dir']) : join(bundle, 'renderer');
if (!values['renderer-dir'] && !values['skip-build']) {
  rmSync(bundle, { recursive: true, force: true });
  const build = spawnSync(
    process.execPath,
    [
      join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      '--mode',
      'development',
      '--outDir',
      bundle,
    ],
    {
      cwd: desktopDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, MIXDOG_ELECTRON_BUILD_TARGETS: 'renderer', MIXDOG_DEV_UNMINIFIED: '1' },
    }
  );
  if (build.status !== 0) throw new Error(`renderer build failed (${build.status}).`);
}
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const { startRelay } = await import(pathToFileURL(join(desktopDir, '..', 'relay', 'server.mjs')).href);
const relay = await startRelay({ port: 0, dataDir, rendererDir });

let idleTimer = null;
let sessionWatcher = null;
let ownerWatch = { cancel() {} };
let stopping = false;

const stop = () => {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  ownerWatch.cancel();
  try {
    sessionWatcher?.close();
  } catch {
    // Ignore.
  }
  relay.close().finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
};

let activePhoneSockets = 0;

const disarmIdle = () => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
};

const armIdleIfQuiet = () => {
  disarmIdle();
  if (activePhoneSockets === 0 && idleMs > 0) {
    idleTimer = setTimeout(stop, idleMs);
    idleTimer.unref?.();
  }
};
armIdleIfQuiet();
relay.server?.on?.('request', armIdleIfQuiet);
relay.server?.on?.('upgrade', (req, socket) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (pathname !== '/ws') return;
  activePhoneSockets += 1;
  disarmIdle();
  socket.once('close', () => {
    activePhoneSockets = Math.max(0, activePhoneSockets - 1);
    armIdleIfQuiet();
  });
});

const ownerPid =
  values['owner-pid'] === 'none'
    ? null
    : values['owner-pid'] !== undefined
      ? Number(values['owner-pid'])
      : findPersistentOwnerPid(listProcesses(), process.pid);
if (process.platform === 'win32' && Number.isInteger(ownerPid) && ownerPid > 0) {
  ownerWatch = watchProcessExit(ownerPid, stop);
}
const session = detectSessionScratchDir(process.env);
if (session && existsSync(session.sessionDir) && existsSync(dirname(session.sessionDir))) {
  sessionWatcher = watch(dirname(session.sessionDir), () => {
    if (!existsSync(session.sessionDir)) stop();
  });
  sessionWatcher.on('error', () => {});
  sessionWatcher.unref?.();
}

console.log(JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}`, bundle: rendererDir, dataDir }));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
