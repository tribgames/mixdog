import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_CONFIGURE_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { ComputerUseCoordinator } from './computer/session/coordinator.ts';
import { computerUseOperates, createUserInputReporter } from './user-input-report.ts';

/** A fake webContents (the 'input-event' source), clock and timer. */
function rig() {
  let clock = 1_000_000;
  const source = new EventEmitter();
  const reports = [];
  const timers = [];
  const reporter = createUserInputReporter({
    report: async (at) => {
      reports.push(at);
    },
    now: () => clock,
    setInterval: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  });
  return {
    source,
    reports,
    timers,
    reporter,
    at: (time) => {
      clock = time;
    },
    input: (type) => source.emit('input-event', {}, { type }),
    tick: async () => {
      timers[0].run();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('keyboard, mouse buttons, wheel and mouse movement are reported as their event time, once a minute and only when newer', async () => {
  const r = rig();
  r.reporter.watch(r.source);
  assert.equal(r.timers[0].ms, 60_000);
  await r.tick();
  assert.deepEqual(r.reports, [], 'no input yet: nothing to report');
  for (const [index, type] of ['keyDown', 'mouseDown', 'mouseWheel', 'mouseMove'].entries()) {
    r.at(2_000_000 + index);
    r.input(type);
  }
  await r.tick();
  assert.deepEqual(r.reports, [2_000_003], 'the latest input time, derived from the clock at the event');
  await r.tick();
  assert.deepEqual(r.reports, [2_000_003], 'not advanced: not sent again');
  r.at(3_000_000);
  r.input('char');
  await r.tick();
  assert.deepEqual(r.reports, [2_000_003, 3_000_000]);
});

test('events that are no user operation are ignored', async () => {
  const r = rig();
  r.reporter.watch(r.source);
  r.at(2_000_000);
  for (const type of ['mouseEnter', 'mouseLeave', 'gestureScrollUpdate', undefined]) r.input(type);
  await r.tick();
  assert.deepEqual(r.reports, []);
});

test('input is ignored while the ignore predicate holds (an agent driving a page), counted otherwise', async () => {
  const r = rig();
  let agentInFlight = true;
  const page = new EventEmitter();
  const unwatch = r.reporter.watch(page, () => agentInFlight);
  r.at(2_000_000);
  page.emit('input-event', {}, { type: 'mouseDown' });
  await r.tick();
  assert.deepEqual(r.reports, [], 'agent CDP input on the page is no user operation');
  agentInFlight = false;
  r.at(3_000_000);
  page.emit('input-event', {}, { type: 'mouseDown' });
  await r.tick();
  assert.deepEqual(r.reports, [3_000_000], "a person's input on the page counts");
  unwatch();
  assert.equal(page.listenerCount('input-event'), 0);
});

test('input on the Mixdog window during an active Computer Use command on it is ignored; otherwise it counts', async () => {
  const coordinator = new ComputerUseCoordinator();
  const mixdog = { name: 'mixdog window' };
  const other = { name: 'another app-owned window' };
  const windows = new Map([
    ['hwnd:100', mixdog],
    ['hwnd:200', other],
  ]);
  const r = rig();
  r.reporter.watch(r.source, () => computerUseOperates(coordinator, (id) => windows.get(id), mixdog));
  const press = async (time) => {
    r.at(time);
    r.input('keyDown');
    await r.tick();
  };
  try {
    await press(2_000_000);
    assert.deepEqual(r.reports, [2_000_000], 'no Computer Use: counts');
    // A lease with no command in flight (the session is thinking) is not executing.
    await coordinator.acquireTargets('agent', ['hwnd:100']);
    await press(3_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000]);
    coordinator.beginCommand({ sessionId: 'agent', action: 'click', target: 'hwnd:100', mode: 'background' });
    await press(4_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000], 'a command is executing on the Mixdog window: ignored');
    coordinator.finishCommand('agent');
    await press(5_000_000);
    assert.deepEqual(r.reports, [2_000_000, 3_000_000, 5_000_000], 'the command finished: counts again');
    // A command on a different window never hides the user's input here.
    coordinator.releaseTargets('agent');
    await coordinator.acquireTargets('agent', ['hwnd:200']);
    coordinator.beginCommand({ sessionId: 'agent', action: 'click', target: 'hwnd:200', mode: 'background' });
    await press(6_000_000);
    assert.deepEqual(r.reports.at(-1), 6_000_000);
    // A Browser Use page inside the Mixdog window follows the same rule, and
    // its own agent-input rule too.
    coordinator.finishCommand('agent');
    coordinator.releaseTargets('agent');
    await coordinator.acquireTargets('agent', ['hwnd:100']);
    const page = new EventEmitter();
    let agentInFlight = false;
    const onMixdog = () => computerUseOperates(coordinator, (id) => windows.get(id), mixdog);
    r.reporter.watch(page, () => agentInFlight || onMixdog());
    coordinator.beginCommand({ sessionId: 'agent', action: 'click', target: 'hwnd:100', mode: 'background' });
    r.at(7_000_000);
    page.emit('input-event', {}, { type: 'mouseDown' });
    await r.tick();
    assert.equal(r.reports.at(-1), 6_000_000, 'Computer Use operates the Mixdog window: page input ignored');
    coordinator.finishCommand('agent');
    agentInFlight = true;
    r.at(8_000_000);
    page.emit('input-event', {}, { type: 'mouseDown' });
    await r.tick();
    assert.equal(r.reports.at(-1), 6_000_000, 'agent CDP input on the page: ignored');
    agentInFlight = false;
    r.at(9_000_000);
    page.emit('input-event', {}, { type: 'mouseDown' });
    await r.tick();
    assert.equal(r.reports.at(-1), 9_000_000, "a person's input on the page counts");
  } finally {
    coordinator.reset();
  }
});

test('a report that failed is sent again on the next tick', async () => {
  let attempts = 0;
  const sent = [];
  const source = new EventEmitter();
  let run = null;
  const reporter = createUserInputReporter({
    report: async (at) => {
      attempts += 1;
      if (attempts === 1) throw new Error('daemon unavailable');
      sent.push(at);
    },
    now: () => 5_000,
    setInterval: (fn) => {
      run = fn;
      return {};
    },
    clearInterval: () => {},
  });
  reporter.watch(source);
  source.emit('input-event', {}, { type: 'keyDown' });
  run();
  await new Promise((resolve) => setImmediate(resolve));
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [5_000]);
});

test('stop sends a pending time, clears the timer and unhooks the window', async () => {
  const r = rig();
  r.reporter.watch(r.source);
  r.at(2_000_000);
  r.input('keyDown');
  r.reporter.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.reports, [2_000_000]);
  assert.equal(r.timers[0].cleared, true);
  assert.equal(r.source.listenerCount('input-event'), 0);
  r.at(3_000_000);
  r.input('keyDown');
  await r.tick();
  assert.deepEqual(r.reports, [2_000_000], 'nothing after the app quit');
});

test('noteUserInput is a desktop capability and a session configure action taking one positive time', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('noteUserInput'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('noteUserInput'), false);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('noteUserInput'), true);
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'noteUserInput', args: [1_700_000_000_000] }).args, [
    1_700_000_000_000,
  ]);
  for (const args of [[], ['1'], [0], [-1], [Number.NaN], [1, 2]]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'noteUserInput', args }), TypeError);
  }
});
