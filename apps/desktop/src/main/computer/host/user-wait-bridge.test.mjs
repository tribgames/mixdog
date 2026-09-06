import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridgeServer } from './bridge-server.ts';
import { createUserWaitService } from './user-wait-service.ts';
import { computerUseCoordinator as coordinator } from '../session/coordinator.ts';

test('user wait bypasses execution queues, permits concurrent discovery and releases on resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-user-wait-bridge-'));
  let enabled = true, serial = 0, aborts = 0, announce;
  const waiting = new Promise((resolve) => { announce = resolve; });
  let watcher;
  let deadline;
  const discovery = new Promise((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('discovery timeout')), 5000);
    watcher = watch(directory, async () => {
      try {
        const value = JSON.parse(await readFile(join(directory, 'computer-bridge.json'), 'utf8'));
        if (!value.port) return;
        clearTimeout(deadline); watcher.close(); resolve(value);
      } catch { /* discovery is atomically published */ }
    });
  });
  const service = createUserWaitService({
    directory, enabled: () => false,
    callPowerShell: async () => { throw new Error('unexpected idle observation'); },
    lifecycle: { resumeAfterTakeover: async () => {} },
  });
  service.configure(0);
  const server = createBridgeServer({
    dataDirectory: () => directory, isBridgeWanted: () => enabled, isDisposed: () => false,
    diagnose() {}, powerShellBySession: new Map(), elevatedSessionIds: () => [],
    callPowerShell: async () => ({ ok: true }), adoptWarmedWorker() {}, releaseSpareWorker() {},
    reapIdleSessionWorkers() {}, abortComputerSession: async () => { aborts++; return { text: 'aborted' }; },
    executeSerialized: async () => { serial++; return { text: '{"ok":true,"windows":[]}' }; },
    waitForUser: async (command, signal) => { announce(); return service.command(command, signal); },
  });
  try {
    coordinator.beginCommand({ sessionId: 'a', action: 'type', mode: 'foreground' });
    coordinator.pauseForUser('user_input_active');
    server.startBridge();
    const record = await discovery;
    const send = (command) => fetch(`http://127.0.0.1:${record.port}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    }).then((response) => response.json());
    const pending = send({ action: 'wait_for_user', session_id: 'a', timeout_ms: 3000 });
    await waiting;
    assert.equal(serial, 0);
    assert.equal((await send({ action: 'list_windows', session_id: 'a' })).ok, true);
    assert.equal(serial, 1);
    coordinator.resumeAfterUserTakeover(coordinator.snapshot().takeoverGeneration);
    const result = await pending;
    assert.equal(JSON.parse(result.value.text).status, 'resumed');
    assert.equal(aborts, 0);
    const invalid = await send({ action: 'wait_for_user', session_id: 'a', timeout_ms: 120001 });
    assert.equal(invalid.ok, false);
    const forged = await send({ action: 'input_idle_state', session_id: '__computer_user_wait__' });
    assert.equal(forged.ok, false);
  } finally {
    clearTimeout(deadline); watcher?.close();
    service.dispose(); enabled = false;
    await server.stopBridge(); coordinator.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('idle preference persists and malformed preferences fail closed to manual mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-idle-preference-'));
  const options = { directory, enabled: () => false, callPowerShell: async () => ({ ok: false }),
    lifecycle: { resumeAfterTakeover: async () => {} } };
  let service;
  try {
    service = createUserWaitService(options);
    service.configure(12); service.dispose();
    service = createUserWaitService(options);
    assert.equal(coordinator.snapshot().idleResumeSeconds, 12);
    assert.throws(() => service.configure(61), /invalid/);
    service.dispose();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'computer-idle-resume.json'), '{invalid');
    service = createUserWaitService(options);
    assert.equal(coordinator.snapshot().idleResumeSeconds, 0);
  } finally {
    service?.dispose(); coordinator.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
