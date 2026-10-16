import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonShouldDetach, spawnDaemonCandidate, stopInTreeDaemon } from './session-client.mjs';
import { IN_TREE_DAEMON_STOP_GRACE_MS } from './daemon-stop-budget.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';

// A stand-in daemon with the real stop contract: POST /stop {force:true}
// answers, then the process runs a short teardown before it exits.
const stubDaemon = (infoPath, stoppedPath, wedged = false) => `
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const infoPath = ${JSON.stringify(infoPath)};
const stoppedPath = ${JSON.stringify(stoppedPath)};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    if (!${JSON.stringify(wedged)} && req.url === '/stop' && JSON.parse(body || '{}').force === true) {
      server.close();
      setTimeout(() => { writeFileSync(stoppedPath, 'teardown ran'); process.exit(0); }, 300);
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(infoPath, JSON.stringify({ pid: process.pid, port: server.address().port }));
  process.send?.({ type: 'ready' });
});
`;

// In-tree spawns happen only in the Windows Desktop's Electron main process.
function inTreeLauncher(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-in-tree-stop-'));
  const previous = {
    type: process.type,
    dataDir: process.env.MIXDOG_DATA_DIR,
    runtimeRoot: process.env.MIXDOG_RUNTIME_ROOT,
    execArgv: process.execArgv,
  };
  const pids = [];
  t.after(async () => {
    for (const pid of pids) {
      if (isPidAlive(pid)) process.kill(pid);
      for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await delay(20);
    }
    // The launcher closes its crash-capture file on the child's 'exit' event.
    if (pids.length) await delay(300);
    process.type = previous.type;
    process.execArgv = previous.execArgv;
    if (previous.dataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous.dataDir;
    if (previous.runtimeRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previous.runtimeRoot;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_RUNTIME_ROOT = join(root, 'runtime');
  process.execArgv = [];
  return {
    root,
    async spawn({ wedged = false } = {}) {
      process.type = 'browser';
      assert.equal(daemonShouldDetach(), false);
      const infoPath = join(root, `info-${wedged}.json`);
      const stoppedPath = join(root, `stopped-${wedged}.txt`);
      const entry = join(root, `stub-daemon-${wedged}.mjs`);
      writeFileSync(entry, stubDaemon(infoPath, stoppedPath, wedged));
      await spawnDaemonCandidate({ cwd: root, timeoutMs: 20_000, entry, log: () => {} });
      const info = JSON.parse(readFileSync(infoPath, 'utf8'));
      pids.push(info.pid);
      for (let i = 0; i < 20 && !isPidAlive(info.pid); i += 1) await delay(10);
      return { ...info, stoppedPath, discovery: { pid: info.pid, port: info.port, token: 'test' } };
    },
  };
}

test('launcher quit stops its in-tree daemon gracefully and waits for it', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const launcher = inTreeLauncher(t);
  // Not in-tree yet: nothing to stop.
  assert.equal(await stopInTreeDaemon({ timeoutMs: 100, discovery: null }), false);

  const daemon = await launcher.spawn();
  const stopped = await stopInTreeDaemon({ timeoutMs: 10_000, discovery: daemon.discovery });
  assert.equal(stopped, true, 'the in-tree daemon exited within the bound');
  assert.equal(isPidAlive(daemon.pid), false);
  assert.equal(existsSync(daemon.stoppedPath), true, 'its teardown ran before exit');
});

test('a daemon that does not exit holds the quit for the default bound only', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const launcher = inTreeLauncher(t);
  const daemon = await launcher.spawn({ wedged: true });
  const startedAt = Date.now();
  assert.equal(await stopInTreeDaemon({ discovery: daemon.discovery }), false);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs >= IN_TREE_DAEMON_STOP_GRACE_MS - 100 && elapsedMs < IN_TREE_DAEMON_STOP_GRACE_MS + 1_000,
    `waited the ${IN_TREE_DAEMON_STOP_GRACE_MS}ms default bound (${elapsedMs}ms)`
  );
  assert.equal(isPidAlive(daemon.pid), true, 'the app exit, not this wait, ends it');
});
