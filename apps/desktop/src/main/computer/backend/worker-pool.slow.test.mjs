import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';

test('retiring a host worker releases its session and process', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-pool-'));
  const retiredSessions = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false,
    onSessionRetired: (sessionId) => { retiredSessions.push(sessionId); },
  });
  try {
    const child = pool.ensurePowerShell('warm-up-race');
    const exited = Promise.race([once(child, 'exit'), once(child, 'error')]);
    pool.retirePowerShell(child, new Error('bridge disabled during warm-up'));
    assert.equal(pool.powerShellBySession.has('warm-up-race'), false);
    assert.deepEqual(retiredSessions, ['warm-up-race']);
    let timeout;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('retired computer host worker did not exit')), 5_000);
      })]);
    } finally { clearTimeout(timeout); }
  } finally {
    pool.releaseSpareWorker(); pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a per-command timeout retires a stuck provider instead of waiting for the global ceiling', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-timeout-'));
  const pool = createWorkerPool({ dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false });
  try {
    await assert.rejects(pool.callPowerShell({
      action: 'wait', duration: 1, session_id: 'provider-timeout', read_only: true,
    }, 100), /computer_command_timeout: command exceeded 100ms/);
    assert.equal(pool.powerShellBySession.has('provider-timeout'), false);
  } finally {
    pool.releaseSpareWorker(); pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the completed warm-up worker replaces a duplicate refill worker', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-adoption-'));
  const pool = createWorkerPool({ dataDirectory: () => directory, isBridgeEnabled: () => true, isDisposed: () => false });
  try {
    const warmed = pool.ensurePowerShell('warm-up-adoption');
    await new Promise((resolve) => setTimeout(resolve, 50));
    pool.adoptWarmedWorker('warm-up-adoption');
    assert.equal(pool.powerShellBySession.has('warm-up-adoption'), false);
    assert.equal(warmed.killed, false);
  } finally {
    for (const child of pool.powerShellBySession.values()) pool.retirePowerShell(child, new Error('test cleanup'));
    pool.releaseSpareWorker(); pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
