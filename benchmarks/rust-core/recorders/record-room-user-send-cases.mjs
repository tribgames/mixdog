#!/usr/bin/env node
// Recording of a user's message into a group room (b6f10295a): the desktop room host's `send` as the composer reaches it
// (`session-host.ts:1089-1091` → `agent-room-messages.ts` createRoomMessages → acceptSend), posting through Node's room log
// (`agent-room-log.ts` createRoomLog) into the daemon's log intake (`src/session-runtime/agent-room-delivery.mjs`
// createAgentRoomDelivery over the real attachment store), the rows read back as the room host reads them (`readItems` →
// roomRowsOfItems). The room records, the member labels and the scheduler's intake/route are the host's, given per case as
// data; what the scheduler was asked to route is recorded, the exchange it starts is not run.
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-room-user-send-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'room-send-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('room-user-send-cases', import.meta.url);
const { createRoomMessages } = await set.load('apps/desktop/src/main/agent-room-messages.ts');
const { createRoomLog } = await set.load('apps/desktop/src/main/agent-room-log.ts');
const { createAgentRoomDelivery } = await set.load('src/session-runtime/agent-room-delivery.mjs');
const { restoreTranscriptItems } = await set.load('src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const { roomRowsOfItems, roomSessionId } = await set.load('src/runtime/agent/orchestrator/session/agent-room.mjs');
const { readAttachmentBuffer } = await set.load('src/runtime/attachments/store.mjs');

const ROOM_ID = 'abc123';
const ROUTE = { provider: 'openai', model: 'gpt-5' };
/** `memberLabels(room)` of the host, every member with its display name; `rel`'s bot is switched off. */
const LABELS = [
  { id: 'bench', name: 'Bench', route: ROUTE, description: '' },
  { id: 'bench-lead', name: 'Bench lead', route: ROUTE, description: '' },
  { id: 'gh', name: 'GitHub 감시', route: ROUTE, description: 'watches GitHub' },
  { id: 'rel', name: 'Release', route: ROUTE, description: '', disabled: true },
];
const room = (extra = {}) => ({
  id: ROOM_ID, name: 'Plan', members: LABELS.map((label) => label.id), maxRounds: 6, maxMessages: 12, shareTools: false, createdAt: 1, cursors: {}, ...extra,
});
const b64 = (text) => Buffer.from(text).toString('base64');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The room records `rooms` (by id), then each send of `sends` in turn (`{ sessionId, prompt, options }`, as `submitToSession`
 *  gets them); what each returned or threw, the log's rows read back, what was routed, the room's fields acceptSend and the
 *  log change, and how often the catalog was republished. `files`: the stored bytes of the read-back rows' parts. */
async function sending({ rooms = [room()], sends, files = false }) {
  const doc = { rooms: Object.fromEntries(rooms.map((record) => [record.id, structuredClone(record)])) };
  const logId = roomSessionId(ROOM_ID);
  const sessions = new Map([[logId, { id: logId, messages: [] }]]);
  const delivery = createAgentRoomDelivery({ loadSession: (id) => sessions.get(id) ?? null, saveSession: async () => {}, live: () => ({ notice: () => {} }) });
  const routed = [];
  let catalogRepublished = 0;
  const deps = {
    appendRows: (id, rows) => delivery.append(id, rows),
    readItems: async (id) => restoreTranscriptItems(sessions.get(id)?.messages ?? [], { sessionId: id }),
    republishCatalog: () => {
      catalogRepublished += 1;
    },
  };
  const log = createRoomLog(deps, () => doc.rooms);
  const messages = createRoomMessages({
    deps,
    ready: async () => {},
    roomOf(roomId) {
      const record = doc.rooms[roomId];
      if (!record) throw new Error('This room no longer exists.');
      return record;
    },
    memberLabels: async (record) => new Map(record.members.map((id) => [id, LABELS.find((label) => label.id === id)])),
    names: new Map(),
    persist: async () => {},
    post: log.post,
    memberSession: async () => {
      throw new Error('recorder: no member session is asked for by a send');
    },
    scheduler: {
      intake: async (_roomId, run) => run({ stopped: false, release() {} }),
      route: (roomId, options) => routed.push({ roomId, ...structuredClone(options) }),
      relayWhenIdle: () => {
        throw new Error('recorder: a send relays nothing');
      },
    },
    now: () => Date.now(),
    newId: () => {
      throw new Error('recorder: every recorded send has a valid submission id');
    },
  });
  const outcomes = [];
  for (const { sessionId, prompt, options } of sends) {
    try {
      outcomes.push({ returned: await messages.send(sessionId, prompt, String(options.id || ''), options) });
    } catch (error) {
      outcomes.push({ threw: { message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) } });
    }
  }
  const readBack = roomRowsOfItems(await deps.readItems(logId));
  const after = doc.rooms[ROOM_ID];
  return {
    rooms, labels: LABELS, sends, outcomes, readBack, routed,
    room: after ? { lastSpeaker: after.lastSpeaker, lastAt: after.lastAt, lastPreview: after.lastPreview, submissions: after.submissions } : null,
    catalogRepublished,
    ...(files ? { storedBytes: readBack.flatMap((row) => (row.parts ?? []).map((part) => ({ type: part.type, text: readAttachmentBuffer(part).toString() }))) } : {}),
  };
}
const send = (prompt, id, extra = {}) => ({ sessionId: roomSessionId(ROOM_ID), prompt, options: { id, ...extra } });

await set.run('a message to the whole room is posted under its submission id and routed to every member', () =>
  sending({ sends: [send('hello all', 'sub-1')] }));
await set.run('/ask names its members in order, by name, and routes to them alone', () =>
  sending({ sends: [send('/ask Bench lead, GitHub 감시 check the build', 'sub-2')] }));
await set.run("a message's files go up with its row: the log stores them and the row carries references", () =>
  sending({
    files: true,
    sends: [
      send(
        [
          { type: 'text', text: '/ask gh see [Image #1], [Pasted text #2 +1 lines] and [File #3: plan.docx]' },
          { type: 'image', data: b64('png bytes'), mimeType: 'image/png' },
          { type: 'file', data: b64('docx bytes'), mimeType: DOCX, filename: 'plan.docx' },
        ],
        'sub-3',
        {
          pastedImages: { 1: { id: 1, type: 'image', mediaType: 'image/png', filename: 'shot.png', sizeBytes: 9 } },
          pastedTexts: { 2: { id: 2, text: 'pasted body', source: 'paste', filename: 'Pasted text #2', mimeType: 'text/plain' } },
        }
      ),
    ],
  }));
await set.run('a submission sent again, or one an earlier process accepted, is acknowledged once and posted once', () =>
  sending({ rooms: [room({ submissions: ['sub-old'] })], sends: [send('first', 'sub-4'), send('first', 'sub-4'), send('again', 'sub-old')] }));
await set.run('an addressee that is no member of the room is refused', () =>
  sending({ sends: [send('/ask Nobody hi', 'sub-5')] }));
await set.run('a switched-off addressee is refused with its code and name', () =>
  sending({ sends: [send('/ask Release ship it', 'sub-6')] }));
await set.run('a message with nothing to send is refused', () =>
  sending({ sends: [send('   ', 'sub-7'), send('/ask Bench', 'sub-8')] }));
await set.run('a room that no longer exists refuses the message', () =>
  sending({ rooms: [], sends: [send('hi', 'sub-9')] }));
await set.run('a file part with no bytes is dropped: the row goes up with its text', () =>
  sending({ sends: [send([{ type: 'text', text: 'see the file' }, { type: 'file', data: '', mimeType: 'text/plain', filename: 'empty.txt' }], 'sub-10')] }));
await set.run('an attached file the log refuses refuses the message: no row, nothing routed, nothing stored', () =>
  sending({
    files: true,
    sends: [send('[File #1]', 'sub-11', { pastedTexts: { 1: { id: 1, text: '', source: 'file', filename: 'empty.txt', mimeType: 'text/plain' } } })],
  }));

await set.finish({
  entry: {
    runs: "agent-room-messages.ts createRoomMessages(...).send (acceptSend) as session-host.ts:1090 calls it, agent-room-log.ts createRoomLog's post, agent-room-delivery.mjs createAgentRoomDelivery's append over the real attachment store, roomRowsOfItems of restoreTranscriptItems as the host's readItems",
    notRun: "the room records' store, the member labels (memberLabels' result per case, `labels`), the scheduler's intake latch (never stopped here) and route (recorded, its exchange not run)",
  },
  replay: {
    entry: "mixdog-core-rooms room/send (rooms/service.rs RoomService, rooms/user_send.rs) over LiveRooms (live.rs View::post) with mixdog-core's SessionFiles intake and DirectoryRoomDaemon on a real thread store: mixdog-core run_host/room_send_replay.rs",
    compare: "per case: each send's answer (`returned` = the reply, `threw` = Node's error as its caller got it, which the core's domain error must equal once the desktop's coreFailure (apps/desktop/src/shared/core-error.ts) turns it into an error: message, code, and details = the detail's fields without the wire's type tag), the log rows read back (DirectoryRoomDaemon::room_rows), the routed requests in Node's option shape ({ roomId, to, everyone, waiting }), the room fields after the send (lastSpeaker, lastAt, lastPreview, submissions), the catalog republish count, and for the files case the stored bytes of each part",
  },
  replaceInText: [[dataDir, '<data>']],
  normaliseReason: 'the temp data dir is written <data>',
});
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
