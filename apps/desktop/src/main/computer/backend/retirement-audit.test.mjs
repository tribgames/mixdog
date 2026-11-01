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
import { createWorkerRequests } from './worker-requests.ts';
import { createSessionLifecycle } from '../host/session-lifecycle.ts';
import { createExecutionState } from '../host/execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

// macOS and Linux spawn the native backend: the pool names its binary before
// handing the spawn to these tests' fakes, which never run it.
process.env.MIXDOG_COMPUTER_BIN ||= 'mixdog-computer';

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
    // macOS background typing posts key-down/key-up per character.
    [{ action: 'type', text: 'plain characters' }, process.platform === 'darwin'],
    [{ action: 'type', text: 'line\nbreak' }, true],
    [{ action: 'type', text: 'point-targeted', x: 0, y: 0 }, true],
    [{ action: 'sequence_step', step: { action: 'type', text: 'plain characters' } }, process.platform === 'darwin'],
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

test('only the worker that sent an unacknowledged background release can later confirm it', async () => {
  const requests = createWorkerRequests();
  const worker = () =>
    Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      kill() {
        this.killed = true;
        return true;
      },
    });
  const sender = worker();
  const replacement = worker();
  let id = 0;
  const reply = (child, body) => {
    const requestId = ++id;
    const pending = requests.dispatch(
      child,
      requestId,
      '{}\n',
      { sessionId: 'a', pointerFeedback: false, mode: 'background', input: true, backgroundPressRelease: true },
      1000
    );
    requests.handleReply(JSON.stringify({ id: requestId, ...body }), child);
    return pending;
  };
  const unacknowledged =
    'input_cleanup_unconfirmed: background input release was not acknowledged; do not replay input';
  const confirmed = { ok: true, result: { text: 'held input released', background_release_confirmed: true } };
  await reply(sender, { ok: false, error: unacknowledged });
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true);
  await reply(sender, { ok: true, result: { text: 'clicked' } });
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true, 'an ordinary reply proves nothing');
  await reply(replacement, confirmed);
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true, 'another worker never sent that release');
  await reply(sender, { ok: false, error: unacknowledged });
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true, 'the resend was not acknowledged either');
  await reply(sender, confirmed);
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), false);
  // A release whose window closed first was never acknowledged, whatever comes after.
  await reply(sender, { ok: false, error: unacknowledged });
  await reply(sender, {
    ok: false,
    error:
      'input_cleanup_unconfirmed: background_target_gone|the target window closed before it acknowledged a background input release',
  });
  await reply(sender, confirmed);
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true, 'a closed window keeps the release unconfirmed');
  requests.clearUnconfirmedBackgroundInput();
  // A held key or button whose release failed is not a release the worker keeps to resend.
  await reply(sender, { ok: false, error: 'input_cleanup_unconfirmed: a held key could not be released' });
  await reply(sender, confirmed);
  assert.equal(requests.hasUnconfirmedBackgroundInput('a'), true);
});
