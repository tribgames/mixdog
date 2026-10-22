// Attachments and artifacts between bots and agents (handoff-attachments.mjs):
// forwarding (images and files, by id or path), the files a turn returns, the
// containment and secret-file refusals, and one test per direction —
// bot→agent, agent→bot, bot→bot (home threads and rooms), agent→agent.
import assert from 'node:assert/strict';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-handoff-data-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const {
  collectTurnArtifacts,
  conversationAttachments,
  handoffContent,
  handoffFileChecks,
  resolveHandoffAttachments,
  sessionRoots,
  turnSlice,
} = await import('./handoff-attachments.mjs');
const { readAttachmentBuffer, attachmentRefForBuffer } = await import('../runtime/attachments/store.mjs');
const { artifactLines } = await import('../runtime/shared/handoff-artifacts.mjs');
const { createAgentTaskSessions } = await import('./agent-task-sessions.mjs');
const { createSessionControl } = await import('../standalone/daemon-session-control.mjs');
const { createWorkspaceToolHandlers } = await import('./internal-tool-executor/workspace-tools.mjs');
const { agentTaskMessage, agentTaskWakePrompt, routineResultNotice } = await import(
  '../runtime/agent/orchestrator/session/routine-result.mjs'
);
const { restoreTranscriptItems } = await import('../runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const { createAgentRoomDelivery } = await import('./agent-room-delivery.mjs');
const { roomMemberSessionId, roomSessionId, roomTurnPrompt, roomRowsOfItems, roomRowItem } = await import(
  '../runtime/agent/orchestrator/session/agent-room.mjs'
);
const { agentTurnContent, agentTurnTranscriptMeta, createAgentTurns } = await import(
  '../standalone/session-service/agent-tree/agent-turns.mjs'
);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

function tempDir(t, prefix = 'mixdog-handoff-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Project with an image, a PDF, a note, a secret and a big file. */
function project(t) {
  const root = tempDir(t);
  writeFileSync(join(root, 'shot.png'), PNG);
  writeFileSync(join(root, 'spec.pdf'), PDF);
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), '[remote]\n');
  return root;
}

const uploadMessage = (id, extra = {}) => ({
  role: 'user',
  content: [{ type: 'text', text: 'look at this' }],
  meta: {
    transcript: {
      attachments: [{ id, attachmentRef: id, kind: 'image', name: 'photo.png', mimeType: 'image/png', size: 12 }],
    },
  },
  ...extra,
});

test('a path inside the caller folders forwards an image and a file as stored reference parts', (t) => {
  const root = project(t);
  const { parts, records } = resolveHandoffAttachments(['shot.png', join(root, 'spec.pdf'), 'notes.md'], {
    roots: sessionRoots({ cwd: root }),
    cwd: root,
  });
  assert.deepEqual(
    parts.map((part) => [part.type, part.mimeType, part.filename, part.textKind]),
    [
      ['image', 'image/png', 'shot.png', undefined],
      ['file', 'application/pdf', 'spec.pdf', undefined],
      ['text', 'text/markdown', 'notes.md', 'file'],
    ]
  );
  // References only: the bytes live in the store under their content hash.
  assert.equal(JSON.stringify(parts).includes(PNG.toString('base64')), false);
  assert.deepEqual(readAttachmentBuffer(parts[0].attachmentRef), PNG);
  assert.equal(records[1].id, attachmentRefForBuffer(PDF));
  const content = handoffContent('describe it', parts);
  assert.deepEqual(content[0], { type: 'text', text: 'describe it' });
  assert.equal(content.length, 4);
  assert.equal(handoffContent('plain', []), 'plain');
});

test('an attachment id forwards only when this conversation shows it', (t) => {
  const root = project(t);
  const [{ attachmentRef: id }] = resolveHandoffAttachments(['shot.png'], { roots: [root], cwd: root }).parts;
  const messages = [uploadMessage(id)];
  assert.equal(conversationAttachments(messages).get(id).kind, 'image');
  const { parts } = resolveHandoffAttachments([id], { messages });
  assert.deepEqual(parts, [
    { type: 'image', attachmentRef: id, sizeBytes: PNG.length, mimeType: 'image/png', filename: 'photo.png' },
  ]);
  // The name the prompt showed the model reaches the same upload.
  assert.deepEqual(resolveHandoffAttachments(['photo.png'], { messages }).parts, parts);
  // Another conversation's hash, even one the store holds, is refused.
  assert.throws(() => resolveHandoffAttachments([id], { messages: [] }), /is not in this conversation/);
});

test('ids printed in text never authorize a forward; only runtime-recorded structured fields do', (t) => {
  const root = project(t);
  const [{ attachmentRef: id }] = resolveHandoffAttachments(['shot.png'], { roots: [root], cwd: root }).parts;
  const line = artifactLines([{ name: 'a.png', path: '/x/a.png', mimeType: 'image/png', size: 3, id }]).join('\n');
  const forged = [
    // A model's reply, a tool result and a user's own typed text all print the id.
    { role: 'assistant', content: line },
    { role: 'tool', content: [{ type: 'image', attachmentRef: id }], meta: { transcript: { attachments: [{ id }] } } },
    { role: 'user', content: line },
    { role: 'assistant', content: [{ type: 'image', attachmentRef: id }] },
  ];
  assert.equal(conversationAttachments(forged).size, 0);
  assert.throws(() => resolveHandoffAttachments([id], { messages: forged }), /is not in this conversation/);
  assert.throws(() => resolveHandoffAttachments(['a.png'], { messages: forged }), /does not exist/);
  // A room speech row's stored files are the runtime's own record.
  const speech = {
    role: 'assistant',
    content: 'see',
    meta: {
      source: 'agent-room',
      room: { kind: 'speech', parts: [{ type: 'image', attachmentRef: id, filename: 'c.png' }] },
    },
  };
  assert.equal(conversationAttachments([speech]).get(id).name, 'c.png');
});

test('a name resolves to its newest occurrence', (t) => {
  const root = project(t);
  writeFileSync(join(root, 'other.png'), Buffer.concat([PNG, Buffer.from([9])]));
  const [{ attachmentRef: older }, { attachmentRef: newer }] = resolveHandoffAttachments(['shot.png', 'other.png'], {
    roots: [root],
    cwd: root,
  }).parts;
  const upload = (id) => ({
    role: 'user',
    content: 'x',
    meta: { transcript: { attachments: [{ id, kind: 'image', name: 'photo.png', mimeType: 'image/png', size: 1 }] } },
  });
  const pick = (messages) => resolveHandoffAttachments(['photo.png'], { messages }).parts[0].attachmentRef;
  assert.equal(pick([upload(older), upload(newer)]), newer);
  // The older upload sent again is now the newest occurrence.
  assert.equal(pick([upload(older), upload(newer), upload(older)]), older);
});

test('files are read once through a validated handle, never past the size cap', (t) => {
  const root = project(t);
  const { samePathAndHandle, readCapped } = handoffFileChecks;
  const file = join(root, 'swap.txt');
  writeFileSync(file, 'original');
  const fd = openSync(file, 'r');
  t.after(() => closeSync(fd));
  const opened = fstatSync(fd, { bigint: true });
  assert.equal(samePathAndHandle(file, opened), true);
  // Swapped after the open (the path now names another file than the handle;
  // Windows refuses a rename over an open file, so the swap is a second path).
  writeFileSync(join(root, 'other.txt'), 'original');
  assert.equal(samePathAndHandle(join(root, 'other.txt'), opened), false);
  // A link on the way to the file never passes, even to the same file.
  try {
    symlinkSync(root, join(root, 'via'), 'junction');
    assert.equal(samePathAndHandle(join(root, 'via', 'swap.txt'), opened), false);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
  }
  // The cap: at most cap + 1 bytes are read; an over-cap file yields nothing.
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(100));
  const big = openSync(join(root, 'big.txt'), 'r');
  t.after(() => closeSync(big));
  assert.equal(readCapped(big, 99), null);
  assert.equal(readCapped(big, 100).length, 100);
  // A text file over its kind's limit is refused; as an artifact it stays a path.
  writeFileSync(join(root, 'huge.md'), 'y'.repeat(750_001));
  const options = { roots: [root], cwd: root };
  assert.throws(() => resolveHandoffAttachments(['huge.md'], options), /larger than the attachment limit/);
  const { files } = collectTurnArtifacts([{ role: 'assistant', content: 'see `huge.md`' }], options);
  assert.deepEqual(
    files.map((entry) => [entry.name, entry.size, 'id' in entry]),
    [['huge.md', 750_001, false]]
  );
  // Re-checked after the read: a file replaced while it was read is refused.
  writeFileSync(join(root, 'race.md'), 'one');
  const swap = (path) => {
    unlinkSync(path);
    writeFileSync(path, 'two');
  };
  assert.throws(
    () => handoffFileChecks.readContained('race.md', { ...options, surface: 'session', afterRead: swap }),
    /changed while it was read/
  );
  assert.equal(handoffFileChecks.readContained('race.md', { ...options, surface: 'session' }).bytes.toString(), 'two');
});

test('containment: paths outside the folders, traversal, links out and secret files are refused', (t) => {
  const root = project(t);
  const outside = tempDir(t, 'mixdog-handoff-outside-');
  writeFileSync(join(outside, 'other.png'), PNG);
  const options = { roots: sessionRoots({ cwd: root }), cwd: root, surface: 'session' };
  assert.throws(
    () => resolveHandoffAttachments([join(outside, 'other.png')], options),
    /outside this session's folders/
  );
  assert.throws(() => resolveHandoffAttachments([`../${outside.split(/[\\/]/).pop()}/other.png`], options), /outside/);
  assert.throws(() => resolveHandoffAttachments(['.env'], options), /credentials or secrets/);
  assert.throws(() => resolveHandoffAttachments(['.git/config'], options), /credentials or secrets/);
  assert.throws(() => resolveHandoffAttachments(['missing.png'], options), /does not exist/);
  assert.throws(() => resolveHandoffAttachments(['a'.repeat(64)], options), /not in this conversation/);
  assert.throws(() => resolveHandoffAttachments('shot.png', options), /must be a list/);
  assert.throws(
    () =>
      resolveHandoffAttachments(
        Array.from({ length: 9 }, (_, index) => `f${index}.png`),
        options
      ),
    /at most 8/
  );
  writeFileSync(join(root, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0, 1]));
  assert.throws(() => resolveHandoffAttachments(['tool.exe'], options), /not an image, PDF, Office or text file/);
  // A link inside the Project that leads out of it is judged where it leads.
  try {
    symlinkSync(join(outside, 'other.png'), join(root, 'link.png'));
  } catch {
    return; // no symlink rights on this host
  }
  assert.throws(() => resolveHandoffAttachments(['link.png'], options), /outside this session's folders/);
});

test("a turn's produced files come back: reply links, media/office/visualize outputs and edits, inside the roots only", (t) => {
  const root = project(t);
  const outside = tempDir(t, 'mixdog-handoff-outside-');
  writeFileSync(join(outside, 'leak.txt'), 'x');
  writeFileSync(join(root, 'mock.html'), '<p>hi</p>');
  writeFileSync(join(root, 'deck.pptx'), Buffer.from('PK\u0003\u0004'));
  writeFileSync(join(root, 'clip.mp4'), Buffer.alloc(16));
  writeFileSync(join(root, 'app.mjs'), 'export {};\n');
  const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const messages = [
    { role: 'user', content: 'older turn', meta: { transcript: { checkpointId: 'run_0' } } },
    { role: 'assistant', content: 'old', tool_calls: [call('edit', { file_path: 'notes.md' })] },
    { role: 'user', content: 'make things', meta: { transcript: { checkpointId: 'run_1' } } },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        call('media', { action: 'generate', kind: 'image', prompt: 'x', path: 'shot.png' }),
        call('media', { action: 'generate', kind: 'video', prompt: 'x', path: 'clip.mp4' }),
        call('office', { action: 'author', path: 'deck.pptx' }),
        call('office', { action: 'snapshot', path: 'spec.pdf' }),
        call('visualize', { action: 'open', input: { targets: ['mock.html', 'https://example.com'] } }),
        call('edit', { file_path: 'app.mjs' }),
        call('apply_patch', {
          patch: '*** Begin Patch\n*** Update File: .env\n*** Add File: ../leak.txt\n*** End Patch',
        }),
      ],
    },
    { role: 'tool', content: 'ok' },
    { role: 'assistant', content: `Done: [the spec](spec.pdf), \`notes.md\` and ${join(outside, 'leak.txt')}` },
  ];
  const turn = turnSlice(messages, { runId: 'run_1' });
  assert.equal(turn.length, 4);
  const { files, omitted } = collectTurnArtifacts(turn, { cwd: root, roots: sessionRoots({ cwd: root }) });
  assert.equal(omitted, 0);
  assert.deepEqual(
    files.map((file) => [file.name, Boolean(file.id)]),
    [
      ['spec.pdf', true],
      ['notes.md', true],
      ['shot.png', true],
      ['clip.mp4', false],
      ['deck.pptx', true],
      ['mock.html', true],
      ['app.mjs', true],
    ]
  );
  assert.ok(
    files.every((file) => file.path.startsWith(root)),
    'nothing outside the roots, no secret'
  );
  const lines = artifactLines(files).join('\n');
  assert.match(lines, /- clip\.mp4 \(application\/octet-stream, 16 B\) — .*clip\.mp4 \(too large or unsupported/);
  assert.match(
    lines,
    new RegExp(`- shot\\.png \\(image/png, 12 B\\) — .*\\[attachment:${attachmentRefForBuffer(PNG)}\\]`)
  );
});

/** A session service over one fake runtime whose messages a turn fills. */
function fakeService(turnMessages = []) {
  const calls = [];
  const runtime = {
    getState: () => ({}),
    subscribe: () => () => {},
    readModelMessages: async () => ({ messages: turnMessages }),
  };
  return {
    calls,
    runtime,
    service: {
      createSession: async (params) => {
        calls.push(['create', params]);
        return { sessionId: 'sess_task_1' };
      },
      configureSession: async () => ({ value: {} }),
      materializeSession: async () => runtime,
      submitSession: async (params) => {
        calls.push(['submit', params]);
        return { accepted: true };
      },
    },
  };
}

function taskApi(h, stored = new Map()) {
  const delivered = [];
  const api = createAgentTaskSessions({
    getSessionService: () => h.service,
    deliver: async (agentId, report) => delivered.push([agentId, report]),
    watches: { add: async () => {}, list: async () => [], remove: async () => {} },
    queuedSubmissionIds: async () => [],
    loadSession: async (id) => stored.get(id) || null,
    listProjects: async () => [],
    newTaskDefault: async () => 'branch',
    modelRoute: async (ref) => ({ provider: 'test', model: ref }),
    leadRoute: async () => ({ provider: 'p', model: 'm' }),
    lastUsedRoute: async () => null,
    // A task turn's end is its final answer at once here (no agent work, no quiet period).
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  return { api, delivered };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('bot → agent: Mixy hands the user’s image to a new agent task session as a real attachment', async (t) => {
  const root = project(t);
  const [{ attachmentRef: id }] = resolveHandoffAttachments(['shot.png'], { roots: [root], cwd: root }).parts;
  const home = {
    id: 'sess_home_mixy',
    owner: 'cli',
    agent: 'mixy',
    sourceType: 'lead',
    cwd: root,
    messages: [uploadMessage(id)],
  };
  const h = fakeService();
  const { api } = taskApi(h);
  const control = createSessionControl({ getSessionService: () => h.service, agentTasks: api });
  const { session } = createWorkspaceToolHandlers({
    rt: { session: home, config: {} },
    executeSessionControl: control,
  });
  const call = (args) => session(args, { callerCtx: { callerSessionId: home.id }, callerCwd: root });
  await call({ action: 'create', brief: 'Describe the attached image', attachments: [id, 'spec.pdf'] });
  const [submit] = h.calls.filter(([name]) => name === 'submit').map(([, params]) => params);
  assert.ok(Array.isArray(submit.prompt));
  assert.deepEqual(
    submit.prompt.map((part) => [part.type, part.filename || part.text]),
    [
      ['text', 'Describe the attached image'],
      ['image', 'photo.png'],
      ['file', 'spec.pdf'],
    ]
  );
  assert.equal(submit.prompt[1].attachmentRef, id);
  // Refusals reach the bot as errors; nothing is submitted.
  await assert.rejects(call({ action: 'create', brief: 'x', attachments: ['.env'] }), /credentials or secrets/);
  await assert.rejects(call({ action: 'list', attachments: ['shot.png'] }), /apply to send and create/);
  assert.equal(h.calls.filter(([name]) => name === 'submit').length, 1);
});

test('agent → bot: a task turn’s files come back on its report as attachments the bot shows and forwards', async (t) => {
  const root = project(t);
  const turn = [
    { role: 'user', content: 'go', meta: { transcript: { checkpointId: 'RUN' } } },
    { role: 'assistant', content: 'Made [the image](shot.png) and the spec `spec.pdf`.' },
  ];
  const h = fakeService(turn);
  const stored = new Map([['sess_task_1', { id: 'sess_task_1', cwd: root, messages: turn }]]);
  const { api, delivered } = taskApi(h, stored);
  await api.create({ brief: 'make it' }, { callerSessionId: 'sess_home_mixy', callerAgentId: 'mixy', callerCwd: root });
  const [submit] = h.calls.filter(([name]) => name === 'submit').map(([, params]) => params);
  turn[0].meta.transcript.checkpointId = submit.options.id;
  submit.options.onSettled({ status: 'done', result: { content: 'Made the image.' } });
  for (let i = 0; i < 5; i += 1) await settle();
  const [, report] = delivered.find(([, entry]) => entry.status === 'completed');
  assert.deepEqual(
    report.files.map((file) => [file.name, Boolean(file.id)]),
    [
      ['shot.png', true],
      ['spec.pdf', true],
    ]
  );
  // The home row: stored files as message attachments, listed for the agent.
  const message = agentTaskMessage({ ...report, messageId: 'routine_x' });
  assert.equal(message.meta.transcript.attachments.length, 2);
  assert.match(message.content, /\[attachment:[a-f0-9]{64}\]/);
  // The chat's result card shows no files: the bot is told to name them itself.
  const wake = agentTaskWakePrompt([message]);
  assert.match(wake, /Its files are not shown in this chat: the user sees only the result card/);
  assert.match(wake, /Name the files that matter by path yourself/);
  assert.doesNotMatch(wake, /already shown to the user/);
  // A report without files says nothing about them.
  assert.doesNotMatch(agentTaskWakePrompt([agentTaskMessage({ ...report, files: [], messageId: 'routine_z' })]), /files/i);
  const notice = routineResultNotice(message);
  assert.equal(notice.attachments.length, 2);
  const [restored] = restoreTranscriptItems([message], { sessionId: 'sess_home_mixy' });
  assert.deepEqual(restored.attachments, notice.attachments);
  // The bot forwards a returned file by its id from that row.
  const { parts } = resolveHandoffAttachments([report.files[0].id], { messages: [message] });
  assert.equal(parts[0].type, 'image');
});

test('recipient rule: files come back only from the bot’s own task sessions and room threads; any other send reports text only', async (t) => {
  const root = project(t);
  const turn = [
    { role: 'user', content: 'go', meta: { transcript: { checkpointId: 'RUN' } } },
    { role: 'assistant', content: 'Made [the image](shot.png).' },
  ];
  const ownTask = 'sess_task_own';
  const coding = 'sess_coding_other';
  const member = roomMemberSessionId('room01', 'mixy');
  const stored = new Map([
    [
      ownTask,
      {
        id: ownTask,
        cwd: root,
        messages: turn,
        taskOrigin: { agentId: 'mixy', sessionId: 'sess_home_mixy', title: 'own' },
      },
    ],
    [coding, { id: coding, cwd: root, title: 'coding', messages: turn }],
    [member, { id: member, cwd: root, messages: turn }],
  ]);
  const h = fakeService(turn);
  const { api, delivered } = taskApi(h, stored);
  const reportOf = async (sessionId) => {
    const origin = await api.reportOrigin(sessionId, 'mixy', 'sess_home_mixy');
    await api.send(sessionId, 'make it', origin);
    const submit = h.calls.filter(([name]) => name === 'submit').at(-1)[1];
    turn[0].meta.transcript.checkpointId = submit.options.id;
    submit.options.onSettled({ status: 'done', result: { content: 'Made it.' } });
    for (let i = 0; i < 5; i += 1) await settle();
    return delivered.findLast(([, entry]) => entry.taskSessionId === sessionId)[1];
  };
  const unrelated = await reportOf(coding);
  assert.equal(unrelated.text, 'Made it.');
  assert.equal('files' in unrelated, false, 'an unrelated session returns no files');
  const message = agentTaskMessage({ ...unrelated, messageId: 'routine_y' });
  assert.equal(message.meta.transcript.attachments, undefined);
  assert.doesNotMatch(message.content, /Files from this turn|\[attachment:/);
  assert.equal((await reportOf(ownTask)).files[0].name, 'shot.png', 'its own task session returns files');
  assert.equal((await reportOf(member)).files[0].name, 'shot.png', 'its own room thread returns files');
  // Another bot's room thread is not its own.
  assert.equal(
    (await api.reportOrigin(roomMemberSessionId('room01', 'bench'), 'mixy', 'sess_home_mixy')).textOnly,
    true
  );
});

test('bot → bot: a send to another bot’s home carries the files; room speech returns its turn’s files to the members', async (t) => {
  const root = project(t);
  // Home threads: Mixy forwards a file to another bot's home; its turn reports back.
  const h = fakeService();
  const { api } = taskApi(h);
  const control = createSessionControl({ getSessionService: () => h.service, agentTasks: api });
  const home = { id: 'sess_home_mixy', owner: 'cli', agent: 'mixy', sourceType: 'lead', cwd: root, messages: [] };
  const { session } = createWorkspaceToolHandlers({
    rt: { session: home, config: {} },
    executeSessionControl: control,
  });
  const sent = JSON.parse(
    await session(
      { action: 'send', session_id: 'sess_home_reviewer', prompt: 'review this', attachments: ['notes.md'] },
      { callerCtx: { callerSessionId: home.id }, callerCwd: root }
    )
  );
  assert.equal(sent.reportsBack, true);
  const [submit] = h.calls.filter(([name]) => name === 'submit').map(([, params]) => params);
  assert.deepEqual(submit.prompt.at(-1).filename, 'notes.md');

  // Rooms: a member's speech takes in the files its own turn produced.
  const roomId = 'room01';
  const memberSession = roomMemberSessionId(roomId, 'bench');
  const sessions = new Map([
    [roomSessionId(roomId), { id: roomSessionId(roomId), messages: [] }],
    [
      memberSession,
      {
        id: memberSession,
        cwd: root,
        messages: [
          { role: 'user', content: 'turn', meta: { transcript: { at: 1000 } } },
          { role: 'assistant', content: 'Here is [the chart](shot.png).' },
        ],
      },
    ],
  ]);
  const delivery = createAgentRoomDelivery({
    loadSession: (id) => sessions.get(id),
    saveSession: async () => {},
    live: () => null,
  });
  const speech = (sessionId) => ({
    id: `s_${sessionId.length}`,
    kind: 'speech',
    speaker: 'bench',
    name: 'Bench',
    text: 'see the chart',
    artifactsFrom: { sessionId, since: 1000 },
  });
  const { rows } = await delivery.append(roomSessionId(roomId), [speech(memberSession)]);
  assert.equal(rows[0].parts[0].type, 'image');
  assert.equal(rows[0].attachments[0].name, 'shot.png');
  assert.equal('artifactsFrom' in rows[0], false);
  const [stored] = sessions.get(roomSessionId(roomId)).messages;
  const prompt = roomTurnPrompt({
    roomName: 'R',
    self: { id: 'gh', name: 'GH' },
    members: [
      { id: 'gh', name: 'GH' },
      { id: 'bench', name: 'Bench' },
    ],
    rows: roomRowsOfItems([roomRowItem(stored, 'x')]),
  });
  assert.equal(prompt.find((part) => part.type === 'image').attachmentRef, rows[0].parts[0].attachmentRef);
  // Another session (not this member's in this room) never lends its files.
  const { rows: forged } = await delivery.append(roomSessionId(roomId), [
    { ...speech(roomMemberSessionId('room02', 'bench')), id: 's_forged' },
  ]);
  assert.equal('parts' in forged[0], false);
});

test('agent → agent: the Lead’s attachments reach a sub-agent turn and its produced files return with the handoff', async (t) => {
  const root = project(t);
  // The agent tool receives resolved parts only, never the model's own.
  const seen = [];
  const lead = { id: 'sess_lead', owner: 'cli', agent: 'lead', sourceType: 'lead', cwd: root, messages: [] };
  const { agent } = createWorkspaceToolHandlers({
    rt: { session: lead, config: {} },
    agentTool: { execute: async (args) => seen.push(args) },
    notifyFnForSession: () => null,
  });
  await agent(
    {
      type: 'spawn',
      agent: 'worker',
      prompt: 'look',
      attachments: ['shot.png'],
      attachmentParts: [{ type: 'image', data: 'AAAA' }],
    },
    { callerCtx: { callerSessionId: lead.id }, callerCwd: root }
  );
  assert.equal(seen[0].attachments, undefined);
  assert.deepEqual(
    seen[0].attachmentParts.map((part) => [part.type, part.filename]),
    [['image', 'shot.png']]
  );
  await assert.rejects(
    agent(
      { type: 'spawn', agent: 'worker', prompt: 'x', attachments: ['.git/config'] },
      { callerCtx: { callerSessionId: lead.id }, callerCwd: root }
    ),
    /credentials or secrets/
  );
  // A follow-up to a busy worker keeps its files on both queue paths.
  const { createSendFlow } = await import('./services/agent-tool/send-flow.mjs');
  const queued = [];
  const worker = { id: 'sess_worker', cwd: root, agent: 'worker' };
  const sendFlowFor = (canonical) =>
    createSendFlow({
      mgr: { getSession: () => worker, enqueuePendingMessage: (_id, message) => queued.push(['pending', message]) },
      defaultCwd: root,
      sessionSurface: { enqueueTurn: async ({ prompt }) => queued.push(['surface', prompt]) && { queueDepth: 1 } },
      canUseSessionSurface: () => canonical,
      registry: { tagForSession: () => 'w1' },
      views: { isSessionBusy: () => true },
      spawnFlow: {},
    });
  for (const canonical of [false, true]) {
    await sendFlowFor(canonical).dispatchToExistingSession(
      { args: { attachmentParts: seen[0].attachmentParts }, session: worker, sessionId: worker.id, prompt: 'and this' },
      null
    );
  }
  assert.deepEqual(
    queued.map(([path, message]) => [path, message.map((part) => part.type), message[1].filename]),
    [
      ['pending', ['text', 'image'], 'shot.png'],
      ['surface', ['text', 'image'], 'shot.png'],
    ]
  );

  // An agent task session sends its own produced file to another session.
  const h = fakeService();
  const control = createSessionControl({ getSessionService: () => h.service, agentTasks: taskApi(h).api });
  const task = { ...lead, id: 'sess_task_9', taskOrigin: { agentId: 'mixy', sessionId: 'sess_home_mixy' } };
  const { session } = createWorkspaceToolHandlers({
    rt: { session: task, config: {} },
    executeSessionControl: control,
  });
  const sent = JSON.parse(
    await session(
      { action: 'send', session_id: 'sess_other', prompt: 'use this', attachments: ['spec.pdf'] },
      { callerCtx: { callerSessionId: task.id }, callerCwd: root }
    )
  );
  assert.equal(sent.reportsBack, false);
  const [forwarded] = h.calls.filter(([name]) => name === 'submit').map(([, params]) => params);
  assert.deepEqual(
    forwarded.prompt.map((part) => part.type),
    ['text', 'file']
  );

  const content = agentTurnContent(handoffContent('look', seen[0].attachmentParts));
  assert.equal(agentTurnTranscriptMeta(content).attachments[0].name, 'shot.png');

  // The worker turn: its prompt arrives as content parts, its files come back.
  const submitted = [];
  const messages = [];
  const runtime = {
    readModelMessages: async (start = 0) => ({ messageCount: messages.length, messages: messages.slice(start) }),
    submitAndWait: async (prompt, options) => {
      submitted.push([prompt, options]);
      messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: 'Wrote `notes.md`.' });
      return { status: 'done', result: { content: 'Wrote notes.' } };
    },
  };
  const descriptor = { id: 'sess_worker', cwd: root };
  const { runAgentTurn } = createAgentTurns({
    registry: { assertAdmission: () => 0, get: () => descriptor },
    rehydrateAgentSessions: async () => {},
    entryForSession: async () => ({ runtime }),
    retainUnwatched: () => {},
    createSession: async () => {},
    takeWatchdogStop: () => null,
    takeCancelTranscript: () => null,
  });
  const result = await runAgentTurn({ session: descriptor, prompt: content });
  assert.deepEqual(
    submitted[0][0].map((part) => part.type),
    ['text', 'image']
  );
  assert.equal(submitted[0][1].transcriptMeta.sender, 'lead');
  assert.match(
    result.content,
    /^Wrote notes\.\n\nFiles from this turn \(forward one with attachments: \[path\][\s\S]*- notes\.md \(text\/markdown, 8 B\) — .*notes\.md \(attachable: forward it by path\)/
  );
  // The text handoff names no id the Lead could forward.
  assert.doesNotMatch(result.content, /\[attachment:/);
});
