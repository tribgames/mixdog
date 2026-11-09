// Records where the memory worker's stderr goes, from the real Node spawner (reference tree b6f10295a,
// `memory-runtime-proxy/daemon-spawn.mjs` `createDaemonSpawner`), whether or not the daemon is ready, and with
// `MIXDOG_DAEMON_ALLOW_STDERR=1`.
// usage: node record-memory.mjs <reference-repo-root> > memory-golden.json
// Three processes: this one runs the two scenarios; each scenario is a "daemon" process (its stderr is a file, as
// `remote-install-daemon.ts` starts it) that forks the memory worker through the real spawner; the worker is a stub
// entry that writes the lines below on the parent's acknowledgement, so each pipe chunk is exactly one write.
//   `before-ready`: the daemon's log has not enabled file logging, nothing is redirected.
//   `allow-stderr`: the daemon is past ready (`enableFileLogging` + `installRedirect`) under MIXDOG_DAEMON_ALLOW_STDERR=1.
// Each `[<ISO>]` stamp becomes the token <ISO> after its exact shape is checked.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The spawner forks the entry with no arguments and MIXDOG_WORKER_MODE=1 (`daemonEnv`): that is the worker.
const [root, argRole, dir] = process.argv.slice(2);
const role = process.env.MIXDOG_WORKER_MODE === '1' ? 'worker' : argRole;

const lines = ['[memory] first\n', '[memory] second\n[memory] third\n', '[memory] padded   \n\n'];
const afterReady = '[memory] after worker ready\n';

if (role === 'worker') {
  let step = 0;
  process.stderr.write(lines[step]);
  process.on('message', () => {
    step += 1;
    if (step < lines.length) {
      process.stderr.write(lines[step]);
    } else {
      process.send({ ready: true }, () => process.stderr.write(afterReady, () => process.exit(0)));
    }
  });
  await new Promise(() => {});
}

if (role === 'daemon') {
  const url = (rel) => pathToFileURL(path.join(root, rel)).href;
  const { createDaemonLog } = await import(url('src/standalone/daemon-log.mjs'));
  const { createDaemonSpawner } = await import(url('src/session-runtime/services/memory-runtime-proxy/daemon-spawn.mjs'));
  const { createMemoryProxyState } = await import(url('src/session-runtime/services/memory-runtime-proxy/state.mjs'));
  const log = createDaemonLog({ logPath: path.join(dir, 'daemon.log') });
  if (process.env.MIXDOG_RECORD_PAST_READY === '1') {
    log.enableFileLogging();
    log.installRedirect();
  }
  log.log('daemon line');
  process.stderr.write('[mod] daemon raw\n');
  const state = createMemoryProxyState();
  const spawner = createDaemonSpawner({
    state,
    entry: process.argv[1],
    dataDir: dir,
    cwd: dir,
    idleTtlMs: 1000,
    logPath: path.join(dir, 'memory-runtime-proxy.log'),
    ownerClaim: { handoffToChild() {}, releaseChild() {} },
    discovery: { waitForPort: async () => 1 },
  });
  const started = spawner.spawnDaemon();
  const child = state.child;
  child.stderr.on('data', () => {
    if (child.connected) child.send({ ack: true });
  });
  // The spawner unrefs the worker's handles once it is ready (the real daemon stays alive on its servers); this handle keeps the
  // stand-in daemon's loop alive until the worker's stderr has closed.
  const keepAlive = setInterval(() => {}, 2 ** 30);
  const closed = new Promise((resolve) => child.stderr.once('end', resolve));
  await started;
  await closed;
  clearInterval(keepAlive);
  await log.flush();
  process.exit(0);
}

const mask = (text) => text.replace(/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] /g, '[<ISO>] ');
const run = (pastReady, allowStderr) => {
  const scenario = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-redirect-'));
  const err = fs.openSync(path.join(scenario, 'daemon.stderr'), 'a');
  const env = { ...process.env, MIXDOG_RECORD_PAST_READY: pastReady ? '1' : '0' };
  delete env.MIXDOG_DAEMON_ALLOW_STDERR;
  if (allowStderr) env.MIXDOG_DAEMON_ALLOW_STDERR = '1';
  const result = spawnSync(process.execPath, [process.argv[1], root, 'daemon', scenario], { stdio: ['ignore', err, err], env });
  if (result.status !== 0) throw new Error(`daemon exited ${result.status}`);
  const read = (name) => (fs.existsSync(path.join(scenario, name)) ? fs.readFileSync(path.join(scenario, name), 'utf8') : null);
  const out = { daemonStderr: mask(read('daemon.stderr')), daemonLog: read('daemon.log') && mask(read('daemon.log')), memoryProxyLog: mask(read('memory-runtime-proxy.log')) };
  fs.rmSync(scenario, { recursive: true, force: true });
  return out;
};
process.stdout.write(`${JSON.stringify({ 'before-ready': run(false, false), 'allow-stderr': run(true, true) }, null, 2)}\n`);
