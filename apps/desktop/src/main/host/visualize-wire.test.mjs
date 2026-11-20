// The visualize state the host sends the core (`host/state/set{key:'visualize'}`) is one atomic value (a snapshot replaces
// the core's whole map) and stays under its inbound frame (maxInboundFrameBytes, 262144) even for a session filled to
// every cap of the host: 8 tabs, 3 panes, 20 versions of 20 turns, 20 problems, 120 annotations, 60 KiB thumbnails,
// 512 KiB inline sources, 50 history items.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVisualizeHost } from './visualize.ts';

const MAX_INBOUND_FRAME_BYTES = 262_144;

const fullTab = (id) => ({
  id,
  label: `tab ${id} ${'l'.repeat(80)}`,
  remoteLabel: `tab ${id} ${'l'.repeat(80)}`,
  revision: 7,
  cwd: 'C:\\Users\\someone\\projects\\a-long-project-name\\subfolder',
  thumbnail: `data:image/png;base64,${'A'.repeat(80 * 1024)}`,
  thumbnailVersion: 3,
  versions: Array.from({ length: 20 }, (_, n) => ({
    n: n + 1,
    at: 1_700_000_000_000 + n,
    turns: Array.from({ length: 20 }, (_, t) => ({ since: 1_700_000_000_000 + t, end: 1_700_000_000_500 + t })),
  })),
  problems: Array.from({ length: 20 }, () => ({
    kind: 'asset-failed',
    message: 'm'.repeat(300),
    source: 's'.repeat(200),
    line: 12,
    count: 3,
    pane: 0,
  })),
  annotations: Array.from({ length: 120 }, (_, n) => ({
    id: `a${n}`,
    selector: 's'.repeat(500),
    label: 'l'.repeat(120),
  })),
  restoreAssets: Array.from({ length: 50 }, (_, n) => `assets/file-${n}.png`),
  panes: Array.from({ length: 3 }, (_, n) => ({
    kind: n === 0 ? 'inline' : 'pdf',
    label: `pane ${n}`,
    target: `docs/target-${n}.pdf`,
    path: `C:\\Users\\someone\\projects\\a-long-project-name\\subfolder\\docs\\target-${n}.pdf`,
    remoteTarget: `docs/target-${n}.pdf`,
    root: 'C:\\Users\\someone\\projects\\a-long-project-name',
    ...(n === 0 ? { inline: { kind: 'mermaid', source: 'x'.repeat(512 * 1024), title: 'T' } } : {}),
  })),
});
const fullSession = (sessionId) => ({
  sessionId,
  active: 'v1',
  tabs: Array.from({ length: 8 }, (_, n) => fullTab(`v${n}`)),
  history: Array.from({ length: 50 }, (_, n) => ({
    id: `h${n}`,
    label: `history item ${n}`,
    kind: 'mermaid',
    versions: 2,
    at: 1_700_000_000_000,
    open: n < 8,
  })),
});

function rig(states) {
  const requests = [];
  const connection = {
    request: async (method, params) => {
      requests.push({ method, params, bytes: Buffer.byteLength(JSON.stringify({ id: 1, method, params })) });
      return {};
    },
    notify() {},
    sendBinary() {},
    handleRequest() {},
    handleNotification() {},
    servedMethods: () => [],
    onClose() {},
  };
  const failures = [];
  const host = createVisualizeHost(
    connection,
    () => ({ execute: async () => null, snapshot: () => states }),
    (error) => failures.push(error)
  );
  return { host, requests, failures, settle: () => new Promise((resolve) => setTimeout(resolve, 20)) };
}

test('a snapshot of sessions filled to every cap is one value under the limit, with what the core reads', async () => {
  const states = [fullSession('s0'), fullSession('s1'), fullSession('s2')];
  const raw = Buffer.byteLength(JSON.stringify(states));
  assert.ok(raw > 4 * 1024 * 1024, `the unslimmed state is ${raw} bytes`);
  const { host, requests, failures, settle } = rig(states);
  host.start();
  await settle();
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 1, 'one atomic value');
  assert.ok(requests[0].bytes <= MAX_INBOUND_FRAME_BYTES, `${requests[0].bytes} bytes`);
  const sent = requests[0].params.value;
  assert.deepEqual(
    sent.map((state) => state.sessionId),
    ['s0', 's1', 's2']
  );
  const text = JSON.stringify(sent);
  for (const gone of ['data:image/png', 'xxxx', 'assets/file-', 'ssss']) assert.ok(!text.includes(gone), gone);
  const tab = sent[0].tabs[0];
  assert.equal(tab.cwd, 'C:\\Users\\someone\\projects\\a-long-project-name\\subfolder');
  assert.deepEqual(tab.panes[0].inline, { kind: 'mermaid', source: '', title: 'T', deferred: true });
  assert.deepEqual(
    [tab.panes[1].kind, tab.panes[1].root],
    ['pdf', 'C:\\Users\\someone\\projects\\a-long-project-name']
  );
  assert.equal(sent[0].history.length, 50);
});

/** A core: blob/put stages chunks; host/state/set expands a {$blobRef, as:'text'} value as the app server does and folds it. */
function blobCore(states) {
  const staged = new Map();
  const log = [];
  const folded = [];
  const connection = {
    request: async (method, params) => {
      const bytes = Buffer.byteLength(JSON.stringify({ id: 1, method, params }));
      assert.ok(bytes <= MAX_INBOUND_FRAME_BYTES, `${method}: ${bytes} bytes`);
      log.push(method);
      if (method === 'blob/put') {
        const parts = staged.get(params.digest) ?? [];
        parts.push(Buffer.from(params.bytesB64, 'base64'));
        staged.set(params.digest, parts);
      } else {
        const { value } = params;
        folded.push(value.$blobRef ? JSON.parse(Buffer.concat(staged.get(value.$blobRef)).toString('utf8')) : value);
      }
      return {};
    },
    notify() {},
    sendBinary() {},
    handleRequest() {},
    handleNotification() {},
    servedMethods: () => [],
    onClose() {},
  };
  const failures = [];
  const host = createVisualizeHost(
    connection,
    () => ({ execute: async () => null, snapshot: () => states }),
    (error) => failures.push(error)
  );
  return { host, log, folded, failures };
}

test('a snapshot of any size is one atomic value: over the frame budget it is uploaded and named, never refused', async () => {
  const states = Array.from({ length: 60 }, (_, n) => fullSession(`s${n}`));
  const { host, log, folded, failures } = blobCore(states);
  host.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(failures, []);
  assert.ok(log.filter((method) => method === 'blob/put').length > 1, 'uploaded in chunks');
  assert.equal(log.filter((method) => method === 'host/state/set').length, 1, 'one call applies the whole snapshot');
  assert.equal(folded[0].length, 60);
  assert.deepEqual(
    folded[0].map((state) => state.sessionId),
    states.map((state) => state.sessionId)
  );
});

test('a change published while a snapshot uploads is applied after it, not overwritten by it', async () => {
  const states = Array.from({ length: 60 }, (_, n) => fullSession(`s${n}`));
  const { host, folded } = blobCore(states);
  host.start();
  await host.publish({ sessionId: 's5', state: fullSession('s5'), reveal: true, tab: 'v1' });
  assert.equal(folded.length, 2);
  assert.ok(Array.isArray(folded[0]), 'the snapshot first');
  assert.equal(folded[1].sessionId, 's5', 'then the live change');
});

test('a claim snapshot is built when it is enqueued, so a later event is never older than the snapshot it follows', async () => {
  const older = { ...fullSession('s1'), active: 'older' };
  const newer = { ...fullSession('s1'), active: 'newer' };
  const states = [older];
  const { host, folded } = blobCore(states);
  host.start();
  states[0] = newer; // changes after the claim; its own event is enqueued after the snapshot and carries it
  await host.publish({ sessionId: 's1', state: newer });
  assert.equal(folded[0][0].active, 'older', 'the snapshot holds the state of its enqueue');
  assert.equal(folded[1].state.active, 'newer', 'the event after it is the newer state');
});
test('a change event is slimmed too', async () => {
  const { host, requests } = rig([]);
  await host.publish({ sessionId: 's', state: fullSession('s'), reveal: true, tab: 'v1' });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].bytes <= MAX_INBOUND_FRAME_BYTES);
  assert.equal(requests[0].params.value.reveal, true);
  assert.ok(!JSON.stringify(requests[0].params).includes('data:image/png'));
});
