import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bindComputerEnvironmentGuard } from './environment-guard.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { createWorkerPool } from '../backend/worker-pool.ts';
import { waitForComputerWorkerExit } from '../backend/worker-capacity.ts';

test('desktop loss and geometry changes cancel queued work, release simulated held keys, and require explicit resume', async () => {
  const power = new EventEmitter(), displays = new EventEmitter();
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  let sent = 0, held = false, unblock;
  const run = new Promise((resolve) => { unblock = resolve; });
  const lifecycle = createSessionLifecycle({
    coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: async () => { held = false; return true; },
    runCommand: async () => {
      sent++; held = true;
      await run;
      execution.assertExecutionNotAborted();
      return { text: '{"ok":true}' };
    },
    recaptureRequiredReply: async () => null,
  });
  const unbind = bindComputerEnvironmentGuard(power, displays, lifecycle.takeOverComputer);
  const first = lifecycle.executeSerialized({ action: 'type', delivery: 'background', session_id: 'fixture' });
  const second = lifecycle.executeSerialized({ action: 'type', delivery: 'background', session_id: 'fixture' });
  const results = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held, true);
  power.emit('lock-screen');
  unblock();
  assert.ok((await results).every((value) => value.status === 'rejected'));
  assert.equal(await lifecycle.waitForCleanup(), true);
  assert.equal(held, false);
  assert.equal(sent, 1);
  power.emit('unlock-screen');
  assert.throws(() => coordinator.assertAutomationAllowed(), /computer_user_control_active/);
  for (let index = 0; index < 1000; index++) {
    coordinator.resumeAfterUserTakeover();
    coordinator.beginCommand({ sessionId: 'fixture', action: 'capture', target: 'fixture', mode: 'background' });
    displays.emit('display-metrics-changed', {}, {}, [index % 2 ? 'scaleFactor' : 'bounds']);
    assert.throws(() => coordinator.assertAutomationAllowed(), /computer_(user_control_active|cleanup_pending)/);
    await lifecycle.waitForCleanup();
    assert.throws(() => coordinator.assertAutomationAllowed(), /computer_user_control_active/);
  }
  assert.equal(execution.commandChainsBySession.size, 0);
  assert.equal(execution.activeExecutionsBySession.size, 0);
  unbind();
  assert.equal(power.listenerCount('lock-screen'), 0);
  assert.equal(displays.listenerCount('display-metrics-changed'), 0);
  coordinator.reset();
});

test('real child transport soak rejects interrupted mutations without replay or resident accumulation', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-transport-soak-'));
  const children = [];
  const sent = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false,
    maxWorkers: 2,
    spawnProcess: () => {
      const child = spawn(process.execPath, ['-e', `
        let pending = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\\n')) >= 0) {
            const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
            if (request.action === 'interrupt') process.exit(2);
            process.stdout.write('@@MIXCU@@' + JSON.stringify({id: request.id, ok: true, result: {ordinal: request.ordinal}}) + '\\n');
          }
        });
      `], { stdio: 'pipe', windowsHide: true });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { sent.push(JSON.parse(String(chunk))); return write(chunk, ...rest); };
      children.push(child);
      return child;
    },
  });
  try {
    for (let generation = 0; generation < 25; generation++) {
      for (let index = 0; index < 40; index++) {
        const ordinal = generation * 40 + index;
        const result = await pool.callPowerShell({ action: 'type', session_id: 'fixture', ordinal });
        assert.equal(result.result.ordinal, ordinal);
      }
      await assert.rejects(pool.callPowerShell({ action: 'interrupt', session_id: 'fixture' }), /exited/);
      assert.equal(await waitForComputerWorkerExit(children.at(-1)), true);
      assert.equal(pool.residentWorkerPids().length, 0);
      assert.equal(pool.powerShellBySession.size, 0);
      assert.equal(pool.workerLastUsedAt.size, 0);
    }
    assert.equal(sent.length, 1025);
    assert.equal(new Set(sent.filter((request) => request.action === 'type').map((request) => request.ordinal)).size, 1000);
    assert.equal(children.length, 25);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => waitForComputerWorkerExit(child)));
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
