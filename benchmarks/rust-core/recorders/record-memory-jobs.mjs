#!/usr/bin/env node
// What the real Node code computes for the daemon's memory background jobs, for the Rust port in
// `mixdog-services` `memory::cycles`, `memory::transcript` and `task_reports` to equal: the cycle
// request signature, intervals and coalesce limits, the cycle1 plan, SQL fragments, line-format
// parse and grouping validation, prompt and quality records, window packing and result merging,
// the chunk generator driven by a scripted classifier, the transcript line to row mapping and the
// incremental tail ingest (a fake db that records its inserts), and the report chain reads over
// stored messages.
//
//   node benchmarks/rust-core/recorders/record-memory-jobs.mjs [--tree <dir>]
//
// Output: native/core/fixtures/memory-jobs/golden.json.
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'memory-jobs');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-memory-jobs.mjs';
const at = (path) => importFrom(tree, path);

const FROZEN = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => FROZEN;

const lib = 'src/runtime/memory/lib/';
const requests = await at(`${lib}memory-cycle-requests.mjs`);
const signatures = await at(`${lib}cycle-signatures.mjs`);
const shared = await at(`${lib}memory-cycle-shared.mjs`);
const tick = await at(`${lib}cycle-scheduler/tick-loop.mjs`);
const quality = await at(`${lib}memory-chunk-quality.mjs`);
const cycle1 = await at(`${lib}memory-cycle1.mjs`);
const plan = await at(`${lib}cycle1/cycle1-plan.mjs`);
const rowsLib = await at(`${lib}cycle1/cycle1-rows.mjs`);
const tail = await at(`${lib}ingest/transcript-tail.mjs`);
const offsetsLib = await at(`${lib}ingest/transcript-offsets.mjs`);
const rowsMod = await at(`${lib}ingest/transcript-rows.mjs`);
const discovery = await at(`${lib}ingest/transcript-discovery.mjs`);
const tasks = await at('src/session-runtime/agent-task-sessions.mjs');
const pendingWork = await at('src/runtime/shared/pending-agent-work.mjs');

const attempt = (fn) => {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
};

// --- cycle request signature, interval, due rule, coalesce limits
const configs = [
  { min_batch: 20, session_cap: 4, batch_size: 50, max_packets: 4, concurrency: 4 },
  { min_batch: 20, session_cap: 4, interval: '10m', timeout: 600000, nested: { a: [1, { b: 2, signal: 'x' }], coalescedRetry: true }, deep: { a: { b: { c: { d: { e: 1 } } } } } },
  {},
  { zeta: null, alpha: 'é', 10: 1, 2: 2, list: [3, 'x', null, true] },
];
const signature = configs.map((config) => ({
  config,
  scheduled: signatures.scheduledCycle1Signature(config),
  withOptions: requests.makeCycleRequestSignature('cycle1', config, { preset: { provider: 'p', model: 'm' }, concurrency: 2, maxConcurrent: undefined }),
}));
const intervals = ['10m', '1.5h', '500 ms', ' 2d ', '30s', '', '10', 'm', '1x', 5, null].map((value) => ({ value, ...attempt(() => shared.parseInterval(value)) }));
const due = [
  [0, 0, 600000, 600000],
  [0, 1000, 600000, 601000],
  [1000, 5, 600000, 600999],
  [1000, 5, 600000, 601000],
  [NaN, 0, 600000, 600000],
  [5, 'x', 10, 15],
  [0, 0, 0, 100],
  [0, 0, -5, 100],
].map(([last, started, interval, now]) => ({ last: Number.isNaN(last) ? 'NaN' : last, started, interval, now, due: tick.periodicCycleDue(last, started, interval, now) }));
const savedEnv = { ...process.env };
const coalesceCases = [
  { config: {}, env: {} },
  { config: { coalesce_max_retries: 7.9, coalesce: { max_retries: 2 } }, env: {} },
  { config: { coalesce: { max_retries: 99, retry_delay_ms: 1, max_drains: 4 } }, env: {} },
  { config: { coalesce_max_drains: null }, env: {} },
  { config: {}, env: { MIXDOG_MEMORY_CYCLE_COALESCE_MAX_RETRIES: '5', MIXDOG_MEMORY_CYCLE_COALESCE_RETRY_MS: '70000', MIXDOG_MEMORY_CYCLE_COALESCE_MAX_DRAINS: 'abc' } },
  { config: { coalesce_max_retries: 'x', coalesce: { max_retries: 6 } }, env: {} },
].map(({ config, env }) => {
  for (const key of Object.keys(process.env)) if (key.startsWith('MIXDOG_MEMORY_CYCLE_COALESCE')) delete process.env[key];
  Object.assign(process.env, env);
  return { config, env, maxRetries: requests.resolveCoalesceMaxRetries(config, 3), maxDrains: requests.resolveCoalesceMaxDrains(config, 1) };
});
for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];

// --- plan, SQL, packing, merging
const planCases = [
  {},
  { batch_size: 30, min_batch: 5, session_cap: 9, timeout: 1000 },
  { window_size: 99, max_packets: 9, rows_per_session: 0, cycle1_concurrency: 2, session_quiet_ms: 0, session_force_age_ms: 5, session_id: ' s1 ' },
  { cycle1: { min_batch: 7, session_cap: 2, timeout: 5 }, input_token_budget: 9000 },
  { batch_size: 'abc', concurrency: 0 },
];
const planResults = planCases.map((config, i) => ({
  config,
  options: i === 1 ? { callerDeadlineMs: 20000, preset: { provider: 'p' } } : i === 3 ? { concurrency: 3, preset: { provider: 'p' } } : { preset: { provider: 'p' } },
  plan: plan.resolveCycle1Plan(config, i === 1 ? { callerDeadlineMs: 20000, preset: { provider: 'p' } } : i === 3 ? { concurrency: 3, preset: { provider: 'p' } } : { preset: { provider: 'p' } }),
}));
const mk = (id, session, content, extra = {}) => ({ id: String(id), ts: String(1_700_000_000_000 + id), role: id % 2 ? 'user' : 'assistant', content, session_id: session, project_id: null, ...extra });
const longText = (n) => `word${'x'.repeat(40)} `.repeat(n);
const sql = {
  due: rowsLib.cycle1RowDueSql('$1'),
  dueAlias: rowsLib.cycle1RowDueSql('$2', 'e'),
  unchunked: rowsLib.cycle1UnchunkedSql(),
  unchunkedAlias: rowsLib.cycle1UnchunkedSql('e'),
};
const rootCases = [[mk(3, 's'), mk(1, 's'), mk(2, 's')], [{ id: '5', ts: '10' }, { id: '4', ts: '10' }, { id: 'x', ts: '1' }], []].map((members) => ({ members, root: rowsLib.selectRootId(members) }));
const bySession = new Map([
  ['sa', [mk(1, 'sa', longText(30)), mk(2, 'sa', longText(30)), mk(3, 'sa', longText(30))]],
  ['sb', [mk(4, 'sb', 'short'), mk(5, 'sb', 'tiny')]],
  ['sc', [mk(6, 'sc', longText(5))]],
  ['sd', [mk(7, 'sd', longText(5))]],
  ['se', [mk(8, 'se', longText(5))]],
]);
const packCases = [
  { packetSize: 50, maxPackets: 4, budget: 16000 },
  { packetSize: 1, maxPackets: 2, budget: 16000 },
  { packetSize: 2, maxPackets: 1, budget: 4500 },
  { packetSize: 0, maxPackets: 0, budget: 16000 },
  { packetSize: 50, maxPackets: 4, budget: 100 },
].map((c) => ({ ...c, sessions: [...bySession.entries()], ...attempt(() => cycle1.packCycle1Windows(bySession, c.packetSize, c.maxPackets, c.budget).map((w) => w.map((r) => r.id))) }));
const resultA = { processed: 3, chunks: 1, skipped: 2, sessions: 1, skippedInFlight: false, pendingRows: 9, embedding_dirty: { deferred: true, attempted: 1, succeeded: 1, failed: 0, failed_ids: [1] }, timing: { llmMs: 5, commitMs: 1 }, failed_row_ids: [1, 2], omitted_row_ids: [3], prefiltered_row_ids: [], invalid_chunks: [{ reason: 'x', member_ids: [1] }], quality: { rows_considered: 5, failed_rows: 2 } };
const resultB = { processed: 4, chunks: 2, skipped: 0, sessions: 2, skippedInFlight: false, pendingRows: undefined, embedding_dirty: { deferred: false, attempted: 2, succeeded: 1, failed: 1, failed_ids: [2] }, timing: { llmMs: 7, fetchMs: 3 }, failed_row_ids: [2, 4], omitted_row_ids: [3, 5], prefiltered_row_ids: [8], invalid_chunks: [], quality: { rows_considered: 7, committed_members: 4 } };
const merged = JSON.parse(JSON.stringify(cycle1.mergeCycle1Results(resultA, resultB)));

// --- classifier reply parse, validation, prompts, quality
const parseCases = [
  '1-3|Topic|decision|The summary',
  '1,3|Topic|FACT|a|b|c\n\n2|T|rule|s',
  '1 - 2 , 4|T|task|s',
  '5-2|T|task|s',
  '1-9999|T|task|s',
  '9007199254740993|T|task|s',
  'not a line',
  '1|only|three',
  '',
  '   \n  ',
  '1|T|unknown|s',
  '1|T|issue|s\r\n2|T|goal|s2',
].map((raw) => ({ raw, parsed: quality.parseCycle1LineFormat(raw) }));
const gRows = [mk(1, 'sa', 'one'), mk(2, 'sa', 'two'), mk(3, 'sb', 'three'), mk(4, 'sa', 'four')];
const groupingCases = [
  [{ _idxList: [1, 2], element: 'e', category: 'fact', summary: 's' }],
  [{ _idxList: [1, 2], element: 'e', category: 'fact', summary: 's' }, { _idxList: [2, 4], element: 'e', category: 'fact', summary: 's' }],
  [{ _idxList: [1, 3], element: 'e', category: 'fact', summary: 's' }],
  [{ _idxList: [0], element: 'e', category: 'fact', summary: 's' }, { _idxList: [9], element: 'e', category: 'fact', summary: 's' }],
  [{ _idxList: [1, 1], element: 'e', category: 'fact', summary: 's' }],
  [{ _idxList: [4], element: '', category: 'fact', summary: 's' }, { _idxList: [3], element: 'e', category: 'nope', summary: 's' }, { _parseError: 'invalid_line_format', _idxList: [] }],
  [],
  null,
].map((chunks) => ({ chunks, result: quality.validateCycle1Grouping(chunks, gRows) }));
const promptRows = [mk(1, 'sa', 'first "quoted" line\nsecond'), mk(2, 'sa', longText(3), { element: 'topic' }), mk(3, 'sb', 'other session')];
const prompts = { source: quality.chunkSourceText(promptRows), prompt: quality.buildCycle1ChunkPrompt(promptRows), rewrite: quality.buildCycle1ChunkPrompt(promptRows, { rewrite: true }), empty: quality.chunkSourceText([]) };
const budgets = [16000, 4096, 4095, 'x', NaN, 0].map((value) => ({ value: Number.isNaN(value) ? 'NaN' : value, ...attempt(() => quality.cycle1SourceBudget(value)) }));
const qMembers = [mk(2, 'sa', longText(6)), mk(1, 'sa', longText(6))];
const qualityRecord = quality.makeChunkQuality('short summary', qMembers);
const assessCases = [
  { summary: 'short summary', chunk_quality: qualityRecord, members: qMembers },
  { summary: 'short summary', chunk_quality: qualityRecord, members: [qMembers[0]] },
  { summary: 'changed', chunk_quality: qualityRecord, members: qMembers },
  { summary: 'short summary', chunk_quality: { ...qualityRecord, version: 2 }, members: qMembers },
  { summary: 'short summary', chunk_quality: null, members: qMembers },
  { summary: longText(40), chunk_quality: null, members: qMembers },
  { summary: 'x', chunk_quality: null, members: [] },
  { summary: 'x', chunk_quality: null, members: [qMembers[0], { ...qMembers[1], session_id: 'other' }] },
].map((root) => ({ root, result: quality.assessChunkQuality(root, root.members) }));
const splitCases = [{ row: mk(1, 'sa', longText(900)), budget: 4000 }, { row: mk(2, 'sa', `${'a'.repeat(300)}😀${'b'.repeat(300)}`), budget: 220 }, { row: mk(3, 'sa', 'x'), budget: 10 }].map(({ row, budget }) => ({
  row,
  budget,
  ...attempt(() => quality.splitCycle1Row(row, budget).map((r) => r.content)),
}));

// --- the generator, driven by a scripted classifier
async function generate(label, rows, replies, inputTokenBudget = 16000) {
  const calls = [];
  let n = 0;
  const callLlm = async (request, prompt) => {
    calls.push({ request: { ...request, signal: undefined }, prompt });
    const reply = replies[Math.min(n, replies.length - 1)];
    n += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const result = await quality.generateCycle1Chunks(rows, { callLlm, inputTokenBudget, request: { agent: 'cycle1-agent', taskType: 'maintenance', preset: { provider: 'p' }, timeout: 1000, cwd: null } });
  const normalized = JSON.parse(JSON.stringify({ ...result, stats: { ...result.stats, llmMs: 0, totalMs: 0 } }));
  return { label, rows, replies: replies.map((r) => (r instanceof Error ? { error: r.message } : r)), inputTokenBudget, calls, result: normalized };
}
const gen = [];
const g1 = [mk(1, 'sa', longText(12)), mk(2, 'sa', longText(12)), mk(3, 'sa', longText(12))];
gen.push(await generate('groups all three', g1, ['1-3|Topic|decision|Short summary of the work']));
gen.push(await generate('tiny window is left raw', [mk(1, 'sa', 'ok')], ['never called']));
gen.push(await generate('summary longer than rows is rewritten', g1, [`1-3|Topic|fact|${longText(60)}`, '1-3|Topic|fact|Brief']));
gen.push(await generate('rewrite still longer leaves rows raw', g1, [`1-3|Topic|fact|${longText(60)}`, `1-3|Topic|fact|${longText(60)}`]));
gen.push(await generate('provider error', g1, [new Error('provider down')]));
gen.push(await generate('unparseable reply', g1, ['']));
gen.push(await generate('partial grouping and an out of range index', g1, ['1-2|T|task|Done\n9|T|task|x']));
gen.push(await generate('oversize window is partitioned', [mk(1, 'sa', longText(60)), mk(2, 'sa', longText(60)), mk(3, 'sa', longText(60))], ['1|T|fact|Part one', '1|T|fact|Part two', '1|T|fact|Part three'], 4096));
gen.push(await generate('oversize single row is fragmented', [mk(1, 'sa', longText(200))], ['1|T|fact|f1', '1|T|fact|f2', '1|T|fact|f3', '1|T|fact|f4', '1|T|fact|f5', '1|T|fact|f6'], 4096));
gen.push(await generate('mixed sessions in one line', [mk(1, 'sa', longText(12)), mk(2, 'sb', longText(12))], ['1-2|T|fact|Mixed']));

// --- transcript line to row, discovery predicates
const lines = [
  { message: { role: 'user', content: 'plain question' }, ts: 1_700_000_000 },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'an answer' }, { type: 'tool_use', name: 'x' }] }, timestamp: '2026-01-02T03:04:05.000Z' },
  { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>internal</system-reminder>' }] } },
  { type: 'summary', message: { content: 'x' } },
  { type: 'user', memoryEligible: false, message: { content: 'hidden' } },
  { type: 'user', message: { content: '   ' } },
  { type: 'user', message: { role: 'assistant', content: 'role from message' }, timestamp: 'garbage' },
  { type: 'user', message: { content: 'ms stamp' }, ts: 1_700_000_000_123 },
];
const rowCases = lines.map((parsed) => ({ parsed, row: rowsMod.transcriptRowFromLine(parsed) }));
const names = ['a/b.jsonl', 'a\\b.jsonl', 'a/agent-b.jsonl', 'a/b.json', 'tmp/b.jsonl', 'a/plugins/b.jsonl', 'cached/b.jsonl', 'a/cache/b.jsonl', 'b.jsonl'];
const nameCases = names.map((name) => ({ name, watchable: discovery.isWatchable(name), skipped: discovery.isSkippedWatchPath(name), jsonl: discovery.isTranscriptJsonlName(name) }));
const tsCases = [1_700_000_000, 1_700_000_000_123, 0.5, 'x', '2026-01-02', null, undefined, true].map((value) => ({ value: value === undefined ? '__undefined__' : value, ms: rowsMod.parseTsToMs(value) }));

// --- the incremental tail ingest over a scripted file
const dir = mkdtempSync(join(tmpdir(), 'mixdog-memory-jobs-'));
const file = join(dir, 'sess-1.jsonl');
const store = {};
const inserts = [];
const fakeDb = { query: async (_sql, params) => { inserts.push(params); return { rowCount: 1 }; } };
const offsets = offsetsLib.createTranscriptOffsets({ loadMeta: async () => '{}', persistMeta: async (json) => { store.json = json; }, log: () => {} });
const logs = [];
const run = async (label, projectId = null) => {
  inserts.length = 0;
  const before = inserts.length;
  const count = await tail.ingestTranscriptTail({ db: fakeDb, transcriptPath: file, cwd: dir, offsets, resolveProjectId: () => projectId, log: (m) => logs.push(m) });
  return { label, count, inserts: inserts.slice(before).map(([ts, role, content, sourceRef, sessionId, turn, project, timeSource]) => ({ ts, role, content, sourceRef, sessionId, turn, project, timeSource })), offset: JSON.parse(JSON.stringify(offsets.get(file) ?? null)), persisted: store.json };
};
const tailSteps = [];
const L = (o) => JSON.stringify(o);
writeFileSync(file, [L({ type: 'user', message: { content: 'first question' }, timestamp: '2026-01-02T03:04:05.000Z' }), '', L({ type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] }, ts: 1_700_000_000 }), '{broken json', L({ type: 'summary' })].join('\r\n') + '\r\n' + '{"type":"user","message":{"content":"par');
tailSteps.push(await run('first read leaves the partial line', 'proj-a'));
appendFileSync(file, 'tial"}}\n' + `\u0000\u0000${L({ type: 'user', message: { content: 'after a NUL run' }, ts: 1_700_000_100 })}\n`);
tailSteps.push(await run('the partial line completes and a NUL run is dropped', 'proj-a'));
tailSteps.push(await run('nothing new'));
truncateSync(file, 10);
writeFileSync(file, `${L({ type: 'user', message: { content: 'rewritten' }, ts: 1_700_000_200 })}\n`);
tailSteps.push(await run('a rewrite bumps the generation'));
Date.now = realNow;
rmSync(dir, { recursive: true, force: true });
tailSteps.push({ logs });

// --- report chain reads
const user = (checkpointId, text = 'go', extra = {}) => ({ role: 'user', content: text, meta: { transcript: { checkpointId, ...extra.transcript }, ...extra.meta } });
const done = (text, at = 100, status = 'done') => ({ role: 'assistant', content: text, meta: { transcript: { completion: { status }, at } } });
const sendCall = (callId, type = 'send') => ({ role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'agent', arguments: { type } }] });
const started = (callId, taskIds) => ({ role: 'tool', toolCallId: callId, agentTaskIds: taskIds, content: 'started' });
const woken = (checkpointId, taskIds) => ({ role: 'user', content: 'result', meta: { source: 'task-notification', transcript: { checkpointId, consumedExecutionIds: taskIds } } });
const conversations = {
  simple: [user('r1', 'do it'), done('all done')],
  open: [user('r1', 'do it')],
  failed: [user('r1'), { role: 'assistant', content: '', meta: { transcript: { completion: { status: 'failed', detail: 'it broke' }, at: 7 } } }],
  interrupted: [user('r1'), { role: 'assistant', content: 'partial' }, { role: 'user', content: '[Request interrupted by user]' }],
  nextPrompt: [user('r1'), { role: 'assistant', content: 'x' }, user('r2')],
  handedOff: [user('r1'), sendCall('c1'), started('c1', ['t1']), done('handing off', 50), woken('r2', ['t1']), done('final answer', 90)],
  handedOffRunning: [user('r1'), sendCall('c1'), started('c1', ['t1']), done('handing off', 50)],
  ambiguous: [user('r1'), sendCall('c1'), { role: 'tool', toolCallId: 'c1', content: 'started' }, done('maybe', 10)],
  otherWake: [user('r1'), sendCall('c1'), started('c1', ['t1']), done('handing off', 50), woken('r2', ['t9']), done('someone else', 90)],
  steered: [user('r1', 'go', { transcript: { submissionIds: ['s2'] } }), { role: 'assistant', content: 'working' }, { role: 'user', content: 'extra', meta: { submissionIds: ['s3'] } }, done('end')],
};
const ids = { simple: 'r1', open: 'r1', failed: 'r1', interrupted: 'r1', nextPrompt: 'r1', handedOff: 'r1', handedOffRunning: 'r1', ambiguous: 'r1', otherWake: 'r1', steered: 's3' };
const chain = Object.fromEntries(Object.entries(conversations).map(([name, messages]) => [name, { messages, runId: ids[name], outcome: tasks.submissionOutcome(messages, ids[name]), latest: tasks.latestTurnOutcome(messages, ids[name]), submissionIds: messages.map((m) => tasks.submissionIdsOf(m)) }]));
chain.missing = { messages: conversations.simple, runId: 'nope', outcome: tasks.submissionOutcome(conversations.simple, 'nope'), latest: tasks.latestTurnOutcome(conversations.simple, 'nope') };
const pool = [
  { sessionId: 'a1', ownerSessionId: 'lead', taskId: 't1', status: 'running' },
  { sessionId: 'a2', ownerSessionId: 'lead', parentSessionId: 'a1', taskId: 't2', status: 'done' },
  { sessionId: 'a3', ownerSessionId: 'lead', parentSessionId: 'a1', taskId: 't3', stage: 'streaming' },
  { sessionId: 'a4', ownerSessionId: 'lead', taskId: 't4', status: 'cancelling' },
  { sessionId: 'lead', ownerSessionId: 'lead', status: 'running' },
  { sessionId: 'a5', ownerSessionId: 'other', taskId: 't5', status: 'queued' },
  { sessionId: 'a6', ownerSessionId: 'lead', taskId: 't6', status: 'cancelled' },
  { sessionId: 'a7', ownerSessionId: 'lead', stage: 'tool_running' },
];
const rowStatus = pool.map((row) => ({ row, pending: pendingWork.hasPendingAgentWork(row) }));
const owed = (taskId) => ({ text: 'r', meta: { execution_id: taskId } });
const pendingCases = [
  { sessionId: 'lead', state: {} },
  { sessionId: 'lead', state: { agentWorking: ['lead'] } },
  { sessionId: 'lead', state: { owed: [owed('t1')] } },
  { sessionId: 'lead', state: { agentTaskOwners: ['lead'] } },
  { sessionId: 'lead', state: { pool } },
  { sessionId: 'other', state: { pool } },
  { sessionId: 'lead', state: { pool, taskIds: ['t1'] } },
  { sessionId: 'lead', state: { pool, taskIds: ['t4'] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], owed: [owed('restart:t9'), owed('t8')] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], owed: [owed('t8')] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], owed: [{ text: 'r', meta: {} }] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], agentTasks: [{ taskId: 't9', sessionId: 'a9', running: true }] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], agentTasks: [{ taskId: 't9', sessionId: 'a9', running: false }], working: ['a9'] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], agentTasks: [{ taskId: 't9', sessionId: 'a9', running: false }], agentTaskOwners: ['a9'] } },
  { sessionId: 'lead', state: { pool: [], taskIds: ['t9'], agentTasks: [{ taskId: 't9', sessionId: 'a9', running: false }] } },
].map(({ sessionId, state }) => {
  const input = { ...state, agentWorking: new Set(state.agentWorking), agentTaskOwners: new Set(state.agentTaskOwners), working: new Set(state.working), taskIds: state.taskIds ? new Set(state.taskIds) : null };
  return { sessionId, state, pending: tasks.pendingWorkOf(sessionId, input) };
});
const closure = [{ taskIds: ['t1'] }, { taskIds: ['t4'] }, { taskIds: ['nope'] }].map(({ taskIds }) => {
  const result = tasks.chainClosure('lead', taskIds, { pool, agentTasks: [] });
  return { taskIds, sessions: [...result.sessions].sort() };
});
const sessionsPending = [...pendingWork.sessionsWithPendingWork(pool)].sort();

writeJson(join(stage, 'golden.json'), {
  frozenNow: FROZEN,
  signature,
  intervals,
  due,
  coalesce: coalesceCases,
  plan: planResults,
  sql,
  roots: rootCases,
  pack: packCases,
  merged: { a: resultA, b: resultB, result: merged },
  parse: parseCases,
  grouping: groupingCases,
  prompts,
  budgets,
  qualityRecord: { members: qMembers, summary: 'short summary', record: qualityRecord },
  assess: assessCases,
  split: splitCases,
  generate: gen,
  rows: rowCases,
  names: nameCases,
  timestamps: tsCases,
  tail: tailSteps,
  chain,
  rowStatus,
  pending: pendingCases,
  closure,
  sessionsPending,
});
writeSetManifest(stage, { set: 'memory-jobs', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`memory jobs: ${gen.length} generator runs, ${tailSteps.length} tail steps, ${Object.keys(chain).length} chains`);
