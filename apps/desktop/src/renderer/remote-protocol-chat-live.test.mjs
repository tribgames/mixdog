// The phone's thread list against a RUNNING mixdogd, in Node's terms. `remote-protocol-chat-live.recorded.json` is what
// `remote-protocol-chat-live.record.mjs` saw from a real `mixdogd serve` (its `thread/list` and every app-feed edge, per scripted action);
// `remote-protocol-chat-roster.recorded.json` is Node's roster for the same sessions at rest (the exact b6f10295a export).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRosterFeed } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const live = read('./remote-protocol-chat-live.recorded.json');
const node = read('./remote-protocol-chat-roster.recorded.json');
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
  assert.deepEqual(live.steps.map((s) => s.name), ['created', 'turns', 'archive', 'unarchive', 'archive-again', 'delete']);
});

// ── the app-feed edges of every action, replayed over the list before it, leave the list the core gives after it ─────────────────────
live.steps.forEach((step, at) => {
  test(`after "${step.name}" the phone's list is the core's list (edges: ${step.edges.map((e) => e.method).join(', ')})`, async () => {
    const before = at === 0 ? [] : live.steps[at - 1].listed.data;
    const r = feedOver(before);
    await r.attach();
    for (const edge of step.edges) r.edge(edge);
    assert.deepEqual(plain(r.published.at(-1)), plain(summariesOfThreadRows(plain(step.listed.data))));
  });
});

// ── the core's rows against Node's roster rows, field by field ───────────────────────────────────────────────────────────────────────
// Node's rows are scripted (ids, folders, counts); the live sessions are real. The representation mapping is: Node's `sess_N` is the
// live session `made.sess_N`, Node's `C:\proj\a|b` is the live project folder `projects.a|b`. Counts, previews, read cursors and times are the run's own
// (the sessions had different histories), so for those the field must be present with Node's type; every other field is equal to Node's.
const final = live.steps.at(-1);
const phoneRows = summariesOfThreadRows(plain(final.listed.data));
const byTitle = new Map(phoneRows.map((row) => [row.title, row]));
const nodeRoster = node.steps.find((s) => s.name === 'idle-roster').roster;
const idMap = new Map(Object.entries(live.made).map(([name, id]) => [name, id]));
const folders = { 'C:\\proj\\a': live.projects.a, 'C:\\proj\\b': live.projects.b };
const RUN_OWN = new Set(['preview', 'updatedAt', 'activityAt', 'messageCount', 'lastMessagePreview', 'readMessageCount', 'readRevision']);
const mapped = (key, value) => (key === 'id' || key === 'inheritedFromSessionId' ? idMap.get(value) : key === 'cwd' || key === 'projectPath' ? folders[value] : value);

// Fields mixdogd's rows do not match Node's yet: exactly these assertions are todo until branch rs-thread-list-rows (the Rust
// worker's, C:\Users\tempe\side\pool\w17) lands; each turns green when it does.
const RUST_GAP = 'branch rs-thread-list-rows: the core\'s thread rows lack the roster fields / the fork lands in the task workspace';
const GAPS = new Set(['Title 1.readMessageCount', 'Title 1.readRevision', 'Title 2.cwd', 'Title 2.classification', 'Title 2.projectPath', 'Title 2.favorite']);

for (const expected of nodeRoster) {
  for (const key of Object.keys(expected)) {
    test(`${expected.title}: ${key} is Node's`, { todo: GAPS.has(`${expected.title}.${key}`) ? RUST_GAP : false }, () => {
      const got = byTitle.get(expected.title);
      assert.ok(got, `${expected.title} is in the phone's list`);
      if (RUN_OWN.has(key)) assert.equal(typeof got[key], typeof expected[key]);
      else assert.deepEqual(got[key], mapped(key, expected[key]));
    });
  }
  test(`${expected.title}: the phone's row has no field Node's row lacks`, { todo: GAPS.has(`${expected.title}.extra`) ? RUST_GAP : false }, () => {
    assert.deepEqual(Object.keys(byTitle.get(expected.title)).filter((key) => !(key in expected)), []);
  });
}

test('the live list has the sessions of Node\'s roster and no other', () => {
  assert.deepEqual([...byTitle.keys()].sort(), nodeRoster.map((r) => r.title).sort());
});

// Not exercised by the live scenario: a retired bot (`agentDeleted`) and a room session (`agentRoom`) need an agent home / room made through
// the protocol. Node's roster carries them (remote-protocol-chat-roster.recorded.json, sess_4 of 'attach-baseline'); the core's list rows have no
// such field at all, so these stay todo until the same branch lands and the scenario creates such rows.
for (const field of ['agentDeleted', 'agentRoom']) {
  test(`a live row carries ${field} where Node's roster does`, { todo: RUST_GAP }, () => {
    assert.ok(final.listed.data.some((row) => field in row));
  });
}

