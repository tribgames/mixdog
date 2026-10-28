import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import zlib, { zstdCompressSync } from 'node:zlib';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-conversation-import-')));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createConversationImportApi, resetConversationImportJobs } = await import('./service.mjs');
const { candidateId, convertCandidateFile, getCandidate, resetConversationDiscovery } = await import('./discovery.mjs');
const { deleteSession, listStoredSessionSummaries, loadSession } = await import(
  '../../runtime/agent/orchestrator/session/store.mjs'
);
const { sessionPath } = await import('../../runtime/agent/orchestrator/session/store/session-paths.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const providerName = 'conversation-import-service-test';
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
  const projectA = join(home, 'project-a');
  const projectB = join(home, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  return {
    home,
    projectA: realpathSync.native(projectA),
    projectB: realpathSync.native(projectB),
    env: { CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') },
  };
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

function codexRollout({ id, cwd, user, assistant = 'Sure.' }) {
  return jsonl([
    { type: 'session_meta', payload: { id, cwd } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `<environment_context>\n<cwd>${cwd}</cwd>\n</environment_context>` }],
      },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] },
    },
  ]);
}

function writeCodex(fixture, day, name, body, mtimeSec) {
  const dir = join(fixture.env.CODEX_HOME, 'sessions', '2026', '01', day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-${day}-${name}.jsonl`);
  writeFileSync(path, body);
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

// Sessions handed to content-search ingestion (no PG in these tests).
const ingested = [];

function freshApi(env, overrides = {}) {
  resetConversationDiscovery();
  resetConversationImportJobs();
  return createConversationImportApi({
    env,
    listSessionSummaries: async () => listStoredSessionSummaries(),
    prepareLeadOptions: async () => leadOptions,
    ingestSession: (session) => ingested.push(session),
    ...overrides,
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

// `tag` keeps foreign ids distinct from fixtures imported by other tests (one shared store).
function codexFixture(tag = '') {
  const fixture = fixtureHome();
  const missing = join(fixture.home, 'deleted-project');
  const files = {
    alpha: writeCodex(
      fixture,
      '05',
      'alpha',
      codexRollout({ id: `id-alpha${tag}`, cwd: fixture.projectA, user: 'Alpha task' }),
      1_700_000_500
    ),
    beta: writeCodex(
      fixture,
      '04',
      'beta',
      codexRollout({ id: `id-beta${tag}`, cwd: fixture.projectA, user: 'Beta task' }),
      1_700_000_400
    ),
    gamma: writeCodex(
      fixture,
      '03',
      'gamma',
      codexRollout({ id: `id-gamma${tag}`, cwd: fixture.projectB, user: 'Gamma task' }),
      1_700_000_300
    ),
    lost: writeCodex(
      fixture,
      '02',
      'lost',
      codexRollout({ id: `id-lost${tag}`, cwd: missing, user: 'Lost cwd task' }),
      1_700_000_200
    ),
    broken: writeCodex(fixture, '01', 'broken', 'not json\n{"half":\n', 1_700_000_100),
  };
  // Not a rollout name: ignored.
  writeFileSync(join(fixture.env.CODEX_HOME, 'sessions', '2026', '01', '05', 'notes.jsonl'), 'x\n');
  // A directory link escaping the root: never followed.
  const outside = join(fixture.home, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(outside, 'rollout-escape.jsonl'),
    codexRollout({ id: 'id-escape', cwd: fixture.projectA, user: 'Escaped' })
  );
  symlinkSync(outside, join(fixture.env.CODEX_HOME, 'sessions', 'escape'), 'junction');
  return { fixture, files, missing };
}

test('discovery pages newest first, filters on cached metadata and rejects expired views', async () => {
  const { fixture, files, missing } = codexFixture();
  const api = freshApi(fixture.env);
  const first = await api.listImportableConversations({ source: 'codex', limit: 2 });
  assert.equal(first.searchedRoot, join(fixture.env.CODEX_HOME, 'sessions'));
  assert.equal(first.matchedCount, 5);
  assert.deepEqual(
    first.rows.map((row) => row.title),
    ['Alpha task', 'Beta task']
  );
  assert.equal(first.rows[0].cwd, fixture.projectA);
  assert.equal(first.rows[0].messageCount, 2);
  assert.equal(first.rows[0].modifiedAt, statSync(files.alpha).mtimeMs);
  assert.equal(first.rows[0].importedSessionId, null);
  const second = await api.listImportableConversations({ source: 'codex', limit: 2, cursor: first.nextCursor });
  assert.equal(second.viewId, first.viewId);
  assert.deepEqual(
    second.rows.map((row) => row.title),
    ['Gamma task', 'Lost cwd task']
  );
  const third = await api.listImportableConversations({ source: 'codex', limit: 2, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  assert.equal(third.rows.length, 1);

  const complete = await listUntilComplete(api, { source: 'codex' });
  const byTitle = Object.fromEntries(complete.rows.map((row) => [row.title, row]));
  assert.deepEqual(byTitle['Lost cwd task'].warnings, ['cwdMissing']);
  assert.equal(byTitle['Lost cwd task'].cwd, missing);
  assert.ok(complete.rows.find((row) => row.title === null).warnings.includes('malformed'));
  assert.deepEqual(complete.projects, [
    { cwd: fixture.projectA, count: 2 },
    { cwd: missing, count: 1 },
    { cwd: fixture.projectB, count: 1 },
  ]);

  const queried = await api.listImportableConversations({ source: 'codex', query: 'GAMMA' });
  assert.deepEqual(
    queried.rows.map((row) => row.title),
    ['Gamma task']
  );
  const byProject = await api.listImportableConversations({ source: 'codex', project: fixture.projectA });
  assert.deepEqual(
    byProject.rows.map((row) => row.title),
    ['Alpha task', 'Beta task']
  );
  assert.equal(byProject.projects.length, 3);
  const recent = await api.listImportableConversations({ source: 'codex', modifiedAfter: 1_700_000_350_000 });
  assert.deepEqual(
    recent.rows.map((row) => row.title),
    ['Alpha task', 'Beta task']
  );

  // Metadata is cached by path + size + mtime: same stamp → cached title.
  const sameSize = codexRollout({ id: 'id-alpha', cwd: fixture.projectA, user: 'Omega task' });
  writeFileSync(files.alpha, sameSize);
  utimesSync(files.alpha, 1_700_000_500, 1_700_000_500);
  assert.equal((await api.listImportableConversations({ source: 'codex', limit: 1 })).rows[0].title, 'Alpha task');
  utimesSync(files.alpha, 1_700_000_600, 1_700_000_600);
  assert.equal((await api.listImportableConversations({ source: 'codex', limit: 1 })).rows[0].title, 'Omega task');

  await assert.rejects(
    api.listImportableConversations({
      source: 'codex',
      cursor: Buffer.from(JSON.stringify(['gone', 0])).toString('base64url'),
    }),
    /viewExpired/
  );
  await assert.rejects(
    api.startConversationImport({ requestId: 'r-expired', selection: { viewId: 'gone', excludeIds: [] } }),
    /viewExpired/
  );
  await assert.rejects(api.listImportableConversations({ source: 'other' }), TypeError);
});

test('Claude Code discovery reads projects/*/*.jsonl under CLAUDE_CONFIG_DIR', async () => {
  const fixture = fixtureHome();
  const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--demo');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  const entry = (uuid, parentUuid, type, content) => ({
    uuid,
    parentUuid,
    type,
    isSidechain: false,
    sessionId: 'claude-session',
    cwd: fixture.projectB,
    message: { role: type, content },
  });
  writeFileSync(
    join(dir, 'claude-session.jsonl'),
    `\uFEFF${jsonl([entry('u1', null, 'user', 'Claude question'), entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Answer' }])]).replace(/\n/g, '\r\n')}`
  );
  writeFileSync(join(dir, 'nested', 'deeper.jsonl'), jsonl([entry('x', null, 'user', 'too deep')]));
  // A blank override counts as unset (falls back to the home default).
  const api = freshApi({ ...fixture.env, CODEX_HOME: '   ' });
  const page = await listUntilComplete(api, { source: 'claude' });
  assert.equal(page.searchedRoot, join(fixture.env.CLAUDE_CONFIG_DIR, 'projects'));
  assert.deepEqual(
    page.rows.map((row) => [row.title, row.cwd, row.messageCount, row.source]),
    [['Claude question', fixture.projectB, 2, 'claude']]
  );
});

test('an imported chat keeps the title it was listed under when the active branch starts later', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const fixture = fixtureHome();
    const dir = join(fixture.env.CLAUDE_CONFIG_DIR, 'projects', 'C--titles');
    mkdirSync(dir, { recursive: true });
    const entry = (uuid, parentUuid, type, content, extra = {}) => ({
      uuid,
      parentUuid,
      type,
      isSidechain: false,
      sessionId: 'claude-titles',
      cwd: fixture.projectA,
      message: { role: type, content },
      ...extra,
    });
    // Large enough that listing reads only a prefix; the compaction boundary
    // points at history the file no longer holds, so the branch starts after it.
    const filler = [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(700 * 1024) }];
    writeFileSync(
      join(dir, 'claude-titles.jsonl'),
      jsonl([
        entry('u1', null, 'user', 'Before compaction'),
        entry('r1', 'u1', 'user', filler),
        { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'gone' },
        entry('s1', 'b1', 'user', 'This session is being continued…', { isCompactSummary: true }),
        entry('u2', 's1', 'user', 'After compaction'),
        entry('a2', 'u2', 'assistant', [{ type: 'text', text: 'Done.' }]),
      ])
    );
    const api = freshApi(fixture.env);
    const page = await listUntilComplete(api, { source: 'claude' });
    assert.deepEqual(
      page.rows.map((row) => row.title),
      ['Before compaction']
    );
    const job = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'titles', selection: { ids: [page.rows[0].id] } })).jobId
    );
    assert.equal(job.results[0].status, 'imported');
    assert.equal(loadSession(job.results[0].sessionId).title, 'Before compaction');
  });
});

test('import: dedupe by foreign id, idempotent requestId, missing cwd, malformed files, read-only sources', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture, files, missing } = codexFixture();
    const twin = writeCodex(
      fixture,
      '06',
      'twin',
      codexRollout({ id: 'id-alpha', cwd: fixture.projectA, user: 'Alpha again' }),
      1_700_000_050
    );
    const before = Object.fromEntries(
      [...Object.values(files), twin].map((path) => [path, [readFileSync(path, 'utf8'), statSync(path).mtimeMs]])
    );
    const api = freshApi(fixture.env);
    const page = await listUntilComplete(api, { source: 'codex' });
    const idOf = (title) => page.rows.find((row) => row.title === title).id;
    const ids = [idOf('Alpha task'), idOf('Alpha again'), idOf('Lost cwd task'), page.rows.find((r) => !r.title).id];
    const started = await api.startConversationImport({ requestId: 'req-1', selection: { ids } });
    assert.equal(started.state, 'running');
    assert.equal(started.total, 4);
    assert.equal(
      (await api.startConversationImport({ requestId: 'req-1', selection: { ids: [] } })).jobId,
      started.jobId
    );
    const job = await waitForJob(api, started.jobId);
    assert.equal(job.state, 'completed');
    assert.deepEqual(
      job.results.map((result) => [result.status, result.errorCode || null]),
      [
        ['imported', null],
        ['alreadyImported', null],
        ['imported', null],
        ['failed', 'malformed'],
      ]
    );
    assert.equal(job.results[1].sessionId, job.results[0].sessionId);
    assert.deepEqual([job.processed, job.imported, job.skippedAlreadyImported, job.failed], [4, 2, 1, 1]);
    assert.deepEqual(job.byProject, [
      { projectPath: fixture.projectA, imported: 1, skippedAlreadyImported: 1, failed: 0 },
      { projectPath: null, imported: 1, skippedAlreadyImported: 0, failed: 1 },
    ]);
    assert.deepEqual(job.results[2].warnings, ['cwdMissing']);

    const alpha = loadSession(job.results[0].sessionId);
    assert.equal(alpha.cwd, fixture.projectA);
    assert.deepEqual(alpha.desktopSession, { classification: 'project', projectPath: fixture.projectA });
    assert.equal(alpha.importOrigin.key, 'codex:id-alpha');
    assert.equal(alpha.importOrigin.sourcePath, realpathSync.native(files.alpha));
    assert.equal('mtime' in alpha.importOrigin || 'mtimeMs' in alpha.importOrigin, false);
    const lost = loadSession(job.results[2].sessionId);
    assert.deepEqual(lost.desktopSession, { classification: 'task', projectPath: null });
    assert.equal(lost.importOrigin.sourceCwd, missing);

    // Imported conversations leave the list (the twin shares alpha's foreign id).
    const after = await api.listImportableConversations({ source: 'codex' });
    assert.equal(after.matchedCount, page.matchedCount - 3);
    assert.equal(after.selectableCount, after.matchedCount);
    assert.deepEqual(
      after.rows.filter((row) => ids.slice(0, 3).includes(row.id)),
      []
    );

    // A second job over the same file, through the view, is all alreadyImported.
    const again = await waitForJob(
      api,
      (
        await api.startConversationImport({
          requestId: 'req-2',
          selection: { ids: [ids[0]] },
        })
      ).jobId
    );
    assert.deepEqual(
      again.results.map((result) => result.status),
      ['alreadyImported']
    );

    for (const [path, [content, mtimeMs]] of Object.entries(before)) {
      assert.equal(readFileSync(path, 'utf8'), content);
      assert.equal(statSync(path).mtimeMs, mtimeMs);
    }
  });
});

test('concurrent jobs over one file import it once (dedupe rechecked at admission)', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const fixture = fixtureHome();
    writeCodex(
      fixture,
      '07',
      'solo',
      codexRollout({ id: 'id-solo', cwd: fixture.projectB, user: 'Solo' }),
      1_700_000_000
    );
    const api = freshApi(fixture.env);
    const page = await listUntilComplete(api, { source: 'codex' });
    const [one, two] = await Promise.all([
      api.startConversationImport({ requestId: 'c-1', selection: { ids: [page.rows[0].id] } }),
      api.startConversationImport({ requestId: 'c-2', selection: { viewId: page.viewId, excludeIds: [] } }),
    ]);
    const statuses = [
      (await waitForJob(api, one.jobId)).results[0].status,
      (await waitForJob(api, two.jobId)).results[0].status,
    ];
    assert.deepEqual(statuses.sort(), ['alreadyImported', 'imported']);
  });
});

// prepareLeadOptions held open: the first admitted file of a job waits inside admission.
function gatedLeadOptions() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release,
    prepareLeadOptions: async () => {
      await gate;
      return leadOptions;
    },
  };
}

async function waitForCurrent(api, jobId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [job] = api.getConversationImportJobs({ jobId }).jobs;
    if (job?.current) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job never started a file');
}

function threeTaskFixture() {
  const fixture = fixtureHome();
  const paths = {};
  for (const [index, name] of ['one', 'two', 'three'].entries()) {
    paths[name] = writeCodex(
      fixture,
      `1${index}`,
      name,
      codexRollout({ id: `id-${name}-${fixtureSeq}`, cwd: fixture.projectA, user: `Task ${name}` }),
      1_700_000_000 + index
    );
  }
  return { fixture, paths };
}

test('cancel stops admitting further files and keeps committed imports; current names the file in progress', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture } = threeTaskFixture();
    const gate = gatedLeadOptions();
    const api = freshApi(fixture.env, { prepareLeadOptions: gate.prepareLeadOptions });
    const page = await listUntilComplete(api, { source: 'codex' });
    const started = await api.startConversationImport({
      requestId: 'cancel-1',
      selection: { viewId: page.viewId, excludeIds: [] },
    });
    assert.equal(started.total, 3);
    const running = await waitForCurrent(api, started.jobId);
    assert.deepEqual(running.current, { candidateId: page.rows[0].id, title: 'Task three' });
    const stopping = api.cancelConversationImport({ jobId: started.jobId });
    assert.equal(stopping.state, 'stopping');
    assert.ok(stopping.seq > running.seq);
    gate.release();
    const job = await waitForJob(api, started.jobId);
    assert.equal(job.state, 'stopped');
    assert.equal(job.current, null);
    assert.equal(job.total, 3);
    assert.equal(job.processed, 1);
    assert.equal(job.imported, 1);
    assert.ok(loadSession(job.results[0].sessionId));
    assert.equal(api.cancelConversationImport({ jobId: started.jobId }).state, 'stopped');
    assert.throws(() => api.cancelConversationImport({ jobId: 'nope' }), /jobNotFound/);
  });
});

test('a job cancelled while queued behind another job imports nothing', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture } = threeTaskFixture();
    const gate = gatedLeadOptions();
    const api = freshApi(fixture.env, { prepareLeadOptions: gate.prepareLeadOptions });
    const page = await listUntilComplete(api, { source: 'codex' });
    const [first, second] = page.rows;
    const blocking = await api.startConversationImport({ requestId: 'q-a', selection: { ids: [first.id] } });
    assert.equal((await waitForCurrent(api, blocking.jobId)).current.candidateId, first.id);
    const queued = await api.startConversationImport({ requestId: 'q-b', selection: { ids: [second.id] } });
    // Let the queued job pass its own pre-admission check and wait in the lane.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(api.getConversationImportJobs({ jobId: queued.jobId }).jobs[0].current, null);
    assert.equal(api.cancelConversationImport({ jobId: queued.jobId }).state, 'stopping');
    gate.release();
    const done = await waitForJob(api, queued.jobId);
    assert.deepEqual([done.state, done.processed, done.results.length], ['stopped', 0, 0]);
    assert.equal((await waitForJob(api, blocking.jobId)).imported, 1);
    const after = await api.listImportableConversations({ source: 'codex' });
    assert.equal(after.rows.find((row) => row.id === second.id).importedSessionId, null);
  });
});

test('select-all over a filtered view resolves pending metadata server-side', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture, files } = codexFixture('-filtered');
    const api = freshApi(fixture.env);
    // A query view built before any metadata resolved matches nothing yet.
    const page = await api.listImportableConversations({ source: 'codex', query: 'TASK' });
    assert.equal(page.complete, false);
    assert.equal(page.matchedCount, 0);
    const idOf = (path) => candidateId('codex', realpathSync.native(path));
    const started = await api.startConversationImport({
      requestId: 'filtered-all',
      selection: { viewId: page.viewId, excludeIds: [idOf(files.beta)] },
    });
    assert.equal(started.total, 3);
    const job = await waitForJob(api, started.jobId);
    assert.deepEqual(
      job.results.map((result) => [result.candidateId, result.status]),
      [
        [idOf(files.alpha), 'imported'],
        [idOf(files.gamma), 'imported'],
        [idOf(files.lost), 'imported'],
      ]
    );
    // Already-imported members are left out of a later select-all.
    const projectView = await listUntilComplete(api, { source: 'codex', project: fixture.projectA });
    const again = await api.startConversationImport({
      requestId: 'filtered-again',
      selection: { viewId: projectView.viewId, excludeIds: [] },
    });
    assert.equal(again.total, 1);
    assert.equal((await waitForJob(api, again.jobId)).results[0].candidateId, idOf(files.beta));
  });
});

test('a deleted import is listed and importable again', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const fixture = fixtureHome();
    writeCodex(
      fixture,
      '09',
      'redo',
      codexRollout({ id: 'id-redo', cwd: fixture.projectA, user: 'Redo' }),
      1_700_000_000
    );
    const api = freshApi(fixture.env);
    const page = await listUntilComplete(api, { source: 'codex' });
    const rowId = page.rows[0].id;
    const first = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'redo-1', selection: { ids: [rowId] } })).jobId
    );
    const oldId = first.results[0].sessionId;
    assert.equal(first.results[0].status, 'imported');
    assert.deepEqual((await api.listImportableConversations({ source: 'codex' })).rows, []);
    assert.equal(deleteSession(oldId), true);
    const listed = await api.listImportableConversations({ source: 'codex' });
    assert.deepEqual(
      listed.rows.map((row) => [row.id, row.importedSessionId]),
      [[rowId, null]]
    );
    assert.equal(listed.selectableCount, 1);
    const second = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'redo-2', selection: { ids: [rowId] } })).jobId
    );
    assert.equal(second.results[0].status, 'imported');
    assert.notEqual(second.results[0].sessionId, oldId);
    assert.ok(loadSession(second.results[0].sessionId));
  });
});

test('oversized files fail with tooLarge without being read whole', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const fixture = fixtureHome();
    const head = jsonl([
      { type: 'session_meta', payload: { id: 'id-big', cwd: fixture.projectA } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Big' }] },
      },
    ]);
    const hugeLine = JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'x', output: 'o'.repeat(8 * 1024) },
    });
    const tail = codexRollout({ id: 'unused', cwd: fixture.projectA, user: 'more' }).repeat(2000);
    const longLine = writeCodex(fixture, '20', 'longline', `${head}${hugeLine}\n${tail}`, 1_700_000_002);
    const chatty = Array.from({ length: 2000 }, (_, index) => ({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${index}` }] },
    }));
    const manyTurns = writeCodex(fixture, '21', 'chatty', `${head}${jsonl(chatty)}`, 1_700_000_001);
    const limits = { maxLineBytes: 1024, maxTranscriptChars: 500, chunkBytes: 512 };

    for (const path of [longLine, manyTurns]) {
      const size = statSync(path).size;
      const candidate = { id: 'probe', source: 'codex', path, size, mtimeMs: statSync(path).mtimeMs };
      const conversion = await convertCandidateFile(candidate, limits);
      assert.equal(conversion.errorCode, 'tooLarge', path);
      assert.deepEqual(conversion.turns, []);
      assert.ok(conversion.bytesRead < size / 10, `${conversion.bytesRead} of ${size}`);
    }
    // The file-byte ceiling stops the read itself; retained entries are capped too.
    const probe = { source: 'codex', path: manyTurns };
    const capped = await convertCandidateFile(probe, { maxFileBytes: 4096, chunkBytes: 512 });
    assert.deepEqual([capped.errorCode, capped.turns], ['tooLarge', []]);
    assert.ok(capped.bytesRead <= 4096, `${capped.bytesRead}`);
    assert.equal((await convertCandidateFile(probe, { maxRetainedEntries: 100 })).errorCode, 'tooLarge');
    // Over the default limits a normal file still converts.
    const fine = await convertCandidateFile({ source: 'codex', path: manyTurns });
    assert.equal(fine.errorCode, null);

    const api = freshApi(fixture.env, { limits });
    const page = await listUntilComplete(api, { source: 'codex' });
    assert.equal(page.rows.length, 2);
    const job = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'big', selection: { viewId: page.viewId, excludeIds: [] } }))
        .jobId
    );
    assert.deepEqual(
      job.results.map((result) => [result.status, result.errorCode]),
      [
        ['failed', 'tooLarge'],
        ['failed', 'tooLarge'],
      ]
    );
    const listed = await api.listImportableConversations({ source: 'codex' });
    assert.ok(listed.rows.every((row) => row.warnings.includes('tooLarge')));
  });
});

test('a route that cannot be prepared fails the job with a code', async () => {
  const fixture = fixtureHome();
  writeCodex(
    fixture,
    '08',
    'route',
    codexRollout({ id: 'id-route', cwd: fixture.projectA, user: 'Route' }),
    1_700_000_000
  );
  const api = freshApi(fixture.env, {
    prepareLeadOptions: async () => {
      throw Object.assign(new Error('noModelRoute'), { code: 'noModelRoute' });
    },
  });
  const page = await listUntilComplete(api, { source: 'codex' });
  const job = await waitForJob(
    api,
    (await api.startConversationImport({ requestId: 'route', selection: { ids: [page.rows[0].id] } })).jobId
  );
  assert.equal(job.state, 'failed');
  assert.equal(job.errorCode, 'noModelRoute');
  assert.equal(job.processed, 0);
});

test('a picked file is validated as a local regular .jsonl and registered', async () => {
  const fixture = fixtureHome();
  const picked = join(fixture.home, 'picked.jsonl');
  writeFileSync(picked, codexRollout({ id: 'id-picked', cwd: fixture.projectA, user: 'Picked file' }));
  const api = freshApi(fixture.env);
  const { row } = await api.registerConversationImportFile({ source: 'codex', path: picked });
  assert.deepEqual(
    [row.title, row.cwd, row.messageCount, row.importedSessionId],
    ['Picked file', fixture.projectA, 2, null]
  );
  assert.equal(api.getConversationImportJobs().jobs.length, 0);
  const packed = join(fixture.home, 'rollout-2026-01-01T00-00-00-id-packed.jsonl.zst');
  writeFileSync(
    packed,
    zstdCompressSync(codexRollout({ id: 'id-packed', cwd: fixture.projectA, user: 'Packed file' }))
  );
  const packedRow = (await api.registerConversationImportFile({ source: 'codex', path: packed })).row;
  assert.deepEqual([packedRow.title, packedRow.cwd, packedRow.messageCount], ['Packed file', fixture.projectA, 2]);
  await assert.rejects(api.registerConversationImportFile({ source: 'claude', path: packed }), /unsupported/);
  const shouted = join(fixture.home, 'picked.jsonl.ZST');
  writeFileSync(shouted, zstdCompressSync('x'));
  await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: shouted }), /unsupported/);
  await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: 'relative.jsonl' }), /invalidPath/);
  const text = join(fixture.home, 'picked.txt');
  writeFileSync(text, 'x');
  await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: text }), /unsupported/);
  mkdirSync(join(fixture.home, 'dir.jsonl'));
  await assert.rejects(
    api.registerConversationImportFile({ source: 'codex', path: join(fixture.home, 'dir.jsonl') }),
    /unsupported/
  );
  await assert.rejects(
    api.registerConversationImportFile({ source: 'codex', path: join(fixture.home, 'missing.jsonl') }),
    /unreadable/
  );
  await assert.rejects(api.registerConversationImportFile({ source: 'claude', path: picked }), /unsupported/);
  for (const remote of ['\\\\server\\share\\a.jsonl', '\\\\?\\UNC\\server\\share\\a.jsonl', '\\\\.\\pipe\\a.jsonl']) {
    await assert.rejects(api.registerConversationImportFile({ source: 'codex', path: remote }), /unsupported/, remote);
  }
});

test('a picked .jsonl.zst on a runtime without zstd reports needsNewerNode, not unreadable', async (t) => {
  const fixture = fixtureHome();
  const packed = join(fixture.home, 'rollout-2026-01-01T00-00-00-id-nozstd.jsonl.zst');
  writeFileSync(packed, zstdCompressSync(codexRollout({ id: 'id-nozstd', cwd: fixture.projectA, user: 'Packed' })));
  const original = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  Object.defineProperty(zlib, 'createZstdDecompress', { ...original, value: undefined });
  t.after(() => Object.defineProperty(zlib, 'createZstdDecompress', original));
  await assert.rejects(
    freshApi(fixture.env).registerConversationImportFile({ source: 'codex', path: packed }),
    /needsNewerNode/
  );
});

test('a junction swapped in after enumeration is not followed: the opened file is revalidated', async () => {
  const fixture = fixtureHome();
  const path = writeCodex(
    fixture,
    '23',
    'swap',
    codexRollout({ id: 'id-swap', cwd: fixture.projectA, user: 'Inside the root' }),
    1_700_000_000
  );
  const api = freshApi(fixture.env);
  const page = await listUntilComplete(api, { source: 'codex' });
  assert.deepEqual(
    page.rows.map((row) => row.title),
    ['Inside the root']
  );
  const outside = join(fixture.home, 'outside-swap');
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(outside, basename(path)),
    codexRollout({ id: 'id-swap', cwd: fixture.projectA, user: 'Outside secret' })
  );
  renameSync(dirname(path), `${dirname(path)}-moved`);
  symlinkSync(outside, dirname(path), 'junction');
  await assert.rejects(convertCandidateFile(getCandidate(page.rows[0].id)), /unreadable/);
  const job = await waitForJob(
    api,
    (await api.startConversationImport({ requestId: 'swap', selection: { ids: [page.rows[0].id] } })).jobId
  );
  assert.deepEqual(
    job.results.map((result) => [result.status, result.errorCode]),
    [['failed', 'unreadable']]
  );
});

test('a batch reads the session catalog once, checks existence asynchronously and indexes imports', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const { fixture } = threeTaskFixture();
    let listings = 0;
    const listSessionSummaries = async () => {
      listings += 1;
      return listStoredSessionSummaries();
    };
    const exists = async (id) => existsSync(sessionPath(id));
    const api = freshApi(fixture.env, { listSessionSummaries, sessionExists: exists });
    const page = await listUntilComplete(api, { source: 'codex' });
    const ids = page.rows.map((row) => row.id);
    ingested.length = 0;
    listings = 0;
    const first = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'batch-1', selection: { ids } })).jobId
    );
    assert.deepEqual(
      first.results.map((result) => result.status),
      ['imported', 'imported', 'imported']
    );
    assert.equal(listings, 1);
    // Every import is handed to content search as saved.
    assert.deepEqual(
      ingested.map((session) => session.id),
      first.results.map((result) => result.sessionId)
    );
    assert.ok(ingested.every((session) => session.messages.some((message) => message.meta?.source === 'import')));
    listings = 0;
    const second = await waitForJob(
      api,
      (await api.startConversationImport({ requestId: 'batch-2', selection: { ids } })).jobId
    );
    assert.deepEqual(
      second.results.map((result) => result.status),
      ['alreadyImported', 'alreadyImported', 'alreadyImported']
    );
    assert.equal(listings, 1);
    // An existence check resolving false is honoured (a pending promise is not "exists").
    const gone = freshApi(fixture.env, { listSessionSummaries, sessionExists: async () => false });
    assert.equal((await listUntilComplete(gone, { source: 'codex' })).selectableCount, 3);
    const third = await waitForJob(
      gone,
      (await gone.startConversationImport({ requestId: 'batch-3', selection: { ids } })).jobId
    );
    assert.deepEqual(
      third.results.map((result) => result.status),
      ['imported', 'imported', 'imported']
    );
  });
});
