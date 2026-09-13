import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { createSessionLifecycle } from '../host/session-lifecycle.ts';
import { createExecutionState } from '../host/execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

test('retired reads can recover, but a killed background sender cannot claim input release', async () => {
  for (const action of ['snapshot', 'click']) {
    const directory = await mkdtemp(join(tmpdir(), 'mixdog-retirement-'));
    const coordinator = new ComputerUseCoordinator();
    const execution = createExecutionState();
    const active = { sessionId: 'a', aborted: false };
    execution.activeExecutionsBySession.set('a', active);
    const retired = [];
    let lifecycle;
    let invalidated = 0;
    let cleanupCalls = 0;
    const pool = createWorkerPool({
      dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false,
      spawnProcess: () => Object.assign(new EventEmitter(), {
        pid: 123, killed: false, exitCode: null, signalCode: null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill() {
          this.killed = true;
          this.exitCode = 0;
          this.emit('exit', 0);
          return true;
        },
      }),
      onSessionRetired: (...args) => { retired.push(args[2]); lifecycle.onSessionWorkerRetired(...args); },
    });
    lifecycle = createSessionLifecycle({
      ...pool, coordinator, execution, sessionIdFor: (command) => command.session_id,
      releaseSessionState() {}, releaseCaptureSession() {}, invalidateWorkerGeneration() { invalidated++; },
      runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
      cleanupInput: async () => { cleanupCalls++; return true; },
    });
    try {
      const pending = pool.callPowerShell({ action, session_id: 'a', delivery: 'background' });
      const rejected = assert.rejects(pending, /fixture termination/);
      pool.retirePowerShell(pool.powerShellBySession.get('a'), new Error('fixture termination'));
      await rejected;
      assert.deepEqual(retired, [action === 'click']);
      assert.equal(invalidated, 1);
      if (action === 'snapshot') {
        assert.equal(active.aborted, false);
        coordinator.assertAutomationAllowed();
        assert.equal(pool.hasUnconfirmedBackgroundInput('a'), false);
      } else {
        await assert.rejects(lifecycle.abortComputerSession({ action: 'session_abort', session_id: 'a' }),
          /background message sender stopped without a release receipt/);
        assert.equal(active.aborted, true);
        assert.equal(cleanupCalls, 0);
        assert.throws(() => coordinator.resumeAfterUserTakeover(), /computer_cleanup_pending/);
      }
    } finally {
      pool.removeHostScript();
      coordinator.reset();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('closing one profile never removes the host script another profile will restart from', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-host-profiles-'));
  const options = { dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false };
  const a = createWorkerPool(options);
  const b = createWorkerPool(options);
  try {
    const first = a.ensureHostScript();
    const second = b.ensureHostScript();
    assert.notEqual(first, second);
    const original = await readFile(second);
    a.removeHostScript();
    assert.deepEqual(await readFile(b.ensureHostScript()), original);
  } finally {
    a.removeHostScript(); b.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
