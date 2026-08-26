// Machine-wide child-spawn budget: every runtime shard must stay on the
// daemon-owned gate. Two ways that silently breaks (and multiplies the cap by
// the shard count) are covered here: an inherited env flag activating the
// process-local lane in a grandchild, and one failed lease latching a shard
// off the remote budget for the rest of its life.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isSessionRuntimeWorkerProcess } from './child-spawn-remote.mjs';

const REMOTE_URL = new URL('./child-spawn-remote.mjs', import.meta.url).href;
const GATE_URL = new URL('./child-spawn-gate.mjs', import.meta.url).href;

const CHILD_SOURCE = `
const inherited = process.env.STUB_PID_MODE === 'inherited';
process.env.MIXDOG_SESSION_RUNTIME_WORKER = '1';
// A grandchild inherits BOTH variables; only its own pid differs.
process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = inherited
  ? String(process.pid + 1)
  : String(process.pid);
const remote = await import(process.env.REMOTE_URL);
const gate = await import(process.env.GATE_URL);
const report = { enabled: remote.remoteSpawnLeasesEnabled(), mode: gate.snapshot().mode };
if (!inherited) {
  try {
    await remote.acquireRemoteSpawnLease({ lane: 'search', ownerKey: 'test', waitTimeoutMs: 30000 });
    report.firstLease = 'granted';
  } catch (error) {
    report.firstLease = String(error?.code || error?.message || error);
  }
  report.enabledAfterFailure = remote.remoteSpawnLeasesEnabled();
  report.modeAfterFailure = gate.snapshot().mode;
  const release = await remote.acquireRemoteSpawnLease({ lane: 'search', ownerKey: 'test', waitTimeoutMs: 30000 });
  report.secondLease = typeof release === 'function' ? 'granted' : 'unexpected';
  release();
}
process.send({ type: 'report', report });
setTimeout(() => process.exit(0), 50).unref?.();
`;

async function runChild(mode, { onLease = () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-spawn-remote-'));
  const entry = join(dir, 'child.mjs');
  await writeFile(entry, CHILD_SOURCE, 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(entry, [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          STUB_PID_MODE: mode,
          REMOTE_URL,
          GATE_URL,
        },
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('child spawn-lease probe timed out'));
      }, 20_000);
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('message', (message) => {
        if (message?.type === 'spawn-lease') {
          onLease(child, message);
          return;
        }
        if (message?.type !== 'report') return;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve({ ...message.report, stderr });
      });
      child.on('error', reject);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('only the pid-scoped runtime worker uses the machine-wide spawn budget', () => {
  assert.equal(isSessionRuntimeWorkerProcess({ MIXDOG_SESSION_RUNTIME_WORKER_PID: '4242' }, 4242), true);
  assert.equal(isSessionRuntimeWorkerProcess({ MIXDOG_SESSION_RUNTIME_WORKER_PID: '4242' }, 99), false);
  // The inheritable flag alone can never claim the runtime IPC channel.
  assert.equal(isSessionRuntimeWorkerProcess({ MIXDOG_SESSION_RUNTIME_WORKER: '1' }, 99), false);
  assert.equal(isSessionRuntimeWorkerProcess({}, 99), false);
});

test('a grandchild that inherited the worker flag stays on its own local lane', async () => {
  const report = await runChild('inherited');
  assert.equal(report.enabled, false);
  assert.equal(report.mode, 'local');
});

test('a failed lease never latches a shard off the machine-wide budget', async () => {
  let leases = 0;
  const report = await runChild('shard', {
    onLease: (child, message) => {
      leases += 1;
      // First lease fails the way a momentarily unreachable pool does.
      child.send(leases === 1
        ? {
          type: 'spawn-lease-result',
          leaseId: message.leaseId,
          ok: false,
          error: 'pool channel unavailable',
          code: 'ELEASEFALLBACK',
        }
        : { type: 'spawn-lease-result', leaseId: message.leaseId, ok: true });
    },
  });
  assert.equal(report.enabled, true);
  assert.equal(report.mode, 'remote-lease');
  assert.equal(report.firstLease, 'ELEASEFALLBACK');
  // Recovery: the shard is still on the daemon budget and the next lease is
  // granted remotely instead of silently using a per-process lane.
  assert.equal(report.enabledAfterFailure, true);
  assert.equal(report.modeAfterFailure, 'remote-lease');
  assert.equal(report.secondLease, 'granted');
  assert.equal(leases, 2);
});
