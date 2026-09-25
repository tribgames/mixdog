import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { RESPONSE_MARKER } from './program.ts';
import { createSessionLifecycle } from '../host/session-lifecycle.ts';
import { createExecutionState } from '../host/execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

test('retirement distinguishes read, semantic, character and press/release lifetimes', async () => {
  for (const [request, held] of [
    [{ action: 'snapshot' }, false],
    [{ action: 'window_capture' }, false],
    [{ action: 'validate_background_input' }, false],
    ...[
      'invoke_menu',
      'focus_window',
      'move_window',
      'set_value',
      'toggle',
      'launch',
      'clipboard_write',
      'mouse_move',
      'scroll',
    ].map((action) => [{ action }, false]),
    ...['click', 'drag', 'key'].map((action) => [{ action }, true]),
    [{ action: 'type', text: 'plain characters' }, false],
    [{ action: 'type', text: 'line\nbreak' }, true],
    [{ action: 'type', text: 'point-targeted', x: 0, y: 0 }, true],
    [{ action: 'sequence_step', step: { action: 'type', text: 'plain characters' } }, false],
    [{ action: 'sequence_step', step: { action: 'type', text: 'line\nbreak' } }, true],
  ]) {
    const action = request.action;
    const readOnly = ['snapshot', 'window_capture', 'validate_background_input'].includes(action);
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
      dataDirectory: () => directory,
      isBridgeEnabled: () => false,
      isDisposed: () => false,
      spawnProcess: () =>
        Object.assign(new EventEmitter(), {
          pid: 123,
          killed: false,
          exitCode: null,
          signalCode: null,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill() {
            this.killed = true;
            this.exitCode = 0;
            this.emit('exit', 0);
            return true;
          },
        }),
      onSessionRetired: (...args) => {
        retired.push(args[2]);
        lifecycle.onSessionWorkerRetired(...args);
      },
    });
    lifecycle = createSessionLifecycle({
      ...pool,
      coordinator,
      execution,
      sessionIdFor: (command) => command.session_id,
      releaseSessionState() {},
      releaseCaptureSession() {},
      invalidateWorkerGeneration() {
        invalidated++;
      },
      runCommand: async () => ({ text: '' }),
      recaptureRequiredReply: async () => null,
      cleanupInput: async () => {
        cleanupCalls++;
        return true;
      },
    });
    try {
      const pending = pool.callPowerShell({ ...request, session_id: 'a', delivery: 'background' });
      const rejected = assert.rejects(pending, /fixture termination/);
      pool.retirePowerShell(pool.powerShellBySession.get('a'), new Error('fixture termination'));
      await rejected;
      assert.deepEqual(retired, [!readOnly]);
      assert.equal(invalidated, 1);
      assert.equal(pool.hasUnconfirmedBackgroundInput(), held);
      if (readOnly) {
        assert.equal(active.aborted, false);
        coordinator.assertAutomationAllowed();
        assert.equal(pool.hasUnconfirmedBackgroundInput('a'), false);
      } else if (!held) {
        await lifecycle.abortComputerSession({ action: 'session_abort', session_id: 'a' });
        assert.equal(active.aborted, true, 'an uncertain mutation must never be replayed');
        assert.equal(pool.hasUnconfirmedBackgroundInput('a'), false);
        assert.equal(cleanupCalls, 1);
        coordinator.assertAutomationAllowed();
      } else {
        await assert.rejects(
          lifecycle.abortComputerSession({ action: 'session_abort', session_id: 'a' }),
          /background message sender stopped without a release receipt/
        );
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
    a.removeHostScript();
    b.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new host removes scripts left by dead processes and keeps every live one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-host-orphans-'));
  const dead = join(directory, 'computer-host-2147483000-0123456789abcdef01234567.ps1');
  const live = join(directory, `computer-host-${process.pid}-aaaaaaaaaaaaaaaaaaaaaaaa.ps1`);
  const unrelated = join(directory, 'computer-host.ps1');
  for (const path of [dead, live, unrelated]) await writeFile(path, '');
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
  });
  try {
    const script = pool.ensureHostScript();
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(script), true);
  } finally {
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture cleanup failure unpublishes the worker before resolving its original reply', async () => {
  for (const status of ['confirmed', 'failed', 'unconfirmed', 'unknown']) {
    const directory = await mkdtemp(join(tmpdir(), 'mixdog-capture-retirement-'));
    const children = [];
    const pool = createWorkerPool({
      dataDirectory: () => directory,
      isBridgeEnabled: () => false,
      isDisposed: () => false,
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: 100 + children.length,
          killed: false,
          exitCode: null,
          signalCode: null,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill() {
            this.killed = true;
            return true;
          },
        });
        children.push(child);
        return child;
      },
    });
    try {
      const pending = pool.callPowerShell({ action: 'window_capture', session_id: 'a', read_only: true });
      const original = pool.powerShellBySession.get('a');
      const request = JSON.parse(original.stdin.read().toString());
      const reply = {
        id: request.id,
        ok: false,
        error: 'capture_timeout|fixture',
        result: { capture_cleanup: { status } },
      };
      original.stdout.write(`${RESPONSE_MARKER + JSON.stringify(reply)}\n`);
      assert.deepEqual(await pending, reply);
      assert.equal(original.exitCode, null, 'the exit acknowledgment is deliberately delayed');
      assert.equal(pool.powerShellBySession.has('a'), status === 'confirmed');
      assert.equal(pool.ensurePowerShell('a') === original, status === 'confirmed');
      assert.equal(pool.hasUnconfirmedBackgroundInput('a'), false);
    } finally {
      for (const child of children) {
        child.exitCode = 0;
        child.emit('exit', 0);
      }
      pool.removeHostScript();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
