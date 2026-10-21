// The room records on disk: a damaged agent-rooms.json must never take the
// rooms away for good, and a failed read must not be remembered.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRoomFileStore, createAgentRooms } from './agent-rooms.ts';

const FILE = 'agent-rooms.json';

function tempFile(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-rooms-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, FILE);
}
const asideNames = (file) => readdirSync(join(file, '..')).filter((name) => name.startsWith(`${FILE}.corrupt-`));
const room = (id) => ({ id, name: id, members: ['gh'], createdAt: 1, cursors: {} });

/** A host that only loads: every other dependency is unused by `ready`. */
function hostOver(store) {
  const unused = async () => undefined;
  return createAgentRooms({
    store,
    listAgents: async () => [],
    sessionExists: unused,
    createSession: unused,
    renameSession: unused,
    appendRows: unused,
    readItems: unused,
    submit: unused,
    decideTurn: unused,
    readSnapshot: unused,
    abort: unused,
    approve: unused,
    deleteSession: unused,
    setArchived: unused,
    startOver: unused,
    resetMember: unused,
    taskWorkspace: unused,
    republish: () => {},
    republishCatalog: () => {},
    log: () => {},
  });
}

test('a missing file loads no rooms', async (t) => {
  assert.deepEqual(await createAgentRoomFileStore(tempFile(t)).load(), { rooms: {} });
});

test('a NUL-filled file loads no rooms, is kept aside, and rooms saved after it persist', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, Buffer.alloc(256));
  const store = createAgentRoomFileStore(file);
  assert.deepEqual(await store.load(), { rooms: {} });
  assert.deepEqual(readFileSync(join(file, '..', asideNames(file)[0])), Buffer.alloc(256));
  await store.save({ rooms: { r1: room('r1') } });
  assert.deepEqual(Object.keys((await store.load()).rooms), ['r1']);
});

test('truncated JSON and a non-object root are damage, not an error', async (t) => {
  for (const content of ['{"rooms":{"r1":{"id":', 'null', '[]']) {
    const file = tempFile(t);
    writeFileSync(file, content);
    assert.deepEqual(await createAgentRoomFileStore(file).load(), { rooms: {} }, content);
    assert.equal(readFileSync(join(file, '..', asideNames(file)[0]), 'utf8'), content);
  }
});

test('a save keeps the replaced version, so a damaged file brings the rooms back', async (t) => {
  const file = tempFile(t);
  const store = createAgentRoomFileStore(file);
  await store.save({ rooms: { r1: room('r1') } });
  await store.save({ rooms: { r1: room('r1'), r2: room('r2') } });
  writeFileSync(file, Buffer.alloc(64));
  assert.deepEqual(Object.keys((await store.load()).rooms), ['r1']);
  assert.equal(
    readdirSync(join(file, '..')).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    false
  );
});

test('a save writes the record as it was when asked, not as it changed while queued', async (t) => {
  const file = tempFile(t);
  const store = createAgentRoomFileStore(file);
  const doc = { rooms: { r1: room('r1') } };
  const first = store.save(doc);
  doc.rooms.r1.name = 'changed';
  await first;
  assert.equal((await store.load()).rooms.r1.name, 'r1');
});

test('a failed read of the records is not remembered: the next room action reads again', async () => {
  let reads = 0;
  const rooms = hostOver({
    load: async () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return { rooms: {} };
    },
    save: async () => {},
  });
  await assert.rejects(rooms.ready(), { code: 'EBUSY' });
  await rooms.ready();
  assert.equal(reads, 2);
  await rooms.ready();
  assert.equal(reads, 2, 'a good read is kept');
});

test('rooms start from a NUL-filled records file instead of failing every room action', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, Buffer.alloc(128));
  const rooms = hostOver(createAgentRoomFileStore(file));
  await rooms.ready();
  assert.deepEqual(await rooms.recover(), []);
});
