import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerOverlayController } from './controls.ts';
import { bindComputerOverlayControls } from './ipc-controls.ts';
import { readComputerRunRecords } from '../session/run-log.ts';

function fixture(controls, presentation = { sessionIds: ['a'], generation: 1 }) {
  const handlers = new Map();
  const contents = { ipc: { handle: (channel, handler) => handlers.set(channel, handler) }, mainFrame: {} };
  const controller = createComputerOverlayController(controls, () => {});
  bindComputerOverlayControls(contents, controller, controls, () => presentation);
  return (request) =>
    handlers.get('computer-overlay-control')({ sender: contents, senderFrame: contents.mainFrame }, request);
}

test('a control request dropped while another one runs is reported, never as an accepted press', async () => {
  let release;
  const running = new Promise((resolve) => {
    release = resolve;
  });
  const invoke = fixture({ resume: () => running, pause: async () => {}, stop: async () => {} });
  const first = invoke({ action: 'resume', generation: 1 });
  const dropped = await invoke({ action: 'resume', generation: 1 });
  assert.equal(dropped.accepted, false);
  assert.equal(dropped.error, 'busy');
  release();
  assert.deepEqual(await first, { accepted: true, busy: false, error: '' });
});

test('every press leaves a record, so a press that did nothing is still evidence it arrived', async () => {
  const invoke = fixture({ resume: async () => {}, pause: async () => {}, stop: async () => {} });
  await invoke({ action: 'pause', generation: 1 });
  await invoke({ action: 'resume', generation: 9 });
  const records = readComputerRunRecords('a', 20)
    .filter((record) => String(record.action).startsWith('overlay_'))
    .slice(-2);
  assert.deepEqual(
    records.map((record) => [record.action, record.generation, record.ok, record.error ?? '']),
    [
      ['overlay_pause', 1, true, ''],
      ['overlay_resume', 9, false, 'stale'],
    ]
  );
});

test('a press that reaches the controls is accepted', async () => {
  const calls = [];
  const invoke = fixture({
    resume: async () => calls.push('resume'),
    pause: async () => calls.push('pause'),
    stop: async () => calls.push('stop'),
  });
  assert.deepEqual(await invoke({ action: 'pause', generation: 1 }), { accepted: true, busy: false, error: '' });
  assert.deepEqual(await invoke({ action: 'resume', generation: 1 }), { accepted: true, busy: false, error: '' });
  assert.deepEqual(calls, ['pause', 'resume']);
});
