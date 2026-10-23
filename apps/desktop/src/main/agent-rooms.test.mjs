import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { roomMemberSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { createAgentRooms } from './agent-rooms.ts';

/** The log's intake (agent-room-delivery.mjs): a user row's files come back
 *  as stored references, never bytes. */
function storedRow({ upload, ...row }) {
  if (!upload) return row;
  const ref = (data) => createHash('sha256').update(data).digest('hex');
  return {
    ...row,
    parts: upload.parts.map((part) => ({ type: part.type, attachmentRef: ref(part.data), mimeType: part.mimeType })),
  };
}

const AGENTS = [
  { id: 'gh', custom: true, kind: 'bot', label: 'GitHub', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'rel', custom: true, kind: 'bot', label: 'Release', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'bench', custom: true, kind: 'bot', label: 'Bench', route: { provider: 'openai', model: 'gpt-5' } },
];

/** A host whose members answer from `script(agentId, prompt)`; '' passes. */
function harness({
  script = () => 'ok',
  doc = { rooms: {} },
  appendFails = 0,
  deleteFails = false,
  leadName = undefined,
  // The top of the budget range by default, so the caps under test hold exactly.
  random = () => 0.999999,
  // The supervisor: finishes by default (while nobody has answered the user,
  // the exchange falls back to a member instead).
  decide = () => ({ action: 'finish' }),
  // A store save that rejects for the docs it matches.
  saveFails = () => false,
  // A store save held until the promise it returns settles.
  saveGate = () => undefined,
  agents = AGENTS,
  mixyRoute = undefined,
  // The log read hands back only its newest rows, as a session read's tail
  // window does (0: nothing, the in-memory rows alone).
  readWindow = 0,
  // Called on every republish of a room's log view.
  onRepublish = () => {},
  // Awaited by every agent listing (a name refresh waits on it).
  listGate = () => undefined,
  // Definition presence per id (gentDefinitionPresence); none by default.
  presence = undefined,
  // Awaited by every session creation, after it started.
  createGate = () => undefined,
  // Awaited by every row append before it lands, and by every snapshot read
  // (given the snapshot, which it may change) and abort.
  appendGate = () => undefined,
  snapshotGate = () => undefined,
  onAbort = () => undefined,
} = {}) {
  /** Every session whose creation started. */
  const createStarted = [];
  const logs = [];
  /** Every session created, with its create params. */
  const created = [];
  let clock = 1_000;
  let ids = 0;
  const saved = { doc };
  const log = [];
  const prompts = [];
  const answers = new Map();
  const sessions = new Set();
  /** Every session a row was written to or a turn submitted in. */
  const touched = new Set();
  const resets = [];
  /** Every member session aborted. */
  const aborts = [];
  /** Every session a delete was asked for. */
  const deleted = [];
  /** Every input a supervisor step was given. */
  const decisions = [];
  let failures = appendFails;
  const rooms = createAgentRooms({
    store: {
      load: async () => structuredClone(saved.doc),
      save: async (value) => {
        await saveGate(value);
        if (saveFails(value)) throw new Error('disk full');
        saved.doc = structuredClone(value);
      },
    },
    listAgents: async () => {
      await listGate();
      return agents;
    },
    ...(presence === undefined
      ? {}
      : { agentPresence: async (ids) => (typeof presence === 'function' ? presence(ids) : presence) }),
    ...(leadName === undefined ? {} : { leadName: async () => leadName }),
    sessionExists: async (id) => sessions.has(id),
    ...(mixyRoute === undefined ? {} : { mixyRoute: async () => mixyRoute }),
    createSession: async (id, params) => {
      createStarted.push(id);
      await createGate(id);
      sessions.add(id);
      created.push([id, params]);
    },
    renameSession: async () => {},
    appendRows: async (id, rows) => {
      touched.add(id);
      await appendGate(id, rows);
      if (failures > 0) {
        failures -= 1;
        throw new Error('daemon unavailable');
      }
      for (const row of rows) if (!log.some((entry) => entry.id === row.id)) log.push(row);
      return { added: rows.length, rows: rows.map(storedRow) };
    },
    readItems: async () =>
      readWindow > 0
        ? log.slice(-readWindow).map(({ text, upload: _upload, artifactsFrom: _from, ...row }) => ({ room: row, text }))
        : [],
    submit: async (id, prompt, options = {}) => {
      const agentId = id.split('_').at(-1);
      touched.add(id);
      prompts.push({
        agentId,
        prompt,
        ...(options.id ? { id: options.id } : {}),
        ...(options.hop ? { hop: options.hop } : {}),
      });
      const text = await script(agentId, prompt);
      answers.set(id, { text, at: clock + 1 });
      return true;
    },
    decideTurn: async (input) => {
      decisions.push(input);
      return decide(input);
    },
    readSnapshot: async (id) => {
      const answer = answers.get(id);
      const snapshot = {
        busy: false,
        items: [
          { id: 'u', kind: 'user', text: 'p' },
          { id: 'a', kind: 'assistant', text: answer.text || ' ' },
          { id: 'd', kind: 'turndone', at: answer.at, status: 'done', finalAssistantId: 'a' },
        ],
      };
      await snapshotGate(id, snapshot);
      return snapshot;
    },
    abort: async (id) => {
      aborts.push(id);
      await onAbort(id);
    },
    approve: async () => true,
    deleteSession: async (id) => {
      deleted.push(id);
      sessions.delete(id);
      if (deleteFails) throw new Error('locked');
    },
    setArchived: async () => {},
    startOver: async (id) => {
      resets.push(['startOver', id]);
      return 'sess_archived_room';
    },
    resetMember: async (id) => {
      resets.push(['resetMember', id]);
    },
    taskWorkspace: async () => '/tmp',
    republish: (id) => onRepublish(id),
    republishCatalog: () => {},
    now: () => (clock += 1),
    random: () => random(),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    newId: () => {
      ids += 1;
      return `id${ids.toString().padStart(6, '0')}`;
    },
    log: (line) => logs.push(line),
  });
  const idle = async (roomId) => {
    for (let i = 0; i < 2000 && rooms.isRunning(roomId); i += 1) await new Promise((r) => setImmediate(r));
  };
  return { rooms, log, logs, prompts, saved, idle, touched, resets, decisions, created, aborts, deleted, sessions, createStarted };
}

/** A supervisor that hands the turn to the member after the last speaker
 *  (the room's newest speech when this exchange has no turn yet). */
const ROTATE = (input) => {
  const ids = input.members.map((member) => member.id);
  const last = input.last || input.rows.findLast((row) => row.kind === 'speech')?.speaker || '';
  return { action: 'speak', agentId: ids[(ids.indexOf(last) + 1) % ids.length] };
};

async function room(h, extra = {}) {
  const { sessionId, roomId } = await h.rooms.create({
    name: 'Release check',
    members: ['gh', 'rel', 'bench'],
    ...extra,
  });
  return { sessionId, roomId };
}

test("a room's log is created on a member's model: a model-less session is never stored", async () => {
  // Mixy first with no route (neither its own nor Main's): the next member's model carries it.
  const h = harness({ mixyRoute: null });
  const { sessionId } = await room(h, { members: ['lead', 'rel'] });
  assert.deepEqual(h.created[0][1].provider, 'openai');
  assert.equal(h.created[0][0], sessionId);
  // Mixy's own route wins when it comes first, and Mixy's member thread runs on it too.
  const mixy = harness({ mixyRoute: { provider: 'anthropic', model: 'opus' } });
  const made = await room(mixy, { members: ['lead', 'gh'] });
  assert.equal(mixy.created[0][1].model, 'opus');
  await mixy.rooms.send(made.sessionId, '@Mixy hello');
  await mixy.idle(made.roomId);
  const memberThread = mixy.created.find(([id]) => id !== made.sessionId);
  assert.equal(memberThread?.[1].model, 'opus', "Mixy's member thread is not model-less");
});

test('a room whose members have no model cannot be created: the model-required refusal, not a broken room', async () => {
  const bare = AGENTS.map(({ route: _route, ...row }) => row);
  const h = harness({ agents: bare, mixyRoute: null });
  await assert.rejects(() => room(h, { members: ['lead', 'gh'] }), /No model selected/);
  assert.deepEqual(h.created, []);
});

const STORED = {
  id: 'r1',
  name: 'Stored',
  members: ['gh', 'rel', 'bench'],
  maxRounds: 1,
  maxMessages: 6,
  shareTools: false,
  createdAt: 1,
  cursors: {},
  running: null,
};

test('a deleted bot leaves every room it was in, saved; Mixy and the other members stay', async () => {
  const h = harness();
  const a = await room(h);
  const b = await room(h, { name: 'Other', members: ['lead', 'gh', 'bench'] });
  await h.rooms.forgetMember('bench');
  await h.rooms.forgetMember('lead');
  assert.deepEqual(h.saved.doc.rooms[a.roomId].members, ['gh', 'rel']);
  assert.deepEqual(h.saved.doc.rooms[b.roomId].members, ['lead', 'gh']);
  const listed = h.rooms.withRooms([]).map((row) => row.agentRoom.members);
  assert.deepEqual(listed, [
    ['gh', 'rel'],
    ['lead', 'gh'],
  ]);
});

test('a rename racing a removal ends without the removed bot: room writes run one after the other', async () => {
  let hold = null;
  const h = harness({ listGate: () => hold });
  const { roomId } = await room(h);
  let release = () => {};
  hold = new Promise((resolve) => {
    release = resolve;
  });
  const renaming = h.rooms.update(roomId, { name: 'Renamed' });
  await new Promise((resolve) => setImmediate(resolve));
  const forgetting = h.rooms.forgetMember('bench');
  release();
  await Promise.all([renaming, forgetting]);
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'rel']);
  assert.equal(h.saved.doc.rooms[roomId].name, 'Renamed');
});

test('a room holding a deleted id is cleaned and saved as the rooms load; an unknown or failed check removes nothing', async () => {
  const doc = { rooms: { r1: { ...STORED, members: ['lead', 'gh', 'rel', 'bench'], owed: ['bench', 'gh'] } } };
  const probed = [];
  const h = harness({
    doc,
    presence: (ids) => {
      probed.push(ids);
      return { gh: 'present', rel: 'unknown', bench: 'deleted' };
    },
  });
  await h.rooms.ready();
  assert.deepEqual(h.saved.doc.rooms.r1.members, ['lead', 'gh', 'rel']);
  assert.deepEqual(h.saved.doc.rooms.r1.owed, ['gh']);
  assert.deepEqual(probed, [['lead', 'gh', 'rel', 'bench']]);
  const failing = harness({
    doc,
    presence: () => {
      throw new Error('daemon down');
    },
  });
  await failing.rooms.ready();
  assert.deepEqual(failing.saved.doc.rooms.r1.members, ['lead', 'gh', 'rel', 'bench']);
});

test('a save that fails while a member is removed fails that call, like any other room save', async () => {
  let failing = false;
  const h = harness({ saveFails: () => failing });
  const { roomId } = await room(h);
  failing = true;
  await assert.rejects(() => h.rooms.forgetMember('bench'), /disk full/);
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'rel', 'bench'], 'nothing reached the disk');
});

test('a restored bot does not rejoin on its own, but update() adds it back by hand', async () => {
  const h = harness();
  const { roomId } = await room(h);
  await h.rooms.forgetMember('bench');
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'rel']);
  const summary = await h.rooms.update(roomId, { members: ['gh', 'rel', 'bench'] });
  assert.deepEqual(summary.members, ['gh', 'rel', 'bench']);
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'rel', 'bench']);
});

test('a message to a room whose last member was removed ends done with no turn and no cap notice', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h, { members: ['gh', 'rel'] });
  await h.rooms.forgetMember('gh');
  await h.rooms.forgetMember('rel');
  await h.rooms.send(sessionId, 'anyone there?');
  await h.idle(roomId);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(
    h.log.filter((row) => row.kind === 'cap' || row.kind === 'interrupted'),
    []
  );
  assert.deepEqual(h.logs, []);
});
test('a renamed representative is listed in its rooms under its name', async () => {
  const rename = async (leadName) => {
    const h = harness({ leadName });
    await room(h, { members: ['lead', 'gh'] });
    const [row] = h.rooms.withRooms([]);
    return row.agentRoom.memberNames;
  };
  assert.deepEqual(await rename('Navi'), { lead: 'Navi', gh: 'GitHub' });
  assert.deepEqual(await rename(''), { lead: 'Mixy', gh: 'GitHub' }, 'Mixy by default');
});

test('the supervisor picks every speaker; its step cap (rounds × members) ends with a cap notice', async () => {
  const h = harness({ decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 2, maxMessages: 30 });
  await h.rooms.send(sessionId, 'check v1.2.6');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'rel', 'bench', 'gh', 'rel', 'bench']
  );
  assert.equal(h.decisions.length, 6);
  assert.deepEqual(h.log.at(-1), { ...h.log.at(-1), kind: 'cap', limit: 'rounds', rounds: 2 });
});

test('with no Maintainer model every member answers a whole-room call once, in order; no follow-ups', async () => {
  const h = harness({
    decide: () => ({ action: 'unmanaged' }),
    // A speech that @mentions a peer must not start a bot-to-bot turn.
    script: (agentId) => (agentId === 'gh' ? '@Bench your view?' : 'ok'),
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '얘들아');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'rel', 'bench']
  );
  const named = harness({ decide: () => ({ action: 'unmanaged' }) });
  const made = await room(named);
  await named.rooms.send(made.sessionId, '/ask bench, gh status?');
  await named.idle(made.roomId);
  assert.deepEqual(
    named.prompts.map((p) => p.agentId),
    ['bench', 'gh']
  );
});

test('the supervisor reads a bounded window as data: members with one line each, messages without tools', async () => {
  const h = harness({
    decide: (input) => (input.mustPick ? { action: 'speak', agentId: 'rel', instruction: '릴리스 상태 확인' } : null),
    script: () => 'x'.repeat(5_000),
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'Release한테 물어봐');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['rel'],
    'the name without @ is the supervisor’s to read; an unusable later answer finishes'
  );
  assert.match(h.prompts[0].prompt, /moderator picked you to speak next and notes what is wanted: "릴리스 상태 확인"/);
  const [first, second] = h.decisions;
  assert.deepEqual(first.members, [
    { id: 'gh', name: 'GitHub', description: '' },
    { id: 'rel', name: 'Release', description: '' },
    { id: 'bench', name: 'Bench', description: '' },
  ]);
  assert.deepEqual(
    [first.mustPick, first.turns, first.rows.map((row) => row.text)],
    [true, [], ['Release한테 물어봐']]
  );
  assert.equal(second.mustPick, false);
  assert.equal(second.last, 'rel');
  const speech = second.rows.at(-1);
  assert.equal(speech.text.length, 600);
  assert.deepEqual(Object.keys(speech).sort(), ['id', 'kind', 'name', 'speaker', 'text']);
});

test('every typing row has an id of its own, also in a later exchange', async () => {
  // The views hand a typing row's id to the message that lands in its place,
  // so an id that comes back puts one key on two rows of the room's log.
  const typing = [];
  const live = {};
  const h = harness({
    decide: ROTATE,
    script: () => {
      typing.push(live.rooms.decorate(live.sessionId, { items: [] }).items.at(-1).id);
      return 'ok';
    },
  });
  live.rooms = h.rooms;
  const { sessionId, roomId } = await room(h, { maxRounds: 1, maxMessages: 30 });
  live.sessionId = sessionId;
  for (const text of ['first', 'second']) {
    await h.rooms.send(sessionId, text);
    await h.idle(roomId);
  }
  assert.equal(typing.length, 6);
  assert.equal(new Set(typing).size, typing.length);
});

test('a free exchange stops at a drawn budget; a user-addressed set keeps the full cap', async () => {
  const h = harness({ random: () => 0, decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 5, maxMessages: 8 });
  await h.rooms.send(sessionId, 'go');
  await h.idle(roomId);
  assert.equal(h.log.filter((row) => row.kind === 'speech').length, 4, 'three members: once each, plus one');
  assert.equal(h.log.at(-1).kind, 'cap');
  const asked = harness({ random: () => 0 });
  const named = await room(asked, { maxMessages: 3 });
  await asked.rooms.send(named.sessionId, '/ask gh, rel, bench all of you');
  await asked.idle(named.roomId);
  assert.deepEqual(
    asked.prompts.map((p) => p.agentId),
    ['gh', 'rel', 'bench']
  );
});

test('typing rows and turn prompts carry no round numbers', async () => {
  const seen = [];
  const live = {};
  const h = harness({
    decide: ROTATE,
    script: (_agentId, prompt) => {
      seen.push(live.rooms.decorate(live.sessionId, { items: [] }).items.at(-1).room);
      assert.doesNotMatch(prompt, /\bround\b/i);
      return 'ok';
    },
  });
  live.rooms = h.rooms;
  const { sessionId, roomId } = await room(h, { maxRounds: 2, maxMessages: 30 });
  live.sessionId = sessionId;
  await h.rooms.send(sessionId, 'go');
  await h.idle(roomId);
  assert.equal(seen.length, 6);
  for (const row of seen) assert.deepEqual(Object.keys(row).sort(), ['kind', 'name', 'speaker']);
});

test('the message cap stops the supervisor mid-talk', async () => {
  const h = harness({ decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 5, maxMessages: 4 });
  await h.rooms.send(sessionId, 'go');
  await h.idle(roomId);
  assert.equal(h.log.filter((row) => row.kind === 'speech').length, 4);
  assert.equal(h.log.at(-1).limit, 'messages');
});

test('the supervisor finishing ends the exchange without a notice', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'anything?');
  await h.idle(roomId);
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'speech']
  );
});

test('a user message never meets total silence: a failing supervisor still hands members turns until one answers', async () => {
  const h = harness({
    decide: () => {
      throw new Error('maintainer offline');
    },
    script: (agentId) => (agentId === 'bench' ? '네, 듣고 있어요.' : '(pass)'),
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '흠');
  await h.idle(roomId);
  assert.deepEqual(
    h.log.map((row) => [row.kind, row.speaker]),
    [
      ['user', undefined],
      ['pass', 'gh'],
      ['pass', 'rel'],
      ['speech', 'bench'],
    ]
  );
});

test('a reply ending in "(pass)" shows without the marker while the user waits, and passes otherwise', async () => {
  const picks = ['rel', 'bench'];
  const h = harness({
    script: () => 'Here is my answer.\n(pass)',
    decide: (input) => (input.mustPick ? null : picks.length ? { action: 'speak', agentId: picks.shift() } : null),
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'hi');
  await h.idle(roomId);
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'speech', 'pass', 'pass']
  );
  assert.equal(h.log[1].text, 'Here is my answer.');
  assert.ok(h.log.every((row) => !row.text.includes('(pass)')));
});

test('"Continue" runs another supervisor-steered batch', async () => {
  const h = harness({ decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 1, maxMessages: 2 });
  await h.rooms.send(sessionId, 'go');
  await h.idle(roomId);
  h.prompts.length = 0;
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['bench', 'gh']
  );
});

test('each member is handed only what is new since it last spoke', async () => {
  const h = harness({ script: (agentId) => `said by ${agentId}`, decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 2, maxMessages: 30 });
  await h.rooms.send(sessionId, 'first question');
  await h.idle(roomId);
  const ghSecond = h.prompts.filter((p) => p.agentId === 'gh')[1].prompt;
  assert.doesNotMatch(ghSecond, /first question/);
  assert.match(ghSecond, /said by rel/);
  assert.match(ghSecond, /said by bench/);
  assert.doesNotMatch(ghSecond, /said by gh/);
});

test('reset: the log starts over archived, members are emptied, and the next exchange sees only new rows', async () => {
  const h = harness({ script: (agentId) => `said by ${agentId}`, decide: ROTATE });
  const { sessionId, roomId } = await room(h, { maxRounds: 1, maxMessages: 30 });
  await h.rooms.send(sessionId, 'old question');
  await h.idle(roomId);
  assert.deepEqual(await h.rooms.reset(roomId), { archivedSessionId: 'sess_archived_room' });
  assert.deepEqual(h.resets[0], ['startOver', sessionId], 'the room log first');
  assert.deepEqual(
    h.resets.slice(1).map(([kind]) => kind),
    ['resetMember', 'resetMember', 'resetMember'],
    'then every member that has spoken'
  );
  const stored = h.saved.doc.rooms[roomId];
  assert.deepEqual(stored.cursors, {});
  assert.equal(stored.lastPreview, undefined);
  assert.deepEqual(h.rooms.withRooms([])[0].agentRoom.members, ['gh', 'rel', 'bench'], 'members and limits stay');
  h.prompts.length = 0;
  await h.rooms.send(sessionId, 'new question');
  await h.idle(roomId);
  const first = h.prompts[0].prompt;
  assert.match(first, /new question/);
  assert.doesNotMatch(first, /old question|said by/);
});

test('reset is refused while members are speaking', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    script: async () => {
      await gate;
      return 'ok';
    },
  });
  const { sessionId, roomId } = await room(h, { maxRounds: 1 });
  await h.rooms.send(sessionId, 'go');
  await assert.rejects(h.rooms.reset(roomId), /still talking/);
  assert.deepEqual(h.resets, []);
  release();
  await h.idle(roomId);
});

test('a switched-off member stays in the room but takes no new turn; switched back on it is called again', async () => {
  const agents = AGENTS.map((row) => ({ ...row }));
  const h = harness({ agents, decide: () => ({ action: 'unmanaged' }) });
  const { sessionId, roomId } = await room(h);
  agents[1].disabled = true;
  await h.rooms.send(sessionId, '얘들아');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'bench']
  );
  await assert.rejects(h.rooms.send(sessionId, '/ask rel only you'), /No member of this room has that name/);
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'rel', 'bench'], 'membership is kept');
  agents[1].disabled = false;
  await h.rooms.send(sessionId, '/ask rel back?');
  await h.idle(roomId);
  assert.equal(h.prompts.at(-1).agentId, 'rel');
});

test('/ask gives only the addressed member a turn', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '/ask rel only you');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['rel']
  );
  assert.deepEqual(h.log[0].to, ['rel']);
  assert.equal(h.log[0].text, 'only you');
});

test('/ask with several members: they answer once each, in the order named; then the supervisor decides', async () => {
  const h = harness({
    script: (agentId) => (agentId === 'bench' ? '@gh your view?' : 'mine'),
    decide: (input) =>
      input.turns.length === 2 ? { action: 'speak', agentId: 'gh', instruction: 'answer Bench' } : { action: 'finish' },
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '/ask bench, rel both of you');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['bench', 'rel', 'gh']
  );
  assert.deepEqual(
    h.decisions[0].turns.map((turn) => turn.id),
    ['bench', 'rel'],
    'the first supervisor step comes after the named members'
  );
  assert.match(h.prompts[2].prompt, /notes what is wanted: "answer Bench"/);
  assert.match(
    h.prompts[2].prompt,
    /^It is your turn\.$/m,
    'a member the supervisor picks is not told the user asked it'
  );
  assert.deepEqual(
    [h.log[0].to, h.log[0].toName],
    [
      ['bench', 'rel'],
      ['Bench', 'Release'],
    ]
  );
  assert.match(h.prompts[0].prompt, /^The user, to you and Release only:$/m);
});

test('a save that fails outside the exchange is logged, not an unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    // The exchange's first save (the room marked running) comes before its try.
    let failed = false;
    const h = harness({
      saveFails: (doc) => {
        if (failed || !Object.values(doc.rooms).some((entry) => entry.running)) return false;
        failed = true;
        return true;
      },
    });
    const { sessionId } = await room(h);
    await h.rooms.send(sessionId, 'go');
    for (let i = 0; i < 50 && !h.logs.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      h.logs.some((line) => /exchange failed: disk full/.test(line)),
      h.logs.join('\n')
    );
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});

test("the supervisor's scene reaches each member's prompt: casual banter, then work", async () => {
  const picks = [
    { action: 'speak', agentId: 'rel', scene: 'casual' },
    { action: 'speak', agentId: 'gh', scene: 'casual', instruction: 'Release 말에 반응' },
    { action: 'finish', scene: 'casual' },
    { action: 'speak', agentId: 'bench', scene: 'work' },
    { action: 'finish', scene: 'work' },
  ];
  const h = harness({ decide: () => picks.shift() ?? null, script: () => 'ㅋㅋ' });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '오늘 다들 뭐 했어?');
  await h.idle(roomId);
  await h.rooms.send(sessionId, '이 방 멤버들 역할 정리해줘');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['rel', 'gh', 'bench']
  );
  const [rel, gh, bench] = h.prompts.map((p) => p.prompt);
  for (const prompt of [rel, gh]) assert.match(prompt, /casual small talk, not a task/);
  assert.match(gh, /Reply with your own take, in your own voice/);
  assert.doesNotMatch(bench, /casual small talk/);
  assert.match(bench, /nobody has answered yet: reply to the user now/);
  assert.match(bench, /Do not repeat another member just to agree/);
});

test('"Continue" after a capped /ask gives the remaining named members their turns first', async () => {
  // The supervisor opens each free batch with bench, then finishes.
  const h = harness({
    decide: (input) => (input.turns.length ? { action: 'finish' } : { action: 'speak', agentId: 'bench' }),
  });
  const { sessionId, roomId } = await room(h, { maxMessages: 1 });
  await h.rooms.send(sessionId, '/ask bench, gh, rel all three');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['bench']
  );
  assert.equal(h.log.at(-1).kind, 'cap');
  assert.deepEqual(h.saved.doc.rooms[roomId].owed, ['gh', 'rel']);
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['bench', 'gh', 'rel'],
    'one named member per capped batch, in order, nobody else'
  );
  assert.equal(h.saved.doc.rooms[roomId].owed, null);
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  assert.equal(h.prompts.length, 4, 'once owed turns are paid, Continue is a supervisor batch again');
  assert.equal(h.prompts[3].agentId, 'bench');
});

test('a new message drops turns a capped /ask still owed', async () => {
  const h = harness({
    decide: (input) => (input.turns.length ? { action: 'finish' } : { action: 'speak', agentId: 'bench' }),
  });
  const { sessionId, roomId } = await room(h, { maxMessages: 1 });
  await h.rooms.send(sessionId, '/ask bench, gh both');
  await h.idle(roomId);
  await h.rooms.send(sessionId, '/ask rel you');
  await h.idle(roomId);
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId).slice(0, 3),
    ['bench', 'rel', 'bench'],
    'Continue runs a supervisor batch, not the dropped gh turn'
  );
});

test("without a usable decision, a member's @mention gives that peer the next turn and is kept on the speech row", async () => {
  const h = harness({
    script: (agentId) => (agentId === 'gh' ? '@Bench can you confirm the numbers?' : 'ok'),
    decide: () => null,
  });
  const { sessionId, roomId } = await room(h, { maxRounds: 1 });
  await h.rooms.send(sessionId, 'check v1.2.6');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'bench']
  );
  assert.match(h.prompts[1].prompt, /GitHub addressed you with @Bench, so you speak next/);
  const speech = h.log.find((row) => row.kind === 'speech' && row.speaker === 'gh');
  assert.deepEqual([speech.to, speech.toName], [['bench'], ['Bench']]);
});

test('a message sent while members speak drops their queued turns and is answered next', async () => {
  let rooms;
  let session;
  const h = harness({
    // gh's turn ends only once the second message is in: a turn boundary follows.
    script: async (agentId, prompt) => {
      if (agentId === 'gh' && /first/.test(prompt)) await rooms.send(session, '/ask bench second');
      return 'ok';
    },
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'bench']
  );
  assert.match(h.prompts[1].prompt, /second/);
  assert.equal(
    h.log.some((row) => row.kind === 'cap' || row.kind === 'stopped'),
    false
  );
});

test('a message sent while a member speaks cancels that turn: nothing is posted for it, the member sees the missed rows next', async () => {
  let rooms;
  let session;
  const h = harness({
    // gh is still answering "first" when "second" arrives.
    script: async (agentId, prompt) => {
      if (agentId === 'gh' && /first/.test(String(prompt)) && !/second/.test(String(prompt))) {
        await rooms.send(session, 'second');
        return 'stale answer to first';
      }
      return `fresh answer by ${agentId}`;
    },
    decide: (input) => (input.mustPick ? { action: 'speak', agentId: 'gh' } : { action: 'finish' }),
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  assert.deepEqual(
    h.log.map((row) => [row.kind, row.speaker ?? row.text, row.text]),
    [
      ['user', 'first', 'first'],
      ['user', 'second', 'second'],
      ['speech', 'gh', 'fresh answer by gh'],
    ],
    'no speech, pass or stopped row for the cancelled turn'
  );
  assert.ok(
    h.aborts.some((id) => id.endsWith('_gh')),
    'the member session was aborted'
  );
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'gh']
  );
  // The cancelled turn's rows are handed again, with the message that cut it off.
  assert.match(String(h.prompts[1].prompt), /first/);
  assert.match(String(h.prompts[1].prompt), /second/);
  assert.equal(h.logs.length, 0);
});

test('a message sent while a member speaks keeps the room busy across the hand-off to its exchange', async () => {
  let rooms;
  let session;
  // The busy flag every published view of the log carried: it drives the
  // composer's stop button and the transcript's typing band, so a view that
  // dropped it for the hand-off made the room jump up and down under the user.
  const published = [];
  const h = harness({
    script: async (agentId, prompt) => {
      if (agentId === 'gh' && /first/.test(String(prompt)) && !/second/.test(String(prompt))) {
        await rooms.send(session, 'second');
      }
      return `answer by ${agentId}`;
    },
    decide: (input) => (input.mustPick ? { action: 'speak', agentId: 'gh' } : { action: 'finish' }),
    onRepublish: () => published.push(rooms.decorate(session, { items: [] }).busy === true),
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'gh']
  );
  assert.equal(published.at(-1), false, 'the room is idle once its last exchange ends');
  assert.equal(
    published.slice(0, -1).every(Boolean),
    true,
    `no view of the room reported idle between the two exchanges: ${published.join()}`
  );
});

test('a turn cut short hands its rows again only as already-shown context; the newer message is the request', async () => {
  let rooms;
  let session;
  const h = harness({
    script: async (agentId, prompt) => {
      if (agentId === 'gh' && /first/.test(String(prompt)) && !/second/.test(String(prompt))) {
        await rooms.send(session, 'second');
        return 'stale answer to first';
      }
      return `fresh answer by ${agentId}`;
    },
    decide: (input) => (input.mustPick ? { action: 'speak', agentId: 'gh' } : { action: 'finish' }),
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  const again = String(h.prompts[1].prompt);
  assert.doesNotMatch(again, /^The user, to everyone:\nfirst$/m, '"first" is not a new request the second time');
  assert.match(
    again,
    /Already shown to you before[^\n]*\nThe user \(earlier, already shown to you\), to everyone:\nfirst\n/
  );
  assert.match(again, /New since then:\nThe user, to everyone:\nsecond/);
});

test('a long room log read as its tail window never re-hands past user messages or anchors the supervisor on them', async () => {
  // The log read sees only its newest three rows, as a session read's tail
  // window does; everything older comes from the rows this host posted.
  const h = harness({ readWindow: 3 });
  const { sessionId, roomId } = await room(h);
  for (const text of ['usage stats?', 'm2', 'm3']) {
    await h.rooms.send(sessionId, text);
    await h.idle(roomId);
  }
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'gh', 'gh']
  );
  const third = String(h.prompts[2].prompt);
  assert.match(third, /^The user, to everyone:\nm3$/m);
  assert.doesNotMatch(third, /usage stats|m2/, 'messages gh already answered are not handed again');
  // The supervisor reads the newest message as the newest, never an older one.
  for (const step of h.decisions.slice(-2)) {
    assert.equal(step.rows.findLast((row) => row.kind === 'user').text, 'm3');
  }
});

for (const [label, readWindow] of [
  ['an overlapping', 100],
  ['a truncated', 3],
]) {
  test(`a daemon task report the host never posted keeps its log place in ${label} read tail`, async () => {
    // "build it": gh, then rel; anything later: rel alone.
    const h = harness({
      readWindow,
      script: (agentId, prompt) => (/thoughts/.test(String(prompt)) ? `${agentId} on thoughts` : `${agentId} on build`),
      decide: (input) => {
        const asked = input.rows.findLast((row) => row.kind === 'user')?.text;
        const plan = asked === 'build it' ? ['gh', 'rel'] : ['rel'];
        const next = plan[input.turns.length];
        return next ? { action: 'speak', agentId: next } : { action: 'finish' };
      },
    });
    const { sessionId, roomId } = await room(h);
    await h.rooms.send(sessionId, 'build it');
    await h.idle(roomId);
    // The daemon posts gh's task report into the log; its `at` is when it
    // was queued, older than the rows before it.
    h.log.push({ id: 'report_run1', kind: 'speech', speaker: 'gh', name: 'GitHub', at: 1, text: 'task report: done' });
    await h.rooms.send(sessionId, 'thoughts?');
    await h.idle(roomId);
    assert.deepEqual(
      h.prompts.map((p) => p.agentId),
      ['gh', 'rel', 'rel']
    );
    // rel's cursor sits on gh's speech: the report after it reaches rel, before the new message.
    const prompt = String(h.prompts[2].prompt);
    assert.match(prompt, /\[GitHub\]\n│ task report: done\n<\/room-transcript>\nThe user, to everyone:\nthoughts\?$/);
    assert.doesNotMatch(prompt, /build it|gh on build/);
    const [user1, speech1, speech2, , user2] = h.log;
    assert.deepEqual(
      h.decisions.at(-1).rows.map((row) => row.id),
      [user1.id, speech1.id, speech2.id, 'report_run1', user2.id, h.log.at(-1).id],
      'the supervisor reads the room in log order'
    );
  });
}

test('a member with nothing new, no mention and no note is never handed an empty turn', async () => {
  const h = harness({
    script: (agentId) => (agentId === 'gh' ? 'answer' : '(pass)'),
    // gh answers, rel passes, then the supervisor picks gh again with no note.
    decide: (input) =>
      [
        { action: 'speak', agentId: 'gh' },
        { action: 'speak', agentId: 'rel' },
        { action: 'speak', agentId: 'gh' },
        { action: 'finish' },
      ][input.turns.length],
  });
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'usage stats?');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'rel']
  );
  assert.ok(!h.prompts.some((p) => /Nothing new was said/.test(String(p.prompt))));
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'speech', 'pass'],
    'the skipped turn posts nothing'
  );
});

test('"Continue" after the user was answered does not force a member to speak about the finished topic', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'usage stats?');
  await h.idle(roomId);
  assert.equal(h.prompts.length, 1);
  await h.rooms.proceed(roomId);
  await h.idle(roomId);
  assert.equal(h.prompts.length, 1, 'the supervisor finished: no member was called');
  assert.equal(h.decisions.at(-1).mustPick, false);
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'speech']
  );
});

test('a user Stop still ends the exchange with a stopped row', async () => {
  let rooms;
  let session;
  const h = harness({
    script: async (agentId) => {
      if (agentId === 'gh') {
        rooms.stop(session);
        return 'ok';
      }
      return 'never';
    },
    decide: ROTATE,
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  await h.idle(roomId);
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'stopped']
  );
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh']
  );
});

test('members who have nothing to add end the exchange quietly: no endless typing, no cap row', async () => {
  const h = harness({
    script: (agentId, prompt) => (agentId === 'gh' && /user/.test(String(prompt)) ? 'a point' : '(pass)'),
    decide: ROTATE,
  });
  const { sessionId, roomId } = await room(h, { maxRounds: 5, maxMessages: 30 });
  await h.rooms.send(sessionId, 'thoughts?');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'rel', 'bench']
  );
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['user', 'speech', 'pass', 'pass']
  );
});

test('the rounds cap after passes only ends without a cap row; a talk still going gets one', async () => {
  // gh speaks, then rel and bench keep passing in turn; the cap lands on a pass.
  const passing = harness({
    script: (agentId, prompt) => (agentId === 'gh' && /thoughts/.test(String(prompt)) ? 'a point' : '(pass)'),
    decide: (input) =>
      input.mustPick
        ? { action: 'speak', agentId: 'gh' }
        : { action: 'speak', agentId: input.last === 'rel' ? 'gh' : 'rel' },
  });
  const quiet = await room(passing, { maxRounds: 1, maxMessages: 30 });
  await passing.rooms.send(quiet.sessionId, 'thoughts?');
  await passing.idle(quiet.roomId);
  assert.equal(
    passing.log.some((row) => row.kind === 'cap'),
    false
  );
  const talking = harness({ decide: ROTATE });
  const live = await room(talking, { maxRounds: 1, maxMessages: 30 });
  await talking.rooms.send(live.sessionId, 'go');
  await talking.idle(live.roomId);
  assert.equal(talking.log.at(-1).kind, 'cap');
});

test("a member's older answer does not land while the newer message is still being saved", async () => {
  let rooms;
  let session;
  const held = [];
  let hold = false;
  const release = () => {
    for (const resolve of held.splice(0)) resolve();
  };
  const h = harness({
    saveGate: () => (hold ? new Promise((resolve) => held.push(resolve)) : undefined),
    script: async (agentId) => {
      if (agentId === 'gh' && !hold && !h.log.some((row) => row.text === 'second')) {
        hold = true;
        const sent = rooms.send(session, 'second');
        for (let i = 0; i < 2000 && !h.log.some((row) => row.text === 'second'); i += 1) {
          await new Promise((r) => setImmediate(r));
        }
        // gh finishes its answer to "first" while "second" is still saving;
        // the save completes only well after gh's turn could have posted.
        void (async () => {
          for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
          hold = false;
          release();
          await sent;
        })();
        return 'old answer';
      }
      return 'ok';
    },
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  assert.equal(
    h.log.some((row) => row.text === 'old answer'),
    false
  );
  assert.deepEqual(
    h.log.map((row) => [row.kind, row.text]),
    [
      ['user', 'first'],
      ['user', 'second'],
      ['speech', 'ok'],
    ]
  );
});

test('messages sent while members speak keep every addressee for the next exchange', async () => {
  let rooms;
  let session;
  const h = harness({
    script: async (agentId, prompt) => {
      if (agentId === 'gh' && /first/.test(String(prompt))) {
        await rooms.send(session, '/ask bench second');
        await rooms.send(session, '/ask rel third');
      }
      return 'ok';
    },
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'first');
  for (let i = 0; i < 2000 && h.prompts.length < 3; i += 1) await new Promise((r) => setImmediate(r));
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'bench', 'rel']
  );
});

test('a room send writes only to the room and its own member sessions, never a home thread', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h, { maxRounds: 1 });
  await h.rooms.send(sessionId, 'hello room');
  await h.rooms.send(sessionId, '/ask bench only you');
  await h.idle(roomId);
  assert.ok(h.touched.has(sessionId));
  for (const id of h.touched) {
    assert.doesNotMatch(id, /^sess_home_/, id);
    assert.ok(id === sessionId || id.includes(roomId), id);
  }
});

test('after the bot split a room keeps its members: migrated bots and Mixy speak; a member now a workflow agent keeps its name', async () => {
  // A room made on 1.3.0 with Mixy, a bot (now in bots/, same id) and an old
  // agent that was shown as a bot then (now a workflow agent: no contact).
  const before = harness();
  const { roomId } = await room(before, { members: ['lead', 'gh', 'rel'], maxRounds: 1 });
  const h = harness({
    doc: before.saved.doc,
    agents: AGENTS.filter((agent) => agent.id !== 'rel').concat({ id: 'rel', custom: true, label: 'Release' }),
    decide: ROTATE,
  });
  await h.rooms.ready();
  const [row] = h.rooms.withRooms([]);
  assert.deepEqual(row.agentRoom.memberNames, { lead: 'Mixy', gh: 'GitHub', rel: 'Release' });
  const sessionId = row.id;
  await h.rooms.send(sessionId, 'hello room');
  await h.idle(roomId);
  const speakers = new Set(h.prompts.map((prompt) => prompt.agentId));
  assert.ok(speakers.has('gh'), 'the migrated bot answers under its unchanged id');
  for (const id of h.touched) assert.doesNotMatch(id, /^sess_home_/, 'no home thread is touched');
});

test('a duplicate send is acknowledged once and posts one row', async () => {
  const h = harness({ script: () => '' });
  const { sessionId, roomId } = await room(h);
  assert.equal(await h.rooms.send(sessionId, 'hello', 'sub-1'), true);
  await h.idle(roomId);
  const rows = h.log.length;
  assert.equal(await h.rooms.send(sessionId, 'hello', 'sub-1'), true);
  await h.idle(roomId);
  assert.equal(h.log.length, rows);
  assert.equal(h.log.filter((row) => row.kind === 'user').length, 1);
  // The row is the submission's own: the sender's pending bubble is released by this id.
  assert.deepEqual(
    h.log.filter((row) => row.kind === 'user').map((row) => row.id),
    ['sub-1']
  );
});

test('a failed post is not recorded: the retry is accepted for real', async () => {
  const h = harness({ script: () => '', appendFails: 1 });
  const { sessionId, roomId } = await room(h);
  await assert.rejects(h.rooms.send(sessionId, 'hello', 'sub-2'), /daemon unavailable/);
  assert.deepEqual(h.saved.doc.rooms[roomId].submissions ?? [], []);
  assert.equal(await h.rooms.send(sessionId, 'hello', 'sub-2'), true);
  await h.idle(roomId);
  assert.equal(h.log.filter((row) => row.kind === 'user').length, 1);
  assert.deepEqual(h.saved.doc.rooms[roomId].submissions, ['sub-2']);
});

test('accepted submissions survive a restart', async () => {
  const first = harness({ script: () => '' });
  const { sessionId, roomId } = await room(first);
  await first.rooms.send(sessionId, 'hello', 'sub-3');
  await first.idle(roomId);
  const second = harness({ script: () => '', doc: first.saved.doc });
  assert.equal(await second.rooms.send(sessionId, 'hello', 'sub-3'), true);
  assert.equal(second.log.length, 0);
  assert.equal(second.prompts.length, 0);
});

const b64 = (text) => Buffer.from(text).toString('base64');
/** The files a member's turn was handed. */
const filesOf = (prompt) => (Array.isArray(prompt) ? prompt.filter((part) => part.type !== 'text') : []);

test('files go to the members a message addresses, once each, as stored references', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h, { maxRounds: 1 });
  const image = { type: 'image', data: b64('png'), mimeType: 'image/png' };
  const pdf = { type: 'file', data: b64('%PDF'), mimeType: 'application/pdf', filename: 'spec.pdf' };
  const pastedTexts = {
    3: { id: 3, text: 'notes', source: 'paste', filename: 'Pasted text #3', mimeType: 'text/plain' },
  };
  const text = 'see [Image #1] [PDF #2: spec.pdf] [Pasted text #3 +1 lines]';
  await h.rooms.send(sessionId, [{ type: 'text', text: `/ask gh, rel ${text}` }, image, pdf], 'sub-files', {
    pastedTexts,
  });
  await h.idle(roomId);
  // The row goes up with the files as sent; the log's intake stores them.
  const posted = h.log.find((row) => row.kind === 'user');
  assert.equal(posted.text, text);
  assert.deepEqual(posted.upload, { parts: [image, pdf], pastedTexts });
  await h.rooms.send(sessionId, '/ask gh, rel, bench and now?');
  await h.idle(roomId);
  const turns = (id) => h.prompts.filter((p) => p.agentId === id).map((p) => filesOf(p.prompt));
  for (const id of ['gh', 'rel']) {
    const [first, ...later] = turns(id);
    assert.deepEqual(
      first.map((part) => part.type),
      ['image', 'file'],
      id
    );
    assert.ok(first.every((part) => /^[a-f0-9]{64}$/.test(part.attachmentRef) && !('data' in part)));
    assert.deepEqual(later.flat(), [], `${id} is not handed them again`);
  }
  assert.ok(turns('bench').length > 0, 'bench spoke');
  assert.deepEqual(turns('bench').flat(), [], 'bench was not addressed');
});

test('a message to everyone hands its files to each member on the turn that first shows it', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h, { maxRounds: 2, maxMessages: 30 });
  await h.rooms.send(sessionId, [
    { type: 'text', text: 'look' },
    { type: 'image', data: b64('png'), mimeType: 'image/png' },
  ]);
  await h.idle(roomId);
  await h.rooms.send(sessionId, 'more?');
  await h.idle(roomId);
  const spoke = [...new Set(h.prompts.map((p) => p.agentId))];
  assert.ok(spoke.length > 0);
  for (const id of spoke) {
    const counts = h.prompts.filter((p) => p.agentId === id).map((p) => filesOf(p.prompt).length);
    assert.deepEqual(counts, [1, ...counts.slice(1).map(() => 0)], id);
  }
});

test('files alone make a message, also one addressed with /ask', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  assert.equal(await h.rooms.send(sessionId, [{ type: 'image', data: b64('png'), mimeType: 'image/png' }]), true);
  await h.idle(roomId);
  const pdf = { type: 'file', data: b64('%PDF'), mimeType: 'application/pdf', filename: 'a.pdf' };
  assert.equal(await h.rooms.send(sessionId, [{ type: 'text', text: '/ask bench' }, pdf]), true);
  await h.idle(roomId);
  assert.deepEqual(
    h.log.filter((row) => row.kind === 'user').map((row) => [row.text, row.to ?? []]),
    [
      ['', []],
      ['', ['bench']],
    ]
  );
  await assert.rejects(h.rooms.send(sessionId, '/ask bench'), /Write a message/);
});

test('a restart marks an in-flight exchange interrupted and never resumes it', async () => {
  const h = harness({
    doc: {
      rooms: {
        abc123: {
          id: 'abc123',
          name: 'R',
          members: ['gh', 'rel'],
          maxRounds: 3,
          maxMessages: 8,
          shareTools: false,
          createdAt: 1,
          cursors: {},
          running: { startedAt: 5 },
        },
      },
    },
  });
  assert.deepEqual(await h.rooms.recover(), ['abc123']);
  assert.deepEqual(
    h.log.map((row) => row.kind),
    ['interrupted']
  );
  assert.equal(h.saved.doc.rooms.abc123.running, null);
  assert.equal(h.prompts.length, 0);
});

test('stop cancels the speaking member and posts a stopped notice', async () => {
  let rooms;
  let session;
  const h = harness({
    script: (agentId) => {
      if (agentId === 'gh') rooms.stop(session);
      return 'x';
    },
  });
  rooms = h.rooms;
  const { sessionId, roomId } = await room(h);
  session = sessionId;
  await h.rooms.send(sessionId, 'go');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh']
  );
  assert.equal(h.log.at(-1).kind, 'stopped');
});

test("a listed room's row time follows its latest speech, not the log's older catalog time", async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  const catalogRow = { id: sessionId, title: 'x', preview: '', updatedAt: 5, activityAt: 5, messageCount: 0 };
  assert.equal(h.rooms.withRooms([catalogRow])[0].activityAt, 5, 'before anyone spoke the catalog time stands');
  await h.rooms.send(sessionId, 'hello');
  await h.idle(roomId);
  const lastAt = h.saved.doc.rooms[roomId].lastAt;
  assert.ok(lastAt > 5);
  const [row] = h.rooms.withRooms([catalogRow]);
  assert.equal(row.activityAt, lastAt);
  assert.equal(row.updatedAt, lastAt);
  const newer = { ...catalogRow, updatedAt: lastAt + 50, activityAt: lastAt + 50 };
  assert.equal(h.rooms.withRooms([newer])[0].activityAt, lastAt, 'a newer log catalog time does not move the room');
  assert.equal(h.rooms.withRooms([newer])[0].updatedAt, lastAt);
});

test("a room lists its latest message time even when the log's catalog row is newer (housekeeping saves)", async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, 'hello');
  await h.idle(roomId);
  const lastAt = h.saved.doc.rooms[roomId].lastAt;
  const touched = { id: sessionId, title: 'x', preview: '', updatedAt: lastAt + 5000, activityAt: lastAt + 9000, messageCount: 1 };
  const [row] = h.rooms.withRooms([touched]);
  assert.equal(row.updatedAt, lastAt);
  assert.equal(row.activityAt, lastAt);
});

test('a message from another session must name a member of the room: by `to`, or a leading @name', async () => {
  const h = harness();
  const { sessionId } = await room(h);
  await assert.rejects(h.rooms.member(sessionId, { prompt: 'status?' }), /must name the member it is for/);
  await assert.rejects(h.rooms.member(sessionId, { to: 'nobody', prompt: 'status?' }), /"nobody" is not a member/);
  const byName = await h.rooms.member(sessionId, { to: 'release', prompt: 'status?' });
  assert.deepEqual([byName.agentId, byName.text], ['rel', 'status?']);
  assert.equal(byName.sessionId, roomMemberSessionId(sessionId.slice('sess_room_'.length), 'rel'));
  const mention = await h.rooms.member(sessionId, { prompt: '@GitHub check the PR' });
  assert.deepEqual([mention.agentId, mention.text], ['gh', 'check the PR']);
});

test('a message from another session is its sender’s row, and only the named member answers it', async () => {
  const h = harness({ decide: ROTATE });
  const { sessionId, roomId } = await room(h);
  const ends = [];
  await h.rooms.ask(sessionId, {
    agentId: 'rel',
    prompt: 'is v2 ready?',
    from: { sessionId: 'sess_lead_1' },
    id: 'atask_1',
    onSettled: (detail) => ends.push(detail),
  });
  await h.idle(roomId);
  const [row] = h.log;
  assert.deepEqual(
    [row.kind, row.text, row.to, row.fromSession, row.fromName, row.fromAgent],
    ['user', 'is v2 ready?', ['rel'], 'sess_lead_1', 'Lead', undefined]
  );
  assert.deepEqual(
    h.prompts.map((p) => [p.agentId, p.id]),
    [['rel', 'atask_1']],
    'the named member alone answers, under the sender’s submission id'
  );
  assert.equal(h.decisions.length, 0, 'no supervisor step follows');
  assert.match(h.prompts[0].prompt, /Lead asked you directly from another session/);
  assert.match(h.prompts[0].prompt, /Lead \(the user's Lead, from another session, not the user\), to you only:/);
  assert.deepEqual(h.log.at(-1), { ...h.log.at(-1), kind: 'speech', speaker: 'rel', text: 'ok' });
  assert.deepEqual(ends, [{ status: 'done', result: { content: 'ok' } }]);
  // A bot's message carries the bot-to-bot trust note.
  await h.rooms.ask(sessionId, {
    agentId: 'gh',
    prompt: 'ship it',
    from: { sessionId: 'sess_home_bench', agentId: 'bench' },
  });
  await h.idle(roomId);
  assert.deepEqual([h.log.at(-2).fromAgent, h.log.at(-2).fromName], ['bench', 'Bench']);
  assert.match(
    h.prompts.at(-1).prompt,
    /Bench \(another bot, from another session, not the user\)[^\n]*\nFrom another bot, not the user\./
  );
});

test("a member relays its own reported work in one turn of its room, with no row of the report itself", async () => {
  const h = harness({ decide: ROTATE });
  const { sessionId, roomId } = await room(h);
  const { settled } = await h.rooms.relay(roomMemberSessionId(roomId, 'bench'), 'REPORT: tests passed', {
    id: 'awake_1',
  });
  assert.equal(await settled, 'done');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => [p.agentId, p.id]),
    [['bench', 'awake_1']]
  );
  assert.match(h.prompts[0].prompt, /Relay them to the room now/);
  assert.match(h.prompts[0].prompt, /REPORT: tests passed$/);
  assert.doesNotMatch(h.prompts[0].prompt, /reply exactly "\(pass\)"/);
  assert.deepEqual(
    h.log.map((row) => [row.kind, row.speaker]),
    [['speech', 'bench']],
    'the room shows the relay, never the raw report'
  );
  assert.equal(h.decisions.length, 0);
  assert.ok(sessionId);
});

/** A script whose `agentId` turns wait for `release()`; others answer at once. */
function gated(agentIds) {
  let release = () => {};
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    script: async (agentId) => {
      if (agentIds.includes(agentId)) await gate;
      return `answer from ${agentId}`;
    },
    release: () => release(),
    reset: () => {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
  };
}

const until = async (check) => {
  for (let i = 0; i < 2000 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A promise and its resolver. */
const latch = () => {
  let open;
  const closed = new Promise((resolve) => {
    open = resolve;
  });
  return { closed, open };
};

test('a submission the daemon accepts after Stop is aborted before the room is released', async (t) => {
  const gate = gated(['rel']);
  t.after(gate.release);
  let live = false;
  const h = harness({
    script: async (agentId) => {
      const answer = await gate.script(agentId);
      live = true;
      return answer;
    },
    onAbort: () => {
      live = false;
    },
  });
  const { sessionId, roomId } = await room(h);
  const ends = [];
  const ask = (id) =>
    h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: 'status?',
      from: { sessionId: 'sess_lead_1' },
      id,
      onSettled: (detail) => ends.push(detail),
    });
  await ask('atask_late_accept');
  await until(() => h.prompts.length === 1);
  h.rooms.stop(sessionId);
  gate.release();
  await h.idle(roomId);
  assert.equal(live, false, 'the late accepted turn was aborted');
  assert.deepEqual(ends, [{ status: 'cancelled' }]);
  assert.deepEqual(h.log.map((row) => row.kind), ['user', 'stopped']);
  await ask('atask_after_stop');
  await h.idle(roomId);
  assert.deepEqual(ends.at(-1), { status: 'done', result: { content: 'answer from rel' } });
});

for (const kind of ['done answer', 'busy approval']) {
  test(`a ${kind} read as Stop lands is discarded`, async (t) => {
    const read = latch();
    const proceed = latch();
    t.after(() => proceed.open());
    let stopped = false;
    const approvals = [];
    const h = harness({
      snapshotGate: async (_id, snapshot) => {
        if (kind === 'busy approval') Object.assign(snapshot, { busy: true, items: [], toolApproval: { id: 'late' } });
        read.open();
        await proceed.closed;
      },
      onRepublish: (id) => {
        if (stopped) approvals.push(h.rooms.decorate(id, { items: [] }).toolApproval);
      },
    });
    const { sessionId, roomId } = await room(h);
    const ends = [];
    await h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: 'status?',
      from: { sessionId: 'sess_lead_1' },
      id: 'atask_late_snapshot',
      onSettled: (detail) => ends.push(detail),
    });
    await read.closed;
    stopped = true;
    h.rooms.stop(sessionId);
    proceed.open();
    await h.idle(roomId);
    assert.deepEqual(approvals.filter(Boolean), [], 'no approval is published after Stop');
    assert.deepEqual(h.log.map((row) => row.kind), ['user', 'stopped'], 'no speech from the stale snapshot');
    assert.deepEqual(ends, [{ status: 'cancelled' }]);
  });
}

for (const kind of ['send', 'ask']) {
  test(`Stop cancels a ${kind} whose row is still being posted`, async (t) => {
    const posting = latch();
    const append = latch();
    const turn = gated(['gh']);
    t.after(() => {
      append.open();
      turn.release();
    });
    const h = harness({
      script: turn.script,
      appendGate: async (_id, rows) => {
        if (!rows.some((row) => row.kind === 'user' && row.text === 'pending')) return;
        posting.open();
        await append.closed;
      },
    });
    const { sessionId, roomId } = await room(h);
    // A send crosses a running exchange; an ask meets an idle room, so the
    // pending intake alone must make Stop count.
    if (kind === 'send') {
      await h.rooms.send(sessionId, '/ask GitHub first');
      await until(() => h.prompts.length === 1);
    }
    const ends = [];
    const pending =
      kind === 'send'
        ? h.rooms.send(sessionId, '/ask Release pending', 'sub_pending')
        : h.rooms.ask(sessionId, {
            agentId: 'rel',
            prompt: 'pending',
            from: { sessionId: 'sess_lead_1' },
            id: 'atask_pending',
            onSettled: (detail) => ends.push(detail),
          });
    await posting.closed;
    assert.equal(h.rooms.stop(sessionId), true);
    turn.release();
    await h.idle(roomId);
    await h.rooms.send(sessionId, '/ask Bench fresh', 'sub_fresh');
    await h.idle(roomId);
    const expected = kind === 'send' ? ['gh', 'bench'] : ['bench'];
    assert.deepEqual(h.prompts.map((p) => p.agentId), expected, 'a fresh request runs normally');
    append.open();
    assert.equal(await pending, true, 'the logged row is still acknowledged');
    await h.idle(roomId);
    assert.deepEqual(h.prompts.map((p) => p.agentId), expected, 'the stopped request starts nothing');
    assert.equal(h.log.filter((row) => row.kind === 'user' && row.text === 'pending').length, 1);
    if (kind === 'send') {
      assert.ok(h.saved.doc.rooms[roomId].submissions.includes('sub_pending'));
      assert.equal(await h.rooms.send(sessionId, '/ask Release pending', 'sub_pending'), true);
      assert.deepEqual(h.prompts.map((p) => p.agentId), expected, 'the retry is deduplicated');
    } else assert.deepEqual(ends, [{ status: 'cancelled' }], 'the caller settles once');
  });
}

test('Stop cancels an ask still waiting for member names', async (t) => {
  const listing = latch();
  const names = latch();
  t.after(() => names.open());
  let hold = false;
  const h = harness({
    listGate: async () => {
      if (!hold) return;
      listing.open();
      await names.closed;
    },
  });
  const { sessionId, roomId } = await room(h);
  hold = true;
  const ends = [];
  const asked = h.rooms.ask(sessionId, {
    agentId: 'rel',
    prompt: 'status?',
    from: { sessionId: 'sess_lead_1' },
    id: 'atask_pending_labels',
    onSettled: (detail) => ends.push(detail),
  });
  await listing.closed;
  assert.equal(h.rooms.stop(sessionId), true);
  hold = false;
  names.open();
  await asked;
  await h.idle(roomId);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(ends, [{ status: 'cancelled' }]);
  assert.equal(h.rooms.stop(sessionId), false, 'nothing is left pending');
});

test('every message waiting on one member is answered by its turn, behind a turn in flight or cutting one short', async () => {
  const gate = gated(['gh', 'rel']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const ends = { a: [], b: [], c: [], d: [] };
  // Each watch the answering turn's id is recorded for, and how many turns were submitted by then.
  const follows = [];
  const ask = (key, id, hop) =>
    h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id,
      hop,
      onSettled: (detail) => ends[key].push(detail),
      follow: (submissionId) => follows.push([key, submissionId, h.prompts.length]),
    });
  // Two asks queued behind another member's turn: one turn of rel answers both.
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  await ask('a', 'atask_a', 1);
  await ask('b', 'atask_b', 1);
  gate.release();
  await until(() => ends.a.length && ends.b.length);
  await h.idle(roomId);
  const answered = { status: 'done', result: { content: 'answer from rel' } };
  assert.deepEqual([ends.a, ends.b], [[answered], [answered]]);
  assert.deepEqual(
    h.prompts.filter((p) => p.agentId === 'rel').map((p) => [p.id, p.hop]),
    [['atask_a', 1]],
    'one turn, under the first submission id'
  );
  // An ask that cuts the member's own turn short: the next turn answers both,
  // under a submission id not used before, at the highest hop.
  gate.reset();
  await ask('c', 'atask_c', 1);
  await until(() => h.prompts.length === 3);
  await ask('d', 'atask_d', 2);
  gate.release();
  await until(() => ends.c.length && ends.d.length);
  await h.idle(roomId);
  assert.deepEqual([ends.c, ends.d], [[answered], [answered]]);
  assert.deepEqual(
    h.prompts.slice(2).map((p) => [p.agentId, p.id, p.hop]),
    [
      ['rel', 'atask_c', 1],
      ['rel', 'atask_d', 2],
    ]
  );
  // Every call answered under another id has its watch follow that turn,
  // recorded before the turn was submitted: b follows a's turn, the cut-short
  // c follows d's.
  assert.deepEqual(follows, [
    ['b', 'atask_a', 1],
    ['c', 'atask_d', 3],
  ]);
});

test('coalesced, then cut short: every watch ends on the turn that answered, its own id included', async () => {
  let openGh = () => {};
  let openRel = () => {};
  const ghGate = new Promise((resolve) => {
    openGh = resolve;
  });
  const relGate = new Promise((resolve) => {
    openRel = resolve;
  });
  let holdRel = true;
  const h = harness({
    script: async (agentId) => {
      if (agentId === 'gh') await ghGate;
      if (agentId === 'rel' && holdRel) await relGate;
      return `answer from ${agentId}`;
    },
  });
  const { sessionId, roomId } = await room(h);
  // The durable watch store as recovery reads it: each watch's followed submission id.
  const follows = new Map();
  const ends = { a: [], b: [] };
  const ask = (key) =>
    h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${key}`,
      onSettled: (detail) => ends[key].push(detail),
      follow: (submissionId) => follows.set(`atask_${key}`, submissionId),
    });
  const recovered = (runId) => follows.get(runId) ?? runId;
  // a and b wait behind gh's turn: rel's one turn under a's id answers both.
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  await ask('a');
  await ask('b');
  openGh();
  await until(() => h.prompts.length === 2);
  assert.deepEqual([h.prompts[1].id, recovered('atask_b')], ['atask_a', 'atask_a']);
  // A user message cuts that turn short: the replacement turn takes b's own id.
  await h.rooms.send(sessionId, '/ask Release one more thing');
  holdRel = false;
  openRel();
  await until(() => ends.a.length && ends.b.length);
  await h.idle(roomId);
  const answering = h.prompts.at(-1);
  assert.deepEqual([answering.agentId, answering.id], ['rel', 'atask_b']);
  assert.deepEqual(
    [recovered('atask_a'), recovered('atask_b')],
    ['atask_b', 'atask_b'],
    "after a restart both watches read the answering turn: b's stale alias to a is gone"
  );
  const answered = { status: 'done', result: { content: 'answer from rel' } };
  assert.deepEqual([ends.a, ends.b], [[answered], [answered]]);
});

test("a watch that cannot follow the shared turn fails every call it covers, and nothing is submitted", async () => {
  const gate = gated(['gh']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const ends = { a: [], b: [] };
  const ask = (key, follow) =>
    h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${key}`,
      onSettled: (detail) => ends[key].push(detail),
      follow,
    });
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  await ask('a', () => {});
  await ask('b', async () => {
    throw new Error('disk full');
  });
  gate.release();
  await until(() => ends.a.length && ends.b.length);
  await h.idle(roomId);
  assert.equal(h.prompts.filter((p) => p.agentId === 'rel').length, 0, 'no turn without its durable mapping');
  assert.deepEqual(
    [ends.a[0].status, ends.b[0].status],
    ['failed', 'failed']
  );
});

test('a failed save at the start or hand-off of an exchange releases the room and fails what waited on it', async () => {
  const gate = gated(['gh']);
  let failing = false;
  const h = harness({ script: gate.script, saveFails: () => failing });
  const { sessionId, roomId } = await room(h);
  const bench = roomMemberSessionId(roomId, 'bench');
  const ends = [];
  const ask = () =>
    h.rooms.ask(sessionId, {
      agentId: 'rel',
      prompt: 'status?',
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${ends.length}`,
      onSettled: (detail) => ends.push(detail),
    });
  // The hand-off: a message and a relay wait behind a turn; the save that
  // passes the room on to them fails.
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  const held = await h.rooms.relay(bench, 'REPORT: done', { id: 'awake_1' });
  await ask();
  failing = true;
  gate.release();
  assert.equal(await held.settled, 'failed');
  await until(() => ends.length === 1);
  assert.deepEqual(ends, [{ status: 'failed', error: 'disk full' }]);
  await until(() => !h.rooms.isRunning(roomId));
  assert.equal(h.rooms.isRunning(roomId), false, 'the room is released');
  // The start: the exchange's first save fails.
  await assert.rejects(ask(), /disk full/);
  await until(() => ends.length === 2);
  assert.deepEqual(ends[1], { status: 'failed', error: 'disk full' });
  assert.equal(h.rooms.isRunning(roomId), false);
  // Nothing is left stuck: once saves work, a relay runs at once.
  failing = false;
  const next = await h.rooms.relay(bench, 'REPORT: again', { id: 'awake_2' });
  assert.equal(await next.settled, 'done');
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh', 'bench']
  );
});

test("a relay waits for the room's talk to end, runs at its hop, and a stop drops it", async () => {
  const gate = gated(['gh']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const bench = roomMemberSessionId(roomId, 'bench');
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  const { settled } = await h.rooms.relay(bench, 'REPORT: done', { id: 'awake_1', hop: 2 });
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh'],
    'the member speaking is never cut off by a relay'
  );
  gate.release();
  assert.equal(await settled, 'done');
  assert.deepEqual(
    h.prompts.map((p) => [p.agentId, p.id, p.hop]),
    [
      ['gh', undefined, undefined],
      ['bench', 'awake_1', 2],
    ]
  );
  assert.deepEqual(h.log.at(-2), { ...h.log.at(-2), kind: 'speech', speaker: 'gh' });
  assert.deepEqual(h.log.at(-1), { ...h.log.at(-1), kind: 'speech', speaker: 'bench' });
  // A relay held back while the user stops the room ends cancelled; nobody speaks for it.
  gate.reset();
  await h.rooms.send(sessionId, '/ask GitHub again');
  await until(() => h.prompts.length === 3);
  const dropped = await h.rooms.relay(bench, 'REPORT: later', { id: 'awake_2' });
  h.rooms.stop(sessionId);
  gate.release();
  assert.equal(await dropped.settled, 'cancelled');
  await h.idle(roomId);
  assert.equal(h.prompts.filter((p) => p.agentId === 'bench').length, 1);
});

test('an ask and a relay arriving after a stop, while the room winds down, end cancelled and nothing hangs', async () => {
  const gate = gated(['gh']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const bench = roomMemberSessionId(roomId, 'bench');
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  h.rooms.stop(sessionId);
  const ends = [];
  await h.rooms.ask(sessionId, {
    agentId: 'rel',
    prompt: 'status?',
    from: { sessionId: 'sess_lead_1' },
    id: 'atask_late',
    onSettled: (detail) => ends.push(detail),
  });
  const relayed = await h.rooms.relay(bench, 'REPORT: late', { id: 'awake_late' });
  assert.equal(await relayed.settled, 'cancelled');
  assert.deepEqual(ends, [{ status: 'cancelled' }]);
  gate.release();
  await h.idle(roomId);
  assert.deepEqual(ends, [{ status: 'cancelled' }], 'settled once');
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh'],
    'neither the ask nor the relay got a turn'
  );
});

test('a bot deleted during its own turn: the turn is aborted and posts nothing, its callers end cancelled, queued targets drop it', async () => {
  const gate = gated(['rel']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const rel = roomMemberSessionId(roomId, 'rel');
  const ends = { first: [], second: [], bench: [] };
  const ask = (key, agentId) =>
    h.rooms.ask(sessionId, {
      agentId,
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${key}`,
      onSettled: (detail) => ends[key].push(detail),
    });
  await ask('first', 'rel');
  await until(() => h.prompts.length === 1);
  // Queued behind rel's turn in flight: another ask for it, one for bench, and rel's own relay.
  await ask('second', 'rel');
  await ask('bench', 'bench');
  const relayed = await h.rooms.relay(rel, 'REPORT: done', { id: 'awake_1' });
  await h.rooms.forgetMember('rel');
  assert.deepEqual(ends.second, [{ status: 'cancelled' }], 'the queued ask for the removed bot ends at once');
  assert.equal(await relayed.settled, 'cancelled', 'so does its queued relay');
  gate.release();
  await until(() => ends.first.length && ends.bench.length);
  await h.idle(roomId);
  assert.deepEqual(ends.first, [{ status: 'cancelled' }], 'the ask its turn was answering ends cancelled');
  assert.deepEqual(ends.second, [{ status: 'cancelled' }], 'settled once');
  assert.equal(ends.bench[0].status, 'done', 'the other member still gets its turn');
  assert.ok(h.aborts.includes(rel), 'the removed bot’s turn in flight is aborted');
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['rel', 'bench'],
    'the removed bot gets no further turn'
  );
  assert.deepEqual(
    h.log.filter((row) => row.speaker === 'rel'),
    [],
    'nothing is posted for the turn it was in'
  );
  assert.equal(h.rooms.isRunning(roomId), false, 'the room is not held by the removed bot');
});

test('a bot deleted while an exchange still owes it a turn: its queued calls end cancelled and it is never handed one', async () => {
  const gate = gated(['gh', 'bench']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const rel = roomMemberSessionId(roomId, 'rel');
  const ends = { bench: [], rel: [] };
  const ask = (key, agentId) =>
    h.rooms.ask(sessionId, {
      agentId,
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${key}`,
      onSettled: (detail) => ends[key].push(detail),
    });
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  // Both wait for the next exchange: bench first, then rel.
  await ask('bench', 'bench');
  await ask('rel', 'rel');
  const relayed = await h.rooms.relay(rel, 'REPORT: done', { id: 'awake_1' });
  gate.release();
  gate.reset();
  await until(() => h.prompts.some((p) => p.agentId === 'bench'));
  // rel's ask now sits in the running exchange, behind bench's turn.
  await h.rooms.forgetMember('rel');
  assert.deepEqual(ends.rel, [{ status: 'cancelled' }]);
  assert.equal(await relayed.settled, 'cancelled');
  gate.release();
  await until(() => ends.bench.length);
  await h.idle(roomId);
  assert.equal(ends.bench[0].status, 'done');
  assert.deepEqual(ends.rel, [{ status: 'cancelled' }], 'settled once');
  assert.equal(
    h.prompts.some((p) => p.agentId === 'rel'),
    false,
    'the removed bot was never handed a turn'
  );
  assert.deepEqual(h.logs, []);
});

test('a member taken out of one room by its settings leaves as a deleted bot does: queued calls end cancelled once, the others carry on', async () => {
  const gate = gated(['gh', 'bench']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h);
  const other = await room(h, { name: 'Other' });
  const rel = roomMemberSessionId(roomId, 'rel');
  const ends = { bench: [], rel: [], more: [], elsewhere: [] };
  const ask = (key, agentId, to = sessionId) =>
    h.rooms.ask(to, {
      agentId,
      prompt: `question ${key}`,
      from: { sessionId: 'sess_lead_1' },
      id: `atask_${key}`,
      onSettled: (detail) => ends[key].push(detail),
    });
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  await ask('bench', 'bench');
  await ask('rel', 'rel');
  await ask('more', 'rel');
  const relayed = await h.rooms.relay(rel, 'REPORT: done', { id: 'awake_1' });
  await h.rooms.update(roomId, { members: ['gh', 'bench'] });
  assert.deepEqual(ends.rel, [{ status: 'cancelled' }], 'cancelled at once, not when the exchange gets to it');
  assert.deepEqual(ends.more, [{ status: 'cancelled' }]);
  assert.equal(await relayed.settled, 'cancelled');
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'bench']);
  gate.release();
  await until(() => ends.bench.length);
  await h.idle(roomId);
  assert.equal(ends.bench[0].status, 'done', 'a member that stays is still answered');
  assert.deepEqual([ends.rel.length, ends.more.length], [1, 1], 'settled once');
  assert.equal(
    h.prompts.some((p) => p.agentId === 'rel'),
    false,
    'the removed member got no turn'
  );
  assert.equal(h.rooms.isRunning(roomId), false);
  // The room works on with its remaining members, and the same bot still serves another room.
  gate.reset();
  gate.release();
  await ask('elsewhere', 'rel', other.sessionId);
  await until(() => ends.elsewhere.length);
  assert.equal(ends.elsewhere[0].status, 'done', 'removal from one room leaves its other rooms alone');
  await h.rooms.send(sessionId, '/ask GitHub again');
  await h.idle(roomId);
  assert.equal(h.log.at(-1).speaker, 'gh');
});

test('a member removed by the room settings takes its conversation with it: none survives the room or a re-add', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  const rel = roomMemberSessionId(roomId, 'rel');
  await h.rooms.send(sessionId, '/ask Release status');
  await h.idle(roomId);
  assert.ok(h.sessions.has(rel), 'rel has a conversation in the room');
  await h.rooms.update(roomId, { members: ['gh', 'bench'] });
  assert.deepEqual(h.deleted, [rel]);
  assert.equal(h.sessions.has(rel), false);
  assert.equal(h.saved.doc.rooms[roomId].cursors.rel, undefined);
  // Added back, it starts a fresh conversation.
  await h.rooms.update(roomId, { members: ['gh', 'rel', 'bench'] });
  await h.rooms.send(sessionId, '/ask Release again');
  await h.idle(roomId);
  assert.equal(h.created.filter(([id]) => id === rel).length, 2);
  await h.rooms.update(roomId, { members: ['gh', 'bench'] });
  await h.rooms.remove(roomId);
  const leftover = [...h.sessions].filter((id) => id.includes(roomId));
  assert.deepEqual(leftover, [], 'no conversation of the room survives its removal');

  // A delete that fails is surfaced, and the removal still applies.
  const stuck = harness({ deleteFails: true });
  const made = await room(stuck);
  await assert.rejects(stuck.rooms.update(made.roomId, { members: ['gh', 'bench'], name: 'Renamed' }), /could not be deleted/);
  assert.deepEqual(stuck.saved.doc.rooms[made.roomId].members, ['gh', 'bench']);
  assert.equal(stuck.saved.doc.rooms[made.roomId].name, 'Renamed');
});

test('every member removed while the room talks: the calls end cancelled and the room is released without a cap notice', async () => {
  const gate = gated(['gh']);
  const h = harness({ script: gate.script });
  const { sessionId, roomId } = await room(h, { members: ['gh', 'rel'] });
  const rel = roomMemberSessionId(roomId, 'rel');
  const ends = [];
  await h.rooms.send(sessionId, '/ask GitHub status');
  await until(() => h.prompts.length === 1);
  await h.rooms.ask(sessionId, {
    agentId: 'rel',
    prompt: 'status?',
    from: { sessionId: 'sess_lead_1' },
    id: 'atask_1',
    onSettled: (detail) => ends.push(detail),
  });
  const relayed = await h.rooms.relay(rel, 'REPORT: done', { id: 'awake_1' });
  await h.rooms.forgetMember('gh');
  await h.rooms.forgetMember('rel');
  assert.deepEqual(ends, [{ status: 'cancelled' }]);
  assert.equal(await relayed.settled, 'cancelled');
  gate.release();
  await h.idle(roomId);
  assert.equal(h.rooms.isRunning(roomId), false, 'nothing hangs');
  assert.deepEqual(h.saved.doc.rooms[roomId].members, []);
  assert.deepEqual(ends, [{ status: 'cancelled' }], 'settled once');
  assert.deepEqual(
    h.log.filter((row) => ['speech', 'pass', 'cap'].includes(row.kind)),
    []
  );
  // The empty room still takes a message and ends it with no turn.
  await h.rooms.send(sessionId, 'anyone?');
  await h.idle(roomId);
  assert.deepEqual(
    h.prompts.map((p) => p.agentId),
    ['gh']
  );
});

test('a member removed while its session is being created is left without one', async () => {
  let openCreate = () => {};
  const createGate = new Promise((resolve) => {
    openCreate = resolve;
  });
  let holdCreate = false;
  const h = harness({ createGate: () => (holdCreate ? createGate : undefined) });
  const { sessionId, roomId } = await room(h);
  const rel = roomMemberSessionId(roomId, 'rel');
  const ends = [];
  holdCreate = true;
  await h.rooms.ask(sessionId, {
    agentId: 'rel',
    prompt: 'status?',
    from: { sessionId: 'sess_lead_1' },
    id: 'atask_1',
    onSettled: (detail) => ends.push(detail),
  });
  await until(() => h.createStarted.includes(rel));
  const forgetting = h.rooms.forgetMember('rel');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.deleted, [], 'the removal waits behind the creation it raced');
  openCreate();
  await forgetting;
  await h.idle(roomId);
  assert.deepEqual(h.deleted, [rel], 'the session the creation finished is deleted with the member');
  assert.equal(h.sessions.has(rel), false, 'no conversation of the removed member is left behind');
  assert.deepEqual(ends, [{ status: 'cancelled' }]);
  assert.deepEqual(h.saved.doc.rooms[roomId].members, ['gh', 'bench']);
});

test('a removed bot’s room conversation is deleted and its cursors go; a failed cleanup is surfaced', async () => {
  const h = harness();
  const { sessionId, roomId } = await room(h);
  await h.rooms.send(sessionId, '/ask Bench status');
  await h.idle(roomId);
  const bench = roomMemberSessionId(roomId, 'bench');
  assert.ok(h.saved.doc.rooms[roomId].cursors.bench, 'bench has a cursor before it leaves');
  await h.rooms.forgetMember('bench');
  assert.deepEqual(h.deleted, [bench], 'only the removed bot’s conversation in that room');
  assert.equal(h.saved.doc.rooms[roomId].cursors.bench, undefined);
  assert.equal(h.saved.doc.rooms[roomId].seen?.bench, undefined);

  const stuck = harness({ deleteFails: true });
  const made = await room(stuck);
  await assert.rejects(stuck.rooms.forgetMember('bench'), /could not be deleted/);
  assert.deepEqual(stuck.saved.doc.rooms[made.roomId].members, ['gh', 'rel'], 'the member still left');

  // Rooms that load holding a deleted bot retire its conversation too.
  const loaded = harness({
    doc: { rooms: { r1: { ...STORED } } },
    presence: () => ({ gh: 'present', rel: 'present', bench: 'deleted' }),
  });
  await loaded.rooms.ready();
  assert.deepEqual(loaded.deleted, [roomMemberSessionId('r1', 'bench')]);
});

test('remove surfaces a failed cleanup', async () => {
  const h = harness({ deleteFails: true });
  const { roomId } = await room(h);
  await assert.rejects(h.rooms.remove(roomId), /could not be deleted/);
  assert.equal(h.saved.doc.rooms[roomId], undefined);
});
