// The window's terminals on a core connection: a tab's output is read on its own feed (`process:<id>`), which an attach subscribes;
// the activity and size-owner events come from the core's terminal sections.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeProtocol } from './fake-core-protocol.mjs';
import { createServiceTerminalHost } from './terminal-host.ts';

/** The connection's desktop operations as the core answers them (`answers[name](...args)`), recording each call. */
function fakeService(answers) {
  const calls = [];
  return {
    calls,
    invokeDesktopOperation: async (name, args) => (calls.push([name, ...args]), answers[name]?.(...args) ?? null),
    notifyDesktopOperation: (name, args) => calls.push([name, ...args]),
  };
}

const notification = (method, feedId, params, feed = { id: feedId }) => ({ type: 'notification', notification: { method, params, feed } });
const output = (id, bytes, feedId = `process:${id}`) =>
  notification('process/outputDelta', feedId, { processHandle: id, bytesB64: Buffer.from(bytes).toString('base64') });
const attaches = (core) => core.calls.filter(([name]) => name === 'termAttach').map(([, id]) => id);

test("a new tab's ensure attaches its feed and answers the attach's replay; the output reaches the window as text", async () => {
  const protocol = fakeProtocol();
  const core = fakeService({
    termEnsure: () => ({ id: 't1', replay: '' }),
    termAttach: (id) => ({ id, replay: 'PS> ', subscription: { mode: 'snapshot', startSeq: 4, liveSeq: 4 } }),
  });
  const host = createServiceTerminalHost(core, protocol);
  const heard = [];
  host.subscribe((event) => heard.push(event));
  assert.deepEqual(await host.ensure(null, 'C:\\work', null), { id: 't1', replay: 'PS> ' });
  // An attached tab's feed already streams to this connection: its next ensure does not subscribe it again.
  assert.deepEqual(await host.ensure('t1', 'C:\\work', null), { id: 't1', replay: '' });
  assert.deepEqual(attaches(core), ['t1']);
  // A character cut between two frames is one character; the phones' lane copy of the same output is not the window's.
  const bytes = Buffer.from('a\uD55Cb');
  protocol.emit(output('t1', bytes.subarray(0, 2)));
  protocol.emit(output('t1', bytes.subarray(0, 2), 'process:relay'));
  protocol.emit(output('t1', bytes.subarray(2)));
  assert.deepEqual(heard, [
    { id: 't1', data: 'a' },
    { id: 't1', data: '\uD55Cb' },
  ]);
});

test('the attached tabs are attached again on each new link; an exited, disposed or not running tab is not', async () => {
  const protocol = fakeProtocol();
  const running = new Set(['t1', 't2', 't3']);
  const core = fakeService({
    termEnsure: (id) => ({ id, replay: '' }),
    termAttach: (id) => (running.has(id) ? { id, replay: '' } : null),
  });
  const host = createServiceTerminalHost(core, protocol);
  // t4's shell is gone by its attach: the ensure's answer stands.
  for (const id of ['t1', 't2', 't3', 't4']) assert.equal((await host.ensure(id, null, null)).id, id);
  protocol.emit(notification('process/exited', 'process:t2', { processHandle: 't2', code: 0 }));
  host.dispose('t3');
  const before = attaches(core).length;
  protocol.emit({ type: 'status', status: { state: 'reconnecting' } });
  protocol.emit({ type: 'status', status: { state: 'ready' } });
  // A reopen's new client holds none of the old one's feeds either.
  protocol.replace();
  await new Promise(setImmediate);
  assert.deepEqual(attaches(core).slice(before), ['t1', 't1']);
  // A new tab under a disposed id has a feed of its own: its ensure attaches it.
  await host.ensure('t3', null, null);
  assert.equal(attaches(core).at(-1), 't3');
});

test("an attach in flight answers the tab's next attach and ensure; a disposed tab's attach in flight is the old shell's", async () => {
  const protocol = fakeProtocol();
  const answer = [];
  const core = fakeService({
    termEnsure: (id) => ({ id, replay: '' }),
    termAttach: () => new Promise((resolve) => answer.push(resolve)),
  });
  const host = createServiceTerminalHost(core, protocol);
  // A dock hover's warm-up attaches the tab; the pane's ensure and another window's attach come before the answer. A second
  // subscription would replace the first and drop what was queued on it.
  const warm = host.attach('t1');
  const other = host.attach('t1');
  const ensured = host.ensure('t1', null, null);
  await new Promise(setImmediate);
  assert.deepEqual(attaches(core), ['t1']);
  answer[0]({ id: 't1', replay: 'PS> ' });
  for (const reply of [warm, other, ensured]) assert.deepEqual(await reply, { id: 't1', replay: 'PS> ' });
  // A shell change disposes the tab and spawns a new one under its id while the old one's attach is in flight.
  const stale = host.attach('t2');
  host.dispose('t2');
  const fresh = host.ensure('t2', null, null);
  await new Promise(setImmediate);
  assert.deepEqual(attaches(core), ['t1', 't2', 't2']);
  answer[2]({ id: 't2', replay: 'new' });
  assert.deepEqual(await fresh, { id: 't2', replay: 'new' });
  // The old shell's answer goes to its own caller and leaves the new tab attached.
  answer[1](null);
  assert.equal(await stale, null);
  protocol.replace();
  await new Promise(setImmediate);
  assert.deepEqual(attaches(core).slice(3).sort(), ['t1', 't2']);
});

test('an ensure whose attach is lost with the link answers the spawned shell, which the next link attaches', async () => {
  const protocol = fakeProtocol();
  let linked = false;
  const core = fakeService({
    termEnsure: () => ({ id: 'dock-1', replay: 'PS> ' }),
    termAttach: (id) => (linked ? { id, replay: 'PS> ls' } : Promise.reject(new Error('The core connection closed.'))),
  });
  const host = createServiceTerminalHost(core, protocol);
  // The dock's terminal has no id: a failed ensure would be retried as a second shell, and the first never disposed.
  assert.deepEqual(await host.ensure(null, null, null), { id: 'dock-1', replay: 'PS> ' });
  linked = true;
  protocol.emit({ type: 'status', status: { state: 'reconnecting' } });
  protocol.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise(setImmediate);
  assert.deepEqual(attaches(core), ['dock-1', 'dock-1']);
});

test("an attach answering that the tab is not running drops the tab's decoder: a later shell under its id starts clean", async () => {
  const protocol = fakeProtocol();
  let running = true;
  const core = fakeService({
    termEnsure: (id) => ({ id, replay: '' }),
    termAttach: (id) => (running ? { id, replay: '' } : null),
  });
  const host = createServiceTerminalHost(core, protocol);
  const heard = [];
  host.subscribe((event) => heard.push(event));
  await host.ensure('t1', null, null);
  // The shell ends a frame inside a character, and its exit never reaches this connection (lost with a link).
  protocol.emit(output('t1', Buffer.from('a한').subarray(0, 2)));
  running = false;
  assert.equal(await host.attach('t1'), null);
  running = true;
  await host.ensure('t1', null, null);
  protocol.emit(output('t1', Buffer.from('b')));
  assert.deepEqual(heard, [
    { id: 't1', data: 'a' },
    { id: 't1', data: 'b' },
  ]);
});

test('activity and size-owner events follow the terminal sections as Node pushed them', () => {
  const protocol = fakeProtocol();
  const host = createServiceTerminalHost(fakeService({}), protocol);
  const activity = [];
  const owners = [];
  host.subscribeActivity((event) => activity.push(event));
  host.subscribeSizeOwner((event) => owners.push(event));
  protocol.pushSection('terminalActivity', { t1: 'running' });
  protocol.pushSection('terminalActivity', { t1: 'running', t2: 'idle' });
  protocol.pushSection('terminalActivity', { t2: 'finished' });
  assert.deepEqual(activity, [
    { id: 't1', state: 'running' },
    { id: 't2', state: 'idle' },
    { id: 't2', state: 'finished' },
    { id: 't1', state: null },
  ]);
  const tab = (id, sizeOwner = null) => ({ id, running: true, sizeOwner });
  protocol.pushSection('terminalTabs', [tab('t1', { cols: 40, rows: 20, owner: 'phone-1' }), tab('t2')]);
  // A released claim on a listed tab is a zero size; a disposed tab's claim ends without an event.
  protocol.pushSection('terminalTabs', [tab('t1'), tab('t2', { cols: 50, rows: 10, owner: 'phone-1' })]);
  protocol.pushSection('terminalTabs', [tab('t1')]);
  // The window never owns a size: it follows the phone's.
  assert.deepEqual(owners, [
    { id: 't1', cols: 40, rows: 20, own: false },
    { id: 't2', cols: 50, rows: 10, own: false },
    { id: 't1', cols: 0, rows: 0, own: false },
  ]);
});

const stamped = (id, bytes, epoch, seq) =>
  notification('process/outputDelta', `process:${id}`, { processHandle: id, bytesB64: Buffer.from(bytes).toString('base64') }, { id: `process:${id}`, epoch, seq });
const relink = async (protocol) => {
  protocol.replace();
  await new Promise(setImmediate);
};

test('a new link attaches each tab again from the last stamp read on its feed; a tab nothing was read on attaches without one', async () => {
  const protocol = fakeProtocol();
  const core = fakeService({ termEnsure: (id) => ({ id, replay: '' }), termAttach: (id) => ({ id, replay: '' }) });
  const host = createServiceTerminalHost(core, protocol);
  await host.ensure('t1', null, null);
  await host.ensure('t2', null, null);
  protocol.emit(stamped('t1', 'a', 'e1', 7));
  protocol.emit(stamped('t1', 'b', 'e1', 8));
  const before = core.calls.length;
  await relink(protocol);
  assert.deepEqual(core.calls.slice(before).filter(([name]) => name === 'termAttach'), [
    ['termAttach', 't1', { epoch: 'e1', seq: 8 }],
    ['termAttach', 't2'],
  ]);
});

test('a replay of the resumed epoch emits no reset; a snapshot or a new epoch emits one with the screen, and resumes from its position', async () => {
  const protocol = fakeProtocol();
  let subscription = { mode: 'replay', epoch: 'e1', startSeq: 9 };
  const core = fakeService({
    termEnsure: (id) => ({ id, replay: '' }),
    termAttach: (id, from) => ({ id, replay: from ? 'SCREEN' : '', subscription }),
  });
  const host = createServiceTerminalHost(core, protocol);
  const resets = [];
  host.subscribeReset((event) => resets.push(event));
  await host.ensure('t1', null, null);
  protocol.emit(stamped('t1', 'a', 'e1', 8));
  await relink(protocol);
  assert.deepEqual(resets, []);
  subscription = { mode: 'snapshot', epoch: 'e1', startSeq: 20 };
  await relink(protocol);
  assert.deepEqual(resets, [{ id: 't1', replay: 'SCREEN' }]);
  // The next link resumes from the snapshot, so frames already drawn are not replayed.
  subscription = { mode: 'replay', epoch: 'e1', startSeq: 20 };
  const before = core.calls.length;
  await relink(protocol);
  assert.deepEqual(core.calls[before], ['termAttach', 't1', { epoch: 'e1', seq: 19 }]);
  subscription = { mode: 'replay', epoch: 'e2', startSeq: 1 };
  await relink(protocol);
  assert.equal(resets.length, 2);
});

test('a tab that printed nothing resumes from the position its attach answered; a tab with no position to resume from is drawn anew', async () => {
  const protocol = fakeProtocol();
  let subscription = { mode: 'snapshot', epoch: 'e1', startSeq: 5 };
  const core = fakeService({
    termEnsure: (id) => ({ id, replay: '' }),
    termAttach: (id) => ({ id, replay: 'SCREEN', ...(id === 't1' ? { subscription } : {}) }),
  });
  const host = createServiceTerminalHost(core, protocol);
  const resets = [];
  host.subscribeReset((event) => resets.push(event));
  await host.ensure('t1', null, null);
  assert.deepEqual(resets, [], 'a first attach draws its replay itself');
  subscription = { mode: 'replay', epoch: 'e1', startSeq: 5 };
  const before = core.calls.length;
  await relink(protocol);
  assert.deepEqual(core.calls[before], ['termAttach', 't1', { epoch: 'e1', seq: 4 }]);
  assert.deepEqual(resets, []);
  // An attach answered without a subscription leaves nothing to resume from: the screen is drawn anew.
  await host.ensure('t2', null, null);
  await relink(protocol);
  assert.deepEqual(resets, [{ id: 't2', replay: 'SCREEN' }]);
});

test('a tab that is not running on the new link forgets its position and draws nothing', async () => {
  const protocol = fakeProtocol();
  let running = true;
  const core = fakeService({ termEnsure: (id) => ({ id, replay: '' }), termAttach: (id) => (running ? { id, replay: '' } : null) });
  const host = createServiceTerminalHost(core, protocol);
  const resets = [];
  host.subscribeReset((event) => resets.push(event));
  await host.ensure('t1', null, null);
  protocol.emit(stamped('t1', 'a', 'e1', 1));
  running = false;
  await relink(protocol);
  assert.deepEqual(resets, []);
  running = true;
  await host.ensure('t1', null, null);
  assert.deepEqual(core.calls.filter(([name]) => name === 'termAttach').at(-1), ['termAttach', 't1']);
});

test("one window's resume leaves the pause another window holds; the last holder's resume or release resumes the tab", () => {
  const core = fakeService({});
  const host = createServiceTerminalHost(core, fakeProtocol());
  const flow = () => core.calls.filter(([name]) => name === 'termPause' || name === 'termResume');
  host.pauseOutput('t1', 'wc:1');
  host.pauseOutput('t1', 'wc:2');
  host.pauseOutput('t1', 'wc:2');
  assert.deepEqual(flow(), [['termPause', 't1']]);
  host.resumeOutput('t1', 'wc:1');
  assert.deepEqual(flow(), [['termPause', 't1']]);
  host.resumeOutput('t1', 'wc:1');
  assert.equal(flow().length, 1);
  host.resumeOutput('t1', 'wc:2');
  assert.deepEqual(flow(), [['termPause', 't1'], ['termResume', 't1']]);
  host.pauseOutput('t1', 'wc:1');
  host.pauseOutput('t2', 'wc:1');
  host.pauseOutput('t2', 'wc:2');
  host.releaseHolder('wc:1');
  assert.deepEqual(flow().slice(2), [['termPause', 't1'], ['termPause', 't2'], ['termResume', 't1']]);
});

test('a new link pauses again the tabs a window still holds', async () => {
  const protocol = fakeProtocol();
  const core = fakeService({ termEnsure: (id) => ({ id, replay: '' }), termAttach: (id) => ({ id, replay: '' }) });
  const host = createServiceTerminalHost(core, protocol);
  await host.ensure('t1', null, null);
  host.pauseOutput('t1', 'wc:1');
  const before = core.calls.length;
  await relink(protocol);
  assert.ok(core.calls.slice(before).some(([name, id]) => name === 'termPause' && id === 't1'));
});
