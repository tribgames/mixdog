// The phone's Visualize panel calls through the adapter (Node's remote-visualize.ts at 0bf8fe0457): each call is the one
// `visualize/command` read the core answers, the state is shaped path-free for the page, the export is a download source of the
// core's `export` transfer source, and a change of the desktop's tabs reaches the page as Node's push did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as files } from './remote-protocol-files.ts';
import { adapter, thumbnailRule } from './remote-protocol-visualize.ts';

function rig(answers = {}) {
  const requests = [];
  const lanes = [];
  let resyncs = 0;
  const sections = new Map();
  const storeListeners = new Set();
  let live = true;
  const noteListeners = new Set();
  const client = {
    status: { state: 'ready' },
    on: (listener) => {
      noteListeners.add(listener);
      return () => noteListeners.delete(listener);
    },
    call: async (method, params) => {
      if (params.action !== 'lane') requests.push([method, params]);
      else lanes.push(params.input);
      const answer = answers[params.action];
      return (typeof answer === 'function' ? answer(params.input) : answer) ?? null;
    },
    store: {
      section: (section, key) =>
        sections.has(`${section}:${key}`) ? { value: sections.get(`${section}:${key}`) } : undefined,
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
      appLive: () => live,
    },
  };
  const fanned = [];
  const ctx = {
    requestResync: () => resyncs++,
    visualizeListeners: {},
    fanOut: (_set, value) => fanned.push(value),
    phone: { start: () => Promise.resolve() },
  };
  const host = {
    ctx,
    client: () => client,
    declareLane() {},
    onClient: (listener) => {
      listener(client);
      return () => undefined;
    },
  };
  const set = (value) => {
    sections.set('hostState:visualize', value);
    for (const listener of storeListeners) listener({ type: 'section', section: 'hostState', key: 'visualize' });
  };
  const notify = (params) => {
    for (const listener of noteListeners)
      listener({ type: 'notification', notification: { method: 'visualize/changed', params } });
  };
  const connection = (status) => {
    client.status = status;
    for (const listener of noteListeners) listener({ type: 'status', status });
  };
  return {
    host,
    connection,
    requests,
    lanes,
    resyncs: () => resyncs,
    fanned,
    set,
    notify,
    setLive: (value) => (live = value),
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const hostState = (extra = {}) => ({
  sessionId: 's1',
  active: 't1',
  tabs: [
    {
      id: 't1',
      label: 'A',
      remoteLabel: 'Chart',
      revision: 2,
      cwd: '/work/proj',
      panes: [
        {
          kind: 'inline',
          label: 'c',
          target: '/work/proj/x',
          path: '',
          remoteTarget: 'x',
          inline: { kind: 'chart', source: '{}' },
        },
      ],
      ...extra,
    },
  ],
});

test('the state is read from the core and shaped path-free, with inline sources deferred when asked', async () => {
  const { host, requests } = rig({ state: [hostState()] });
  const plain = await adapter.calls.visualizeState([{}], host);
  assert.equal(plain[0].tabs[0].label, 'Chart', 'the remote label');
  assert.equal(plain[0].tabs[0].panes[0].inline.source, '{}');
  assert.ok(!JSON.stringify(plain).includes('/work/proj'), 'no host path reaches the page');
  const deferred = await adapter.calls.visualizeState([{ deferInline: true }], host);
  assert.deepEqual(deferred[0].tabs[0].panes[0].inline, { kind: 'chart', source: '', deferred: true });
  assert.deepEqual(requests[0], ['visualize/command', { action: 'state', input: {} }]);
});

test("the mark of the running turn's own tab reaches the phone's page, by the initial read and by a change; an unmarked tab carries none", async () => {
  const { host, fanned, notify } = rig({ state: [hostState({ turnWork: true })] });
  const read = await adapter.calls.visualizeState([{}], host);
  assert.equal(read[0].tabs[0].turnWork, true);
  const stop = adapter.install(host);
  notify({ sessionId: 's1', held: true, heldSince: 5, state: hostState({ turnWork: true }) });
  assert.equal(fanned.at(-1).state.tabs[0].turnWork, true);
  assert.equal(fanned.at(-1).held, true);
  notify({ sessionId: 's1', state: hostState() });
  assert.equal(fanned.length, 2);
  assert.equal('turnWork' in fanned.at(-1).state.tabs[0], false);
  stop();
});

test("pane reads and commands are the core's visualize/command with the fields it checks", async () => {
  const { host, requests } = rig({ network: null, thumbnail: { thumbnail: 'data:image/png;base64,AAAA' } });
  const c = adapter.calls;
  await c.visualizePaneInline(['s1', 't1', 0], host);
  await c.visualizePaneFile(['s1', 't1', 1], host);
  await c.visualizePaneRange(['s1', 't1', 'a.css', 0, 100], host);
  await c.visualizePaneRange(['s1', 't1', 'a.css', 5, 100, 1], host);
  await c.visualizePanePages(['s1', 't1', 2, { pages: [1], maxWidth: 800, extra: 1 }], host);
  assert.deepEqual(
    await c.visualizeCommand([{ sessionId: 's1', tabId: 't1', action: 'thumbnail', version: 1 }], host),
    { thumbnail: 'data:image/png;base64,AAAA' }
  );
  assert.equal(
    await c.visualizeCommand([{ sessionId: 's1', tabId: 't1', action: 'close' }], host),
    null,
    'nothing answered is null'
  );
  assert.deepEqual(requests, [
    ['visualize/command', { action: 'paneInline', input: { sessionId: 's1', tabId: 't1', pane: 0 } }],
    ['visualize/command', { action: 'paneFile', input: { sessionId: 's1', tabId: 't1', pane: 1 } }],
    [
      'visualize/command',
      { action: 'paneRange', input: { sessionId: 's1', tabId: 't1', rel: 'a.css', offset: 0, length: 100 } },
    ],
    [
      'visualize/command',
      { action: 'paneRange', input: { sessionId: 's1', tabId: 't1', rel: 'a.css', offset: 5, length: 100, pane: 1 } },
    ],
    [
      'visualize/command',
      {
        action: 'panePages',
        input: { sessionId: 's1', tabId: 't1', pane: 2, options: { pages: [1], maxWidth: 800, extra: 1 } },
      },
    ],
    ['visualize/command', { action: 'thumbnail', input: { sessionId: 's1', tabId: 't1', version: 1 } }],
    ['visualize/command', { action: 'close', input: { sessionId: 's1', tabId: 't1' } }],
  ]);
});

test('an export is a download source naming its render, and a bad one is refused before anything is sent', () => {
  const { host, requests } = rig();
  const exported = adapter.calls.visualizeExport(['s1', 't1', 'png', 0], host);
  assert.equal(exported.name, 'visualize.png');
  assert.deepEqual(exported.source.kind === 'export' && exported.source.sessionId, 's1');
  assert.equal(exported.source.exportId, 'visualize-export:{"tabId":"t1","format":"png","pane":0}');
  assert.throws(() => adapter.calls.visualizeExport(['s1', 't1', 'project', 0], host), {
    message: 'export format is invalid.',
  });
  assert.deepEqual(requests, []);
});

test("a change of the desktop's tabs reaches the page whole, in order; a section change is not applied while the notifications flow", async () => {
  const { host, requests, fanned, set, notify, setLive } = rig({ state: [hostState()] });
  const stop = adapter.install(host);
  notify({ sessionId: 's1', state: hostState(), reveal: true, tab: 't1', updated: 't1' });
  assert.equal(fanned.length, 1);
  assert.deepEqual(
    { ...fanned[0], state: undefined },
    { sessionId: 's1', state: undefined, reveal: true, tab: 't1', updated: 't1' }
  );
  assert.ok(!JSON.stringify(fanned[0]).includes('/work/proj'));
  assert.deepEqual(requests, [], 'an event needs no read: it carries what it announces');
  // The lane is registered: the section (a snapshot, or no value when too large to hold) is the state alone, which the events said.
  set(null);
  await settled();
  assert.deepEqual(requests, []);
  assert.equal(fanned.length, 1);
  setLive(false);
  set([hostState()]);
  await settled();
  assert.equal(fanned.length, 1, 'a replay of what stood is not a change');
  stop();
});

test('a repeated thumbnail is not sent again, a new one is', async () => {
  const { host, fanned, notify } = rig();
  adapter.install(host);
  const picture = (data) => ({ thumbnail: `data:image/png;base64,${data}`, thumbnailVersion: 1 });
  notify({ sessionId: 's1', state: hostState(picture('AAAA')) });
  notify({ sessionId: 's1', state: hostState(picture('AAAA')) });
  notify({ sessionId: 's1', state: hostState(picture('BBBB')) });
  await settled();
  assert.deepEqual(
    fanned.map((event) => event.state.tabs[0].thumbnail?.slice(-4)),
    ['AAAA', undefined, 'BBBB']
  );
});

test('an event too large for one section value arrives as ordered parts and is applied whole; a sequence joined in the middle is dropped', () => {
  const { host, fanned, notify, resyncs } = rig();
  adapter.install(host);
  const event = {
    sessionId: 's1',
    state: hostState({ label: 'x'.repeat(300_000) }),
    reveal: true,
    tab: 't1',
    held: true,
    heldSince: 7,
  };
  const text = JSON.stringify(event);
  const slices = [];
  for (let at = 0; at < text.length; at += 40_000) slices.push(text.slice(at, at + 40_000));
  const parts = slices.map((slice, index) => ({ part: { id: 4, index, count: slices.length, text: slice } }));
  // The page connected in the middle: the parts before the first it saw are gone, the rest is not an event.
  for (const part of parts.slice(2)) notify(part);
  assert.equal(fanned.length, 0);
  assert.ok(resyncs() > 0, 'a dropped sequence ends in a read of the current state');
  for (const part of parts) notify(part);
  assert.equal(fanned.length, 1);
  const { state, ...fields } = fanned[0];
  assert.deepEqual(fields, { sessionId: 's1', reveal: true, tab: 't1', held: true, heldSince: 7 });
  assert.equal(state.tabs[0].id, 't1');
});

const GRANT = '00000000-0000-4000-8000-000000000001';
const TRANSFER = '00000000-0000-4000-8000-000000000002';
const EXPORT_VERSION = 'v'.repeat(43);

function exportHost(answers) {
  const sent = [];
  const client = {
    call: async (method, params) => {
      sent.push([method, params]);
      assert.ok(Object.hasOwn(answers, method), `unexpected request ${method}`);
      const answer = answers[method];
      return typeof answer === 'function' ? answer(params) : answer;
    },
  };
  return { sent, host: { ctx: {}, client: () => client, declareLane() {} } };
}

test("an export download round trips through the core's export transfer source: authorize, begin, range, finish", async () => {
  const chunk = {
    transferId: TRANSFER,
    version: EXPORT_VERSION,
    offset: 0,
    length: 9,
    data: 'MTIzNDU2Nzg5',
    eof: true,
  };
  const { sent, host } = exportHost({
    'transfer/authorizeRead': {
      grantId: GRANT,
      size: 9,
      name: 'visualize.png',
      mime: 'image/png',
      version: EXPORT_VERSION,
    },
    'transfer/redeemGrant': { transferId: TRANSFER, size: 9, version: EXPORT_VERSION },
    'transfer/readRange': chunk,
    'transfer/finishRead': { transferId: TRANSFER, size: 9, version: EXPORT_VERSION },
  });
  const exported = adapter.calls.visualizeExport(['s1', 't1', 'png', 0], host);
  const grant = await files.calls.fileDownloadAuthorize([{ source: exported.source, purpose: 'save' }], host);
  assert.deepEqual(
    sent.map(([method]) => method),
    ['transfer/authorizeRead']
  );
  assert.equal(sent[0][1].source.kind, 'export');
  assert.equal(sent[0][1].sessionId, 's1');
  assert.equal(grant.size, 9);
  const transfer = await files.calls.fileDownloadBegin([grant.grantId], host);
  assert.equal(transfer.transferId, TRANSFER);
  const received = await files.calls.fileDownloadRange([transfer.transferId, 0, 9, transfer.version], host);
  assert.deepEqual(received, chunk);
  assert.equal(received.length, 9);
  assert.equal(Buffer.from(received.data, 'base64').toString('utf8'), '123456789');
  const finished = await files.calls.fileDownloadFinish([transfer.transferId], host);
  assert.equal(finished.transferId, TRANSFER);
  assert.deepEqual(sent.slice(1), [
    ['transfer/redeemGrant', { grantId: GRANT }],
    ['transfer/readRange', { transferId: TRANSFER, offset: 0, length: 9, version: EXPORT_VERSION }],
    ['transfer/finishRead', { transferId: TRANSFER }],
  ]);
});

test('a release behind another publication stays a release: held is exactly as published, absence included', () => {
  const { host, fanned, notify } = rig();
  adapter.install(host);
  notify({ sessionId: 's1', state: hostState(), held: true, heldSince: 9 });
  // Another session publishes, then the release of s1 (the producer leaves `held` out).
  notify({ sessionId: 's2', state: { ...hostState(), sessionId: 's2' } });
  notify({ sessionId: 's1', state: hostState() });
  assert.deepEqual(
    fanned.map((event) => [event.sessionId, event.held]),
    [
      ['s1', true],
      ['s2', undefined],
      ['s1', undefined],
    ]
  );
});

test("a reveal of one session is not dropped by another session's publication", () => {
  const { host, fanned, notify } = rig();
  adapter.install(host);
  notify({ sessionId: 'A', state: { ...hostState(), sessionId: 'A' }, reveal: true, tab: 't1' });
  notify({ sessionId: 'B', state: { ...hostState(), sessionId: 'B' } });
  assert.deepEqual(
    fanned.map((event) => [event.sessionId, event.reveal, event.tab]),
    [
      ['A', true, 't1'],
      ['B', undefined, undefined],
    ]
  );
});

test('an empty state followed by a reopen reaches the page as a clear and then the reopened state, each with its own state', () => {
  const { host, fanned, notify } = rig();
  adapter.install(host);
  notify({ sessionId: 's1', state: { sessionId: 's1', active: null, tabs: [] } });
  notify({ sessionId: 's1', state: hostState(), reveal: true, tab: 't1' });
  assert.deepEqual(
    fanned.map((event) => event.state.tabs.length),
    [0, 1]
  );
  assert.equal(fanned[1].reveal, true);
});

test('a phone that connects late gets the current state through the initial read and no effect is invented', async () => {
  const { host, fanned, requests } = rig({ state: [hostState()] });
  adapter.install(host);
  // Events queued before this client existed were queued to the connections that existed then: nothing reaches this one.
  assert.equal(fanned.length, 0);
  const states = await adapter.calls.visualizeState([{}], host);
  assert.equal(states.length, 1);
  assert.deepEqual(requests, [['visualize/command', { action: 'state', input: {} }]]);
  assert.equal(states[0].reveal, undefined);
  assert.equal(states[0].held, undefined);
});

test('cancelling an export sends the grant or transfer id the page holds', async () => {
  const released = new Set();
  const { sent, host } = exportHost({
    'transfer/authorizeRead': { grantId: GRANT },
    'transfer/redeemGrant': { transferId: TRANSFER },
    'transfer/endRead': ({ transferId }) => {
      const ended = !released.has(transferId);
      released.add(transferId);
      return { ended };
    },
  });
  const source = adapter.calls.visualizeExport(['s1', 't1', 'pdf'], host).source;
  // The page cancelled while the authorization was in flight: the grant that arrives after is aborted by its id.
  const grant = await files.calls.fileDownloadAuthorize([{ source, purpose: 'save' }], host);
  assert.equal(await files.calls.fileDownloadAbort([grant.grantId], host), true);
  assert.deepEqual(sent.at(-1), ['transfer/endRead', { transferId: GRANT }], 'the core releases an unredeemed grant');
  // After redemption the page instead aborts the transfer.
  const again = await files.calls.fileDownloadAuthorize([{ source, purpose: 'save' }], host);
  const begun = await files.calls.fileDownloadBegin([again.grantId], host);
  sent.length = 0;
  assert.equal(await files.calls.fileDownloadAbort([begun.transferId], host), true);
  assert.deepEqual(sent, [['transfer/endRead', { transferId: TRANSFER }]]);
  // A repeated abort still asks the core, which reports nothing was released.
  sent.length = 0;
  assert.equal(await files.calls.fileDownloadAbort([begun.transferId], host), false);
  assert.deepEqual(sent, [['transfer/endRead', { transferId: TRANSFER }]]);
});

test('the phone surfaces the core’s refusal to redeem an expired export grant', async () => {
  const { sent, host } = exportHost({
    'transfer/authorizeRead': { grantId: GRANT, expiresAt: 10 },
    'transfer/redeemGrant': () => {
      throw Object.assign(new Error('RPC error'), {
        detail: {
          data: { reason: 'domainError', code: 'file-download:expired', message: 'The download has expired.' },
        },
      });
    },
  });
  const source = adapter.calls.visualizeExport(['s1', 't1', 'png'], host).source;
  const grant = await files.calls.fileDownloadAuthorize([{ source, purpose: 'save' }], host);
  await assert.rejects(files.calls.fileDownloadBegin([grant.grantId], host), { code: 'file-download:expired' });
  assert.deepEqual(sent.at(-1), ['transfer/redeemGrant', { grantId: GRANT }]);
});

test('the lane is registered on every connection that becomes ready, and notifications flow only while the current one holds it', async () => {
  const { host, lanes, connection, resyncs, set } = rig({ state: [hostState()] });
  adapter.install(host);
  await settled();
  assert.deepEqual(lanes, [{ on: true }]);
  // Registered: a section change is the state alone, which the events already said: no read.
  const before = resyncs();
  set([hostState()]);
  assert.equal(resyncs(), before);
  // The connection drops and the same client object reconnects: the new connection has no lane until it registers again.
  connection({ state: 'reconnecting', attempt: 1 });
  set([hostState()]);
  assert.equal(resyncs(), before + 1, 'with no registration the section drives a read');
  connection({ state: 'ready' });
  await settled();
  assert.deepEqual(lanes, [{ on: true }, { on: true }], 'registered again on the replacement connection');
  const registered = resyncs();
  set([hostState()]);
  assert.equal(resyncs(), registered, 'and a change then arrives as the notification alone');
});

test('a core that refuses the lane is followed through its section, which always holds the current state', async () => {
  const refused = rig({
    state: [hostState()],
    lane: () => {
      throw new Error('refused');
    },
  });
  adapter.install(refused.host);
  await settled();
  const before = refused.resyncs();
  refused.set([hostState()]);
  assert.equal(refused.resyncs(), before + 1);
});

test('the thumbnail rule keeps a digest of a picture, and forgets a session that ended', () => {
  const rule = thumbnailRule();
  const state = (data) => ({
    sessionId: 's1',
    tabs: [{ id: 't1', thumbnail: `data:image/png;base64,${data}`, thumbnailVersion: 1 }],
  });
  assert.ok(rule(state('AAAA')).tabs[0].thumbnail);
  assert.equal(rule(state('AAAA')).tabs[0].thumbnail, undefined, 'a repeat is not sent');
  assert.ok(rule(state('AAAB')).tabs[0].thumbnail, 'a one-character change is');
  rule.forget('s1');
  assert.ok(rule(state('AAAB')).tabs[0].thumbnail, 'a forgotten session is sent whole again');
});
