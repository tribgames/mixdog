// createTerminalApi against a fake connection: every member sends the request main sent for the same IPC call (the former main ipc-terminal.ts and
// connections/terminal-host.ts over the shared routes), answers what main answered, and the feeds, sections and flow control
// behave as the terminal host did.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createTerminalApi } from './api-terminal.ts';

const b64 = (text) => Buffer.from(text).toString('base64');

function setup({ answers = {}, sections = {} } = {}) {
  const calls = [];
  const notes = [];
  const eventListeners = new Set();
  const storeListeners = new Set();
  const replaced = new Set();
  const connection = {
    onEvent: (l) => (eventListeners.add(l), () => eventListeners.delete(l)),
    onReplaced: (l) => (replaced.add(l), () => replaced.delete(l)),
    onStoreChange: (l) => (storeListeners.add(l), () => storeListeners.delete(l)),
    notify: (method, params) => notes.push({ method, params }),
    whenSynced: async () => undefined,
    snapshot: () => ({ status: 'ready', entries: Object.entries(sections).map(([section, value]) => ({ section, key: null, revision: 1, value })) }),
    protocolClient: () => ({ store: { section: (name) => (name in sections ? { value: sections[name] } : undefined) } }),
  };
  const ctx = {
    connection,
    call: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      return typeof answer === 'function' ? answer(params) : method in answers ? answer : {};
    },
  };
  const api = createTerminalApi(ctx);
  return {
    api,
    calls,
    notes,
    sections,
    emit: (event) => eventListeners.forEach((l) => l(event)),
    store: (change) => storeListeners.forEach((l) => l(change)),
    replace: () => replaced.forEach((l) => l()),
  };
}
const delta = (tab, text, seq = 1) => ({
  type: 'notification',
  notification: { method: 'process/outputDelta', params: { processHandle: tab, bytesB64: b64(text) }, feed: { id: `process:${tab}`, epoch: 'e1', seq } },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('every key of the terminal group is a member', () => {
  const { api } = setup();
  for (const key of DIRECT_KEYS.terminal) assert.equal(typeof api[key], 'function', key);
});

test('the requests equal the ones main sent for the same IPC calls', async () => {
  const { api, calls, notes } = setup({ answers: { 'terminal/ensure': { id: 't1', replay: 'r', sizeOwner: null }, 'terminal/attach': { id: 't1', replay: 'r', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } } } });
  await api.termEnsure('t1', '/r', 'bash');
  await api.termEnsure('', '', '');
  await api.termAttach('t2');
  await api.termProfiles();
  api.termFocus('t1', true);
  api.termFocus('', true);
  await api.termDispose('t1');
  api.termWrite('t1', 'ls\r');
  api.termWrite(undefined, undefined);
  api.termResize('t1', 80, 24);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ['terminal/ensure', { tabId: 't1', options: { cwd: '/r', profile: 'bash' } }],
    ['terminal/attach', { tabId: 't1' }],
    ['terminal/ensure', { options: {} }],
    ['terminal/attach', { tabId: 't2' }],
    ['terminal/profiles', {}],
    ['terminal/focus', { tabId: 't1', focused: true }],
    ['terminal/dispose', { tabId: 't1' }],
  ]);
  assert.deepEqual(notes, [
    { method: 'terminal/input', params: { tabId: 't1', data: 'ls\r' } },
    { method: 'terminal/input', params: { tabId: '', data: '' } },
    { method: 'terminal/resize', params: { tabId: 't1', cols: 80, rows: 24 } },
  ]);
});

test('ensure and attach answer {id, replay} and a size owner that is never this window', async () => {
  const owner = { cols: 100, rows: 30, owner: 'phone-1' };
  const { api } = setup({
    answers: {
      'terminal/ensure': { id: 't1', replay: 'r', sizeOwner: null },
      'terminal/attach': ({ tabId }) => (tabId === 'gone' ? null : { id: tabId, replay: 'x', replayLeadUnit: 0xdc00, sizeOwner: owner, client: 'c1', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 4 } }),
    },
  });
  assert.deepEqual(await api.termAttach('t9'), { id: 't9', replay: '\udc00x', sizeOwner: { cols: 100, rows: 30, own: false } });
  assert.equal(await api.termAttach('gone'), null);
  // The ensure answers the attach's session, as the host did.
  assert.deepEqual(await api.termEnsure('t1', null, null), { id: 't1', replay: '\udc00x', sizeOwner: { cols: 100, rows: 30, own: false } });
});

test('an ensure the core answered with no session fails with the host text; a failed attach leaves the ensure answered', async () => {
  const none = setup({ answers: { 'terminal/ensure': null } });
  await assert.rejects(none.api.termEnsure('t1', null, null), /did not return a session/);
  const lost = setup({
    answers: {
      'terminal/ensure': { id: 't1', replay: 'r' },
      'terminal/attach': () => {
        throw new Error('link lost');
      },
    },
  });
  assert.deepEqual(await lost.api.termEnsure('t1', null, null), { id: 't1', replay: 'r' });
});

test('output of an attached tab reaches the page coalesced, other feeds and disposed tabs do not', async () => {
  const rig = setup({ answers: { 'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } } } });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(delta('t1', 'one', 1));
  rig.emit(delta('t2', 'other', 1));
  rig.emit({ type: 'notification', notification: { method: 'process/outputDelta', params: { processHandle: 't1', bytesB64: b64('relay') }, feed: { id: 'process:relay', epoch: 'e', seq: 1 } } });
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'one' }]);
  await rig.api.termDispose('t1');
  rig.emit(delta('t1', 'late', 2));
  await wait(30);
  assert.equal(seen.length, 1);
});

test('flow control: 256 KiB unacknowledged pauses the core, under 32 KiB resumes it', async () => {
  const rig = setup({ answers: { 'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } } } });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(delta('t1', 'a'.repeat(300 * 1024), 1));
  await wait(30);
  const flow = () => rig.calls.filter((c) => c.method === 'terminal/pause' || c.method === 'terminal/resume').map((c) => [c.method, c.params]);
  assert.deepEqual(flow(), [['terminal/pause', { tabId: 't1' }]]);
  assert.equal(seen.reduce((sum, e) => sum + e.data.length, 0), 256 * 1024);
  rig.api.termAcknowledge('t1', 256 * 1024);
  await wait(30);
  // The 44 KiB still unacknowledged is above the low mark.
  assert.equal(seen.reduce((sum, e) => sum + e.data.length, 0), 300 * 1024);
  assert.equal(flow().length, 1);
  rig.api.termAcknowledge('t1', 44 * 1024);
  assert.deepEqual(flow(), [['terminal/pause', { tabId: 't1' }], ['terminal/resume', { tabId: 't1' }]]);
});

test('a new link attaches the tab again from its position and asks for the pause again; its replay is no redraw', async () => {
  const replies = [
    { id: 't1', replay: 'first', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 5 } },
    { id: 't1', replay: 'more', subscription: { mode: 'replay', epoch: 'e1', startSeq: 8 } },
  ];
  const rig = setup({ answers: { 'terminal/attach': () => replies.shift() } });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(delta('t1', 'x'.repeat(300 * 1024), 7));
  await wait(30);
  rig.calls.length = 0;
  const before = seen.length;
  rig.replace();
  await wait(30);
  assert.deepEqual(rig.calls.map((c) => [c.method, c.params]), [
    ['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 7 } }],
    ['terminal/pause', { tabId: 't1' }],
  ]);
  assert.equal(seen.length, before);
});

test('a snapshot answered to a new link is drawn anew, as a reset', async () => {
  const replies = [
    { id: 't1', replay: 'first', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 5 } },
    { id: 't1', replay: 'SCREEN', subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 } },
  ];
  const rig = setup({ answers: { 'terminal/attach': () => replies.shift() } });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.replace();
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'SCREEN', reset: true }]);
});

test('a status that turns ready attaches the tabs again, once', async () => {
  const rig = setup({ answers: { 'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'replay', epoch: 'e1', startSeq: 1 } } } });
  await rig.api.termAttach('t1');
  rig.calls.length = 0;
  const status = (state) => rig.emit({ type: 'status', status: { state } });
  status('ready');
  status('ready');
  status('reconnecting');
  status('ready');
  await wait(10);
  assert.equal(rig.calls.filter((c) => c.method === 'terminal/attach').length, 2);
});

test('an exited shell is no longer read', async () => {
  const rig = setup({ answers: { 'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } } } });
  await rig.api.termAttach('t1');
  rig.emit({ type: 'notification', notification: { method: 'process/exited', params: { processHandle: 't1' }, feed: { id: 'process:t1', epoch: 'e1', seq: 2 } } });
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('activity and size owner follow the sections, termActivity reads the held rows', async () => {
  const rig = setup({ sections: { terminalActivity: { t1: 'running' }, terminalTabs: [{ id: 't1', sizeOwner: { cols: 90, rows: 20, owner: 'phone' } }] } });
  const activity = [];
  const owners = [];
  rig.api.subscribeTermActivity((e) => activity.push(e));
  rig.api.subscribeTermSizeOwner((e) => owners.push(e));
  rig.store({ type: 'section', section: 'terminalActivity' });
  rig.store({ type: 'section', section: 'terminalTabs' });
  assert.deepEqual(activity, [{ id: 't1', state: 'running' }]);
  assert.deepEqual(owners, [{ id: 't1', cols: 90, rows: 20, own: false }]);
  rig.sections.terminalActivity = {};
  rig.sections.terminalTabs = [{ id: 't1', sizeOwner: null }];
  rig.store({ type: 'appSnapshot' });
  assert.deepEqual(activity.at(-1), { id: 't1', state: null });
  assert.deepEqual(owners.at(-1), { id: 't1', cols: 0, rows: 0, own: false });
  rig.sections.terminalActivity = { t2: 'finished', t3: 'bogus' };
  assert.deepEqual(await rig.api.termActivity(), [{ id: 't2', state: 'finished' }, { id: 't3', state: null }]);
});

test('termActivity without the section fails as the operation lane did', async () => {
  await assert.rejects(setup().api.termActivity(), { code: 'sectionUnavailable' });
});

test('a terminal run reveal reaches the page without its kind; the claim goes to the core once, id validated', async () => {
  const rig = setup();
  const runs = [];
  rig.api.onTerminalRunRequested((r) => runs.push(r));
  const open = (params) => rig.emit({ type: 'notification', notification: { method: 'ui/openRequested', params } });
  open({ kind: 'terminal', sessionId: 's1', terminalId: 't1', requestId: 'run-1' });
  open({ kind: 'browser', sessionId: 's1' });
  open({ kind: 'terminal', sessionId: '' });
  assert.deepEqual(runs, [{ sessionId: 's1', terminalId: 't1', requestId: 'run-1' }]);
  assert.equal(await rig.api.claimTerminalRun('run-1'), true);
  assert.deepEqual(rig.notes, [{ method: 'ui/terminalRun/claimed', params: { requestId: 'run-1' } }]);
  for (const bad of ['', 7, null, 'x'.repeat(129)]) await assert.rejects(rig.api.claimTerminalRun(bad));
  assert.equal(rig.notes.length, 1);
});
