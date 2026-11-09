// The phone's thread list against a RUNNING mixdogd, in Node's terms. `remote-protocol-chat-live.recorded.json` is what
// `remote-protocol-chat-live.record.mjs` saw from a real `mixdogd serve` (its `thread/list` and every app-feed edge, per scripted action; inputs
// only); `remote-protocol-chat-roster.recorded.json` is the roster Node's phone published for the same actions (the exact b6f10295a export).
// What must be equal is what the phone publishes: remote-protocol-chat-parity.mjs compares whole rows, field by field, in Node's order.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRosterFeed } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { assertParity, createParity } from './remote-protocol-chat-parity.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const live = read('./remote-protocol-chat-live.recorded.json');
const node = read('./remote-protocol-chat-roster.recorded.json');
const plain = (value) => JSON.parse(JSON.stringify(value));
const parity = createParity({ live, node, project: (rows) => summariesOfThreadRows(plain(rows)) });

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
  const feed = createRosterFeed({
    summaries: (rows) => summariesOfThreadRows(rows),
    publish: (rows) => {
      published.push(plain(rows));
      waiting.splice(0).forEach((resolve) => resolve());
    },
  });
  feed.attach(client);
  return {
    published,
    async attach() {
      const done = new Promise((resolve) => waiting.push(resolve));
      stores.forEach((l) => l({ type: 'appSnapshot' }));
      await done;
    },
    edge: ({ method, params }) => listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
  };
}

test('the live recording is of a real mixdogd, its harness pinned, and every step ended with the feed folded to the core\'s list', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(live.manifest.source, /running mixdogd serve/);
  assert.deepEqual(Object.keys(live.manifest.harness).sort(), ['lib/deadline.mjs', 'lib/env.mjs', 'lib/fake-provider.mjs', 'lib/pg-version.json', 'lib/proc.mjs', 'lib/scenarios.mjs', 'lib/stage.mjs']);
  for (const hash of Object.values(live.manifest.harness)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(live.steps.map((s) => s.name), node.manifest.actions);
});

// ── after each action, the roster the phone feed publishes from the core's real edges is the roster Node's phone published ──────────
live.steps.forEach((step, at) => {
  test(`after "${step.name}" the phone's roster is Node's (edges: ${step.edges.map((e) => e.method).join(', ')})`, async (t) => {
    const before = at === 0 ? [] : live.steps[at - 1].listed.data;
    const r = feedOver(before);
    await r.attach();
    for (const edge of step.edges) r.edge(edge);
    // Node published once at the end of an action (its roster publication per store change coalesces to the action's result); the phone
    // feed publishes per edge, so the result of the action is the last roster published.
    assertParity(t, parity.classify(node.steps.find((s) => s.name === `action:${step.name}`).roster, r.published.at(-1)));
  });
});

// The scenario makes a room (`agentRoom`) and an agent whose definition is deleted: both sides have such rows, so the whole-row comparison
// above covers them.
for (const field of ['agentRoom', 'agentHome']) {
  test(`both Node's roster and the live core's list have a row with ${field}`, () => {
    assert.ok(node.states.at(-1).roster.some((row) => field in row));
    assert.ok(live.steps.at(-1).listed.data.some((row) => field in row) || field === 'agentHome');
  });
}