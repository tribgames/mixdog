import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_COMPUTER_POINTER_FEEDBACK, registerComputerPointer } from './computer-pointer.ts';

function rig() {
  const published = [];
  const handlers = new Map();
  registerComputerPointer({ handleRequest: (method, run) => handlers.set(method, run) }, (...args) => published.push(args));
  return { published, ask: (params) => handlers.get(HOST_COMPUTER_POINTER_FEEDBACK)(params, new AbortController().signal) };
}

test('each event goes to the overlay consumer in the helper order and the request is answered null', async () => {
  const { published, ask } = rig();
  const answer = await ask({
    sessionId: 'thr_1',
    events: [
      { x: 10, y: 20, held: false, phase: 'move', mode: 'foreground', windowId: 'hwnd:0x3' },
      { x: 11, y: 21, held: true, phase: 'press', mode: 'background' },
    ],
  });
  assert.equal(answer, null);
  assert.deepEqual(published, [
    ['thr_1', 10, 20, false, 'foreground', 'move', 'hwnd:0x3'],
    ['thr_1', 11, 21, true, 'background', 'press', undefined],
  ]);
});

test('an event the overlay cannot draw is dropped and the others still arrive', async () => {
  const { published, ask } = rig();
  await ask({
    sessionId: 'thr_1',
    events: [
      null,
      { x: 'a', y: 1, held: false, phase: 'move', mode: 'foreground' },
      { x: Infinity, y: 1, held: false, phase: 'move', mode: 'foreground' },
      { x: 1, y: 1, held: 'no', phase: 'move', mode: 'foreground' },
      { x: 1, y: 1, held: false, phase: 3, mode: 'foreground' },
      { x: 1, y: 1, held: false, phase: 'move', mode: 'sideways' },
      { x: 5, y: 6, held: false, phase: 'scroll', mode: 'foreground' },
    ],
  });
  assert.deepEqual(published, [['thr_1', 5, 6, false, 'foreground', 'scroll', undefined]]);
});

test('a consumer that throws does not fail the request or stop the later events', async () => {
  const handlers = new Map();
  let calls = 0;
  registerComputerPointer({ handleRequest: (method, run) => handlers.set(method, run) }, () => {
    calls += 1;
    throw new Error('overlay gone');
  });
  const event = { x: 1, y: 1, held: false, phase: 'move', mode: 'foreground' };
  const answer = await handlers.get(HOST_COMPUTER_POINTER_FEEDBACK)({ sessionId: 's', events: [event, event] });
  assert.equal(answer, null);
  assert.equal(calls, 2);
});

test('params without a session and an event list are refused', async () => {
  const { ask } = rig();
  await assert.rejects(ask({ events: [] }), /needs sessionId and events/);
  await assert.rejects(ask({ sessionId: 's' }), /needs sessionId and events/);
  await assert.rejects(ask(null), /expects an object/);
});
