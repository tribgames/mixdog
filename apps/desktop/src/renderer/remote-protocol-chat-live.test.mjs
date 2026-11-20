// The phone's thread list against a RUNNING mixdogd. `remote-protocol-chat-live.core` is what `remote-protocol-chat-live.record.mjs` saw
// from a real `mixdogd serve`: its `thread/list` and every app-feed edge, per scripted action. After each action, the roster the phone
// feed publishes from that action's real edges (over the list before it) is the core's own list after it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRosterFeed } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

const live = verifiedFixture('live').recordings[0];
const plain = (value) => JSON.parse(JSON.stringify(value));
/** The phone's feed over a scripted client; `edge` is delivered as the core's notification, `published` is what the phone's catalog is told. */
function feedOver(listing) {
  const listeners = new Set();
  const stores = new Set();
  const published = [];
  const waiting = [];
  const client = {
    call: async () => ({ data: listing }),
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    store: { subscribe: (l) => (stores.add(l), () => stores.delete(l)) },
  };
  // The feed's catalog clock, moved by the test: `refresh()` runs the refresh its edges set.
  const due = [];
  const feed = createRosterFeed({
    summaries: (rows) => summariesOfThreadRows(rows),
    publish: (rows) => {
      published.push(plain(rows));
      waiting.splice(0).forEach((resolve) => resolve());
    },
    timers: { now: () => 0, setTimeout: (run) => due.push(run) },
  });
  feed.attach(client);
  return {
    published,
    refresh: () => due.splice(0).forEach((run) => run()),
    async attach() {
      const done = new Promise((resolve) => waiting.push(resolve));
      stores.forEach((l) => l({ type: 'appSnapshot' }));
      await done;
    },
    edge: ({ method, params }) =>
      listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
  };
}

test('the live recording is of a real mixdogd and its harness is pinned', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(live.manifest.source, /running mixdogd serve/);
  assert.deepEqual(Object.keys(live.manifest.harness).sort(), [
    'lib/deadline.mjs',
    'lib/env.mjs',
    'lib/fake-provider.mjs',
    'lib/pg-version.json',
    'lib/proc.mjs',
    'lib/scenarios.mjs',
    'lib/stage.mjs',
  ]);
  for (const hash of Object.values(live.manifest.harness)) assert.match(hash, /^[0-9a-f]{64}$/);
});

live.steps.forEach((step, at) => {
  test(`after "${step.name}" the phone's roster is the core's list (edges: ${step.edges.map((e) => e.method).join(', ')})`, async () => {
    const before = at === 0 ? [] : live.steps[at - 1].listed.data;
    const r = feedOver(before);
    await r.attach();
    // The attach publishes the roster before the action; the action's own publications follow it.
    const [attached] = r.published.splice(0);
    for (const edge of step.edges) r.edge(edge);
    r.refresh();
    const last = r.published.at(-1) ?? attached;
    assert.deepEqual(last, plain(summariesOfThreadRows(plain(step.listed.data))));
  });
});

test('the scenario makes a room (`agentRoom`) and an agent home: the final list has rows with those fields', () => {
  const rows = live.steps.at(-1).listed.data;
  assert.ok(rows.some((row) => 'agentRoom' in row));
  assert.ok(rows.some((row) => 'agentHome' in row));
});