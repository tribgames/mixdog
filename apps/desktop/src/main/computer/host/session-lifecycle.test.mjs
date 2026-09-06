import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

test('abort does not report cleanup success before elevated termination is confirmed', async () => {
  for (const confirmed of [true, false]) {
    const computerUseCoordinator = new ComputerUseCoordinator();
    let confirm;
    let cancellationRequested = false;
    const stopped = new Promise((resolve) => { confirm = resolve; });
    const execution = createExecutionState();
    const active = { sessionId: 'test', aborted: false };
    execution.activeExecutionsBySession.set('test', active);
    const host = createSessionLifecycle({
      coordinator: computerUseCoordinator,
      powerShellBySession: new Map(),
      workerLastUsedAt: new Map(),
      retirePowerShell() {},
      callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: () => { cancellationRequested = true; return stopped; },
      elevatedSessionIds: () => ['test'],
      sessionIdFor: () => 'test',
      releaseSessionState() {},
      invalidateWorkerGeneration() {},
      releaseCaptureSession() {},
      execution,
      runCommand: async () => ({ text: '' }),
      recaptureRequiredReply: async () => null,
    });
    let finished = false;
    const abort = host.abortComputerSession({ action: 'session_abort', session_id: 'test' })
      .finally(() => { finished = true; });
    await Promise.resolve();
    assert.equal(cancellationRequested, true);
    assert.equal(active.aborted, true);
    assert.equal(finished, false);
    confirm(confirmed);
    if (confirmed) assert.match((await abort).text, /session aborted/);
    else {
      await assert.rejects(abort, /computer_abort_cleanup_unconfirmed/);
      assert.throws(() => computerUseCoordinator.resumeAfterUserTakeover(), /computer_cleanup_pending/);
    }
  }
});

test('abort keeps target acquisition and resume blocked until worker exit AND input cleanup finish', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  execution.activeExecutionsBySession.set('a', { sessionId: 'a', aborted: false });
  let exitWorker;
  let cleanInput;
  const stopped = new Promise((resolve) => { exitWorker = resolve; });
  const cleaned = new Promise((resolve) => { cleanInput = resolve; });
  const host = createSessionLifecycle({
    coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: () => stopped, elevatedSessionIds: () => ['a'],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: () => cleaned, runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
  });
  await host.claimComputerTargets({ session_id: 'a' }, ['hwnd:0x1']);
  const aborted = host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  await assert.rejects(host.claimComputerTargets({ session_id: 'b' }, ['hwnd:0x1']), /computer_cleanup_pending/);
  assert.throws(() => coordinator.resumeAfterUserTakeover(), /computer_cleanup_pending/);
  exitWorker(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => coordinator.assertAutomationAllowed(), /computer_cleanup_pending/);
  cleanInput(true);
  await aborted;
  coordinator.resumeAfterUserTakeover();
  await host.claimComputerTargets({ session_id: 'b' }, ['hwnd:0x1']);
  coordinator.reset();
});
