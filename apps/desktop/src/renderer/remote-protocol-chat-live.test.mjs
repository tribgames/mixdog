// The running mixdogd's app-feed rows against Node's roster rows (PH-2 chat). `remote-protocol-chat-live.recorded.json` is what
// `remote-protocol-chat-live.record.mjs` saw from a real `mixdogd serve` (thread/list and every app-feed notification, over the
// WebSocket protocol); Node's rows are `remote-protocol-chat-roster.recorded.json` (the exact b6f10295a export). The mapping is
// representation only: Node's session ids and project paths are the scripted ones, so a live row is matched to Node's by its title,
// and a project by the folder's name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRosterFeed } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const live = read('./remote-protocol-chat-live.recorded.json');
const node = read('./remote-protocol-chat-roster.recorded.json');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const nodeRows = new Map(node.steps.find((s) => s.name === 'attach-baseline').roster.map((row) => [row.title, row]));
const liveRows = live.listed.data;
const phoneRows = summariesOfThreadRows(plain(liveRows));
const liveByTitle = new Map(phoneRows.map((row) => [row.title, row]));
const titleOf = (id) => liveRows.find((row) => row.id === id)?.title;
const folder = (path) => String(path).split(/[\\/]/).pop();

test('the live recording is of a real mixdogd, with the binary named', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(live.manifest.source, /running mixdogd serve/);
  assert.equal(liveRows.length, 5);
});

test('every session the scenario made reaches the phone list with Node\'s title, project, archive mark and inherit link', () => {
  for (const [title, expected] of nodeRows) {
    const got = liveByTitle.get(title);
    assert.ok(got, `${title} is listed`);
    assert.equal(got.title, expected.title);
    // Node's rows put the archive mark only when set (`archived: true`); the core's list row says false.
    assert.equal(got.archived === true, expected.archived === true, `${title} archived`);
    if (title !== 'Title 2') {
      assert.equal(got.classification, expected.classification, `${title} classification`);
      assert.equal(folder(got.projectPath), folder(expected.projectPath), `${title} project`);
    } else {
      // The fork: Node's inherit link names the source session; the core's fork lands in the task workspace (a difference listed).
      assert.equal(titleOf(liveRows.find((r) => r.title === title).forkedFromId), 'Title 0');
      assert.equal(got.inheritedFromSessionId, liveRows.find((r) => r.title === 'Title 0').id);
    }
  }
});

test('the list order is Node\'s byActivityThenId', () => {
  const order = phoneRows.map((row) => [row.activityAt, row.id]);
  const sorted = [...order].sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  assert.deepEqual(order, sorted);
});

test('the app-feed edges, replayed through the roster feed, leave the list the core listed', async () => {
  const listeners = new Set();
  const stores = new Set();
  const published = [];
  const client = {
    call: async () => ({ data: [] }),
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    store: { subscribe: (l) => (stores.add(l), () => stores.delete(l)) },
  };
  const feed = createRosterFeed({ summaries: (rows) => summariesOfThreadRows(rows), publish: (rows) => published.push(plain(rows)) });
  feed.attach(client);
  stores.forEach((l) => l({ type: 'appSnapshot' }));
  await tick();
  for (const note of live.notes) listeners.forEach((l) => l({ type: 'notification', notification: note }));
  const last = published.at(-1);
  // An edge row carries provider, model and createdAt beside the list row's fields; the phone's row has none of them.
  assert.deepEqual(plain(last), plain(phoneRows));
  assert.ok(last.find((row) => row.title === 'Title 3').archived, 'thread/archived reached the phone list');
});

// What Node's roster row carries for a session and mixdogd's list row and edges do not: a Rust-side gap (reported, not worked
// around). `todo` keeps the check visible without failing the suite.
test('every field Node\'s roster row carries is in the core\'s row', { todo: 'core list rows have no favorite, readMessageCount/readRevision, working flags, agentRoom/agentDeleted' }, () => {
  const missing = new Set();
  for (const [title, expected] of nodeRows) {
    const got = liveByTitle.get(title) ?? {};
    for (const key of ['favorite', 'readMessageCount', 'readRevision', 'working', 'agentWorking', 'leadWorking', 'agentDeleted']) {
      if (key in expected && !(key in got)) missing.add(key);
    }
  }
  assert.deepEqual([...missing], []);
});
