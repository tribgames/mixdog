import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ensureDaemon } from './session-client.mjs';

import { makeTempDirSync } from '../../scripts/lib/scoped-temp.mjs';
// Isolated data dir, runtime root and a plain-script fork (fork() inherits the
// runner's execArgv) for one ensureDaemon run.
function fixture(t) {
  const root = makeTempDirSync('daemon-unavailable');
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
  process.execArgv = [];
  const pids = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {}
    }
    process.execArgv = previous.execArgv;
    for (const [name, value] of [
      ['MIXDOG_DATA_DIR', previous.dataDir],
      ['MIXDOG_RUNTIME_ROOT', previous.runtimeRoot],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const stub = (source) => {
    const entry = join(root, `stub-${pids.length}-${Math.random().toString(16).slice(2)}.mjs`);
    writeFileSync(entry, source);
    return entry;
  };
  return { root, dataDir, runtimeRoot, captureDir: join(dataDir, 'daemon-crash'), stub, pids };
}

async function unavailableError(options) {
  try {
    await ensureDaemon(options);
  } catch (error) {
    return error;
  }
  assert.fail('ensureDaemon resolved without a daemon');
}

test('giving up names the newest candidate exit, its first stderr error and the capture folder', async (t) => {
  const env = fixture(t);
  const entry = env.stub(`
process.stderr.write('[daemon] boot-phase phase=daemon-main status=mark\\n');
process.stderr.write('[daemon] memory.start setup failed (non-fatal): skipped\\n');
process.stderr.write("[daemon] fatal boot error: Error: EACCES: permission denied, mkdir 'C:\\\\data\\\\daemon-owner.json.claim.lock'\\n    at mkdirSync (node:fs:1:1)\\n");
process.exit(2);
`);
  const error = await unavailableError({ attempts: 2, readyTimeoutMs: 20_000, entry });
  const lines = error.message.split('\n');
  assert.equal(lines[0], 'daemon session endpoint is unavailable');
  const candidate = lines.find((line) => line.startsWith('last daemon candidate'));
  assert.match(candidate, /^last daemon candidate \(attempt 2 of 2\): pid=\d+ exited code=2 signal=- after \d+ms/);
  assert.ok(
    lines.includes(
      "first stderr error: [daemon] fatal boot error: Error: EACCES: permission denied, mkdir 'C:\\data\\daemon-owner.json.claim.lock'"
    ),
    error.message
  );
  const capture = lines.find((line) => line.startsWith('stderr capture: '))?.slice('stderr capture: '.length);
  assert.ok(capture?.startsWith(env.captureDir) && capture.endsWith('.err.log') && existsSync(capture), error.message);
  assert.equal(lines.at(-1), `daemon crash captures: ${env.captureDir}`);
  assert.equal(error.daemonUnavailable.candidate.exitCode, 2);
});

test('a candidate still booting at the deadline is reported with its last stderr line', async (t) => {
  const env = fixture(t);
  const entry = env.stub(`
process.stderr.write('[daemon] boot-phase phase=owner-claimed status=mark\\n');
setInterval(() => {}, 1_000);
`);
  const error = await unavailableError({ attempts: 1, readyTimeoutMs: 1_500, entry });
  const pid = error.daemonUnavailable.candidate?.pid;
  if (pid) env.pids.push(pid);
  const lines = error.message.split('\n');
  assert.equal(lines[0], 'daemon session endpoint is unavailable');
  assert.match(
    lines.find((line) => line.startsWith('last daemon candidate')),
    /^last daemon candidate \(attempt 1 of 1\): pid=\d+ still running, not ready \d+ms after spawn$/
  );
  assert.ok(lines.includes('last stderr line: [daemon] boot-phase phase=owner-claimed status=mark'), error.message);
});

test('a live owner that never publishes is named when no candidate was spawned', async (t) => {
  const env = fixture(t);
  const claimedAt = new Date().toISOString();
  writeFileSync(
    join(env.dataDir, 'daemon-owner.json'),
    JSON.stringify({ kind: 'mixdog-daemon', pid: process.pid, claimedAt })
  );
  const error = await unavailableError({ attempts: 1, readyTimeoutMs: 300 });
  assert.deepEqual(error.message.split('\n'), [
    'daemon session endpoint is unavailable',
    `daemon owner: pid=${process.pid} (claimed ${claimedAt}) held the lock but never published an endpoint`,
    'no daemon candidate was spawned (spawn attempts allowed: 1)',
    `daemon crash captures: ${env.captureDir}`,
  ]);
});
