import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalManager } from '../main/terminal-manager.ts';
import { createTerminalConnectGate } from './terminal-connect-gate.ts';

// A terminal pane's connects (TerminalPane) against the real PTY manager, whose
// spawns the test counts: a warm-up attaches only, the real open ensures.

function managerWithCountedSpawns() {
  const manager = new TerminalManager();
  const shell = { spawns: 0, exit: null };
  manager.loadPtyBindings = async () => ({
    spawn: () => {
      shell.spawns += 1;
      return {
        onData() {},
        onExit(listener) {
          shell.exit = listener;
        },
        write() {},
        resize() {},
        kill() {},
      };
    },
  });
  const running = (id) => manager.terminals.get(id)?.disposed === false;
  return { manager, shell, running };
}

/** A pane's gate whose connects the test can await (`idle`). */
function paneGate(manager, id, warm) {
  const calls = [];
  let running = Promise.resolve();
  const gate = createTerminalConnectGate(warm, (mode) => {
    calls.push(mode);
    running = mode === 'attach' ? manager.attach(id) : manager.ensure(id, null);
    return running;
  });
  const idle = async () => {
    for (let settled = null; settled !== running; ) {
      settled = running;
      await settled;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { gate, calls, idle };
}

test('warm attach succeeds, the shell exits, then the real open ensures it again', async () => {
  const { manager, shell, running } = managerWithCountedSpawns();
  const id = 'session-terminal:warm-exit';
  await manager.ensure(id, null);
  assert.equal(shell.spawns, 1);

  const pane = paneGate(manager, id, true);
  pane.gate.connect();
  await pane.idle();
  assert.deepEqual(pane.calls, ['attach'], 'the hover attaches');
  assert.equal(shell.spawns, 1, 'attaching to the live shell spawns nothing');

  shell.exit({ exitCode: 0 });
  assert.equal(running(id), false, 'the shell is gone before the open');

  pane.gate.open();
  await pane.idle();
  assert.deepEqual(pane.calls, ['attach', 'ensure'], 'the open ensures');
  assert.equal(shell.spawns, 2, 'the exited shell is started again by the open');
  assert.equal(running(id), true);
});

test('the open ensures a live shell idempotently: the same PTY, no second spawn', async () => {
  const { manager, shell } = managerWithCountedSpawns();
  const id = 'session-terminal:warm-live';
  await manager.ensure(id, null);
  const pane = paneGate(manager, id, true);
  pane.gate.connect();
  await pane.idle();
  pane.gate.open();
  await pane.idle();
  assert.deepEqual(pane.calls, ['attach', 'ensure']);
  assert.equal(shell.spawns, 1);
});

test('a hover that never opens spawns nothing for a never-started or exited shell', async () => {
  const { manager, shell, running } = managerWithCountedSpawns();
  const fresh = paneGate(manager, 'session-terminal:never', true);
  fresh.gate.connect();
  await fresh.idle();
  fresh.gate.connect();
  await fresh.idle();
  assert.equal(shell.spawns, 0);
  assert.equal(manager.terminals.size, 0);

  const id = 'session-terminal:exited';
  await manager.ensure(id, null);
  shell.exit({ exitCode: 0 });
  const exited = paneGate(manager, id, true);
  exited.gate.connect();
  await exited.idle();
  assert.deepEqual(exited.calls, ['attach']);
  assert.equal(shell.spawns, 1, 'only the first ensure ever spawned');
  assert.equal(running(id), false);
});

test('an open during the warm attach ensures after it, never alongside it', async () => {
  const { manager } = managerWithCountedSpawns();
  const id = 'session-terminal:mid-attach';
  const order = [];
  const attachAnswer = Promise.withResolvers();
  const gate = createTerminalConnectGate(true, async (mode) => {
    order.push(`${mode}:start`);
    if (mode === 'attach') await attachAnswer.promise;
    else await manager.ensure(id, null);
    order.push(`${mode}:end`);
  });
  gate.connect();
  gate.open();
  gate.connect();
  assert.deepEqual(order, ['attach:start'], 'the ensure waits for the attach in flight; no duplicate connect');
  attachAnswer.resolve(null);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['attach:start', 'attach:end', 'ensure:start', 'ensure:end']);
  assert.equal(gate.mode, 'ensure');
});

test('a pane mounted open ensures from its first connect; open adds nothing', async () => {
  const { manager, shell } = managerWithCountedSpawns();
  const pane = paneGate(manager, 'session-terminal:cold-open', false);
  pane.gate.connect();
  pane.gate.open();
  await pane.idle();
  assert.deepEqual(pane.calls, ['ensure']);
  assert.equal(shell.spawns, 1);
});
