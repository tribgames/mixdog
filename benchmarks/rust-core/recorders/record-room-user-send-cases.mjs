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
const { createRoomRecords } = await set.load('apps/desktop/src/main/agent-room-records.ts');
const { createRoomScheduler } = await set.load('apps/desktop/src/main/agent-room-scheduler.ts');
const { createAgentRoomFileStore } = await set.load('apps/desktop/src/main/agent-rooms.ts');
const { requiredSessionId } = await set.load('apps/desktop/src/main/desktop-state.ts');
const { requiredPromptContent, requiredSubmitOptions } = await set.load('apps/desktop/src/main/ipc-validation.ts');
const { sessionIdOf } = await set.load('apps/desktop/src/main/session-host-transport.ts');
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

const unreached = (what) => () => {
  throw new Error(`recorder: a send ${what}`);
};
const outcomeOf = (pending) =>
  pending.then(
    (returned) => ({ returned }),
    (error) => ({ threw: { message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) } })
  );

/** The room records `rooms` saved in the room host's real file store (`createAgentRoomFileStore`, as `session-host.ts:293`
 *  composes it), then each step of `sends` in turn:
 *  - `{ sessionId, prompt, options }`: `submitToSession` as the desktop's IPC handler runs it (`ipc-sessions.ts:221-222`:
 *    `requiredSessionId`, `requiredPromptContent`, `requiredSubmitOptions`), then the session host (`session-host.ts:1089-1091`:
 *    `agentRooms.send(sessionIdOf(id), prompt, String(options.id || ''), options)`); with `held`, its row waits at the log's
 *    post until a later `release` step (the send is then in flight: its intake latch is open and its row not posted);
 *  - `{ release: true }`: the oldest held send's post goes on; its outcome is written at its own step;
 *  - `{ stop: true }`: the room's stop button (`scheduler.stop(logSessionId)`), what it returned;
 *  - `{ restart: true }`: the room host starts again (a new process): its records are loaded from the same file, its
 *    scheduler and log are new; the room log (the daemon's) is the same.
 *  What each step gave, the log's rows read back, what was routed, the room's fields after, and how often the catalog was
 *  republished. `files`: the stored bytes of the read-back rows' parts. */
async function sending({ rooms = [room()], sends, files = false }) {
  const roomFile = join(mkdtempSync(join(dataDir, 'host-')), 'agent-rooms.json');
  await createAgentRoomFileStore(roomFile).save({ rooms: Object.fromEntries(rooms.map((record) => [record.id, structuredClone(record)])) });
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
  const memberLabels = async (record) => new Map(record.members.map((id) => [id, LABELS.find((label) => label.id === id)]));
  /** The next post to hold: `{ arrived, released }`. */
  let holdNext = null;
  // Not the wall clock: openSet holds Date.now at FIXED_NOW for the whole run (lib/case-set.mjs:20), the golden's
  // clock.dateNow, which the replay gives the core as its now.
  const now = () => Date.now();
  // The room's own ids (`agent-rooms.ts:183`, `now().toString(36)` + random bytes, so each one new): written `newId1`,
  // `newId2`, ... in the order they are made, the replay's declared normalisation.
  let made = 0;
  const newId = () => `newId${(made += 1)}`;
  function start() {
    const records = createRoomRecords({ store: createAgentRoomFileStore(roomFile), listAgents: async () => [], leadName: async () => 'Mixy' });
    const log = createRoomLog(deps, records.rooms);
    const scheduler = createRoomScheduler({
      deps: {},
      rooms: records.rooms,
      roomOf: records.roomOf,
      memberLabels,
      persist: records.persist,
      rows: log.rows,
      post: log.post,
      memberSession: unreached('asks no member session'),
      now,
      newId,
      sleep: unreached('waits for nothing'),
      random: () => 0,
      pollMs: 500,
      log: () => {},
    });
    const messages = createRoomMessages({
      deps,
      ready: records.ready,
      roomOf: records.roomOf,
      memberLabels,
      names: records.names,
      persist: records.persist,
      async post(roomId, rows) {
        const hold = holdNext;
        holdNext = null;
        if (hold) {
          hold.arrived();
          await hold.released;
        }
        return log.post(roomId, rows);
      },
      memberSession: unreached('asks no member session'),
      // The scheduler's own intake latch and stop; the exchange a route starts is not run: each request is recorded.
      scheduler: { intake: scheduler.intake, route: (roomId, options) => routed.push({ roomId, ...structuredClone(options) }), relayWhenIdle: unreached('relays nothing') },
      now,
      newId,
    });
    return { records, scheduler, messages };
  }
  let host = start();
  const submit = async ({ sessionId, prompt, options }) => {
    const id = requiredSessionId(sessionId);
    const content = requiredPromptContent(prompt);
    const submitOptions = requiredSubmitOptions(options);
    return host.messages.send(sessionIdOf(id), content, String(submitOptions.id || ''), submitOptions);
  };
  const outcomes = [];
  const inFlight = [];
  for (const step of sends) {
    if (step.restart) {
      host = start();
      outcomes.push({ restarted: true });
    } else if (step.stop) {
      outcomes.push({ stopped: host.scheduler.stop(logId) });
    } else if (step.release) {
      const held = inFlight.shift();
      held.release();
      outcomes[held.at] = await held.outcome;
      outcomes.push({ released: held.at });
    } else if (step.held) {
      let arrived;
      let release;
      const reached = new Promise((resolve) => {
        arrived = resolve;
      });
      holdNext = { arrived, released: new Promise((resolve) => {
        release = resolve;
      }) };
      const at = outcomes.length;
      outcomes.push(null);
      const outcome = outcomeOf(submit(step));
      await Promise.race([reached, outcome]);
      // Refused before its post: the hold is not left for the next send's.
      if (holdNext?.arrived === arrived) holdNext = null;
      inFlight.push({ at, release, outcome });
    } else {
      outcomes.push(await outcomeOf(submit(step)));
    }
  }
  if (inFlight.length) throw new Error('recorder: a held send was never released');
  const readBack = roomRowsOfItems(await deps.readItems(logId));
  // The room as stored (what a restart reads), not the host's memory, which a refused send may not have loaded.
  const after = (await createAgentRoomFileStore(roomFile).load()).rooms[ROOM_ID];
  return {
    rooms, labels: LABELS, sends, outcomes, readBack, routed,
    room: after ? { lastSpeaker: after.lastSpeaker, lastAt: after.lastAt, lastPreview: after.lastPreview, submissions: after.submissions } : null,
    catalogRepublished,
    ...(files ? { storedBytes: readBack.flatMap((row) => (row.parts ?? []).map((part) => ({ type: part.type, text: readAttachmentBuffer(part).toString() }))) } : {}),
  };
}
const send = (prompt, id, extra = {}) => ({ sessionId: roomSessionId(ROOM_ID), prompt, options: { ...(id === undefined ? {} : { id }), ...extra } });
const held = (prompt, id) => ({ ...send(prompt, id), held: true });

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
await set.run('a submission sent again, in the same process or after a restart of the room host, is acknowledged once and posted once', () =>
  sending({ sends: [send('first', 'sub-4'), send('first', 'sub-4'), { restart: true }, send('first', 'sub-4'), send('after', 'sub-4b')] }));
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

await set.run('two sends with one submission id at once: the second arrives while the first is on its way', () =>
  sending({ sends: [held('first copy', 'sub-c'), send('second copy', 'sub-c'), { release: true }, send('third copy', 'sub-c')] }));
await set.run('the room is stopped while a message is on its way: it is posted and routes nothing', () =>
  sending({ sends: [held('on its way', 'sub-s'), { stop: true }, { release: true }, send('next', 'sub-s2')] }));
await set.run('a room keeps its newest 64 submission ids: an older one sent again is taken again (routed and kept; the log holds one row per id)', () =>
  sending({
    sends: [
      ...Array.from({ length: 65 }, (_, n) => send(`m${n}`, `sub-e${String(n).padStart(2, '0')}`)),
      send('m0 again', 'sub-e00'),
      send('m64 again', 'sub-e64'),
    ],
  }));
await set.run('a send without a submission id, and one whose id is no row id, get a row id of the room; the second is still deduplicated', () =>
  sending({ sends: [send('no id'), send('dotted', 'sub.dot'), send('dotted again', 'sub.dot')] }));
// A message can only name files by their content address (`attachmentRef`, the sha256 of the bytes, store.mjs:49): one the
// store does not hold, or a name that is no address, never reads another file.
const pastedImage = (attachmentRef) => ({ 1: { id: 1, type: 'image', mediaType: 'image/png', filename: 'shot.png', attachmentRef, sizeBytes: 3 } });
await set.run('a pasted image naming a file the store does not hold, or no content address, reads no file', () =>
  sending({
    files: true,
    sends: [send('see [Image #1]', 'sub-ref', { pastedImages: pastedImage('f'.repeat(64)) }), send('see [Image #1]', 'sub-ref-bad', { pastedImages: pastedImage('../../agent-rooms.json') })],
  }));
// The composer's limits, which requiredPromptContent enforces (ipc-validation.ts:315, :1152-1222; shared/prompt-limits.ts):
// a message of exactly 1,000,000 units goes, one unit more is refused; 8 images and 8 files go, a ninth of either is refused.
await set.run('the text limit: 1,000,000 units are posted, one more is refused before anything happens', () =>
  sending({ sends: [send('a'.repeat(1_000_000), 'sub-t'), send('a'.repeat(1_000_001), 'sub-t-over')] }));
const image = (n) => ({ type: 'image', data: b64(`png ${n}`), mimeType: 'image/png' });
const file = (n) => ({ type: 'file', data: b64(`docx ${n}`), mimeType: DOCX, filename: `f${n}.docx` });
await set.run('the attachment counts: 8 images and 8 files are posted, a ninth image or file is refused before anything happens', () =>
  sending({
    files: true,
    sends: [
      send([{ type: 'text', text: 'eight of each' }, ...Array.from({ length: 8 }, (_, n) => image(n)), ...Array.from({ length: 8 }, (_, n) => file(n))], 'sub-n'),
      send([{ type: 'text', text: 'nine images' }, ...Array.from({ length: 9 }, (_, n) => image(n))], 'sub-n-img'),
      send([{ type: 'text', text: 'nine files' }, ...Array.from({ length: 9 }, (_, n) => file(n))], 'sub-n-file'),
    ],
  }));

await set.finish({
  entry: {
    runs: "submitToSession as ipc-sessions.ts:221-222 runs it (requiredSessionId, requiredPromptContent, requiredSubmitOptions) and session-host.ts:1089-1091 hands it on: agent-room-messages.ts createRoomMessages(...).send (acceptSend) under agent-room-scheduler.ts createRoomScheduler's intake latch and stop, over agent-room-records.ts createRoomRecords on agent-rooms.ts createAgentRoomFileStore (a restart is a new records/scheduler/log over the same file), agent-room-log.ts createRoomLog's post, agent-room-delivery.mjs createAgentRoomDelivery's append over the real attachment store, roomRowsOfItems of restoreTranscriptItems as the host's readItems",
    notRun: "the member labels (memberLabels' result per case, `labels`) and the exchange a route starts (scheduler.route is recorded, its exchange not run)",
  },
  replay: {
    entry: "mixdog-core-rooms room/send (rooms/service.rs RoomService, rooms/user_send.rs) over LiveRooms (live.rs View::post) with mixdog-core's SessionFiles intake and DirectoryRoomDaemon on a real thread store, the room records in state/core.sqlite (rooms/store.rs StateRoomStore): mixdog-core run_host/room_send_replay.rs. A restart stops the core's rooms and sessions and starts them again over the same folders; the stop button is the scheduler's (RoomCalls::stop, as RoomRunner::stop)",
    compare: "per case: each step's outcome in step order (a send's `returned` = the reply, `threw` = Node's error as its caller got it, which the core's domain error must equal once the desktop's coreFailure (apps/desktop/src/shared/core-error.ts) turns it into an error: message, code, and details = the detail's fields without the wire's type tag; `stopped` = what the stop returned; `restarted`/`released` mark the step), the log rows read back (DirectoryRoomDaemon::room_rows), the routed requests in Node's option shape ({ roomId, to, everyone, waiting }) as the scheduler took them (RoomCalls::route), the room fields after the last step (lastSpeaker, lastAt, lastPreview, submissions), the catalog republish count, and for the files case the stored bytes of each part",
    normalised: {
      newId: "a row id the room makes (`user_` + newId(), agent-rooms.ts:183: the time in base 36 and four random bytes, each one new) is recorded as `user_newId1`, `user_newId2`, ... in the order the room made them; the replay renames the core's read-back row ids that start with `user_` and are no submission id of the case, in the order they first appear, to the same names, and nothing else",
    },
    notRecorded: "a file part at the log's 64 MiB file limit: the composer and requiredPromptContent hold a file part to 28,000,000 base64 characters (shared/prompt-limits.ts:12-13), so no shipped client reaches it; the argument limits themselves (sizes, counts, types) are refused before anything happens and are tested in the core without a recording (AGENT-RULES: input no shipped client can send)",
  },
});
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
