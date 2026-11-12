import assert from 'node:assert/strict';
import test from 'node:test';

import { createListRowFeed } from './list-row-feed.mjs';
import { seededRandom } from '../session-runtime/services/agent-tool/status-fixture.test-helpers.mjs';

// A wire client of one global list (wire.md "Global lists").
function listClient(feed, idKey) {
  let rows = [];
  let seq = 0;
  let live = false;
  let buffered = [];
  let held = null;
  const apply = (frame) => {
    rows = rows.filter((row) => row[idKey] !== frame.id);
    if (!frame.removed) {
      const at = frame.after === null ? 0 : rows.findIndex((row) => row[idKey] === frame.after) + 1;
      assert.ok(frame.after === null || at > 0, `frame ${frame.seq} follows a row the client holds`);
      rows.splice(at, 0, frame.row);
    }
    seq = frame.seq;
  };
  return {
    connect() {
      live = false;
      buffered = [];
      held = feed.read();
    },
    answer() {
      if (live || !held) return;
      rows = [...held.rows];
      seq = held.seq;
      live = true;
      for (const frame of buffered) if (frame.seq > seq) apply(frame);
      buffered = [];
    },
    receive(frame) {
      if (!live) {
        if (held) buffered.push(frame);
        return;
      }
      assert.equal(frame.seq, seq + 1, 'frames arrive in seq order');
      apply(frame);
    },
    disconnect() {
      live = false;
      held = null;
    },
    rows: () => rows,
    live: () => live,
  };
}

for (const list of ['agent-pool', 'sessions']) {
  test(`${list}: frames applied to a read rebuild every publication, across reconnects and races`, () => {
    const random = seededRandom(list.length * 97);
    const idKey = list === 'sessions' ? 'id' : 'sessionId';
    const feed = createListRowFeed(list, (row) => row[idKey]);
    let published = [];
    let nextId = 0;
    const row = (id, version) => ({ [idKey]: id, title: `${id}@${version}` });
    const clients = [listClient(feed, idKey), listClient(feed, idKey), listClient(feed, idKey)];
    let frames = 0;
    for (let step = 0; step < 400; step += 1) {
      for (const client of clients) {
        const roll = random();
        if (roll < 0.06) client.disconnect();
        else if (roll < 0.12) client.connect();
        else if (roll < 0.5) {
          if (!client.live()) client.connect();
          client.answer();
        }
      }
      let next = published.map((r) => ({ ...r }));
      const edits = 1 + Math.floor(random() * 4);
      for (let i = 0; i < edits; i += 1) {
        const roll = random();
        if (roll < 0.3 || next.length < 3) next.splice(Math.floor(random() * (next.length + 1)), 0, row(`r${nextId++}`, 0));
        else if (roll < 0.5) next.splice(Math.floor(random() * next.length), 1);
        else if (roll < 0.75) {
          const [moved] = next.splice(Math.floor(random() * next.length), 1);
          next.splice(Math.floor(random() * (next.length + 1)), 0, moved);
        } else {
          const at = Math.floor(random() * next.length);
          next[at] = row(next[at][idKey], step);
        }
      }
      if (random() < 0.05) next = next.reverse();
      const out = feed.publish(next);
      frames += out.length;
      for (const frame of out) for (const client of clients) client.receive(frame);
      published = next;
      for (const client of clients) if (client.live()) assert.deepEqual(client.rows(), published, `step ${step}`);
    }
    assert.ok(frames > 400, `frames ${frames}`);
    assert.deepEqual(feed.publish(published.map((r) => ({ ...r }))), [], 'an identical publication sends nothing');
  });
}

test('one moved row of a long list is one frame', () => {
  const feed = createListRowFeed('sessions', (row) => row.id);
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}` }));
  feed.publish(rows);
  const moved = [rows[299], ...rows.slice(0, 299)];
  const frames = feed.publish(moved);
  assert.deepEqual(frames.map(({ id, after }) => ({ id, after })), [{ id: 's299', after: null }]);
});
