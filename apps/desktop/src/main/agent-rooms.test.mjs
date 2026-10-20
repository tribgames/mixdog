import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

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
  { id: 'gh', custom: true, label: 'GitHub', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'rel', custom: true, label: 'Release', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'bench', custom: true, label: 'Bench', route: { provider: 'openai', model: 'gpt-5' } },
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
} = {}) {
  const logs = [];
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
  /** Every input a supervisor step was given. */
  const decisions = [];
  let failures = appendFails;
  const rooms = createAgentRooms({
    store: {
      load: async () => structuredClone(saved.doc),
      save: async (value) => {
        if (saveFails(value)) throw new Error('disk full');
        saved.doc = structuredClone(value);
      },
    },
    listAgents: async () => AGENTS,
    ...(leadName === undefined ? {} : { leadName: async () => leadName }),
    sessionExists: async (id) => sessions.has(id),
    createSession: async (id) => {
      sessions.add(id);
    },
    renameSession: async () => {},
    appendRows: async (id, rows) => {
      touched.add(id);
      if (failures > 0) {
        failures -= 1;
        throw new Error('daemon unavailable');
      }
      for (const row of rows) if (!log.some((entry) => entry.id === row.id)) log.push(row);
      return { added: rows.length, rows: rows.map(storedRow) };
    },
    readItems: async () => [],
    submit: async (id, prompt) => {
      const agentId = id.split('_').at(-1);
      touched.add(id);
      prompts.push({ agentId, prompt });
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
      return {
        busy: false,
        items: [
          { id: 'u', kind: 'user', text: 'p' },
          { id: 'a', kind: 'assistant', text: answer.text || ' ' },
          { id: 'd', kind: 'turndone', at: answer.at, status: 'done', finalAssistantId: 'a' },
        ],
      };
    },
    abort: async () => {},
    approve: async () => true,
    deleteSession: async () => {
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
    republish: () => {},
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
  return { rooms, log, logs, prompts, saved, idle, touched, resets, decisions };
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
    const h = harness({ saveFails: (doc) => Object.values(doc.rooms).some((entry) => entry.running) });
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
  assert.match(gh, /React to what was just said/);
  assert.doesNotMatch(bench, /casual small talk/);
  assert.match(bench, /nobody has answered yet: reply to the user now/);
  assert.match(bench, /Do not repeat another member just to agree/);
});

test('"Continue" after a capped /ask gives the remaining named members their turns first', async () => {
  const h = harness();
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
  assert.equal(h.prompts.length, 4, 'once owed turns are paid, Continue is a whole-room batch again');
});

test('a new message drops turns a capped /ask still owed', async () => {
  const h = harness({
    decide: (input) => (input.mustPick ? { action: 'speak', agentId: 'bench' } : { action: 'finish' }),
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

test('remove surfaces a failed cleanup', async () => {
  const h = harness({ deleteFails: true });
  const { roomId } = await room(h);
  await assert.rejects(h.rooms.remove(roomId), /could not be deleted/);
  assert.equal(h.saved.doc.rooms[roomId], undefined);
});
