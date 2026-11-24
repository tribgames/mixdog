// The phone holds a tab (its retry, its recovery frames, its output decoder) exactly while the tab's terminal lives. The core's answers,
// tab list rows and terminal-lane exits name the terminal of an id alike (`terminal: {core, incarnation}`). A tab list ends a held tab
// only when it is known to be no older than the terminal held, an exit only when it names that terminal, and what the phone knew of one
// terminal of an id is never carried over to another. Terminals of two runs of the core have no order; a store without the list, a
// reconnect, or a list from before the terminal says nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter, followTerminalOutput } from './remote-protocol-terminal.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A terminal as the core names it: its incarnation within the run `core`. */
const T = (incarnation, core = 'run-1') => ({ core, incarnation });

/** The `terminalTabs` section as the core publishes it, from `[id, terminal, running?]` per tab (a number is that incarnation of run-1). */
const listing = (...tabs) =>
  tabs.map(([id, terminal, running = true]) => ({
    id,
    shell: 'pwsh',
    running,
    cwd: null,
    terminal: typeof terminal === 'number' ? T(terminal) : terminal,
    sizeOwner: null,
  }));

/** A relay frame of `text` from the output stream `stream`, starting at `offset` of it, of `terminal` when the core names it. */
const frame = (id, text, stream, offset, terminal) => ({
  processHandle: id,
  bytesB64: Buffer.from(text).toString('base64'),
  outputStream: stream,
  outputOffset: offset,
  ...(terminal ? { terminal } : {}),
});

/** A follower whose attach answers `answer(id)`. `held()` is the tabs a gap replay attaches: the tabs still held. */
function follower(answer = () => ({ replay: '' })) {
  const asked = [];
  const output = followTerminalOutput(
    async (id) => {
      asked.push(id);
      return answer(id);
    },
    () => undefined,
    () => true
  );
  const held = async () => {
    asked.length = 0;
    output.gap();
    await tick();
    return [...asked].sort();
  };
  return { output, held };
}

test('a refused attach is not retried, and a later gap does not attach the tab again', async () => {
  const asked = [];
  const follow = followTerminalOutput(
    async (id) => {
      asked.push(id);
      throw Object.assign(new Error('gone'), { permanent: true });
    },
    () => undefined,
    () => true
  );
  follow.hold('a');
  follow.gap();
  await tick();
  follow.gap();
  await tick();
  assert.deepEqual(asked, ['a']);
});

test('a tab the core answers with nothing or refuses, whose shell exited, or that a list shows not running or as no tab, is forgotten', async () => {
  const asked = [];
  const follow = followTerminalOutput(
    async (id) => {
      asked.push(id);
      if (id === 'term_refused') throw Object.assign(new Error('gone'), { permanent: true });
      return id === 'term_null' ? null : { replay: '' };
    },
    () => undefined,
    () => true
  );
  follow.listed(listing(['term_live', 1], ['term_stopped', 2], ['term_claimed', 3]));
  for (const [id, incarnation] of [
    ['term_null', 1],
    ['term_refused', 1],
    ['term_live', 1],
    ['term_exits', 1],
    ['term_stopped', 2],
    ['term_claimed', 3],
  ])
    follow.hold(id, T(incarnation));
  follow.end('term_exits', { processHandle: 'term_exits', code: 0, outputStream: 'stream', terminal: T(1) });
  // A claim on an id with no tab is listed as `tab: false`.
  follow.listed([
    ...listing(['term_live', 1], ['term_stopped', 2, false]),
    { id: 'term_claimed', tab: false, running: false, sizeOwner: { cols: 80, rows: 24, owner: 'x' } },
  ]);
  follow.gap();
  await tick();
  follow.gap();
  await tick();
  assert.deepEqual(asked, ['term_null', 'term_refused', 'term_live', 'term_live']);
});

test('a desktop tab listed before the phone attaches is forgotten by the next list without it, with no gap or exit to say so', async () => {
  const { output, held } = follower();
  output.listed(listing(['term_desk', 5], ['term_kept', 4]));
  output.hold('term_desk', T(5));
  output.listed(listing(['term_kept', 4]));
  assert.deepEqual(await held(), []);
  output.hold('term_last', T(6));
  output.listed(listing(['term_kept', 4], ['term_last', 6]));
  output.listed(listing());
  assert.deepEqual(await held(), [], 'an empty list ends it too');
});

test('a tab the phone just created is not forgotten by a list or snapshot that predates it', async () => {
  const { output, held } = follower();
  output.listed(listing(['term_other', 3]));
  output.hold('term_new', T(7));
  output.listed(listing(['term_other', 3]));
  output.listed(listing());
  assert.deepEqual(await held(), ['term_new'], 'lists from before the core published it');
  output.listed(listing(['term_new', 7]));
  output.listed(listing(['term_other', 3]));
  assert.deepEqual(await held(), [], 'listed, then left out');
});

test('a list naming an earlier terminal of a reused id predates the terminal the phone holds', async () => {
  const { output, held } = follower();
  // The list names the id's earlier terminal: the desktop disposed it, and the phone's ensure made the next one before the list
  // without it arrived.
  output.listed(listing(['term_reused', 4]));
  output.hold('term_reused', T(9));
  output.listed(listing());
  assert.deepEqual(await held(), ['term_reused']);
  // Held while listed, and then ensured again after a dispose: the dispose's list is older than the new terminal.
  output.listed(listing(['term_reused', 9]));
  output.hold('term_reused', T(12));
  output.listed(listing());
  assert.deepEqual(await held(), ['term_reused']);
  output.listed(listing(['term_reused', 12]));
  output.listed(listing());
  assert.deepEqual(await held(), []);
});

test('a snapshot without the tab list neither pins the held tabs nor lets the list before it label a new terminal of a reused id', async () => {
  const { output, held } = follower();
  output.listed(listing(['term_gone', 5], ['term_view', 6], ['term_early', 7]));
  for (const [id, incarnation] of [
    ['term_gone', 5],
    ['term_view', 6],
    ['term_early', 7],
  ])
    output.hold(id, T(incarnation));
  // Reconnected to a restarted core, whose run counts its terminals from 1: one pane ensures its view id again before the core's
  // snapshot is read, which still holds the earlier core's list.
  output.hold('term_early', T(1, 'run-2'));
  // The restarted core has no tabs: its snapshot has no `terminalTabs`, which is no list at all.
  output.listed(undefined);
  assert.deepEqual(await held(), ['term_early', 'term_gone', 'term_view'], 'nothing is known of the tabs');
  // Another pane ensures its view id again; the restarted core's first list predates both of the new terminals.
  output.hold('term_view', T(2, 'run-2'));
  output.listed(listing(['term_desk', T(3, 'run-2')]));
  assert.deepEqual(await held(), ['term_early', 'term_view'], "the earlier core's tab is gone, the new terminals of reused ids are not");
  output.listed(listing(['term_desk', T(3, 'run-2')], ['term_early', T(1, 'run-2')], ['term_view', T(2, 'run-2')]));
  output.listed(listing(['term_desk', T(3, 'run-2')]));
  assert.deepEqual(await held(), []);
});

test("a restarted core's terminal is never ordered against the earlier core's, whatever their incarnations", async () => {
  const { output, held } = follower();
  output.listed(listing(['term_x', 500]));
  output.hold('term_x', T(500));
  // Reconnected to a restarted core: the pane's ensure answers that run's first terminal of the id.
  output.hold('term_x', T(1, 'run-2'));
  // The earlier core's list, still in the store, then the restarted core's first list, which predates the new terminal.
  output.listed(listing(['term_x', 500]));
  output.listed(listing(['term_y', T(2, 'run-2')]));
  // A late exit of the earlier core's terminal of the id.
  output.end('term_x', { processHandle: 'term_x', code: 0, outputStream: 'stream-500', terminal: T(500) });
  assert.deepEqual(await held(), ['term_x']);
  output.listed(listing(['term_x', T(1, 'run-2')], ['term_y', T(2, 'run-2')]));
  output.listed(listing(['term_y', T(2, 'run-2')]));
  assert.deepEqual(await held(), []);
});

test('after a reconnect or an exit, a terminal ensured before the newer list arrives is not forgotten by an older one', async () => {
  const { output, held } = follower();
  output.listed(listing(['term_same', 5], ['term_again', 6], ['term_exit', 7]));
  for (const [id, incarnation] of [
    ['term_same', 5],
    ['term_again', 6],
    ['term_exit', 7],
  ])
    output.hold(id, T(incarnation));
  // Reconnected; the panes ensure again before the snapshot or the missed list changes are read: one terminal is still the one held,
  // one was disposed meanwhile and the ensure made the next.
  output.hold('term_same', T(5));
  output.hold('term_again', T(8));
  // A shell exits: its tab is forgotten, and the pane respawns it before the core publishes the respawn.
  output.end('term_exit', { processHandle: 'term_exit', code: 0, outputStream: 'stream-7', terminal: T(7) });
  output.hold('term_exit', T(9));
  // The missed list of the exit, then the snapshot from before the respawn: both older than those answers.
  output.listed(listing(['term_same', 5], ['term_exit', 7, false]));
  output.listed(listing(['term_same', 5]));
  assert.deepEqual(await held(), ['term_again', 'term_exit', 'term_same']);
  output.listed(listing(['term_same', 5], ['term_again', 8], ['term_exit', 9]));
  output.listed(listing());
  assert.deepEqual(await held(), []);
});

test('a gap replay recovers every live held tab and holds the terminal its attach answers', async () => {
  const answers = {
    term_a: { replay: 'a', replayCut: { stream: 's', offset: 0 }, terminal: T(5) },
    // The desktop respawned it: the attach answers the id's next terminal.
    term_b: { replay: 'b', replayCut: { stream: 's', offset: 0 }, terminal: T(12) },
    term_c: { replay: 'c', replayCut: { stream: 's', offset: 0 }, terminal: T(3) },
  };
  const events = [];
  const asked = [];
  const output = followTerminalOutput(
    async (id) => {
      asked.push(id);
      return answers[id];
    },
    (event) => events.push(event),
    () => true
  );
  output.listed(listing(['term_a', 5], ['term_b', 6]));
  output.hold('term_a', T(5));
  output.hold('term_b', T(6));
  // The phone's own, not listed yet.
  output.hold('term_c', T(3));
  output.gap();
  await tick();
  assert.deepEqual(asked, ['term_a', 'term_b', 'term_c']);
  assert.deepEqual(events, [
    { id: 'term_a', data: 'a', reset: true },
    { id: 'term_b', data: 'b', reset: true },
    { id: 'term_c', data: 'c', reset: true },
  ]);
  // A list from the respawn, before the core published the next terminal: older than the terminal now held.
  output.listed(listing(['term_a', 5]));
  asked.length = 0;
  output.gap();
  await tick();
  assert.deepEqual(asked, ['term_a', 'term_b', 'term_c']);
});

test('a late exit of an earlier terminal of the id does not end the terminal the phone holds now', async () => {
  const { output, held } = follower();
  output.hold('t1', T(5));
  output.forget('t1');
  output.hold('t1', T(10));
  output.end('t1', { processHandle: 't1', code: 0, outputStream: 'stream-5', terminal: T(5) });
  assert.deepEqual(await held(), ['t1']);
  // Queued behind a gap's recovery, and read once it is done.
  output.gap();
  output.end('t1', { processHandle: 't1', code: 0, outputStream: 'stream-5', terminal: T(5) });
  await tick();
  assert.deepEqual(await held(), ['t1']);
  output.end('t1', { processHandle: 't1', code: 0, outputStream: 'stream-10', terminal: T(10) });
  assert.deepEqual(await held(), [], 'the exit of the terminal held ends it');
});

test('a held tab whose terminal changes keeps nothing of the earlier one: its cut, its listing, its replay or its exit', async () => {
  const one = { replay: 'one', replayCut: { stream: 'stream-5', offset: 3 }, terminal: T(5) };
  const two = { replay: 'two', replayCut: { stream: 'stream-6', offset: 3 }, terminal: T(6) };
  // Each id's attaches in turn: the first gap's, then a later gap's that the core answered before the respawns, then the core's again.
  const answers = {
    t1: [one, one, { replay: 'new', replayCut: { stream: 'stream-10', offset: 3 }, terminal: T(10) }],
    t2: [two, two, { replay: 'next', replayCut: { stream: 'stream-11', offset: 4 }, terminal: T(11) }],
  };
  const events = [];
  const asked = [];
  const output = followTerminalOutput(
    async (id) => {
      asked.push(id);
      return answers[id].shift();
    },
    (event) => events.push(event),
    () => true
  );
  output.listed(listing(['t1', 5], ['t2', 6]));
  output.hold('t1', T(5));
  output.hold('t2', T(6));
  output.gap();
  await tick();
  assert.deepEqual(events.splice(0), [
    { id: 't1', data: 'one', reset: true },
    { id: 't2', data: 'two', reset: true },
  ]);
  // The phone's pane changed t1's shell: the desktop disposed its terminal and the ensure made the id's next one. The desktop
  // respawned t2: a list names its next terminal. The list without t1 is the dispose's.
  output.hold('t1', T(10));
  output.listed(listing(['t2', 11]));
  output.frame('t1', frame('t1', 'new', 'stream-10', 0));
  output.frame('t2', frame('t2', 'next', 'stream-11', 0));
  // The earlier terminals' exits arrive late, and a gap whose attaches the core answered before the respawns.
  output.end('t1', { processHandle: 't1', code: 0, outputStream: 'stream-5', terminal: T(5) });
  output.end('t2', { processHandle: 't2', code: 0, outputStream: 'stream-6', terminal: T(6) });
  asked.length = 0;
  output.gap();
  await tick();
  assert.deepEqual([...asked].sort(), ['t1', 't1', 't2', 't2'], 'each recovered again for the terminal it has now');
  output.frame('t1', frame('t1', '!', 'stream-10', 3));
  assert.deepEqual(events, [
    { id: 't1', data: 'new' },
    { id: 't2', data: 'next' },
    { id: 't1', data: 'new', reset: true },
    { id: 't2', data: 'next', reset: true },
    { id: 't1', data: '!' },
  ]);
});

test('a gap answered for an earlier terminal than the one held emits none of its frames and is recovered again', async () => {
  const answers = [
    // The attach the core answered before the id's next terminal existed.
    { replay: 'five', replayCut: { stream: 'stream-5', offset: 4 }, terminal: T(5) },
    { replay: 'ten', replayCut: { stream: 'stream-10', offset: 3 }, terminal: T(10) },
  ];
  const events = [];
  const asked = [];
  const output = followTerminalOutput(
    async (id) => {
      asked.push(id);
      return answers.shift();
    },
    (event) => events.push(event),
    () => true
  );
  output.hold('t1', T(10));
  output.gap();
  // Queued while the gap is recovered: the earlier terminal's last output, then the held one's, the start of it in its replay.
  output.frame('t1', frame('t1', 'late', 'stream-5', 4));
  output.frame('t1', frame('t1', 'tenmore', 'stream-10', 0));
  await tick();
  assert.deepEqual(asked, ['t1', 't1']);
  assert.deepEqual(events, [
    { id: 't1', data: 'ten', reset: true },
    { id: 't1', data: 'more' },
  ]);
});

test("outside a gap, what an earlier terminal of a held id writes as it is replaced never reaches the pane, and a later terminal's output makes it the one held", async () => {
  const events = [];
  const output = followTerminalOutput(
    async () => ({ replay: '' }),
    (event) => events.push(event),
    () => true
  );
  output.hold('t1', T(10));
  output.frame('t1', frame('t1', 'old', 'stream-5', 9, T(5)));
  output.frame('t1', frame('t1', 'ten', 'stream-10', 0, T(10)));
  // Respawned by another client: the next terminal's output comes before any answer or list names it.
  output.frame('t1', frame('t1', 'eleven', 'stream-11', 0, T(11)));
  output.frame('t1', frame('t1', 'late', 'stream-10', 3, T(10)));
  output.frame('t2', frame('t2', 'unheld', 'stream-2', 0, T(2)));
  assert.deepEqual(events, [
    { id: 't1', data: 'ten' },
    { id: 't1', data: 'eleven' },
    { id: 't2', data: 'unheld' },
  ]);
});

test('a tab an older core answers without a terminal name is judged by no list, and any exit of the id ends it', async () => {
  const { output, held } = follower();
  output.listed([{ id: 'term_old', shell: 'pwsh', running: true, cwd: null, sizeOwner: null }]);
  output.hold('term_old');
  output.listed([]);
  assert.deepEqual(await held(), ['term_old']);
  output.end('term_old', { processHandle: 'term_old', code: 0, outputStream: 'stream' });
  assert.deepEqual(await held(), []);
});

test('the adapter judges the terminals its ensure and attach answer name by the tab list the store holds', async (t) => {
  installTestDom(t);
  let tabs;
  const storeListeners = new Set();
  const attached = [];
  let notify;
  const client = {
    status: { state: 'ready' },
    server: { platformOs: 'windows' },
    on: (listener) => {
      notify = listener;
      return () => undefined;
    },
    call: async (method, params) => {
      if (method === 'terminal/attach') attached.push(params.tabId);
      const terminal = T(params.tabId === 'term_desk' ? 3 : 7);
      return { id: params.tabId, replay: '', client: 'me', sizeOwner: null, terminal };
    },
    store: {
      section: (name) => (name === 'terminalTabs' && tabs !== undefined ? { value: tabs } : undefined),
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
  };
  /** The core's tab list as a section change; `undefined` is an app snapshot without it. */
  const list = (value) => {
    tabs = value;
    const change = value === undefined ? { type: 'appSnapshot' } : { type: 'section', section: 'terminalTabs', key: null };
    for (const listener of [...storeListeners]) listener(change);
  };
  /** The tabs a gap replay attaches. */
  const gap = async () => {
    attached.length = 0;
    window.dispatchEvent(new window.Event('mixdog:remote-terminal-gap'));
    await tick();
    return [...attached].sort();
  };
  let wired;
  const host = {
    ctx: {
      // Away from the terminal lane: no output, no exit, no gap of its own.
      activeLanes: new Set(),
      termListeners: new Set(),
      termActivityListeners: new Set(),
      termSizeOwnerListeners: new Set(),
      folderChangeListeners: new Set(),
      terminalRunListeners: new Set(),
      fanOut: (listeners, value) => {
        for (const listener of listeners) listener(value);
      },
      phone: { start: async () => undefined },
    },
    client: () => client,
    declareLane: () => undefined,
    onClient: (listener) => {
      wired = listener;
      return () => undefined;
    },
  };
  const stop = adapter.install(host);
  wired(client);

  list(listing(['term_desk', 3]));
  assert.deepEqual(await adapter.calls.termAttach(['term_desk'], host), { id: 'term_desk', replay: '' }, "the page gets Node's answer");
  assert.deepEqual(await adapter.calls.termEnsure(['term_new', '/r', null], host), { id: 'term_new', replay: '' });
  // The desktop disposed its tab; the list predates the phone's new one.
  list(listing());
  assert.deepEqual(await gap(), ['term_new']);
  list(undefined);
  assert.deepEqual(await gap(), ['term_new'], 'a snapshot without the list is no list');
  /** A `process/exited` of the terminal lane for the phone's tab, naming the terminal that ended. */
  const exited = (terminal) =>
    notify({
      type: 'notification',
      notification: {
        method: 'process/exited',
        params: { processHandle: 'term_new', code: 0, outputStream: 's', terminal },
        feed: { id: 'process:relay', epoch: 'e', seq: 1 },
      },
    });
  exited(T(6));
  assert.deepEqual(await gap(), ['term_new'], "an earlier terminal's exit");
  exited(T(7));
  assert.deepEqual(await gap(), []);
  stop();
});
