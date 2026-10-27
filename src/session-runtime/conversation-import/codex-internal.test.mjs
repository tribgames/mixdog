// Synthetic fixtures mirroring the markers Codex writes: `session_meta` source /
// thread_source for internal threads, and the thread titles it stores in
// session_index.jsonl and state_<N>.sqlite. No real user content.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-conversation-internal-')));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createConversationImportApi, resetConversationImportJobs } = await import('./service.mjs');
const { candidateId, resetConversationDiscovery } = await import('./discovery.mjs');
const { listStoredSessionSummaries, loadSession } = await import('../../runtime/agent/orchestrator/session/store.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const providerName = 'conversation-import-internal-test';
const provider = {
  name: providerName,
  contextWindow: 128000,
  async send() {
    throw new Error('no turn runs during import');
  },
};
const leadOptions = {
  provider: providerName,
  model: 'fake-model',
  owner: 'cli',
  agent: 'lead',
  lane: 'cli',
  sourceType: 'lead',
  sourceName: 'main',
  skipSkills: true,
  schemaAllowedTools: modelToolSchemaAllowlist('headless'),
  workflow: { id: 'headless', delegatesAgents: false },
};

let fixtureSeq = 0;
function fixtureHome() {
  const home = join(root, `case-${++fixtureSeq}`);
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  return {
    home,
    project: realpathSync.native(project),
    env: { CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') },
  };
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const message = (role, text) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  },
});

function rollout({ id, cwd, meta = {}, user = 'A question', envelopeFirst = false, withMessages = true }) {
  const records = [
    { type: 'session_meta', payload: { id, cwd, originator: 'Codex Desktop', source: 'vscode', ...meta } },
  ];
  if (!withMessages) return jsonl(records);
  if (envelopeFirst) {
    records.push(message('user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'));
  }
  records.push(message('user', user), message('assistant', 'An answer'));
  return jsonl(records);
}

let day = 0;
function writeCodex(fixture, name, body) {
  const dir = join(fixture.env.CODEX_HOME, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-01T00-00-00-${name}.jsonl`);
  writeFileSync(path, body);
  const stamp = 1_700_000_000 + ++day * 10;
  utimesSync(path, stamp, stamp);
  return path;
}

function writeStateDb(fixture, version, rows) {
  mkdirSync(fixture.env.CODEX_HOME, { recursive: true });
  const db = new DatabaseSync(join(fixture.env.CODEX_HOME, `state_${version}.sqlite`));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT)');
  const insert = db.prepare('INSERT INTO threads (id, title, name) VALUES (?, ?, ?)');
  for (const [id, title, name] of rows) insert.run(id, title, name ?? null);
  db.close();
}

function writeSessionIndex(fixture, entries) {
  mkdirSync(fixture.env.CODEX_HOME, { recursive: true });
  writeFileSync(
    join(fixture.env.CODEX_HOME, 'session_index.jsonl'),
    jsonl(entries.map(([id, thread_name]) => ({ id, thread_name, updated_at: '2026-01-01T00:00:00Z' })))
  );
}

function freshApi(env) {
  resetConversationDiscovery();
  resetConversationImportJobs();
  return createConversationImportApi({
    env,
    listSessionSummaries: async () => listStoredSessionSummaries(),
    prepareLeadOptions: async () => leadOptions,
    ingestSession: () => {},
  });
}

async function listUntilComplete(api, params) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = await api.listImportableConversations(params);
    if (page.complete) return page;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('discovery never completed');
}

async function waitForJob(api, jobId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [job] = api.getConversationImportJobs({ jobId }).jobs;
    if (job && !['running', 'stopping'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('import job never finished');
}

// A project's Codex history as the reporter saw it: user threads among guardian
// review and subagent threads, plus one thread that never got a message.
function internalMix(tag) {
  const fixture = fixtureHome();
  const cwd = fixture.project;
  const files = {
    user: writeCodex(fixture, `user${tag}`, rollout({ id: `u-user${tag}`, cwd, meta: { thread_source: 'user' } })),
    renamed: writeCodex(
      fixture,
      `renamed${tag}`,
      rollout({ id: `u-renamed${tag}`, cwd, user: 'derived words', meta: { thread_source: 'user' } })
    ),
    opened: writeCodex(
      fixture,
      `opened${tag}`,
      rollout({ id: `u-opened${tag}`, cwd, user: 'first typed words', envelopeFirst: true })
    ),
    guardian: writeCodex(
      fixture,
      `guardian${tag}`,
      rollout({
        id: `u-guardian${tag}`,
        cwd,
        user: 'The following is the Codex agent history whose request action you are assessing.',
        meta: { source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' },
      })
    ),
    spawned: writeCodex(
      fixture,
      `spawned${tag}`,
      rollout({
        id: `u-spawned${tag}`,
        cwd,
        meta: {
          source: { subagent: { thread_spawn: { parent_thread_id: `u-user${tag}`, depth: 1 } } },
          thread_source: 'subagent',
        },
      })
    ),
    empty: writeCodex(fixture, `empty${tag}`, rollout({ id: `u-empty${tag}`, cwd, withMessages: false })),
  };
  return { fixture, files, tag };
}

test('Codex listing leaves out guardian review and subagent records and counts only real conversations', async () => {
  const { fixture } = internalMix('-list');
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'codex' });
  assert.deepEqual(
    page.rows.map((row) => row.title).sort(),
    ['A question', 'derived words', 'first typed words'].sort()
  );
  assert.equal(page.matchedCount, 3);
  assert.equal(page.selectableCount, 3);
  assert.deepEqual(page.projects, [{ cwd: fixture.project, count: 3 }]);
  const filtered = await api.listImportableConversations({ source: 'codex', project: fixture.project });
  assert.equal(filtered.matchedCount, 3);
  const queried = await api.listImportableConversations({ source: 'codex', query: 'agent history' });
  assert.equal(queried.matchedCount, 0);
});

test('Codex titles: the stored thread title wins over the one derived from messages', async () => {
  const { fixture, tag } = internalMix('-titles');
  writeStateDb(fixture, 4, [[`u-renamed${tag}`, 'Stale schema title']]);
  writeStateDb(fixture, 5, [
    [`u-renamed${tag}`, 'Db auto title', 'Db renamed title'],
    [`u-opened${tag}`, 'ㅇㅇㅇㅇㅇㅇ\nsecond line is ignored'],
  ]);
  writeSessionIndex(fixture, [
    [`u-user${tag}`, 'Old index name'],
    [`u-renamed${tag}`, 'Index name'],
    [`u-user${tag}`, '  Latest   index name  '],
    [`u-renamed${tag}`, ''],
  ]);
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'codex' });
  assert.deepEqual(
    page.rows.map((row) => row.title).sort(),
    ['Latest index name', 'Index name', 'ㅇㅇㅇㅇㅇㅇ'].sort()
  );
  const queried = await api.listImportableConversations({ source: 'codex', query: 'ㅇㅇㅇ' });
  assert.equal(queried.matchedCount, 1);
});

test('Codex titles: without a stored title the derived one is kept, and an unreadable store is ignored', async () => {
  const { fixture } = internalMix('-fallback');
  mkdirSync(fixture.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(fixture.env.CODEX_HOME, 'state_5.sqlite'), 'not a database');
  writeFileSync(join(fixture.env.CODEX_HOME, 'session_index.jsonl'), '{broken\n');
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'codex' });
  assert.deepEqual(
    page.rows.map((row) => row.title).sort(),
    ['A question', 'derived words', 'first typed words'].sort()
  );
});

test('import: select-all skips internal records, the chat takes Codex’s title, each failure names its record', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture, files, tag } = internalMix('-import');
    writeSessionIndex(fixture, [[`u-renamed${tag}`, 'Name Codex shows']]);
    const api = freshApi(fixture.env);
    const page = await listUntilComplete(api, { source: 'codex' });
    const started = await api.startConversationImport({
      requestId: `all${tag}`,
      selection: { viewId: page.viewId, excludeIds: [] },
    });
    const job = await waitForJob(api, started.jobId);
    assert.deepEqual(
      [job.total, job.imported, job.failed],
      [3, 3, 0],
      'guardian, subagent and empty records are not part of the batch'
    );
    // Records picked by id still fail, each naming itself and its reason.
    const byId = (path) => candidateId('codex', realpathSync.native(path));
    const failedJob = await waitForJob(
      api,
      (
        await api.startConversationImport({
          requestId: `ids${tag}`,
          selection: { ids: [byId(files.empty), byId(files.guardian)] },
        })
      ).jobId
    );
    assert.deepEqual(
      failedJob.results.map((result) => [result.status, result.errorCode, result.title, result.sourceName]),
      [
        ['failed', 'empty', null, basename(files.empty)],
        [
          'failed',
          'internalRecord',
          'The following is the Codex agent history whose request action you are assessing.',
          basename(files.guardian),
        ],
      ]
    );
    const imported = job.results.filter((result) => result.status === 'imported');
    const titles = imported.map((result) => loadSession(result.sessionId).title).sort();
    assert.deepEqual(titles, ['A question', 'Name Codex shows', 'first typed words'].sort());
    assert.deepEqual(imported.map((result) => result.title).sort(), titles);
    for (const result of imported) {
      assert.equal(loadSession(result.sessionId).messages.filter((entry) => entry.meta?.source === 'import').length, 2);
    }
  });
});

test('import: an internal record picked by id or by file fails as internalRecord and names itself', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture, files, tag } = internalMix('-picked');
    const api = freshApi(fixture.env);
    // The listing never offers them, so the ids come from a picked file.
    await assert.rejects(
      api.registerConversationImportFile({ source: 'codex', path: files.guardian }),
      /internalRecord/
    );
    await assert.rejects(
      api.registerConversationImportFile({ source: 'codex', path: files.spawned }),
      /internalRecord/
    );
    const row = (await api.registerConversationImportFile({ source: 'codex', path: files.user })).row;
    assert.equal(row.title, 'A question');
    const job = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: `picked${tag}`, selection: { ids: [row.id] } })).jobId
    );
    assert.equal(job.results[0].status, 'imported');
  });
});

test('Claude Code discovery leaves out sidechain-only subagent transcripts', async () => {
  const fixture = fixtureHome();
  const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--demo');
  mkdirSync(dir, { recursive: true });
  const entry = (uuid, parentUuid, type, content, extra = {}) => ({
    uuid,
    parentUuid,
    type,
    isSidechain: false,
    sessionId: 'claude-main',
    cwd: fixture.project,
    message: { role: type, content },
    ...extra,
  });
  writeFileSync(
    join(dir, 'claude-main.jsonl'),
    jsonl([entry('u1', null, 'user', 'Main question'), entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Ok' }])])
  );
  const side = { isSidechain: true, agentId: 'agent-1' };
  writeFileSync(
    join(dir, 'agent-agent-1.jsonl'),
    jsonl([
      entry('s1', null, 'user', 'Warmup', side),
      entry('s2', 's1', 'assistant', [{ type: 'text', text: 'Ready' }], side),
    ])
  );
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'claude' });
  assert.deepEqual(
    page.rows.map((row) => row.title),
    ['Main question']
  );
  assert.equal(page.selectableCount, 1);
});

test('the first page returns before every record is classified, and counts cover only classified records', async () => {
  const fixture = fixtureHome();
  const cwd = fixture.project;
  // Conversations are the oldest files; 60 newer guardian records sit in front of them.
  for (let n = 0; n < 2; n++) writeCodex(fixture, `chat-${n}`, rollout({ id: `u-chat-${n}`, cwd, user: `Chat ${n}` }));
  for (let n = 0; n < 60; n++) {
    writeCodex(
      fixture,
      `guardian-${n}`,
      rollout({ id: `u-guardian-${n}`, cwd, meta: { source: { subagent: { other: 'guardian' } } } })
    );
  }
  const api = freshApi(fixture.env);
  const first = await api.listImportableConversations({ source: 'codex', limit: 1 });
  // Only the awaited first page (and a few queued reads) is classified: the conversations are not yet.
  assert.equal(first.complete, false);
  assert.deepEqual([first.matchedCount, first.selectableCount, first.rows.length], [0, 0, 0]);
  assert.deepEqual(first.projects, []);
  const done = await listUntilComplete(api, { source: 'codex', limit: 1 });
  assert.deepEqual([done.matchedCount, done.selectableCount], [2, 2]);
  assert.deepEqual(done.projects, [{ cwd, count: 2 }]);
  const next = await api.listImportableConversations({ source: 'codex', limit: 1, cursor: done.nextCursor });
  assert.deepEqual([done.rows[0].title, next.rows[0].title, next.nextCursor], ['Chat 1', 'Chat 0', null]);
});
test('records with no messages are hidden once read, but a picked empty file still reports "empty"', async () => {
  const fixture = fixtureHome();
  const cwd = fixture.project;
  writeCodex(fixture, 'real', rollout({ id: 'u-real', cwd, user: 'Real one' }));
  const metaOnly = writeCodex(fixture, 'meta-only', rollout({ id: 'u-meta-only', cwd, withMessages: false }));
  const zeroByte = writeCodex(fixture, 'zero', '');
  writeCodex(
    fixture,
    'envelope-only',
    jsonl([
      { type: 'session_meta', payload: { id: 'u-env', cwd, source: 'vscode' } },
      message('user', '<environment_context>\n<cwd>x</cwd>\n</environment_context>'),
    ])
  );
  writeCodex(fixture, 'broken', 'not json\n');
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'codex' });
  // The unreadable-as-JSON file is not proven empty, so it stays listed.
  assert.deepEqual(page.rows.map((row) => row.title).sort(), [null, 'Real one'].sort());
  assert.deepEqual([page.matchedCount, page.selectableCount], [2, 2]);
  assert.deepEqual(page.projects, [{ cwd, count: 1 }]);
  await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: metaOnly }), /empty/);
  await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: zeroByte }), /empty/);
});

test('Claude Code: a sidechain prefix does not prove a transcript is sidechain-only', async () => {
  const fixture = fixtureHome();
  const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--mixed');
  mkdirSync(dir, { recursive: true });
  const entry = (uuid, parentUuid, type, content, extra = {}) => ({
    uuid,
    parentUuid,
    type,
    isSidechain: false,
    sessionId: 'claude-mixed',
    cwd: fixture.project,
    message: { role: type, content },
    ...extra,
  });
  const side = { isSidechain: true, agentId: 'agent-1' };
  const main = [
    entry('u1', null, 'user', 'Main question'),
    entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Ok' }]),
  ];
  // Small: read to the end, main conversation present.
  writeFileSync(join(dir, 'small.jsonl'), jsonl([entry('s1', null, 'user', 'Warmup', side), ...main]));
  // Large: the first 512 KB prefix holds sidechain messages only.
  const filler = [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(700 * 1024) }];
  writeFileSync(
    join(dir, 'large.jsonl'),
    jsonl([
      entry('s1', null, 'user', 'Warmup', side),
      entry('s2', 's1', 'user', filler, side),
      entry('u1', null, 'user', 'Main question'),
      entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Ok' }]),
    ])
  );
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'claude' });
  assert.equal(page.rows.length, 2);
  assert.equal(page.selectableCount, 2);
});

test('Claude Code: a sidechain-only transcript larger than the prefix budget is still recognized', async () => {
  const fixture = fixtureHome();
  const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--big-side');
  mkdirSync(dir, { recursive: true });
  const side = (index) => ({
    uuid: `s${index}`,
    parentUuid: index ? `s${index - 1}` : null,
    type: index % 2 ? 'assistant' : 'user',
    isSidechain: true,
    agentId: 'agent-9',
    sessionId: 'claude-big-side',
    cwd: fixture.project,
    message: { role: index % 2 ? 'assistant' : 'user', content: `${index} ${'y'.repeat(1200)}` },
  });
  const body = jsonl(Array.from({ length: 600 }, (_, index) => side(index)));
  assert.ok(Buffer.byteLength(body) > 600 * 1024, 'fixture exceeds the 512 KiB prefix budget');
  writeFileSync(join(dir, 'agent-big.jsonl'), body);
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'claude' });
  assert.deepEqual([page.matchedCount, page.selectableCount, page.rows.length], [0, 0, 0]);
});

test('Claude Code: a sidechain-only scan stops at its byte budget and leaves the transcript listed', async () => {
  const fixture = fixtureHome();
  const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--over-budget');
  mkdirSync(dir, { recursive: true });
  const side = (index) => ({
    uuid: `s${index}`,
    parentUuid: index ? `s${index - 1}` : null,
    type: index % 2 ? 'assistant' : 'user',
    isSidechain: true,
    agentId: 'agent-7',
    sessionId: 'claude-over-budget',
    cwd: fixture.project,
    message: { role: index % 2 ? 'assistant' : 'user', content: `${index} ${'z'.repeat(1200)}` },
  });
  const body = jsonl(Array.from({ length: 600 }, (_, index) => side(index)));
  const budget = 640 * 1024;
  assert.ok(Buffer.byteLength(body) > budget, 'fixture is larger than the injected scan budget');
  writeFileSync(join(dir, 'agent-over.jsonl'), body);
  const api = freshApi(fixture.env);
  resetConversationDiscovery({ scanMaxBytes: budget });
  try {
    const page = await listUntilComplete(api, { source: 'claude' });
    assert.deepEqual([page.matchedCount, page.selectableCount, page.rows.length], [1, 1, 1]);
    // Within its budget the same transcript is proven sidechain-only and hidden.
    resetConversationDiscovery({ scanMaxBytes: 2 * budget });
    const hidden = await listUntilComplete(api, { source: 'claude' });
    assert.deepEqual([hidden.matchedCount, hidden.selectableCount], [0, 0]);
  } finally {
    resetConversationDiscovery();
  }
});
