import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCommandService } from './command-service.ts';
import { assertPublicComputerRequest } from './request-policy.ts';
import { createUserWaitService } from './user-wait-service.ts';
import { computerUseCoordinator as coordinator } from '../session/coordinator.ts';
import { computerUseOverlayPresentation } from '../overlay/model.ts';

/** An endpoint that admits everything. */
const endpoint = { signal: new AbortController().signal, commit() {}, track() {} };

test('user wait bypasses execution queues, permits concurrent discovery and releases on resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-user-wait-bridge-'));
  let serial = 0,
    aborts = 0,
    announce;
  const waiting = new Promise((resolve) => {
    announce = resolve;
  });
  const service = createUserWaitService({
    directory,
    enabled: () => false,
    callPowerShell: async () => {
      throw new Error('unexpected idle observation');
    },
    lifecycle: { resumeAfterTakeover: async () => {} },
  });
  service.configure(0);
  const server = createCommandService({
    powerShellBySession: new Map(),
    elevatedSessionIds: () => [],
    reapIdleSessionWorkers() {},
    abortComputerSession: async () => {
      aborts++;
      return { text: 'aborted' };
    },
    executeSerialized: async () => {
      serial++;
      return { text: '{"ok":true,"windows":[]}' };
    },
    waitForUser: async (command, signal) => {
      announce();
      return service.command(command, signal);
    },
  });
  try {
    coordinator.beginCommand({ sessionId: 'a', action: 'type', mode: 'foreground' });
    coordinator.pauseForUser('user_pause');
    const send = (command) => {
      try {
        assertPublicComputerRequest(command);
      } catch (error) {
        return Promise.resolve({ ok: false, error: `invalid request: ${error.message}` });
      }
      return server.answerCommand(command, endpoint);
    };
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
    service.dispose();
    await server.stop();
    coordinator.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a cancelled turn that held a pause ends it, so nothing is left on screen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-abort-pause-bridge-'));
  let aborts = 0;
  const server = createCommandService({
    powerShellBySession: new Map(),
    elevatedSessionIds: () => [],
    reapIdleSessionWorkers() {},
    abortComputerSession: async () => {
      aborts++;
      return { text: 'computer session aborted' };
    },
    executeSerialized: async () => ({ text: '{"ok":true}' }),
  });
  try {
    coordinator.beginCommand({ sessionId: 'cancelled', action: 'click', mode: 'foreground' });
    coordinator.finishCommand('cancelled');
    coordinator.pauseForUser('user_pause');
    // A cancelled turn sends session_abort and never execution_end.
    const reply = await server.answerCommand({ action: 'session_abort', session_id: 'cancelled' }, endpoint);
    assert.equal(reply.ok, true);
    assert.equal(aborts, 1);
    const snapshot = coordinator.snapshot();
    assert.equal(snapshot.userControlActive, false);
    assert.equal(computerUseOverlayPresentation(snapshot, 'ko').visible, false);
  } finally {
    await server.stop();
    coordinator.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('idle preference persists and malformed preferences fail closed to manual mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-idle-preference-'));
  const options = {
    directory,
    enabled: () => false,
    callPowerShell: async () => ({ ok: false }),
    lifecycle: { resumeAfterTakeover: async () => {} },
  };
  let service;
  try {
    service = createUserWaitService(options);
    service.configure(12);
    service.dispose();
    service = createUserWaitService(options);
    assert.equal(coordinator.snapshot().idleResumeSeconds, 12);
    assert.throws(() => service.configure(61), /invalid/);
    service.dispose();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'computer-idle-resume.json'), '{invalid');
    service = createUserWaitService(options);
    assert.equal(coordinator.snapshot().idleResumeSeconds, 0);
  } finally {
    service?.dispose();
    coordinator.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
