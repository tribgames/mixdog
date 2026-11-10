// The room log's delivery queue (agent-room-delivery.mjs): one instance per
// process, posts into a log in submission order, and one row once.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-room-delivery-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// pdf.js is replaced so a PDF's inspection can be made to stall.
let loadingPdf = () => Promise.reject(new Error('no PDF expected'));
mock.module('unpdf', {
  namedExports: { definePDFJSModule: async () => {}, getDocumentProxy: (...args) => loadingPdf(...args) },
});

const { createAgentRoomDelivery } = await import('./agent-room-delivery.mjs');

const ROOM_LOG = 'sess_room_abc123';
const ids = (session) => session.messages.map((message) => message.meta.transcript.messageId);
const speech = (id, text = id) => ({ id, kind: 'speech', speaker: 'gh', at: 1, text });
const memory = (session = { id: ROOM_LOG, messages: [] }, extra = {}) => ({
  session,
  delivery: createAgentRoomDelivery({
    loadSession: () => session,
    saveSession: async () => {},
    live: () => null,
    ...extra,
  }),
});

test('concurrent first callers share one delivery, so no write to a log is lost', async (t) => {
  // A store that, like the disk, hands out a copy and lands a save later; a
  // second delivery instance would load the log before the first one's save.
  const disk = new Map([[ROOM_LOG, JSON.stringify({ id: ROOM_LOG, generation: 1, messages: [] })]]);
  let saving = 0;
  let overlapped = false;
  const store = mock.module('../runtime/agent/orchestrator/session/store.mjs', {
    namedExports: {
      loadSession: (id) => JSON.parse(disk.get(id)),
      saveSessionAsync: async (session) => {
        saving += 1;
        overlapped ||= saving > 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        disk.set(session.id, JSON.stringify(session));
        saving -= 1;
      },
    },
  });
  t.after(() => store.restore());
  // A fresh copy of the module is a cold process: nothing initialized yet.
  const cold = await import('./agent-room-delivery.mjs?cold-start');
  const results = await Promise.all([
    cold.appendRoomRows(ROOM_LOG, [speech('first')]),
    cold.appendRoomRows(ROOM_LOG, [speech('second')]),
    cold.appendRoomRows(ROOM_LOG, [speech('third')]),
  ]);
  assert.deepEqual(
    results.map((result) => result.added),
    [1, 1, 1]
  );
  assert.equal(overlapped, false, 'saves of one log never overlap');
  assert.deepEqual(ids(JSON.parse(disk.get(ROOM_LOG))), ['first', 'second', 'third']);
});

test('a post whose files are still being taken in is not overtaken by a later post', async () => {
  const { session, delivery } = memory();
  const b64 = (text) => Buffer.from(text).toString('base64');
  const user = {
    id: 'sub-1',
    kind: 'user',
    at: 1,
    text: 'see [Image #1]',
    to: ['gh'],
    toName: ['GH'],
    upload: {
      parts: [{ type: 'image', data: b64('png bytes'), mimeType: 'image/png' }],
      pastedImages: { 1: { id: 1, type: 'image', mediaType: 'image/png', filename: 'shot.png', sizeBytes: 9 } },
    },
  };
  const posts = [delivery.append(ROOM_LOG, [user]), delivery.append(ROOM_LOG, [speech('later')])];
  await Promise.all(posts);
  assert.deepEqual(ids(session), ['sub-1', 'later']);
});

test('a batch with one id twice stores and shows that row once', async () => {
  const notices = [];
  const { session, delivery } = memory(undefined, { live: () => ({ notice: (_id, notice) => notices.push(notice) }) });
  const { added } = await delivery.append(ROOM_LOG, [speech('dup'), speech('other'), speech('dup', 'again')]);
  assert.equal(added, 2);
  assert.deepEqual(ids(session), ['dup', 'other']);
  assert.deepEqual(
    notices.map((notice) => notice.messageId),
    ['dup', 'other']
  );
  assert.equal((await delivery.append(ROOM_LOG, [speech('dup')])).added, 0, 'a retried post still adds nothing');
});

test('a post whose PDF intake stalls fails at the deadline and the next post still commits', async (t) => {
  const { session, delivery } = memory();
  let started = false;
  loadingPdf = () => {
    started = true;
    return new Promise(() => {});
  };
  t.after(() => {
    loadingPdf = () => Promise.reject(new Error('no PDF expected'));
    mock.timers.reset();
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  const user = {
    id: 'sub-pdf',
    kind: 'user',
    at: 1,
    text: 'see [File #1: a.pdf]',
    to: ['gh'],
    toName: ['GH'],
    upload: {
      parts: [
        {
          type: 'file',
          data: Buffer.from('%PDF-1.4\n').toString('base64'),
          mimeType: 'application/pdf',
          filename: 'a.pdf',
        },
      ],
    },
  };
  const stalled = delivery.append(ROOM_LOG, [user]);
  const failed = assert.rejects(stalled, /timed out/);
  const report = delivery.append(ROOM_LOG, [speech('after')]);
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ids(session), [], 'nothing commits while the intake is pending');
  mock.timers.tick(60_000);
  await failed;
  assert.equal((await report).added, 1);
  assert.deepEqual(ids(session), ['after']);
});
