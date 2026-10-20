import assert from 'node:assert/strict';
import test from 'node:test';
import { createTakeoverGate } from '../takeover-gate.ts';

test('a browser takeover is reported once as it starts, so its panel opens at that moment', async () => {
  const gate = createTakeoverGate(async (work) => work());
  const state = (approval) => ({ sessionId: 's1', snapshot: { toolApproval: approval } });
  const browser = { id: 't1', kind: 'takeover', takeover: { surface: 'browser', instructions: 'Sign in' } };
  assert.equal(gate.onSessionState(state(browser)), 'browser');
  assert.equal(gate.onSessionState(state(browser)), '', 'repeated snapshots never reopen it');
  assert.equal(gate.onSessionState(state(null)), '', '"다 했어요" opens nothing more');
  assert.equal(
    gate.onSessionState(state({ id: 't2', kind: 'takeover', takeover: { surface: 'computer' } })),
    'computer'
  );
  assert.equal(gate.onSessionState(state({ id: 'a1', kind: 'approval' })), '');
  gate.dispose();
});

test('human control is ready only after new commands are refused and in-flight commands are aborted and drained', async () => {
  let enterHold;
  const holdEntered = new Promise((resolve) => {
    enterHold = resolve;
  });
  // The hold enters only once Computer Use has drained (human-only-approval.ts).
  const gate = createTakeoverGate(async (work) => {
    await holdEntered;
    return work();
  });
  const inFlight = gate.beginOperation();
  let ready = null;
  void gate.ready('s1', 't1').then((value) => {
    ready = value;
  });
  const takeover = { id: 't1', kind: 'takeover', takeover: { surface: 'browser', instructions: 'Sign in' } };
  assert.equal(gate.onSessionState({ sessionId: 's1', snapshot: { toolApproval: takeover } }), 'browser');
  assert.throws(() => gate.beginOperation(), /taken over/, 'new commands are refused at once');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  assert.equal(ready, null, 'not ready while Computer Use drains');
  enterHold();
  await tick();
  assert.equal(inFlight.signal.aborted, true, 'the in-flight command is suppressed');
  assert.equal(ready, null, 'not ready until it has drained');
  inFlight.release();
  await tick();
  assert.equal(ready, true);
  // A takeover that ends before it is ready never reports ready.
  const second = createTakeoverGate(() => new Promise(() => {}));
  second.onSessionState({ sessionId: 's2', snapshot: { toolApproval: { ...takeover, id: 't2' } } });
  const pending = second.ready('s2', 't2');
  second.onSessionState({ sessionId: 's2', snapshot: { toolApproval: null } });
  assert.equal(await pending, false);
  gate.dispose();
});
