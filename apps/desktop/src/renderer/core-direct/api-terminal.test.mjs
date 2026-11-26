// createTerminalApi against a fake connection: every member sends the request main sent for the same IPC call (the former main ipc-terminal.ts and
// connections/terminal-host.ts over the shared routes), answers what main answered, and the feeds, sections and flow control
// behave as the terminal host did.
import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createTerminalApi } from './api-terminal.ts';
import { createTerminalFeed } from './terminal-feed.ts';

const b64 = (text) => Buffer.from(text).toString('base64');

function setup({ answers = {}, sections = {}, deferredDetachTimeoutMs, client } = {}) {
  const calls = [];
  const notes = [];
  const eventListeners = new Set();
  const storeListeners = new Set();
  const replaced = new Set();
  const connection = {
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    onReplaced: (l) => {
      replaced.add(l);
      return () => replaced.delete(l);
    },
    onStoreChange: (l) => {
      storeListeners.add(l);
      return () => storeListeners.delete(l);
    },
    notify: (method, params) => notes.push({ method, params }),
    whenSynced: async () => undefined,
    snapshot: () => ({
      status: 'ready',
      entries: Object.entries(sections).map(([section, value]) => ({ section, key: null, revision: 1, value })),
    }),
    protocolClient: () => ({
      store: { section: (name) => (name in sections ? { value: sections[name] } : undefined) },
    }),
    ...(client ? { client } : {}),
  };
  const ctx = {
    connection,
    call: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (typeof answer === 'function') return answer(params);
      return method in answers ? answer : {};
    },
  };
  const api = createTerminalApi(ctx, deferredDetachTimeoutMs === undefined ? undefined : { deferredDetachTimeoutMs });
  return {
    api,
    connection,
    calls,
    notes,
    sections,
    emit: (event) =>
      eventListeners.forEach((l) => {
        l(event);
      }),
    store: (change) =>
      storeListeners.forEach((l) => {
        l(change);
      }),
    replace: () =>
      replaced.forEach((l) => {
        l();
      }),
  };
}
const delta = (tab, text, seq = 1) => ({
  type: 'notification',
  notification: {
    method: 'process/outputDelta',
    params: { processHandle: tab, bytesB64: b64(text) },
    feed: { id: `process:${tab}`, epoch: 'e1', seq },
  },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('every key of the terminal group is a member', () => {
  const { api } = setup();
  for (const key of DIRECT_KEYS.terminal) assert.equal(typeof api[key], 'function', key);
});

test('the requests equal the ones main sent for the same IPC calls', async () => {
  const { api, calls, notes } = setup({
    answers: {
      'terminal/ensure': { id: 't1', replay: 'r', sizeOwner: null },
      'terminal/attach': { id: 't1', replay: 'r', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    },
  });
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
  assert.deepEqual(
    calls.map((c) => [c.method, c.params]),
    [
      ['terminal/ensure', { tabId: 't1', options: { cwd: '/r', profile: 'bash' } }],
      ['terminal/attach', { tabId: 't1' }],
      ['terminal/ensure', { options: {} }],
      ['terminal/attach', { tabId: 't2' }],
      ['terminal/profiles', {}],
      ['terminal/focus', { tabId: 't1', focused: true }],
      ['feed/unsubscribe', { feedId: 'process:t1' }],
      ['terminal/dispose', { tabId: 't1' }],
    ]
  );
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
      'terminal/attach': ({ tabId }) =>
        tabId === 'gone'
          ? null
          : {
              id: tabId,
              replay: 'x',
              replayLeadUnit: 0xdc00,
              sizeOwner: owner,
              client: 'c1',
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 4 },
            },
    },
  });
  assert.deepEqual(await api.termAttach('t9'), {
    id: 't9',
    replay: '\udc00x',
    sizeOwner: { cols: 100, rows: 30, own: false },
  });
  assert.equal(await api.termAttach('gone'), null);
  // The ensure answers the attach's session, as the host did.
  assert.deepEqual(await api.termEnsure('t1', null, null), {
    id: 't1',
    replay: '\udc00x',
    sizeOwner: { cols: 100, rows: 30, own: false },
  });
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
  const rig = setup({
    answers: {
      'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(delta('t1', 'one', 1));
  rig.emit(delta('t2', 'other', 1));
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/outputDelta',
      params: { processHandle: 't1', bytesB64: b64('relay') },
      feed: { id: 'process:relay', epoch: 'e', seq: 1 },
    },
  });
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'one' }]);
  await rig.api.termDispose('t1');
  rig.emit(delta('t1', 'late', 2));
  await wait(30);
  assert.equal(seen.length, 1);
});

/** A terminal as the core names it: its incarnation within the run `core`. */
const T = (incarnation, core = 'run-1') => ({ core, incarnation });
const named = (event, terminal) => ({
  ...event,
  notification: { ...event.notification, params: { ...event.notification.params, terminal } },
});

test('an ensure that names a later terminal of an attached tab attaches it again, and the earlier one never reaches its pane', async () => {
  const replies = [
    { id: 't1', replay: 'one', terminal: T(1), subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    { id: 't1', replay: 'two', terminal: T(2), subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 } },
  ];
  const rig = setup({
    answers: {
      'terminal/attach': () => replies.shift(),
      'terminal/ensure': { id: 't1', replay: 'two', terminal: T(2) },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(named(delta('t1', 'one-live', 2), T(1)));
  await wait(15);
  // The shell exited and was respawned; its exit has not reached this window when the pane's ensure answers the next terminal.
  assert.deepEqual(await rig.api.termEnsure('t1', null, null), { id: 't1', replay: 'two', terminal: T(2) });
  assert.equal(rig.calls.filter((c) => c.method === 'terminal/attach').length, 2, 'the next terminal is attached');
  rig.emit(named(delta('t1', 'one-late', 3), T(1)));
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/exited',
      params: { processHandle: 't1', code: 0, terminal: T(1) },
      feed: { id: 'process:t1', epoch: 'e1', seq: 4 },
    },
  });
  const live = delta('t1', 'two-live', 2);
  rig.emit(
    named({ ...live, notification: { ...live.notification, feed: { id: 'process:t1', epoch: 'e2', seq: 2 } } }, T(2))
  );
  await wait(30);
  assert.equal(seen.map((event) => event.data).join(''), 'one-livetwo-live');
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e2', seq: 2 } }]],
    "the earlier terminal's exit did not end the tab's reading"
  );
});

test('an ensure joining an attach in flight that finds the earlier shell gone, or fails, still attaches the terminal it ensured', async () => {
  for (const ending of ['gone', 'failed']) {
    let answerWarmUp;
    const attaches = [
      () =>
        new Promise((resolve, reject) => {
          answerWarmUp = () => (ending === 'gone' ? resolve(null) : reject(new Error('link lost')));
        }),
      () => ({ id: 't1', replay: 'two', terminal: T(2), subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 } }),
    ];
    const rig = setup({
      answers: {
        'terminal/attach': () => attaches.shift()(),
        'terminal/ensure': { id: 't1', replay: 'two', terminal: T(2) },
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));
    // A dock hover's warm-up attaches the tab whose shell just exited; the pane's ensure respawns it meanwhile.
    const warmUp = rig.api.termAttach('t1').catch(() => null);
    const ensured = rig.api.termEnsure('t1', null, null);
    await wait(0);
    answerWarmUp();
    assert.deepEqual(await ensured, { id: 't1', replay: 'two', terminal: T(2) }, ending);
    await warmUp;
    assert.equal(
      rig.calls.filter((c) => c.method === 'terminal/attach').length,
      2,
      `the ensured terminal is attached (${ending})`
    );
    const live = delta('t1', 'two-live', 2);
    rig.emit(
      named({ ...live, notification: { ...live.notification, feed: { id: 'process:t1', epoch: 'e2', seq: 2 } } }, T(2))
    );
    await wait(30);
    assert.equal(seen.map((event) => event.data).join(''), 'two-live', ending);
  }
});

test('an ensure that names the terminal a tab is attached for, or an earlier one, attaches nothing more', async () => {
  const ensured = [
    { id: 't1', replay: 'r', terminal: T(2) },
    { id: 't1', replay: 'r', terminal: T(1) },
  ];
  const rig = setup({
    answers: {
      'terminal/attach': {
        id: 't1',
        replay: 'r',
        terminal: T(2),
        subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
      },
      'terminal/ensure': () => ensured.shift(),
    },
  });
  await rig.api.termAttach('t1');
  await rig.api.termEnsure('t1', null, null);
  await rig.api.termEnsure('t1', null, null);
  assert.equal(rig.calls.filter((c) => c.method === 'terminal/attach').length, 1);
});

test('flow control: 256 KiB unacknowledged pauses the core, under 32 KiB resumes it', async () => {
  const rig = setup({
    answers: {
      'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));
  await rig.api.termAttach('t1');
  rig.emit(delta('t1', 'a'.repeat(300 * 1024), 1));
  await wait(30);
  const flow = () =>
    rig.calls
      .filter((c) => c.method === 'terminal/pause' || c.method === 'terminal/resume')
      .map((c) => [c.method, c.params]);
  assert.deepEqual(flow(), [['terminal/pause', { tabId: 't1' }]]);
  assert.equal(
    seen.reduce((sum, e) => sum + e.data.length, 0),
    256 * 1024
  );
  rig.api.termAcknowledge('t1', 256 * 1024);
  await wait(30);
  // The 44 KiB still unacknowledged is above the low mark.
  assert.equal(
    seen.reduce((sum, e) => sum + e.data.length, 0),
    300 * 1024
  );
  assert.equal(flow().length, 1);
  rig.api.termAcknowledge('t1', 44 * 1024);
  assert.deepEqual(flow(), [
    ['terminal/pause', { tabId: 't1' }],
    ['terminal/resume', { tabId: 't1' }],
  ]);
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
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [
      ['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 7 } }],
      ['terminal/pause', { tabId: 't1' }],
    ]
  );
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
  const rig = setup({
    answers: {
      'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'replay', epoch: 'e1', startSeq: 1 } },
    },
  });
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
  const rig = setup({
    answers: {
      'terminal/attach': { id: 't1', replay: '', subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    },
  });
  await rig.api.termAttach('t1');
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/exited',
      params: { processHandle: 't1' },
      feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
    },
  });
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('activity and size owner follow the sections, termActivity reads the held rows', async () => {
  const rig = setup({
    sections: {
      terminalActivity: { t1: 'running' },
      terminalTabs: [{ id: 't1', sizeOwner: { cols: 90, rows: 20, owner: 'phone' } }],
    },
  });
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
  assert.deepEqual(await rig.api.termActivity(), [
    { id: 't2', state: 'finished' },
    { id: 't3', state: null },
  ]);
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

test('claimTerminalRun with no open core link resolves false and sends nothing; a bad id still rejects', async () => {
  const rig = setup();
  rig.api = createTerminalApi({
    connection: {
      ...rig.connection,
      notify: () => {
        throw new Error('The core connection is not open.');
      },
    },
    call: async () => ({}),
  });
  assert.equal(await rig.api.claimTerminalRun('run-1'), false);
  assert.equal(rig.notes.length, 0);
  await assert.rejects(rig.api.claimTerminalRun(''));
});

test('termDetach unsubscribes the feed, resumes paused flow, drops stale frames, and serializes reopen through terminal/attach', async () => {
  let resolveUnsubscribe;
  let attachCalls = 0;
  let emitDuringAttach = null;
  const rig = setup({
    answers: {
      'feed/unsubscribe': () =>
        new Promise((resolve) => {
          resolveUnsubscribe = () => resolve({});
        }),
      'terminal/ensure': { id: 't1', replay: 'stale-ensure-replay', terminal: T(1) },
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'initial',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return new Promise((resolve) => {
          emitDuringAttach = () =>
            resolve({
              id: 't1',
              replay: 'atomic-cut|',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 10 },
            });
        });
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // Initial attach and fill past high-watermark so PTY pauses.
  await rig.api.termEnsure('t1', null, null);
  rig.emit(named(delta('t1', 'x'.repeat(300 * 1024), 1), T(1)));
  await wait(30);
  assert.ok(rig.calls.some((c) => c.method === 'terminal/pause' && c.params.tabId === 't1'));
  seen.length = 0;
  rig.calls.length = 0;

  // Hide terminal: detaches feed, resumes paused PTY, drops buffered/late frames, and does not reattach on link replace.
  rig.api.termDetach('t1');
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [
      ['terminal/resume', { tabId: 't1' }],
      ['feed/unsubscribe', { feedId: 'process:t1' }],
    ]
  );
  rig.emit(named(delta('t1', 'stale-pre-unsub', 2), T(1)));
  rig.replace();
  await wait(20);
  assert.equal(seen.length, 0, 'frames arriving while detached or unsubscribing are ignored');
  assert.equal(attachCalls, 1, 'detached tab is not reattached on connection replace');

  // Reopen while feed/unsubscribe is still in flight: terminal/attach must wait for unsubscribe to settle.
  const reopen = rig.api.termEnsure('t1', null, null);
  await wait(15);
  assert.equal(attachCalls, 1, 'terminal/attach waits for in-flight feed/unsubscribe');
  rig.emit(named(delta('t1', 'still-stale', 3), T(1)));

  // Unsubscribe completes -> terminal/attach starts; live delta arriving mid-attach is held until attach resolves.
  resolveUnsubscribe();
  await wait(15);
  assert.equal(attachCalls, 2, 'reopen runs terminal/attach for an atomic replay cut');
  rig.emit(named(delta('t1', 'after-cut', 10), T(1)));
  await wait(20);
  assert.equal(seen.length, 0, 'delta arriving mid-attach is held until attach reply resolves');

  emitDuringAttach();
  const session = await reopen;
  assert.equal(session.replay, 'atomic-cut|');
  await wait(30);
  assert.deepEqual(
    seen,
    [{ id: 't1', data: 'after-cut' }],
    'held delta delivers once after replay cut with zero loss or duplication'
  );
});

test('termDetach while a reopened termEnsure is in flight does not disconnect the reopened feed', async () => {
  let ensureCount = 0;
  let resolveSecondEnsure;
  let rejectThirdEnsure;
  const rig = setup({
    answers: {
      'terminal/ensure': () => {
        ensureCount += 1;
        if (ensureCount === 1) return { id: 't1', replay: 'first', terminal: T(1) };
        if (ensureCount === 2) {
          return new Promise((resolve) => {
            resolveSecondEnsure = () => resolve({ id: 't1', replay: 'second', terminal: T(1) });
          });
        }
        return new Promise((_, reject) => {
          rejectThirdEnsure = () => reject(new Error('ensure failed'));
        });
      },
      'terminal/attach': {
        id: 't1',
        replay: 'first',
        terminal: T(1),
        subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // Mount 1 finishes ensure/attach; Mount 2 begins a new termEnsure for the same tab.
  await rig.api.termEnsure('t1', null, null);
  const second = rig.api.termEnsure('t1', null, null);
  await wait(0);

  // Stale Mount 1 detaches while Mount 2's termEnsure is still in flight: feed must stay subscribed.
  rig.api.termDetach('t1');
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'detach defers while a reopened ensure is in flight'
  );

  resolveSecondEnsure();
  await second;
  rig.emit(named(delta('t1', 'still-streaming', 2), T(1)));
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'still-streaming' }]);

  // If a subsequent in-flight ensure rejects after a deferred detach, the feed still unsubscribes cleanly.
  const failing = rig.api.termEnsure('t1', null, null);
  await wait(0);
  rig.api.termDetach('t1');
  assert.equal(rig.calls.filter((c) => c.method === 'feed/unsubscribe').length, 0);
  rejectThirdEnsure();
  await assert.rejects(failing, /ensure failed/);
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    1,
    'deferred detach runs when the in-flight ensure fails'
  );
});

test('a rejected feed attach inside termEnsure does not clear a deferred termDetach', async () => {
  let rejectAttach;
  const rig = setup({
    answers: {
      'terminal/ensure': { id: 't1', replay: 'fallback', terminal: T(1) },
      'terminal/attach': () =>
        new Promise((_resolve, reject) => {
          rejectAttach = () => reject(new Error('link lost'));
        }),
    },
  });

  // termEnsure receives the session and starts terminal/attach; termDetach arrives while attach is in flight.
  const ensured = rig.api.termEnsure('t1', null, null);
  await wait(0);
  rig.api.termDetach('t1');
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'detach defers while terminal/attach is in flight'
  );

  // Feed attach rejects, so termEnsure returns the ensure fallback, but the deferred detach must still unsubscribe.
  rejectAttach();
  assert.deepEqual(await ensured, { id: 't1', replay: 'fallback', terminal: T(1) });
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    1,
    'rejected attach must not mask or clear deferred detach'
  );

  // Because the feed was properly detached, link replacement must not reattach the orphaned tab.
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('a never-settling ensure flushes deferred termDetach on timeout without poisoning subsequent detaches', async () => {
  let ensureCount = 0;
  const rig = setup({
    deferredDetachTimeoutMs: 25,
    answers: {
      'terminal/ensure': () => {
        ensureCount += 1;
        if (ensureCount === 2) return new Promise(() => {});
        return { id: 't1', replay: `r${ensureCount}`, terminal: T(1) };
      },
      'terminal/attach': {
        id: 't1',
        replay: 'attached',
        terminal: T(1),
        subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
      },
    },
  });

  // Initial ensure attaches t1; a second ensure hangs indefinitely when termDetach arrives.
  await rig.api.termEnsure('t1', null, null);
  void rig.api.termEnsure('t1', null, null);
  await wait(0);

  rig.api.termDetach('t1');
  assert.equal(rig.calls.filter((c) => c.method === 'feed/unsubscribe').length, 0);

  // After the bounded timeout, the deferred detach flushes and clears the hung in-flight entry.
  await wait(45);
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    1,
    'deferred detach flushes even if the in-flight request never settles'
  );

  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, [], 'flushed tab is not reattached after link replace');

  // A subsequent reopen and immediate detach works cleanly without being stuck behind the hung request.
  await rig.api.termEnsure('t1', null, null);
  rig.calls.length = 0;
  rig.api.termDetach('t1');
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['feed/unsubscribe', { feedId: 'process:t1' }]]
  );
});

test('link replacement flushes a pending deferred termDetach before reattach runs', async () => {
  let ensureCount = 0;
  const rig = setup({
    deferredDetachTimeoutMs: 10_000,
    answers: {
      'terminal/ensure': () => {
        ensureCount += 1;
        if (ensureCount === 1) return { id: 't1', replay: 'first', terminal: T(1) };
        return new Promise(() => {});
      },
      'terminal/attach': {
        id: 't1',
        replay: 'first',
        terminal: T(1),
        subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
      },
    },
  });

  await rig.api.termEnsure('t1', null, null);
  void rig.api.termEnsure('t1', null, null);
  await wait(0);

  rig.api.termDetach('t1');
  rig.calls.length = 0;

  // Link replacement must flush the deferred detach BEFORE terminal-feed's reattach runs.
  rig.replace();
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['feed/unsubscribe', { feedId: 'process:t1' }]]
  );
});

test('deferred-detach timeout during in-flight terminal/attach invalidates the attach instead of returning a dead session', async () => {
  let attachCalls = 0;
  let resolveFirstAttach;
  const rig = setup({
    deferredDetachTimeoutMs: 25,
    answers: {
      'terminal/ensure': { id: 't1', replay: 'ensured-fallback', terminal: T(1) },
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstAttach = () =>
              resolve({
                id: 't1',
                replay: 'stale-unsubscribed-session',
                terminal: T(1),
                subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
              });
          });
        }
        return {
          id: 't1',
          replay: 'fresh-live-session',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // termEnsure finishes terminal/ensure and blocks in terminal/attach while termDetach arrives.
  const firstEnsure = rig.api.termEnsure('t1', null, null);
  await wait(0);
  assert.equal(attachCalls, 1);
  rig.api.termDetach('t1');

  // Deferred-detach timeout fires and unsubscribes while terminal/attach is still in flight.
  await wait(45);
  assert.equal(rig.calls.filter((c) => c.method === 'feed/unsubscribe').length, 1);

  // When the superseded terminal/attach resolves late, termEnsure must reject instead of returning a dead session.
  resolveFirstAttach();
  await assert.rejects(firstEnsure, { name: 'TerminalAttachCancelledError' });

  // No stale attached state remains: late deltas are ignored and link replace does not reattach.
  rig.emit(named(delta('t1', 'dead-output', 2), T(1)));
  rig.calls.length = 0;
  rig.replace();
  await wait(20);
  assert.equal(seen.length, 0);
  assert.deepEqual(rig.calls, []);

  // A fresh termEnsure afterward re-attaches cleanly and streams live output.
  const fresh = await rig.api.termEnsure('t1', null, null);
  assert.equal(fresh.replay, 'fresh-live-session');
  rig.emit(
    named(
      {
        ...delta('t1', 'live-output', 2),
        notification: {
          ...delta('t1', 'live-output', 2).notification,
          feed: { id: 'process:t1', epoch: 'e2', seq: 2 },
        },
      },
      T(1)
    )
  );
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'live-output' }]);
});

test('a rejected attach leaves no optimistic attached marker for an overlapping termEnsure', async () => {
  let ensureCount = 0;
  let attachCount = 0;
  let resolveSecondEnsure;
  let rejectFirstAttach;
  let rejectSecondAttach;
  const rig = setup({
    answers: {
      'terminal/ensure': () => {
        ensureCount += 1;
        if (ensureCount === 1) return { id: 't1', replay: 'e1', terminal: T(1) };
        return new Promise((resolve) => {
          resolveSecondEnsure = () => resolve({ id: 't1', replay: 'e2', terminal: T(1) });
        });
      },
      'terminal/attach': () => {
        attachCount += 1;
        if (attachCount === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirstAttach = () => reject(new Error('attach 1 failed'));
          });
        }
        return new Promise((_resolve, reject) => {
          rejectSecondAttach = () => reject(new Error('attach 2 failed'));
        });
      },
    },
  });

  // Ensure #1 enters terminal/attach; Ensure #2 overlaps while awaiting terminal/ensure; termDetach defers.
  const ensure1 = rig.api.termEnsure('t1', null, null);
  const ensure2 = rig.api.termEnsure('t1', null, null);
  await wait(0);
  assert.equal(attachCount, 1);
  rig.api.termDetach('t1');

  // Attach #1 rejects: Ensure #1 returns its fallback without clearing deferred detach or leaving a stale attached marker.
  rejectFirstAttach();
  assert.deepEqual(await ensure1, { id: 't1', replay: 'e1', terminal: T(1) });
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'detach remains deferred while overlapping ensure #2 is still in flight'
  );

  // Ensure #2 resolves terminal/ensure: because attach #1 left no optimistic marker, Ensure #2 MUST retry terminal/attach.
  resolveSecondEnsure();
  await wait(0);
  assert.equal(attachCount, 2, 'overlapping ensure retries terminal/attach instead of trusting a failed attach');

  // When Attach #2 also rejects, the deferred detach executes and link replacement does not reattach.
  rejectSecondAttach();
  assert.deepEqual(await ensure2, { id: 't1', replay: 'e2', terminal: T(1) });
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    1,
    'deferred detach unsubscribes once all overlapping attaches fail'
  );
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('a rejected refresh termAttach flushes buffered live deltas without dropping seq 1 or corrupting resumeFrom', async () => {
  let attachCalls = 0;
  let rejectRefresh;
  const rig = setup({
    answers: {
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'initial',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        if (attachCalls === 2) {
          return new Promise((_resolve, reject) => {
            rejectRefresh = () => reject(new Error('refresh rpc failed'));
          });
        }
        return {
          id: 't1',
          replay: '',
          terminal: T(1),
          subscription: { mode: 'replay', epoch: 'e1', startSeq: 3 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // Initial attach succeeds on e1 starting at seq 1.
  await rig.api.termAttach('t1');

  // Refresh attach starts on the same live link; live delta seq 1 arrives while refresh is in flight.
  const refresh = rig.api.termAttach('t1');
  await wait(0);
  rig.emit(named(delta('t1', 'seq1-live', 1), T(1)));

  // Refresh rejects: seq 1 must be delivered in order to the still-live subscription, never skipped.
  rejectRefresh();
  await assert.rejects(refresh, /refresh rpc failed/);
  rig.emit(named(delta('t1', 'seq2-live', 2), T(1)));
  await wait(30);
  assert.equal(seen.map((e) => e.data).join(''), 'seq1-liveseq2-live');

  // Reconnect resumes from seq 2, confirming resumeFrom stayed accurate.
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 2 } }]]
  );
});

test('a failed first attach inside termEnsure stays wanted and recovers on link replacement', async () => {
  let attachCalls = 0;
  const rig = setup({
    answers: {
      'terminal/ensure': { id: 't1', replay: 'fallback-screen', terminal: T(1) },
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) throw new Error('link lost');
        return {
          id: 't1',
          replay: 'recovered-screen',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // First attach hits a link drop; termEnsure answers the fallback session without losing reconnect recovery.
  assert.deepEqual(await rig.api.termEnsure('t1', null, null), {
    id: 't1',
    replay: 'fallback-screen',
    terminal: T(1),
  });
  assert.equal(attachCalls, 1);

  // Link replacement triggers a fresh terminal/attach for the wanted tab and redraws the recovered screen.
  rig.calls.length = 0;
  rig.replace();
  await wait(30);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1' }]]
  );
  assert.deepEqual(seen, [{ id: 't1', data: 'recovered-screen', reset: true }]);

  // Live output on the recovered link streams normally.
  rig.emit(
    named(
      {
        ...delta('t1', 'after-recovery', 2),
        notification: {
          ...delta('t1', 'after-recovery', 2).notification,
          feed: { id: 'process:t1', epoch: 'e2', seq: 2 },
        },
      },
      T(1)
    )
  );
  await wait(30);
  assert.deepEqual(seen.at(-1), { id: 't1', data: 'after-recovery' });
});

test('a rejected relink clears current-link attached state so an overlapping termEnsure retries and honors deferred detach', async () => {
  let attachCalls = 0;
  let rejectRelink;
  let rejectEnsureAttach;
  let resolveOverlappingEnsure;
  const rig = setup({
    answers: {
      'terminal/ensure': () =>
        new Promise((resolve) => {
          resolveOverlappingEnsure = () => resolve({ id: 't1', replay: 'e2', terminal: T(1) });
        }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'link1',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        if (attachCalls === 2) {
          return new Promise((_resolve, reject) => {
            rejectRelink = () => reject(new Error('relink failed'));
          });
        }
        return new Promise((_resolve, reject) => {
          rejectEnsureAttach = () => reject(new Error('retry attach failed'));
        });
      },
    },
  });

  // Tab is attached on Link 1.
  await rig.api.termAttach('t1');
  assert.equal(attachCalls, 1);

  // Link 1 is replaced -> current-link attached state clears immediately and relink attach #2 starts.
  rig.replace();
  await wait(0);
  assert.equal(attachCalls, 2);

  // Overlapping termEnsure starts while relink is failing, and termDetach arrives (deferred).
  const overlapping = rig.api.termEnsure('t1', null, null);
  await wait(0);
  rig.api.termDetach('t1');

  // Relink attach #2 rejects, then overlapping termEnsure resolves terminal/ensure.
  rejectRelink();
  await wait(0);
  resolveOverlappingEnsure();
  await wait(0);

  // Because Link 1's stale attached entry was cleared, termEnsure MUST NOT treat t1 as attached and must send attach #3.
  assert.equal(attachCalls, 3, 'overlapping ensure must not mistake previous-link state for an active attachment');

  // When attach #3 also rejects, the deferred detach executes and removes t1 from wanted.
  rejectEnsureAttach();
  assert.deepEqual(await overlapping, { id: 't1', replay: 'e2', terminal: T(1) });
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    1,
    'deferred detach must run instead of being cleared by stale previous-link state'
  );
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('a queued attach that reaches the server after disconnect+detach+reconnect sends feed/unsubscribe and throws TerminalAttachCancelledError', async () => {
  let connected = false;
  const rawCalls = [];
  let resolveQueuedAttach;
  const rawClient = {
    call: async (method, params) => {
      rawCalls.push({ method, params });
      return {};
    },
  };
  const rig = setup({
    client: () => (connected ? rawClient : null),
    answers: {
      'terminal/attach': () =>
        new Promise((resolve) => {
          resolveQueuedAttach = () =>
            resolve({
              id: 't1',
              replay: 'late-reconnected-session',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            });
        }),
    },
  });

  // Start disconnected; queue terminal/attach with an AbortController so detach runs while still disconnected.
  rig.emit({ type: 'status', status: { state: 'reconnecting' } });
  const abort = new AbortController();
  const pendingAttach = rig.api.termAttach('t1', abort.signal);
  await wait(0);

  // Detach while disconnected: connection.client() is null, so no feed/unsubscribe can reach the server yet.
  abort.abort();
  rig.api.termDetach('t1');
  assert.equal(rawCalls.length, 0, 'no unsubscribe was sent while disconnected');

  // Reconnect, then the queued terminal/attach reaches the server and resolves with a live session.
  connected = true;
  rig.emit({ type: 'status', status: { state: 'ready' } });
  resolveQueuedAttach();

  await assert.rejects(pendingAttach, { name: 'TerminalAttachCancelledError' });
  await wait(0);
  assert.deepEqual(
    rawCalls,
    [{ method: 'feed/unsubscribe', params: { feedId: 'process:t1' } }],
    'cancelled attach that succeeded on the server after reconnect must immediately unsubscribe on the server'
  );

  // No local state remains: a subsequent link replacement does not reattach.
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(rig.calls, []);
});

test('a plain termAttach queued across reconnect ready preserves holding and delivers post-snapshot frames arriving before its reply', async () => {
  let resolveAttach;
  const rig = setup({
    answers: {
      'terminal/attach': () =>
        new Promise((resolve) => {
          resolveAttach = () =>
            resolve({
              id: 't1',
              replay: 'snapshot-screen',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
            });
        }),
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // Start disconnected and queue a plain termAttach (not yet in wanted).
  rig.emit({ type: 'status', status: { state: 'reconnecting' } });
  const pending = rig.api.termAttach('t1');
  await wait(0);

  // Connection becomes ready -> reattach/invalidateCurrentLink runs while the plain termAttach is still in flight.
  rig.emit({ type: 'status', status: { state: 'ready' } });

  // Server processes the queued attach on the new link and emits a post-snapshot frame BEFORE the RPC reply settles.
  rig.emit(
    named(
      {
        ...delta('t1', 'first-live-frame', 1),
        notification: {
          ...delta('t1', 'first-live-frame', 1).notification,
          feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
        },
      },
      T(1)
    )
  );

  resolveAttach();
  assert.deepEqual(await pending, { id: 't1', replay: 'snapshot-screen', terminal: T(1) });
  await wait(30);
  assert.deepEqual(
    seen,
    [{ id: 't1', data: 'first-live-frame' }],
    'post-snapshot live frame arriving before queued attach reply must not be lost across ready'
  );

  // Resume position advanced to seq 1 on e2.
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e2', seq: 1 } }]]
  );
});

test('a rejected refresh preserves the feed stamp of a split multibyte UTF-8 prefix across reconnect replay', async () => {
  let attachCalls = 0;
  let rejectRefresh;
  const rig = setup({
    answers: {
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: '',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        if (attachCalls === 2) {
          return new Promise((_resolve, reject) => {
            rejectRefresh = () => reject(new Error('refresh failed'));
          });
        }
        return {
          id: 't1',
          replay: '',
          terminal: T(1),
          subscription: { mode: 'replay', epoch: 'e1', startSeq: 2 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  await rig.api.termAttach('t1');

  // Start a refresh attach; while in flight, frame seq 1 delivers the first 2 bytes of '한' (0xED 0x95 0x9C).
  const refresh = rig.api.termAttach('t1');
  await wait(0);
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/outputDelta',
      params: { processHandle: 't1', bytesB64: Buffer.from([0xed, 0x95]).toString('base64'), terminal: T(1) },
      feed: { id: 'process:t1', epoch: 'e1', seq: 1 },
    },
  });

  // Refresh rejects: flush must record seq 1's stamp even though the partial UTF-8 decoded to "".
  rejectRefresh();
  await assert.rejects(refresh, /refresh failed/);

  // Link drops and reconnects: resumeFrom MUST be seq 1 (not seq 0) so the prefix is not replayed twice.
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 1 } }]]
  );

  // Server replays seq 2 carrying the continuation byte (0x9C); the decoder completes '한' without corruption.
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/outputDelta',
      params: { processHandle: 't1', bytesB64: Buffer.from([0x9c]).toString('base64'), terminal: T(1) },
      feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
    },
  });
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: '한' }]);
});

test('reconnect buffers post-snapshot frames and early exits for a replacement PTY incarnation arriving before relink reply', async () => {
  for (const withEarlyExit of [false, true]) {
    let attachCalls = 0;
    let resolveRelink;
    const rig = setup({
      answers: {
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            return {
              id: 't1',
              replay: 'old-screen',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            };
          }
          return new Promise((resolve) => {
            resolveRelink = () =>
              resolve({
                id: 't1',
                replay: 'new-screen|',
                terminal: T(2),
                subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
              });
          });
        },
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    // Initial attach on incarnation T(1).
    await rig.api.termAttach('t1');

    // Link replaces -> relink sends terminal/attach with prior incarnation T(1).
    rig.replace();
    await wait(0);
    assert.equal(attachCalls, 2);

    // Before relink reply settles, old T(1) emits a late exit and replacement T(2) emits a post-snapshot frame (and optional early exit).
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/exited',
        params: { processHandle: 't1', code: 0, terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
      },
    });
    rig.emit(
      named(
        {
          ...delta('t1', 'replacement-first-frame', 1),
          notification: {
            ...delta('t1', 'replacement-first-frame', 1).notification,
            feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
          },
        },
        T(2)
      )
    );
    if (withEarlyExit) {
      rig.emit({
        type: 'notification',
        notification: {
          method: 'process/exited',
          params: { processHandle: 't1', code: 0, terminal: T(2) },
          feed: { id: 'process:t1', epoch: 'e2', seq: 2 },
        },
      });
    }

    // Relink reply settles with replacement incarnation T(2).
    resolveRelink();
    await wait(30);

    assert.deepEqual(
      seen,
      [
        { id: 't1', data: 'new-screen|', reset: true },
        { id: 't1', data: 'replacement-first-frame' },
      ],
      `replacement PTY first frame must be delivered (withEarlyExit=${withEarlyExit})`
    );

    // If T(2) already exited early, the tab is no longer attached/wanted; otherwise it remains attached and resumes from e2 seq 1.
    assert.equal(rig.api.isTerminalAttached('t1'), !withEarlyExit);
    rig.calls.length = 0;
    rig.replace();
    await wait(10);
    if (withEarlyExit) {
      assert.deepEqual(rig.calls, [], 'early exit of replacement incarnation clears wanted state');
    } else {
      assert.deepEqual(
        rig.calls.map((c) => [c.method, c.params]),
        [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e2', seq: 1 } }]]
      );
    }
  }
});

test('aborting one consumer on a shared pending attach does not cancel or detach the other consumer across reconnect', async () => {
  let resolveAttach;
  const rig = setup({
    answers: {
      'terminal/attach': () =>
        new Promise((resolve) => {
          resolveAttach = () =>
            resolve({
              id: 't1',
              replay: 'shared-screen',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
            });
        }),
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  const abort1 = new AbortController();
  const abort2 = new AbortController();
  const caller1 = rig.api.termAttach('t1', abort1.signal);
  const caller2 = rig.api.termAttach('t1', abort2.signal);
  await wait(0);

  // Caller 1 aborts while Caller 2 is still waiting, then link replacement occurs.
  abort1.abort();
  rig.replace();
  await wait(0);
  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'aborting Caller 1 while Caller 2 is active must not schedule a deferred detach flushed on reconnect'
  );

  // Shared attach resolves: Caller 1 rejects as cancelled, Caller 2 succeeds and stays attached.
  resolveAttach();
  await assert.rejects(caller1, { name: 'TerminalAttachCancelledError' });
  assert.deepEqual(await caller2, { id: 't1', replay: 'shared-screen', terminal: T(1) });
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  assert.equal(rig.calls.filter((c) => c.method === 'feed/unsubscribe').length, 0);

  // Live output continues reaching Caller 2.
  rig.emit(
    named(
      {
        ...delta('t1', 'caller2-live', 1),
        notification: {
          ...delta('t1', 'caller2-live', 1).notification,
          feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
        },
      },
      T(1)
    )
  );
  await wait(30);
  assert.deepEqual(seen, [{ id: 't1', data: 'caller2-live' }]);
});

test('UTF-8 decoder state and feed position stay in lockstep for post-cut prefixes before snapshot reply and rejected relinks', async () => {
  // Probe A: post-cut UTF-8 prefix arriving BEFORE a snapshot redraw reply settles.
  {
    let attachCalls = 0;
    let resolveRelink;
    const rig = setup({
      answers: {
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            return {
              id: 't1',
              replay: 'old',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            };
          }
          return new Promise((resolve) => {
            resolveRelink = () =>
              resolve({
                id: 't1',
                replay: 'snap:',
                terminal: T(1),
                subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
              });
          });
        },
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    await rig.api.termAttach('t1');
    rig.replace();
    await wait(0);

    // Post-cut frame seq 1 on e2 carries the first 2 bytes of '한' (0xED 0x95) BEFORE the snapshot reply arrives.
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', bytesB64: Buffer.from([0xed, 0x95]).toString('base64'), terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
      },
    });

    // Snapshot reply settles and redraws, then seq 2 delivers the continuation byte (0x9C).
    resolveRelink();
    await wait(10);
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', bytesB64: Buffer.from([0x9c]).toString('base64'), terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e2', seq: 2 },
      },
    });
    await wait(30);
    assert.deepEqual(
      seen,
      [
        { id: 't1', data: 'snap:', reset: true },
        { id: 't1', data: '한' },
      ],
      'post-cut UTF-8 prefix arriving before snapshot reply must decode intact without replacement characters'
    );
  }

  // Probe B: rejected relink after a committed UTF-8 prefix must not wipe the live decoder while keeping resumeFrom.
  {
    let attachCalls = 0;
    const rig = setup({
      answers: {
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            return {
              id: 't1',
              replay: '',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            };
          }
          if (attachCalls === 2) {
            throw new Error('relink hiccup');
          }
          return {
            id: 't1',
            replay: '',
            terminal: T(1),
            subscription: { mode: 'replay', epoch: 'e1', startSeq: 2 },
          };
        },
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    await rig.api.termAttach('t1');

    // Commit first 2 bytes of '한' at e1 seq 1.
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', bytesB64: Buffer.from([0xed, 0x95]).toString('base64'), terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e1', seq: 1 },
      },
    });

    // First relink rejects.
    rig.replace();
    await wait(10);
    assert.equal(attachCalls, 2);

    // Second relink succeeds with replay starting at seq 2 (resuming from e1 seq 1).
    rig.calls.length = 0;
    rig.replace();
    await wait(10);
    assert.deepEqual(
      rig.calls.map((c) => [c.method, c.params]),
      [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 1 } }]]
    );

    // Continuation byte arrives at seq 2: decoder still holds [0xED, 0x95] so '한' decodes intact.
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', bytesB64: Buffer.from([0x9c]).toString('base64'), terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
      },
    });
    await wait(30);
    assert.deepEqual(
      seen,
      [{ id: 't1', data: '한' }],
      'rejected relink must preserve committed UTF-8 prefix matching resumeFrom'
    );
  }
});

test('surviving termEnsure keeps reconnect recovery when a shared aborting termAttach rejects on link loss', async () => {
  let attachCalls = 0;
  let rejectFirstAttach;
  let resolveFirstAttachStarted;
  const firstAttachStarted = new Promise((resolve) => {
    resolveFirstAttachStarted = resolve;
  });
  const rig = setup({
    answers: {
      'terminal/ensure': () => ({
        id: 't1',
        replay: 'fallback\r\n',
        terminal: T(1),
      }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          resolveFirstAttachStarted();
          return new Promise((_resolve, reject) => {
            rejectFirstAttach = reject;
          });
        }
        return {
          id: 't1',
          replay: 'recovered\r\n',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
      'feed/unsubscribe': () => ({ ok: true }),
    },
  });

  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // Surviving consumer calls termEnsure (starts shared terminal/attach).
  const ensurePromise = rig.api.termEnsure('t1', '/tmp', null);
  await firstAttachStarted;

  // Second caller joins the same in-flight attach and aborts before link loss rejects it.
  const ac = new AbortController();
  const attachPromise = rig.api.termAttach('t1', ac.signal);
  ac.abort();
  rejectFirstAttach(new Error('link dropped'));

  await assert.rejects(attachPromise, /link dropped/);
  const session = await ensurePromise;
  assert.deepEqual(session, { id: 't1', replay: 'fallback\r\n', terminal: T(1) });

  assert.equal(
    rig.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'surviving termEnsure fallback must not unsubscribe the shared feed'
  );
  assert.equal(rig.api.isTerminalAttached('t1'), false);

  // Link replacement must still recover the surviving consumer's tab.
  rig.calls.length = 0;
  rig.replace();
  await wait(20);
  assert.equal(attachCalls, 2, 'link replacement must reattach surviving termEnsure tab');
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  assert.deepEqual(
    seen,
    [{ id: 't1', data: 'recovered\r\n', reset: true }],
    'recovered relink must deliver snapshot redraw to the surviving pane'
  );

  // Subsequent live output streams cleanly on e2.
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/outputDelta',
      params: { processHandle: 't1', bytesB64: Buffer.from('live\r\n').toString('base64'), terminal: T(1) },
      feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
    },
  });
  await wait(20);
  assert.deepEqual(seen, [
    { id: 't1', data: 'recovered\r\n', reset: true },
    { id: 't1', data: 'live\r\n' },
  ]);

  // Explicit detach from the surviving consumer still cleans up and stops reconnect recovery.
  rig.calls.length = 0;
  rig.api.termDetach('t1');
  await wait(10);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['feed/unsubscribe', { feedId: 'process:t1' }]]
  );
  rig.calls.length = 0;
  rig.replace();
  await wait(10);
  assert.equal(
    rig.calls.filter((c) => c.method === 'terminal/attach').length,
    0,
    'explicitly detached tab must not reattach on later reconnect'
  );
});

test('held exit of previous shell during failed replacement attach preserves reconnect recovery for replacement incarnation', async () => {
  let attachCalls = 0;
  let rejectSecondAttach;
  let resolveSecondAttachStarted;
  const secondAttachStarted = new Promise((resolve) => {
    resolveSecondAttachStarted = resolve;
  });
  const rig = setup({
    answers: {
      'terminal/ensure': () => ({
        id: 't1',
        replay: 'replacement-fallback\r\n',
        terminal: T(2),
      }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'old-shell\r\n',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        if (attachCalls === 2) {
          resolveSecondAttachStarted();
          return new Promise((_resolve, reject) => {
            rejectSecondAttach = reject;
          });
        }
        return {
          id: 't1',
          replay: 'replacement-recovered\r\n',
          terminal: T(2),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // 1. Attach incarnation 1 and advance its position.
  await rig.api.termAttach('t1');
  rig.emit(named(delta('t1', 'old-live\r\n', 1), T(1)));
  await wait(20);
  seen.length = 0;

  // 2. termEnsure spawns replacement incarnation 2 -> starts attach #2 for T(2).
  const ensurePromise = rig.api.termEnsure('t1', '/tmp', null);
  await secondAttachStarted;

  // 3. Old shell T(1)'s exit arrives while T(2)'s attach is in flight, then T(2)'s attach rejects on link loss.
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/exited',
      params: { processHandle: 't1', terminal: T(1) },
      feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
    },
  });
  rejectSecondAttach(new Error('link lost'));

  const session = await ensurePromise;
  assert.deepEqual(session, { id: 't1', replay: 'replacement-fallback\r\n', terminal: T(2) });
  assert.equal(rig.api.isTerminalAttached('t1'), false);

  // 4. Next link replacement must still recover T(2) (without stale T(1) resumeFrom).
  rig.calls.length = 0;
  rig.replace();
  await wait(20);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1' }]],
    'old shell exit must not clear wanted recovery for replacement incarnation'
  );
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  assert.deepEqual(seen, [{ id: 't1', data: 'replacement-recovered\r\n', reset: true }]);
});

test('onReplaced does not clear held post-snapshot deltas for an attach already running on the current link', async () => {
  // Variant A: without connection.client (status ready -> delta -> onReplaced -> attach reply).
  {
    let resolveAttach;
    const rig = setup({
      answers: {
        'terminal/attach': () =>
          new Promise((resolve) => {
            resolveAttach = () =>
              resolve({
                id: 't1',
                replay: 'snap-a',
                terminal: T(1),
                subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
              });
          }),
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    rig.emit({ type: 'status', status: { state: 'reconnecting' } });
    rig.emit({ type: 'status', status: { state: 'ready' } });
    const pending = rig.api.termAttach('t1');
    await wait(0);

    // Post-cut delta arrives on the new ready link BEFORE onReplaced fires.
    rig.emit(
      named(
        {
          ...delta('t1', 'post-cut-a', 1),
          notification: {
            ...delta('t1', 'post-cut-a', 1).notification,
            feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
          },
        },
        T(1)
      )
    );
    rig.replace();
    resolveAttach();

    assert.deepEqual(await pending, { id: 't1', replay: 'snap-a', terminal: T(1) });
    await wait(20);
    assert.deepEqual(seen, [{ id: 't1', data: 'post-cut-a' }]);
  }

  // Variant B: with connection.client identity — same-client onReplaced preserves held delta,
  // while cross-client onReplaced clears stale frames from the superseded client.
  {
    const client1 = { call: async () => ({}) };
    const client2 = { call: async () => ({}) };
    let activeClient = client1;
    let resolveAttach;
    const rig = setup({
      client: () => activeClient,
      answers: {
        'terminal/attach': () =>
          new Promise((resolve) => {
            resolveAttach = () =>
              resolve({
                id: 't1',
                replay: 'snap-b',
                terminal: T(1),
                subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
              });
          }),
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    // Switch to client2 and emit ready, start attach on client2, emit post-cut delta, then fire onReplaced on client2.
    rig.emit({ type: 'status', status: { state: 'reconnecting' } });
    activeClient = client2;
    rig.emit({ type: 'status', status: { state: 'ready' } });
    const pending = rig.api.termAttach('t1');
    await wait(0);

    rig.emit(
      named(
        {
          ...delta('t1', 'post-cut-b', 1),
          notification: {
            ...delta('t1', 'post-cut-b', 1).notification,
            feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
          },
        },
        T(1)
      )
    );
    rig.replace();
    resolveAttach();

    assert.deepEqual(await pending, { id: 't1', replay: 'snap-b', terminal: T(1) });
    await wait(20);
    assert.deepEqual(seen, [{ id: 't1', data: 'post-cut-b' }]);
  }

  // Variant C: cross-client onReplaced (client1 -> client2) clears stale frames buffered on the superseded client.
  {
    const client1 = { call: async () => ({}) };
    const client2 = { call: async () => ({}) };
    let activeClient = client1;
    let resolveAttach;
    const rig = setup({
      client: () => activeClient,
      answers: {
        'terminal/attach': () =>
          new Promise((resolve) => {
            resolveAttach = () =>
              resolve({
                id: 't1',
                replay: 'snap-c',
                terminal: T(1),
                subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
              });
          }),
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    // Attach starts on client1 and buffers a frame from client1 before link switches to client2.
    const pending = rig.api.termAttach('t1');
    await wait(0);
    rig.emit(named(delta('t1', 'stale-from-client1', 1), T(1)));

    activeClient = client2;
    rig.replace();
    rig.emit(named(delta('t1', 'fresh-from-client2', 1), T(1)));
    resolveAttach();

    assert.deepEqual(await pending, { id: 't1', replay: 'snap-c', terminal: T(1) });
    await wait(20);
    assert.deepEqual(seen, [{ id: 't1', data: 'fresh-from-client2' }]);
  }
});

test('establishing a new replacement snapshot drops unflushed buffered deltas from the previous PTY', async () => {
  let attachCalls = 0;
  const rig = setup({
    answers: {
      'terminal/ensure': () => ({
        id: 't1',
        replay: 'snapshot-2\r\n',
        terminal: T(2),
      }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'snapshot-1\r\n',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        return {
          id: 't1',
          replay: 'snapshot-2\r\n',
          terminal: T(2),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  await rig.api.termAttach('t1');

  // Emit an old-PTY delta that sits in the 5ms coalescing buffer (do not flush yet).
  rig.emit(named(delta('t1', 'old-buffered-tail\r\n', 1), T(1)));

  // Immediately replace the PTY under the same tab id before the coalescing timer fires.
  const session = await rig.api.termEnsure('t1', '/tmp', null);
  assert.deepEqual(session, { id: 't1', replay: 'snapshot-2\r\n', terminal: T(2) });

  // Wait past the coalescing window: old-buffered-tail must never flush after snapshot-2.
  await wait(30);
  assert.deepEqual(seen, [], 'unflushed old-PTY delta must be dropped before replacement snapshot');

  // New-PTY live output on e2 streams cleanly.
  rig.emit(
    named(
      {
        ...delta('t1', 'new-live\r\n', 1),
        notification: {
          ...delta('t1', 'new-live\r\n', 1).notification,
          feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
        },
      },
      T(2)
    )
  );
  await wait(20);
  assert.deepEqual(seen, [{ id: 't1', data: 'new-live\r\n' }]);
});

test('terminal-feed cancel tokens do not leak closed, idle, or settled tab IDs', async () => {
  let resolvePendingAttach;
  const ctx = {
    connection: {
      onEvent: () => () => {},
      onReplaced: () => () => {},
      notify: () => {},
    },
    call: async (method, params) => {
      if (method === 'terminal/attach' && params.tabId === 't-inflight') {
        return new Promise((resolve) => {
          resolvePendingAttach = () =>
            resolve({
              id: 't-inflight',
              replay: '',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            });
        });
      }
      if (method === 'terminal/attach') {
        return {
          id: params.tabId,
          replay: '',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
        };
      }
      return {};
    },
  };
  const feed = createTerminalFeed(ctx, () => {});

  // 1. Disposing/detaching idle tabs must never insert cancel entries.
  for (let i = 0; i < 20; i += 1) {
    feed.dispose(`idle-${i}`);
    feed.detach(`idle-detach-${i}`);
  }
  assert.equal(feed.activeCancelTokenCount(), 0);

  // 2. Normal settled attach releases its cancel token once complete.
  await feed.attach('t-ok');
  assert.equal(feed.activeCancelTokenCount(), 0);
  feed.detach('t-ok');
  feed.dispose('t-ok');
  assert.equal(feed.activeCancelTokenCount(), 0);

  // 3. Disposing while attach + joinOrAttach are in flight cancels both and deletes the map entry immediately.
  const inflight = feed.attach('t-inflight');
  const joined = feed.joinOrAttach('t-inflight', T(2));
  assert.equal(feed.activeCancelTokenCount(), 1);
  feed.dispose('t-inflight');
  assert.equal(feed.activeCancelTokenCount(), 0, 'dispose must remove cancel token immediately without leaking');
  resolvePendingAttach();
  await assert.rejects(inflight, { name: 'TerminalAttachCancelledError' });
  await assert.rejects(joined, { name: 'TerminalAttachCancelledError' });
  assert.equal(feed.activeCancelTokenCount(), 0);
});

test('late ensure for superseded shell T1 does not overwrite wanted T2 or disable reconnect recovery on T1 exit', async () => {
  for (const [label, oldTerm, newTerm] of [
    ['same-core', T(1), T(2)],
    ['cross-core', { core: 'run-1', incarnation: 1 }, { core: 'run-2', incarnation: 1 }],
  ]) {
    let ensureCalls = 0;
    let attachCalls = 0;
    let resolveLateOldEnsure;
    const rig = setup({
      answers: {
        'terminal/ensure': () => {
          ensureCalls += 1;
          if (ensureCalls === 1) {
            return new Promise((resolve) => {
              resolveLateOldEnsure = () =>
                resolve({
                  id: 't1',
                  replay: 'old-ensure\r\n',
                  terminal: oldTerm,
                });
            });
          }
          return {
            id: 't1',
            replay: 'new-fallback\r\n',
            terminal: newTerm,
          };
        },
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            return {
              id: 't1',
              replay: 'old-snap\r\n',
              terminal: oldTerm,
              subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
            };
          }
          if (attachCalls === 2) {
            throw new Error('replacement attach failed');
          }
          return {
            id: 't1',
            replay: 'new-recovered\r\n',
            terminal: newTerm,
            subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
          };
        },
      },
    });
    const seen = [];
    rig.api.subscribeTermData((event) => seen.push(event));

    // 1. Attach old shell T1.
    await rig.api.termAttach('t1');

    // 2. Start an ensure for T1 that will answer late.
    const lateOldEnsure = rig.api.termEnsure('t1', '/tmp', null);
    await wait(0);

    // 3. Replacement ensure for T2 advances wanted to T2; its attach rejects while attached still holds T1.
    const newEnsure = await rig.api.termEnsure('t1', '/tmp', null);
    assert.deepEqual(newEnsure, { id: 't1', replay: 'new-fallback\r\n', terminal: newTerm });
    assert.equal(attachCalls, 2);

    // 4. Outstanding ensure for old T1 now resolves -> must NOT overwrite wanted back from T2 to T1.
    resolveLateOldEnsure();
    await lateOldEnsure;
    assert.equal(attachCalls, 2, `${label}: late ensure for superseded T1 must not trigger bogus attach`);

    // 5. Live exit of old T1 arrives -> must clear attached T1 while keeping wanted T2.
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/exited',
        params: { processHandle: 't1', terminal: oldTerm },
        feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
      },
    });
    assert.equal(rig.api.isTerminalAttached('t1'), false);

    // 6. Next link replacement must still recover T2.
    rig.calls.length = 0;
    rig.replace();
    await wait(20);
    assert.deepEqual(
      rig.calls.map((c) => [c.method, c.params]),
      [['terminal/attach', { tabId: 't1' }]],
      `${label}: next link replacement must still recover wanted T2`
    );
    assert.equal(rig.api.isTerminalAttached('t1'), true);
    assert.deepEqual(seen, [{ id: 't1', data: 'new-recovered\r\n', reset: true }]);
  }
});

test('same-client onReplaced preserves live attached subscription and linkGen when a refresh attach rejects', async () => {
  const client1 = { call: async () => ({}) };
  const client2 = { call: async () => ({}) };
  let activeClient = client1;
  let attachCalls = 0;
  let rejectRefresh;
  const rig = setup({
    client: () => activeClient,
    answers: {
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          return {
            id: 't1',
            replay: 'initial\r\n',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          };
        }
        if (attachCalls === 2) {
          return new Promise((_resolve, reject) => {
            rejectRefresh = reject;
          });
        }
        return {
          id: 't1',
          replay: 'client2-reattached\r\n',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // 1. Client1 becomes ready and confirms live subscription for t1 before onReplaced fires for client1.
  rig.emit({ type: 'status', status: { state: 'ready' } });
  await rig.api.termAttach('t1');
  assert.equal(rig.api.isTerminalAttached('t1'), true);

  // 2. A refresh attach starts on client1, buffers a live frame, and onReplaced fires for that SAME client1.
  const refresh = rig.api.termAttach('t1');
  await wait(0);
  rig.emit(named(delta('t1', 'during-refresh\r\n', 1), T(1)));
  rig.replace();
  assert.equal(attachCalls, 2, 'same-client onReplaced must not spawn a duplicate reattach');
  assert.equal(rig.api.isTerminalAttached('t1'), true, 'same-client onReplaced must keep confirmed attached state');

  // 3. Refresh rejects while original subscription on client1 is still live -> held frame is delivered and feed stays attached.
  rejectRefresh(new Error('refresh rejected'));
  await assert.rejects(refresh, /refresh rejected/);
  await wait(20);
  assert.deepEqual(seen, [{ id: 't1', data: 'during-refresh\r\n' }]);
  assert.equal(rig.api.isTerminalAttached('t1'), true);

  // 4. Subsequent live frames on client1 continue streaming cleanly.
  rig.emit(named(delta('t1', 'after-refresh-error\r\n', 2), T(1)));
  await wait(20);
  assert.deepEqual(seen, [
    { id: 't1', data: 'during-refresh\r\n' },
    { id: 't1', data: 'after-refresh-error\r\n' },
  ]);

  // 5. Genuinely replacing with a different client (client2) clears client1's subscription and reattaches on client2.
  activeClient = client2;
  rig.calls.length = 0;
  rig.replace();
  await wait(20);
  assert.equal(attachCalls, 3);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1', resumeFrom: { epoch: 'e1', seq: 2 } }]]
  );
  assert.equal(rig.api.isTerminalAttached('t1'), true);
});

test('older warm-up attach settling late does not retire a newer cross-core shell from a concurrent ensure', async () => {
  const oldTerm = { core: 'run-1', incarnation: 1 };
  const newTerm = { core: 'run-2', incarnation: 1 };
  let attachCalls = 0;
  let resolveWarmUp;
  let warmUpStartedResolve;
  const warmUpStarted = new Promise((resolve) => {
    warmUpStartedResolve = resolve;
  });
  const rig = setup({
    answers: {
      'terminal/ensure': () => ({
        id: 't1',
        replay: 'new-fallback\r\n',
        terminal: newTerm,
      }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          warmUpStartedResolve();
          return new Promise((resolve) => {
            resolveWarmUp = () =>
              resolve({
                id: 't1',
                replay: 'old-warmup\r\n',
                terminal: oldTerm,
                subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
              });
          });
        }
        if (attachCalls === 2) {
          throw new Error('replacement attach hit link loss');
        }
        return {
          id: 't1',
          replay: 'new-recovered\r\n',
          terminal: newTerm,
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
    },
  });
  const seen = [];
  rig.api.subscribeTermData((event) => seen.push(event));

  // 1. Start a warm-up attach that will eventually answer oldTerm (run-1).
  const warmUp = rig.api.termAttach('t1');
  await warmUpStarted;

  // 2. Before warm-up answers, an explicit ensure names newTerm (run-2) and joins the pending attach.
  const ensurePromise = rig.api.termEnsure('t1', '/tmp', null);
  await wait(0);

  // 3. Warm-up settles with oldTerm: must NOT retire newTerm or satisfy the ensure waiter.
  resolveWarmUp();
  assert.deepEqual(await warmUp, { id: 't1', replay: 'old-warmup\r\n', terminal: oldTerm });
  // Ensure waiter must proceed to attempt attach #2 for newTerm (which rejects on link loss -> fallback returned).
  assert.deepEqual(await ensurePromise, { id: 't1', replay: 'new-fallback\r\n', terminal: newTerm });
  assert.equal(attachCalls, 2, 'ensure waiter for newTerm must not accept oldTerm as satisfying newTerm');

  // 4. Old shell exits; wanted must still hold newTerm so replacing the link recovers newTerm.
  rig.emit({
    type: 'notification',
    notification: {
      method: 'process/exited',
      params: { processHandle: 't1', terminal: oldTerm },
      feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
    },
  });
  assert.equal(rig.api.isTerminalAttached('t1'), false);

  rig.calls.length = 0;
  rig.replace();
  await wait(20);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['terminal/attach', { tabId: 't1' }]],
    'replacing the link after oldTerm exits must still recover newTerm'
  );
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  assert.deepEqual(seen, [{ id: 't1', data: 'new-recovered\r\n', reset: true }]);
});

test('detach and dispose immediately release held frames for GC while attach RPC remains pending', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');

  for (const action of ['detach', 'dispose']) {
    const rig = setup({
      answers: {
        'terminal/attach': () => new Promise(() => {}),
        'feed/unsubscribe': () => ({ ok: true }),
        'terminal/dispose': () => ({ ok: true }),
      },
    });

    // Keep the pending promise referenced so the RPC closure stays alive across GC.
    const ac = new AbortController();
    const stalled = rig.api.termAttach('t1', ac.signal).catch(() => undefined);
    await wait(0);

    let weakParams;
    (() => {
      const payload = {
        processHandle: 't1',
        bytesB64: b64('x'.repeat(16 * 1024)),
        terminal: T(1),
      };
      weakParams = new WeakRef(payload);
      rig.emit({
        type: 'notification',
        notification: {
          method: 'process/outputDelta',
          params: payload,
          feed: { id: 'process:t1', epoch: 'e1', seq: 1 },
        },
      });
    })();

    if (action === 'detach') {
      ac.abort();
      rig.api.termDetach('t1');
    } else {
      await rig.api.termDispose('t1');
    }

    // Force GC cycles while the stalled attach RPC is still pending and never settles.
    for (let i = 0; i < 4; i += 1) {
      gc();
      await wait(0);
    }
    assert.equal(
      weakParams.deref(),
      undefined,
      `${action} must release buffered held frames immediately even while the attach RPC remains stalled`
    );
    void stalled;
  }
});

test('exit followed by detach and direct dispose both unsubscribe retained server feeds', async () => {
  // A. process/exited followed by termDetach unsubscribes once.
  {
    const rig = setup({
      answers: {
        'terminal/attach': {
          id: 't1',
          replay: '',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
        },
        'feed/unsubscribe': { ok: true },
      },
    });
    await rig.api.termAttach('t1');
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/exited',
        params: { processHandle: 't1', terminal: T(1) },
        feed: { id: 'process:t1', epoch: 'e1', seq: 2 },
      },
    });
    assert.equal(rig.api.isTerminalAttached('t1'), false);

    rig.calls.length = 0;
    rig.api.termDetach('t1');
    await wait(10);
    assert.deepEqual(
      rig.calls.map((c) => [c.method, c.params]),
      [['feed/unsubscribe', { feedId: 'process:t1' }]],
      'detach after process/exited must still unsubscribe the retained server feed'
    );

    // Second detach is a no-op.
    rig.calls.length = 0;
    rig.api.termDetach('t1');
    await wait(10);
    assert.deepEqual(rig.calls, []);
  }

  // B. Direct termDispose on an attached tab and on an exited tab both send feed/unsubscribe.
  for (const exitedFirst of [false, true]) {
    const rig = setup({
      answers: {
        'terminal/attach': {
          id: 't2',
          replay: '',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
        },
        'feed/unsubscribe': { ok: true },
        'terminal/dispose': { ok: true },
      },
    });
    await rig.api.termAttach('t2');
    if (exitedFirst) {
      rig.emit({
        type: 'notification',
        notification: {
          method: 'process/exited',
          params: { processHandle: 't2', terminal: T(1) },
          feed: { id: 'process:t2', epoch: 'e1', seq: 2 },
        },
      });
    }
    rig.calls.length = 0;
    await rig.api.termDispose('t2');
    await wait(10);
    assert.deepEqual(
      rig.calls.map((c) => [c.method, c.params]),
      [
        ['feed/unsubscribe', { feedId: 'process:t2' }],
        ['terminal/dispose', { tabId: 't2' }],
      ],
      `termDispose (exitedFirst=${exitedFirst}) must unsubscribe the retained server feed`
    );
  }

  // C. After process/exited and client replacement, the old socket's subscription is gone so detach sends no unsubscribe.
  {
    const rawCalls = [];
    const makeClient = (name) => ({
      call: async (method, params) => {
        rawCalls.push({ client: name, method, params });
        return {};
      },
    });
    const c1 = makeClient('c1');
    const c2 = makeClient('c2');
    let activeClient = c1;
    const rig = setup({
      client: () => activeClient,
      answers: {
        'terminal/attach': {
          id: 't3',
          replay: '',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e1', startSeq: 1 },
        },
      },
    });
    await rig.api.termAttach('t3');
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/exited',
        params: { processHandle: 't3', terminal: T(1) },
        feed: { id: 'process:t3', epoch: 'e1', seq: 2 },
      },
    });
    activeClient = c2;
    rig.replace();
    rig.api.termDetach('t3');
    await wait(10);
    assert.deepEqual(rawCalls, [], 'replacing the client clears old-client server subscriptions');
  }
});

test('aborting the sole unbound termEnsure after relink succeeded detaches the unclaimed feed without affecting claimed tabs', async () => {
  let attachCalls = 0;
  let resolveFirstAttachStarted;
  const firstAttachStarted = new Promise((resolve) => {
    resolveFirstAttachStarted = resolve;
  });
  const rig = setup({
    answers: {
      'terminal/ensure': () => ({ id: 't1', replay: 'r', terminal: T(1) }),
      'terminal/attach': () => {
        attachCalls += 1;
        if (attachCalls === 1) {
          resolveFirstAttachStarted();
          return new Promise(() => {});
        }
        return {
          id: 't1',
          replay: 'relinked',
          terminal: T(1),
          subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
        };
      },
      'feed/unsubscribe': () => ({ ok: true }),
    },
  });

  // 1. Sole caller starts termEnsure; attach #1 stays pending.
  const ac = new AbortController();
  const pendingEnsure = rig.api.termEnsure('t1', '/tmp', null, ac.signal).catch(() => undefined);
  await firstAttachStarted;

  // 2. Link replaces and relink #2 succeeds while original caller still has not claimed the tab.
  rig.replace();
  await wait(10);
  assert.equal(rig.api.isTerminalAttached('t1'), true);

  // 3. Sole caller aborts -> feed must detach and send feed/unsubscribe immediately.
  rig.calls.length = 0;
  ac.abort();
  await wait(10);
  assert.equal(rig.api.isTerminalAttached('t1'), false);
  assert.deepEqual(
    rig.calls.map((c) => [c.method, c.params]),
    [['feed/unsubscribe', { feedId: 'process:t1' }]]
  );
  void pendingEnsure;

  // 4. By contrast, once an active consumer has claimed the tab, aborting a second caller does NOT detach it.
  await rig.api.termAttach('t1');
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  rig.calls.length = 0;
  const ac2 = new AbortController();
  const second = rig.api.termAttach('t1', ac2.signal).catch(() => undefined);
  ac2.abort();
  await wait(10);
  assert.equal(rig.api.isTerminalAttached('t1'), true);
  assert.equal(rig.calls.filter((c) => c.method === 'feed/unsubscribe').length, 0);
  void second;
});

test('delayed first attach resolving or rejecting after chained relinks returns the latest confirmed snapshot baseline', async () => {
  // Subcase A: snapshot relink B -> snapshot relink C -> delayed attach A rejects -> resolves to C (not B).
  {
    let attachCalls = 0;
    let rejectA;
    let resolveAStarted;
    const aStarted = new Promise((resolve) => {
      resolveAStarted = resolve;
    });
    const rig = setup({
      answers: {
        'terminal/ensure': () => ({ id: 't1', replay: 'ensure-snap', terminal: T(1) }),
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            resolveAStarted();
            return new Promise((_, reject) => {
              rejectA = reject;
            });
          }
          if (attachCalls === 2) {
            return {
              id: 't1',
              replay: 'snap-B',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
            };
          }
          return {
            id: 't1',
            replay: 'snap-C-unique',
            terminal: T(1),
            subscription: { mode: 'snapshot', epoch: 'e3', startSeq: 1 },
          };
        },
      },
    });

    const pendingA = rig.api.termEnsure('t1', '/tmp', null);
    await aStarted;

    // Relink B succeeds and buffers live output while no consumer is subscribed yet.
    rig.replace();
    await wait(10);
    assert.equal(attachCalls, 2);
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', terminal: T(1), bytesB64: b64('delta-B1') },
        feed: { id: 'process:t1', epoch: 'e2', seq: 1 },
      },
    });

    // Relink C succeeds with a newer snapshot (superseding B and its buffered delta), then live C1 arrives.
    rig.replace();
    await wait(10);
    assert.equal(attachCalls, 3);
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't1', terminal: T(1), bytesB64: b64('delta-C1') },
        feed: { id: 'process:t1', epoch: 'e3', seq: 1 },
      },
    });

    // Original attach A finally rejects: must return C's latest session, not intermediate B's.
    rejectA(new Error('old link closed'));
    const session = await pendingA;
    assert.equal(session?.replay, 'snap-C-unique');

    const received = [];
    const off = rig.api.subscribeTabTermData('t1', (ev) => received.push(ev.data));
    await wait(20);
    off();
    assert.equal(received.join(''), 'delta-C1');
  }

  // Subcase B: snapshot relink B -> replay relink C (same epoch) -> delayed attach A rejects -> keeps B baseline + B1 + C1.
  {
    let attachCalls = 0;
    let rejectA;
    let resolveAStarted;
    const aStarted = new Promise((resolve) => {
      resolveAStarted = resolve;
    });
    const rig = setup({
      answers: {
        'terminal/ensure': () => ({ id: 't2', replay: 'ensure-snap', terminal: T(1) }),
        'terminal/attach': () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            resolveAStarted();
            return new Promise((_, reject) => {
              rejectA = reject;
            });
          }
          if (attachCalls === 2) {
            return {
              id: 't2',
              replay: 'snap-B',
              terminal: T(1),
              subscription: { mode: 'snapshot', epoch: 'e2', startSeq: 1 },
            };
          }
          return {
            id: 't2',
            replay: 'ignored-replay-snap',
            terminal: T(1),
            subscription: { mode: 'replay', epoch: 'e2', startSeq: 2 },
          };
        },
      },
    });

    const pendingA = rig.api.termEnsure('t2', '/tmp', null);
    await aStarted;

    rig.replace();
    await wait(10);
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't2', terminal: T(1), bytesB64: b64('delta-B1|') },
        feed: { id: 'process:t2', epoch: 'e2', seq: 1 },
      },
    });

    rig.replace();
    await wait(10);
    rig.emit({
      type: 'notification',
      notification: {
        method: 'process/outputDelta',
        params: { processHandle: 't2', terminal: T(1), bytesB64: b64('delta-C1') },
        feed: { id: 'process:t2', epoch: 'e2', seq: 2 },
      },
    });

    rejectA(new Error('old link closed'));
    const session = await pendingA;
    assert.equal(session?.replay, 'snap-B');

    const received = [];
    const off = rig.api.subscribeTabTermData('t2', (ev) => received.push(ev.data));
    await wait(20);
    off();
    assert.equal(received.join(''), 'delta-B1|delta-C1');
  }
});
