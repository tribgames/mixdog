// The phone's thread list against a RUNNING mixdogd, in Node's terms. `remote-protocol-chat-live.recorded.json` is what
// `remote-protocol-chat-live.record.mjs` saw from a real `mixdogd serve` (its `thread/list` and every app-feed edge, per scripted action; inputs
// only); `remote-protocol-chat-roster.recorded.json` is the roster Node's phone published for the same actions (the exact b6f10295a export).
// What must be equal is what the phone publishes: remote-protocol-chat-parity.mjs compares whole rows, field by field, in Node's order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRosterFeed } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';
import { assertParity, createParity } from './remote-protocol-chat-parity.mjs';

// The fixtures verified against their manifests (remote-protocol-chat-fixtures.mjs): the core's live recording, Node's N roster recordings.
const live = verifiedFixture('live').recordings[0];
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = (rows) => summariesOfThreadRows(plain(rows));
const nodeRuns = verifiedFixture('roster').recordings.map((recording) => ({ recording, parity: createParity({ live, node: recording, project }) }));
const node = nodeRuns[0].recording;
const parity = nodeRuns[0].parity;

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
    // The attach publishes the roster before the action (the previous step's); the action's own publications follow it.
    const [attached] = r.published.splice(0);
    for (const edge of step.edges) r.edge(edge);
    r.refresh();
    // The whole sequence the phone's catalog was told (the review's B2), under the Stop rule for coalesced messages over Node's N
    // recordings: the roster is published when summaries reach the host or feed (Node: session-host-catalog.ts:228-240, the free
    // point the fixture's manifest declares), so how many publications an action gives is free; each must be a roster some Node
    // recording's phone got in that action, two distinct rosters only in an order some Node recording shows, and the last Node's last.
    const name = `action:${step.name}`;
    const sequences = nodeRuns.map(({ recording, parity: p }) => recording.steps.find((s) => s.name === name).published.map(p.nodeContent));
    const got = r.published.map(parity.phoneContent);
    const problems = [];
    if (sequences.every((s) => !s.length)) {
      if (got.length) problems.push(`Node's phone got no roster in this action; the core's got ${got.length}`);
    } else {
      const shown = new Set(sequences.flat());
      got.forEach((content, index) => { if (!shown.has(content)) problems.push(`publication ${index + 1} of ${got.length} is a roster Node never published: ${content}`); });
      const orders = new Set(sequences.flatMap((s) => s.flatMap((a, i) => s.slice(i + 1).filter((b) => b !== a).map((b) => `${a}\u0000${b}`))));
      got.forEach((a, i) => got.slice(i + 1).forEach((b, j) => {
        if (a !== b && shown.has(a) && shown.has(b) && !orders.has(`${a}\u0000${b}`)) problems.push(`publications ${i + 1} and ${i + j + 2}: an order Node never showed`);
      }));
      // The phone's roster at the end: its last publication, or (the action's edges coalesced into one refresh that changed nothing,
      // as a start and delete of one task does) the roster it attached with.
      problems.push(...parity.classify(node.steps.find((s) => s.name === name).roster, r.published.at(-1) ?? attached).map((d) => `the last publication: ${d}`));
    }
    assertParity(t, problems);
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