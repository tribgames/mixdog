import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createComputerPresence } from './computer/presence/mirror.ts';
import { ComputerUseCoordinator } from './computer/session/coordinator.ts';
import { CLIENT_ACTIVITY_MIN_GAP_MS, createProtocolConnection } from './protocol/connection.ts';
import { computerUseOperates, createUserInputReporter } from './user-input-report.ts';

/** A fake webContents (the 'input-event' source) and clock; reports are the times handed on. */
function rig() {
  let clock = 1_000_000;
  const source = new EventEmitter();
  const reports = [];
  const reporter = createUserInputReporter({ report: (at) => reports.push(at), now: () => clock });
  return {
    source,
    reports,
    reporter,
    at: (time) => {
      clock = time;
    },
    input: (type) => source.emit('input-event', {}, { type }),
  };
}

test('keyboard, mouse buttons, wheel and mouse movement are reported at their event time, on input, with no timer', () => {
  const r = rig();
  r.reporter.watch(r.source);
  for (const [index, type] of ['keyDown', 'mouseDown', 'mouseWheel', 'mouseMove'].entries()) {
    r.at(2_000_000 + index);
    r.input(type);
  }
  assert.deepEqual(r.reports, [2_000_000, 2_000_001, 2_000_002, 2_000_003]);
});

test('events that are no user operation are ignored', () => {
  const r = rig();
  r.reporter.watch(r.source);
  r.at(2_000_000);
  for (const type of ['mouseEnter', 'mouseLeave', 'gestureScrollUpdate', undefined]) r.input(type);
  assert.deepEqual(r.reports, []);
});

test('input is ignored while the ignore predicate holds (an agent driving a page), counted otherwise', () => {
  const r = rig();
  let agentInFlight = true;
  const page = new EventEmitter();
  const unwatch = r.reporter.watch(page, () => agentInFlight);
  r.at(2_000_000);
  page.emit('input-event', {}, { type: 'mouseDown' });
  assert.deepEqual(r.reports, [], 'agent CDP input on the page is no user operation');
  agentInFlight = false;
  r.at(3_000_000);
  page.emit('input-event', {}, { type: 'mouseDown' });
  assert.deepEqual(r.reports, [3_000_000], "a person's input on the page counts");
  unwatch();
  assert.equal(page.listenerCount('input-event'), 0);
});

test('input on the Mixdog window during an active Computer Use command on it is ignored; otherwise it counts', async () => {
  const coordinator = new ComputerUseCoordinator();
  const mixdog = { name: 'mixdog window' };
  const windows = new Map([['hwnd:100', mixdog]]);
  const r = rig();
  r.reporter.watch(r.source, () => computerUseOperates(coordinator, (id) => windows.get(id), mixdog));
  const press = (time) => {
    r.at(time);
    r.input('keyDown');
  };
  try {
    press(2_000_000);
    assert.deepEqual(r.reports, [2_000_000], 'no Computer Use: counts');
    // A lease with no command in flight (the session is thinking) is not executing.
    await coordinator.acquireTargets('agent', ['hwnd:100']);
    press(3_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000]);
    coordinator.beginCommand({ sessionId: 'agent', action: 'click', target: 'hwnd:100', mode: 'background' });
    press(4_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000], 'a command is executing on the Mixdog window: ignored');
    coordinator.finishCommand('agent');
    press(5_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000, 5_000_000], 'the command finished: counts again');
  } finally {
    coordinator.reset();
  }
});

test('stop unhooks the window', () => {
  const r = rig();
  r.reporter.watch(r.source);
  r.reporter.stop();
  assert.equal(r.source.listenerCount('input-event'), 0);
  r.at(3_000_000);
  r.input('keyDown');
  assert.deepEqual(r.reports, [], 'nothing after the app quit');
});

test('client/activity goes out at most once per minute under continuous typing and is sent again once a minute passed', async () => {
  const sent = [];
  const connection = createProtocolConnection({
    open: async () => ({
      store: { section: () => undefined, sections: () => [], subscribe: () => () => {} },
      status: { state: 'ready' },
      call: async () => ({}),
      notify: (method, params) => sent.push({ method, params }),
      subscribeApp: async () => {},
      respond: () => {},
      on: () => () => {},
      close: async () => {},
    }),
  });
  await connection.start();
  const t0 = 10_000_000;
  for (let at = t0; at < t0 + CLIENT_ACTIVITY_MIN_GAP_MS; at += 1_000) connection.noteUserInput(at);
  assert.deepEqual(sent, [{ method: 'client/activity', params: { at: t0 } }]);
  connection.noteUserInput(t0 + CLIENT_ACTIVITY_MIN_GAP_MS);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].params.at, t0 + CLIENT_ACTIVITY_MIN_GAP_MS);
  await connection.close();
  connection.noteUserInput(t0 + 10 * CLIENT_ACTIVITY_MIN_GAP_MS);
  assert.equal(sent.length, 2, 'a closed connection sends nothing');
});

test("a window the core's section names for a running command is the agent's, not the user's", () => {
  const mixdog = {};
  const presence = createComputerPresence({ notifyPointerReleased: () => {}, now: () => 1 });
  const r = rig();
  r.reporter.watch(r.source, () => computerUseOperates(presence, (id) => (id === 'hwnd:0x64' ? mixdog : null), mixdog));
  r.input('keyDown');
  assert.equal(r.reports.length, 1, 'no section: counts');
  presence.applySection({
    active: true,
    observeOnly: false,
    controller: null,
    sessionThreadId: 't1',
    sessions: [{ sessionThreadId: 't1', observeOnly: false, windowIds: ['hwnd:0x64'], mode: 'background' }],
  });
  r.input('keyDown');
  assert.equal(r.reports.length, 1, 'a command runs against the window: not counted');
  presence.applySection({
    active: true,
    observeOnly: false,
    controller: null,
    sessionThreadId: 't1',
    sessions: [{ sessionThreadId: 't1', observeOnly: false, windowIds: [], mode: null }],
  });
  r.input('keyDown');
  assert.equal(r.reports.length, 2, 'the command ended: counts again');
});
