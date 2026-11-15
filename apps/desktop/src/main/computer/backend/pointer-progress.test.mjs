import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { RESPONSE_MARKER } from './program.ts';

// macOS and Linux spawn the native backend: the pool names its binary before
// handing the spawn to these tests' fakes, which never run it.
process.env.MIXDOG_COMPUTER_BIN ||= 'mixdog-computer';

/** Polls until the condition holds, failing at a deadline instead of hanging. */
async function until(condition, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

for (const command of [
  { action: 'sequence_step', step: { action: 'drag', window_id: 'hwnd:0x123' }, delivery: 'background' },
  { action: 'click', ref: 's1:e0', delivery: 'background' },
  { action: 'scroll', delivery: 'background' },
  { action: 'type', delivery: 'background' },
  { action: 'key', delivery: 'background' },
  { action: 'set_value', delivery: 'background' },
  { action: 'drag', delivery: 'foreground' },
  { action: 'click', ref: 's1:e0', delivery: 'foreground' },
  { action: 'scroll', delivery: 'foreground' },
  { action: 'type', delivery: 'foreground' },
  { action: 'key', delivery: 'foreground' },
])
  test(`${command.action}/${command.delivery} progress remains bound to the pending worker`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mixdog-pointer-progress-'));
    const children = [];
    const events = [];
    let request;
    const pool = createWorkerPool({
      dataDirectory: () => directory,
      isBridgeEnabled: () => false,
      isDisposed: () => false,
      onPointerProgress: (...event) => events.push(event),
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 500 + children.length;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.stdin.on('data', (line) => {
          request = JSON.parse(line.toString());
        });
        child.kill = () => {
          child.killed = true;
          child.emit('exit', 0);
          return true;
        };
        children.push(child);
        return child;
      },
    });
    try {
      let settled = false;
      const pending = pool.callPowerShell({ ...command, window_id: 'hwnd:0x123', session_id: 'a' }).then((value) => {
        settled = true;
        return value;
      });
      await until(() => request !== undefined && pool.powerShellBySession.has('a'), 'the worker request');
      const child = pool.powerShellBySession.get('a');
      assert.equal(request.pointer_feedback, true);
      const emit = (data) => child.stdout.write(`@@MIXDOG_POINTER@@${JSON.stringify(data)}\n`);
      emit({ id: request.id + 100, x: 1, y: 2, held: true });
      emit({ id: request.id, x: 'bad', y: 2, held: true });
      emit({ id: request.id, x: 3100, y: 900, held: true, window_id: 'hwnd:0xBAD' });
      emit({ id: request.id, x: 3200, y: 1000, held: false });
      emit({ id: request.id, x: 3200, y: 1000, held: false, phase: 'prepare' });
      emit({ id: request.id, x: 3200, y: 1000, held: true, phase: 'press' });
      emit({ id: request.id, x: 3200, y: 1000, held: false, phase: 'release' });
      emit({ id: request.id, x: 3200, y: 1000, held: false, phase: 'scroll' });
      emit({ id: request.id, x: 3200, y: 1000, held: false, phase: 'type' });
      emit({ id: request.id, x: 0, y: 0, held: false, phase: 'unknown' });
      await until(() => events.length >= 7, 'the pointer progress events');
      assert.equal(settled, false);
      assert.deepEqual(events, [
        ['a', 3100, 900, true, command.delivery, 'drag', 'hwnd:0x123'],
        ['a', 3200, 1000, false, command.delivery, 'move', 'hwnd:0x123'],
        ['a', 3200, 1000, false, command.delivery, 'prepare', 'hwnd:0x123'],
        ['a', 3200, 1000, true, command.delivery, 'press', 'hwnd:0x123'],
        ['a', 3200, 1000, false, command.delivery, 'release', 'hwnd:0x123'],
        ['a', 3200, 1000, false, command.delivery, 'scroll', 'hwnd:0x123'],
        ['a', 3200, 1000, false, command.delivery, 'type', 'hwnd:0x123'],
      ]);
      child.stdout.write(`${RESPONSE_MARKER}${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
      await pending;
      // The pool's data listener runs before this one, so the late event has
      // been handled by the time the chunk reaches here.
      const late = new Promise((resolve) => child.stdout.once('data', resolve));
      emit({ id: request.id, x: 0, y: 0, held: true });
      await late;
      assert.equal(events.length, 7);
    } finally {
      for (const child of children) pool.retirePowerShell(child, new Error('fixture cleanup'));
      // Native workers publish no PowerShell host script.
      await rm(directory, { recursive: true, force: true });
    }
  });
