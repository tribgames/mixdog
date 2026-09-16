import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnDaemonCandidate } from './session-client.mjs';

// A stand-in daemon: boot diagnostics on fd 2, the same ready handshake the
// real daemon sends, then a known exit AFTER the launcher detached.
const STUB_DAEMON = `
process.stderr.write('stub daemon boot diagnostic\\n');
process.send?.({ type: 'ready' });
setTimeout(() => { process.exit(7); }, 150);
`;

test('the session launcher records the daemon exit and mirrors boot stderr once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const previous = {
    dataDir: process.env.MIXDOG_DATA_DIR,
    runtimeRoot: process.env.MIXDOG_RUNTIME_ROOT,
    execArgv: process.execArgv,
  };
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  // fork() inherits the runner's execArgv; the stub must run as a plain script.
  process.execArgv = [];
  t.after(() => {
    process.execArgv = previous.execArgv;
    if (previous.dataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous.dataDir;
    if (previous.runtimeRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previous.runtimeRoot;
  });

  const entry = join(root, 'stub-daemon.mjs');
  writeFileSync(entry, STUB_DAEMON);
  const logs = [];
  let resolveExit;
  const exitLogged = new Promise((resolve) => {
    resolveExit = resolve;
  });
  await spawnDaemonCandidate({
    cwd: root,
    timeoutMs: 20_000,
    entry,
    log: (line) => {
      logs.push(line);
      if (line.startsWith('daemon exit ')) resolveExit(line);
    },
  });
  assert.ok(
    logs.some((line) => line.startsWith('daemon ready at=')),
    'the ready handshake is logged'
  );

  const exitLine = await Promise.race([exitLogged, delay(20_000).then(() => null)]);
  assert.ok(exitLine, `the launcher logged the daemon exit: ${logs.join(' | ')}`);
  assert.match(exitLine, /code=7 signal=- ready=1 uptimeMs=\d+/);

  // Boot diagnostics survive the switch from a pipe to a capture file, once.
  assert.equal(logs.filter((line) => line.includes('stub daemon boot diagnostic')).length, 1);

  const captureDir = join(dataDir, 'daemon-crash');
  const recordName = readdirSync(captureDir).find((name) => name.endsWith('.json'));
  assert.ok(recordName, `a lifecycle record is persisted: ${readdirSync(captureDir).join(', ')}`);
  const record = JSON.parse(readFileSync(join(captureDir, recordName), 'utf8'));
  assert.equal(record.launcher, 'session-client');
  assert.equal(record.launcherPid, process.pid);
  assert.equal(record.ready, true);
  assert.equal(record.exitCode, 7);
  assert.equal(record.exitSignal, null);
  assert.ok(record.pid > 0);
  assert.ok(record.spawnedAt && record.readyAt && record.exitedAt);
  assert.match(exitLine, new RegExp(`pid=${record.pid}\\b`));
});
