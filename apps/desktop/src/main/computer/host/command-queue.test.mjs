import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { buildRecaptureRequiredPayload } from '../observation/recapture.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const calls = [];
  const host = createSessionLifecycle({
    coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async (command) => { calls.push(command.action); return { text: command.action }; },
    recaptureRequiredReply: async (command, error) => {
      const payload = buildRecaptureRequiredPayload(command.action, error, {
        ok: true, action: 'capture', window_id: 'hwnd:0x1', frame_id: 'fresh',
      });
      if (!payload) return null;
      calls.push('recapture');
      return { text: JSON.stringify(payload) };
    },
    ...overrides,
  });
  t.after(async () => { await host.stopAllComputerSessions(); coordinator.reset(); });
  return { coordinator, execution, host, calls };
}

for (const reason of ['user_pause', 'user_input_active']) {
  test(`${reason} retains FIFO work without holding the resume drain or replaying stale input`, { timeout: 3000 }, async (t) => {
    const f = fixture(t);
    const first = f.host.executeSerialized({ action: 'capture', session_id: 'a' });
    const second = f.host.executeSerialized({ action: 'click', session_id: 'a', window_id: 'hwnd:0x1' });
    const third = f.host.executeSerialized({ action: 'clipboard_read', session_id: 'a' });
    f.host.takeOverComputer(reason);
    let settled = false;
    const results = Promise.all([first, second, third]).then((value) => { settled = true; return value; });
    await f.host.waitForCleanup();
    await turn();
    assert.equal(settled, false);
    assert.deepEqual(f.calls, []);
    await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
    const values = await results;
    assert.deepEqual(f.calls, ['capture', 'recapture', 'clipboard_read']);
    assert.equal(JSON.parse(values[1].text).verdict.recommended, 'retry_fresh_action');
    assert.equal(JSON.parse(values[1].text).observation.frame_id, 'fresh');
    assert.equal(f.coordinator.snapshot().userControlActive, false);
  });
}

test('work admitted during a pause is visible to Stop and must refresh its target on resume', { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  f.coordinator.pauseForUser('user_pause', ['a']);
  const pending = f.host.executeSerialized({ action: 'type', session_id: 'b', window_id: 'hwnd:0x1' });
  await turn();
  assert.ok(f.coordinator.snapshot().pausedSessionIds.includes('b'));
  // A safe probe cannot deadlock behind that parked request.
  assert.equal((await f.host.executeSerialized({ action: 'diagnose', session_id: 'b' })).text, 'diagnose');
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal(JSON.parse((await pending).text).code, 'computer_resume_recapture_required');
  assert.deepEqual(f.calls, ['diagnose', 'recapture']);
});

test('Stop cancels parked work even while its pause cleanup is still pending', { timeout: 3000 }, async (t) => {
  let clean;
  const f = fixture(t, { cleanupInput: () => new Promise((resolve) => { clean = resolve; }) });
  const one = f.host.executeSerialized({ action: 'capture', session_id: 'a' });
  const two = f.host.executeSerialized({ action: 'type', session_id: 'a' });
  const results = Promise.allSettled([one, two]);
  f.host.takeOverComputer('user_pause');
  await turn();
  const stopped = f.host.stopAllComputerSessions();
  await turn();
  assert.deepEqual((await results).map((result) => result.status), ['rejected', 'rejected']);
  assert.deepEqual(f.calls, []);
  clean(true);
  await stopped;
});

test('a queued foreground request yields its lane to cleanup instead of blocking resume', { timeout: 3000 }, async (t) => {
  let finish;
  const f = fixture(t, {
    runCommand: () => new Promise((resolve) => { finish = () => resolve({ text: 'late result' }); }),
  });
  const first = f.host.executeSerialized({ action: 'capture', session_id: 'a', delivery: 'foreground' });
  const firstResult = first.catch((error) => error);
  await turn();
  const second = f.host.executeSerialized({ action: 'click', session_id: 'b', delivery: 'foreground', window_id: 'hwnd:0x1' });
  await turn();
  f.host.takeOverComputer('user_pause');
  finish();
  assert.match(String(await firstResult), /session_aborted/);
  await f.host.waitForCleanup();
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal(JSON.parse((await second).text).verdict.recommended, 'retry_fresh_action');
  assert.deepEqual(f.calls, ['recapture']);
});

test('lost callers cancel only their parked queue and release its admission budget', { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  f.coordinator.pauseForUser('user_pause', ['a', 'b']);
  const a = Array.from({ length: 4 }, () => f.host.executeSerialized({ action: 'capture', session_id: 'a' }));
  const cancelled = Promise.allSettled(a);
  const b = f.host.executeSerialized({ action: 'capture', session_id: 'b' });
  await f.host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  assert.ok((await cancelled).every((result) => result.status === 'rejected'));
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal((await b).text, 'capture');
  assert.equal((await f.host.executeSerialized({ action: 'capture', session_id: 'a' })).text, 'capture');
});
