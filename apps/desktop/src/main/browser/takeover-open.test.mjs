import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { beginComputerOperation } from '../human-only-approval.ts';
import { createTakeoverGate, TAKEOVER_EXPIRED_REASON, TAKEOVER_EXPIRY_MS } from '../takeover-gate.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const login = (id = 't1') => ({
  id,
  kind: 'takeover',
  takeover: { surface: 'browser', purpose: 'login', url: 'https://opendart.fss.or.kr/login', instructions: 'Sign in' },
});

test("one session's pending login takeover never stops another session's Browser Use", async () => {
  const gate = createTakeoverGate(() => {
    throw new Error('a browser takeover never holds the screen');
  });
  const otherInFlight = gate.beginOperation('B');
  const ownInFlight = gate.beginOperation('A');
  const ready = gate.ready('A', 't1');
  assert.equal(gate.onSessionState({ sessionId: 'A', snapshot: { toolApproval: login() } }), 'browser');
  assert.equal(otherInFlight.signal.aborted, false, "B's running command keeps going");
  assert.equal(ownInFlight.signal.aborted, true, "A's running command is suppressed");
  ownInFlight.release();
  assert.equal(await ready, true, "A's takeover is ready without waiting for B");
  const next = gate.beginOperation('B');
  assert.equal(next.signal.aborted, false);
  gate.assertFree('B');
  next.release();
  otherInFlight.release();
  // The session that asked stays held, and is told what it waits on.
  for (const refuse of [() => gate.beginOperation('A'), () => gate.assertFree('A')]) {
    assert.throws(refuse, (error) => {
      assert.match(error.message, /sign-in on opendart\.fss\.or\.kr/);
      assert.match(error.message, /shown a card/);
      return true;
    });
  }
  gate.onSessionState({ sessionId: 'A', snapshot: { toolApproval: null } });
  gate.beginOperation('A').release();
  gate.dispose();
});

test("a copy of another session's takeover shown in the chat it handed work to never locks that chat", () => {
  const gate = createTakeoverGate(() => {
    throw new Error('a browser takeover never holds the screen');
  });
  assert.equal(gate.onSessionState({ sessionId: 'task', snapshot: { toolApproval: login() } }), 'browser');
  const copy = { ...login(), sessionId: 'task', surfaceSessionId: 'home' };
  assert.equal(gate.onSessionState({ sessionId: 'home', snapshot: { toolApproval: copy } }), '');
  gate.assertFree('home');
  gate.beginOperation('home').release();
  assert.throws(() => gate.assertFree('task'), /shown a card/);
  gate.dispose();
});

test('Computer Use is blocked only by a screen takeover', async () => {
  const gate = createTakeoverGate();
  gate.onSessionState({ sessionId: 'A', snapshot: { toolApproval: login() } });
  await tick();
  beginComputerOperation()();
  const screen = { id: 'c1', kind: 'takeover', takeover: { surface: 'computer', target: 'Solve the CAPTCHA' } };
  assert.equal(gate.onSessionState({ sessionId: 'C', snapshot: { toolApproval: screen } }), 'computer');
  assert.equal(await gate.ready('C', 'c1'), true);
  assert.throws(() => beginComputerOperation(), (error) => {
    assert.match(error.message, /human-only approval is pending/);
    assert.match(error.message, /Solve the CAPTCHA/);
    assert.match(error.message, /shown a card/);
    return true;
  });
  gate.beginOperation('B').release();
  gate.onSessionState({ sessionId: 'C', snapshot: { toolApproval: null } });
  await tick();
  beginComputerOperation()();
  gate.dispose();
});

test("a takeover nobody finishes settles 'expired' after the timeout and frees its session", async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  assert.equal(TAKEOVER_EXPIRED_REASON, 'expired');
  assert.equal(TAKEOVER_EXPIRY_MS, 15 * 60_000);
  const gate = createTakeoverGate(async (work) => work());
  const expired = [];
  gate.onExpire((sessionId, id) => expired.push([sessionId, id]));
  const state = { sessionId: 'A', snapshot: { toolApproval: login() } };
  gate.onSessionState(state);
  assert.equal(await gate.ready('A', 't1'), true);
  mock.timers.tick(TAKEOVER_EXPIRY_MS - 1);
  await tick();
  assert.deepEqual(expired, []);
  assert.throws(() => gate.beginOperation('A'), /taken over/);
  mock.timers.tick(1);
  await tick();
  assert.deepEqual(expired, [['A', 't1']]);
  gate.beginOperation('A').release();
  // A snapshot still showing it (the settle in flight) does not hold it again.
  assert.equal(gate.onSessionState(state), '');
  gate.assertFree('A');
  assert.equal(gate.pending(), 0);
  // A later takeover of the session is held anew.
  gate.onSessionState({ sessionId: 'A', snapshot: { toolApproval: login('t2') } });
  assert.throws(() => gate.assertFree('A'), /taken over/);
  gate.dispose();
});

test('a screen takeover that ends while still draining or queued gives up the screen', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const gate = createTakeoverGate();
  const screen = (id) => ({ id, kind: 'takeover', takeover: { surface: 'computer', target: 'Solve the CAPTCHA' } });
  // Draining: the session's command was aborted but never returns.
  const stuck = gate.beginOperation('C');
  const ready = gate.ready('C', 'c1');
  gate.onSessionState({ sessionId: 'C', snapshot: { toolApproval: screen('c1') } });
  await tick();
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/, 'held while it drains');
  mock.timers.tick(TAKEOVER_EXPIRY_MS);
  await tick();
  assert.equal(gate.pending(), 0);
  assert.equal(await ready, false);
  beginComputerOperation()();
  stuck.release();
  // Queued behind a running Computer Use operation, then settled.
  const running = beginComputerOperation();
  gate.onSessionState({ sessionId: 'D', snapshot: { toolApproval: screen('d1') } });
  await tick();
  gate.onSessionState({ sessionId: 'D', snapshot: { toolApproval: null } });
  await tick();
  running();
  await tick();
  beginComputerOperation()();
  gate.dispose();
});

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
  const inFlight = gate.beginOperation('s1');
  let ready = null;
  void gate.ready('s1', 't1').then((value) => {
    ready = value;
  });
  const takeover = { id: 't1', kind: 'takeover', takeover: { surface: 'computer', instructions: 'Solve the CAPTCHA' } };
  assert.equal(gate.onSessionState({ sessionId: 's1', snapshot: { toolApproval: takeover } }), 'computer');
  assert.throws(() => gate.beginOperation('s1'), /taken over/, 'new commands are refused at once');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  assert.equal(ready, null, 'a screen takeover is not ready while Computer Use drains');
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
