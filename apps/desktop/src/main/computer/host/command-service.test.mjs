import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPACITY_REFUSAL, createCommandService } from './command-service.ts';

// `host/computer/command` runs the real dispatch under the service's allowance: these hold a command on a gate (no
// timing) and look at what the service does around it.
const CAPTURE = { action: 'capture', screen: 0, session_id: 's' };

function heldHost(extra = {}) {
  const started = [];
  const aborted = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  return {
    started,
    aborted,
    release: () => release(),
    host: {
      powerShellBySession: new Map(),
      elevatedSessionIds: () => [],
      abortComputerSession: async (command) => {
        aborted.push(command);
        return { text: 'aborted' };
      },
      executeSerialized: async (command) => {
        started.push(command);
        await gate;
        return { text: 'frame' };
      },
      reapIdleSessionWorkers: () => {},
      ...extra,
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** An endpoint that admits everything, under `signal`. */
const endpoint = (signal) => ({ signal, commit() {}, track() {} });

test('an abandoned command ends its session as a dropped caller did, and a finished one does not', async () => {
  const held = heldHost();
  const answer = createCommandService(held.host).answerCommand;
  const gone = new AbortController();
  const abandoned = answer(CAPTURE, endpoint(gone.signal));
  await settle();
  assert.equal(held.started.length, 1);
  gone.abort();
  await settle();
  assert.deepEqual(held.aborted, [CAPTURE]);
  held.release();
  await abandoned;

  const finished = heldHost();
  finished.release();
  const kept = new AbortController();
  assert.deepEqual(await createCommandService(finished.host).answerCommand(CAPTURE, endpoint(kept.signal)), {
    ok: true,
    value: { text: 'frame' },
  });
  kept.abort();
  await settle();
  assert.deepEqual(finished.aborted, []);
});

test('a spent allowance of 32 is refused as a failed request naming the refusal, and dispatches nothing', async () => {
  const held = heldHost();
  const answer = createCommandService(held.host).answerCommand;
  const signal = new AbortController().signal;
  const running = Array.from({ length: 32 }, () => answer(CAPTURE, endpoint(signal)));
  await settle();
  assert.deepEqual(await answer(CAPTURE, endpoint(signal)), { ok: false, error: CAPACITY_REFUSAL });
  assert.equal(held.started.length, 32);
  held.release();
  await Promise.all(running);
  assert.deepEqual(await answer(CAPTURE, endpoint(signal)), { ok: true, value: { text: 'frame' } });
});

const WINDOWS = { action: 'list_windows', session_id: 's' };
const LIFECYCLE = { action: 'execution_end', session_id: 's' };

test('lifecycle controls are admitted past 32 ordinary commands and refused at 40, with the literal refusal text', async () => {
  const held = heldHost();
  const answer = createCommandService(held.host).answerCommand;
  const signal = new AbortController().signal;
  const running = Array.from({ length: 32 }, () => answer(WINDOWS, endpoint(signal)));
  await settle();
  assert.equal(CAPACITY_REFUSAL, 'computer_capacity_exhausted: too many active requests');
  assert.deepEqual(await answer(WINDOWS, endpoint(signal)), { ok: false, error: CAPACITY_REFUSAL });
  for (let at = 0; at < 8; at++) running.push(answer(LIFECYCLE, endpoint(signal)));
  await settle();
  assert.equal(held.started.length, 40);
  assert.deepEqual(await answer(LIFECYCLE, endpoint(signal)), { ok: false, error: CAPACITY_REFUSAL });
  held.release();
  await Promise.all(running);
});

test('a command reclaims idle workers before it dispatches and releases its slot', async () => {
  const seen = [];
  let reaps = 0;
  const held = heldHost({
    reapIdleSessionWorkers: () => reaps++,
    executeSerialized: async (command) => {
      seen.push([command.action, reaps]);
      return { text: 'done' };
    },
  });
  const answer = createCommandService(held.host).answerCommand;
  const signal = new AbortController().signal;
  assert.deepEqual(await answer(WINDOWS, endpoint(signal)), { ok: true, value: { text: 'done' } });
  assert.deepEqual(seen, [['list_windows', 1]]);
  const running = Array.from({ length: 32 }, () => answer(WINDOWS, endpoint(signal)));
  assert.deepEqual(await Promise.all(running).then((all) => all.every((reply) => reply.ok)), true);
});

test('an oversized, over-budget or failed reply is an error answer, never a partial value', async () => {
  const signal = new AbortController().signal;
  const answerFor = (executeSerialized) =>
    createCommandService(heldHost({ executeSerialized }).host).answerCommand(WINDOWS, endpoint(signal));
  assert.deepEqual(await answerFor(async () => ({ text: 'x'.repeat(1_000_001) })), {
    ok: false,
    error: 'computer bridge returned invalid or oversized text',
  });
  assert.deepEqual(await answerFor(async () => ({ text: 'a', image: { mimeType: 'image/gif', data: 'x' } })), {
    ok: false,
    error: 'computer bridge returned an invalid or oversized image',
  });
  // Valid in every field, yet past the transport budget as a whole.
  assert.deepEqual(await answerFor(async () => ({ text: 'big', padding: 'x'.repeat(33 * 1024 * 1024) })), {
    ok: false,
    error: 'computer response exceeds byte limit; input may have executed and was not replayed',
  });
  assert.deepEqual(
    await answerFor(async () => {
      throw new Error('worker gone');
    }),
    { ok: false, error: 'worker gone' }
  );
});

test('a dropped caller aborts its session once, except a user wait or a lifecycle control', async () => {
  for (const [action, expectAbort] of [
    ['list_windows', true],
    ['wait_for_user', false],
    ['execution_end', false],
  ]) {
    let started;
    const running = new Promise((resolve) => (started = resolve));
    const held = heldHost({
      executeSerialized: (command) => {
        started(command);
        return new Promise(() => {});
      },
      waitForUser: (command) => {
        started(command);
        return new Promise(() => {});
      },
    });
    const gone = new AbortController();
    void createCommandService(held.host).answerCommand({ action, session_id: 'dropped' }, endpoint(gone.signal));
    await running;
    gone.abort();
    await settle();
    assert.deepEqual(
      held.aborted.map((command) => command.action),
      expectAbort ? [action] : [],
      action
    );
  }
});

test('overlapping stops share one cleanup, and a later stop cleans up again', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const held = heldHost({
    powerShellBySession: new Map([['a', {}]]),
    waitForCleanup: async () => {
      await gate;
      return true;
    },
  });
  const service = createCommandService(held.host);
  const first = service.stop();
  const second = service.stop();
  await settle();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    held.aborted.map((command) => command.session_id),
    ['a']
  );
  await service.stop();
  assert.deepEqual(
    held.aborted.map((command) => command.session_id),
    ['a', 'a']
  );
});

test('stopping aborts every live session and resets the coordinator once cleanup is confirmed', async () => {
  const held = heldHost({
    powerShellBySession: new Map([['a', {}]]),
    elevatedSessionIds: () => ['b'],
    waitForCleanup: async () => true,
  });
  await createCommandService(held.host).stop();
  assert.deepEqual(held.aborted.map((command) => command.session_id).sort(), ['a', 'b']);
});
