#!/usr/bin/env node
// Records the thread fold of the TypeScript client (packages/protocol-client/src/session-state.ts: `sessionReducer` and
// `desktopSessionState`, over the rows of rows.ts) over thread feeds: the golden the Rust fold (src/reducer.rs, src/state.rs,
// src/rows.rs) is compared with by tests/fold_twin.rs. After every snapshot and notification of a feed the recording holds the
// projected state, the way a UI reads it, with the server requests then pending and the host's shell jobs joined in.
//
// The feeds:
//  - `session-state`: the recorded Node session states of native/core/fixtures/session-state/stream.json, replayed as the
//    notifications that take one state to the next (the mapping of packages/protocol-client/test/session-state-parity.test.ts);
//    `node` is the state Node recorded for the step, as that test compares it.
//  - `live-turn`: the notifications the Rust core sent for a real turn (packages/protocol-client/test/live-turn-items.json), and the
//    same turn restored (every `run.live` removed).
//  - `rows-golden/<case>`: the items of packages/protocol-client/test/rows-golden.json as a snapshot, and one by one as completions.
//  - synthetic feeds: interleaved deltas, out-of-order tool results, aggregate merges (restored and live), a Stop during tools,
//    history resets, approvals pending and resolved, every section, the queue, prompt history and frames.
//
//   node record-fold.mjs --tree <tree root> [--out file | --check file]
//
// Without --out or --check the recording goes to stdout. --check writes nothing and exits 1 when the file differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const tree = flag('--tree');
if (!tree) {
  console.error('record-fold: --tree <tree root> is required');
  process.exit(2);
}
const { sessionReducer, desktopSessionState } = await import(pathToFileURL(resolve(tree, 'packages/protocol-client/src/session-state.ts')).href);
const readJson = (path) => JSON.parse(readFileSync(resolve(tree, path), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

// ───────────────────────────── the recorder ─────────────────────────────

/** A step: `{ method, params }`, with `requests` (the server requests pending from this step on) and `hostShellJobs` when they change. */
function record(name, steps) {
  let fold = null;
  let requests = [];
  let host;
  const recorded = steps.map((step) => {
    if (step.requests !== undefined) requests = step.requests;
    if (step.hostShellJobs !== undefined) host = step.hostShellJobs;
    if (step.method === 'thread/snapshot') fold = sessionReducer.initial(clone(step.params));
    else if (fold === null) throw new Error(`${name}: the feed does not begin with a snapshot`);
    else fold = sessionReducer.apply(fold, { jsonrpc: '2.0', method: step.method, params: clone(step.params) });
    const state = clone(desktopSessionState(fold, requests, host));
    return { ...clone(step), state, framed: fold.framedRevision ?? fold.structureRevision, frames: fold.frames ?? 0 };
  });
  return { name, steps: recorded };
}

const T = 'lead';
const snapshot = (items = [], state = {}, hasOlder = false, thread = T) => ({ method: 'thread/snapshot', params: { thread: { id: thread }, items, state, hasOlder } });
const note = (method, params = {}) => ({ method, params: { threadId: T, ...params } });
const completed = (item) => note('item/completed', { turnId: 'turn', item });
const started = (item) => note('item/started', { turnId: 'turn', item });
const delta = (itemId, text) => note('item/agentMessage/delta', { turnId: 'turn', itemId, delta: text });

// ───────────────────────────── feed: the recorded Node session states ─────────────────────────────

const OBJ_SECTIONS = {
  'thread/runtime/updated': ['runtime', ['busy', 'commandBusy', 'thinking', 'spinner', 'commandStatus', 'progressHint', 'activeTools']],
  'thread/route/updated': ['route', ['sessionProvider', 'sessionModel', 'fast', 'fastCapable', 'autoEffort', 'modelParameters', 'selectedContextWindow']],
  'thread/context/updated': ['context', ['contextPercent', 'contextTokens', 'contextDefaultPercent']],
  'thread/agents/updated': ['agents', ['agentWorkers', 'agentJobs']],
  'thread/workflow/updated': ['workflow', ['workflow', 'orchestrationMode', 'pendingWorkflowSwitch', 'pendingOrchestrationModeSwitch']],
  'thread/approvals/updated': ['approvals', ['toolApprovalResult', 'handoffQuestions']],
};
const VALUE_SECTIONS = {
  'thread/todo/updated': 'todo',
  'thread/goal/updated': 'goal',
  'thread/quotaResume/updated': 'quotaResume',
  'thread/shellJobs/updated': 'shellJobs',
  'thread/workspace/updated': 'workspace',
  'thread/promptRestore': 'promptRestore',
  'thread/providerAccount/changed': 'providerAccountChange',
  'thread/remote/updated': 'remoteEnabled',
};
const J = (v) => JSON.stringify(v);
const pick = (d, fields) => Object.fromEntries(fields.filter((f) => d[f] !== undefined).map((f) => [f, d[f]]));

function typedItem(row) {
  const { id, kind, text, ...ext } = row;
  if (kind === 'user') return { type: 'userMessage', id, content: [{ type: 'text', text }], meta: { ext } };
  if (kind === 'assistant') return { type: 'agentMessage', id, text, meta: { ext } };
  return { type: 'statusRow', id, kind, meta: { ext: text === undefined ? ext : { ...ext, text } } };
}
function snapshotOf(d) {
  const state = { queued: d.queued ?? [] };
  if (d.desktopSessionTitle !== undefined) state.title = d.desktopSessionTitle;
  for (const [, [key, fields]] of Object.entries(OBJ_SECTIONS)) state[key] = pick(d, fields);
  for (const f of Object.values(VALUE_SECTIONS)) if (d[f] !== undefined) state[f] = d[f];
  return { thread: { id: T }, state, items: d.items.map(typedItem), hasOlder: d.transcriptHasOlder === true };
}
const liveOf = (d) => {
  const t = d.streamingTail ?? null;
  const p = d.streamingPartial ?? null;
  return t || p ? { id: (t ?? p).id, text: (t?.text ?? '') + (p?.text ?? '') } : null;
};
function diff(prev, next, prevLive) {
  const ids = (d) => d.items.map(J);
  if (prev.items.length > next.items.length || ids(prev).some((r, i) => r !== ids(next)[i])) return null;
  if (prev.desktopSessionTitle !== next.desktopSessionTitle || prev.transcriptHasOlder !== next.transcriptHasOlder) return null;
  const out = [];
  const t = { threadId: T };
  for (const [method, [, fields]] of Object.entries(OBJ_SECTIONS)) {
    if (J(pick(prev, fields)) !== J(pick(next, fields))) out.push({ method, params: { ...t, value: pick(next, fields) } });
  }
  for (const [method, f] of Object.entries(VALUE_SECTIONS)) {
    if (J(prev[f]) !== J(next[f])) out.push({ method, params: { ...t, value: next[f] ?? null } });
  }
  if (J(prev.queued) !== J(next.queued)) out.push({ method: 'thread/queue/changed', params: { ...t, queued: next.queued } });
  for (const row of next.items.slice(prev.items.length)) out.push({ method: 'item/completed', params: { ...t, turnId: 'turn', item: typedItem(row) } });
  const live = liveOf(next);
  if (live) {
    const same = prevLive?.id === live.id && live.text.startsWith(prevLive.text);
    if (!same) out.push({ method: 'item/started', params: { ...t, turnId: 'turn', item: { type: 'agentMessage', id: live.id, text: '', meta: {} } } });
    const d = same ? live.text.slice(prevLive.text.length) : live.text;
    if (d) out.push({ method: 'item/agentMessage/delta', params: { ...t, turnId: 'turn', itemId: live.id, delta: d } });
  } else if (prevLive) out.push({ method: 'turn/completed', params: { ...t, turn: { id: 'turn', status: 'completed' } } });
  return out;
}

function sessionStateFeeds() {
  const stream = readJson('native/core/fixtures/session-state/stream.json');
  const steps = readJson('native/core/fixtures/session-state/steps.json').steps;
  return [
    feedOfStates('session-state', stream.frames.map((f) => ({ step: f.step, d: f.decoded })), stream.frames[0].decoded.hostShellJobs, true),
    feedOfStates('session-state-steps', steps.map((x) => ({ step: x.name, d: x.snapshot })), undefined, false),
  ];
}

/** The feed that takes a list of recorded session states (`{ step, d }`) one to the next. */
function feedOfStates(name, states, hostShell, withNode) {
  const steps = [];
  const nodeOf = new Map();
  let prev = null;
  let live = null;
  let pending = [];
  for (const { step: frameName, d } of states) {
    const notes = prev ? diff(prev, d, live) : null;
    const first = steps.length;
    if (notes === null) {
      steps.push({ method: 'thread/snapshot', params: snapshotOf(d) });
      live = null;
      const l = liveOf(d);
      if (l) {
        steps.push(started({ type: 'agentMessage', id: l.id, text: '', meta: {} }));
        steps.push(delta(l.id, l.text));
      }
    } else steps.push(...notes.map((n) => ({ method: n.method, params: n.params })));
    live = liveOf(d);
    const want = d.toolApproval ? [d.toolApproval.id, ...Array.from({ length: d.toolApprovalsWaiting ?? 0 }, (_, i) => `${d.toolApproval.id}-w${i}`)] : [];
    pending = want.map((id, i) => {
      const { id: _id, tool, ...request } = d.toolApproval;
      return { id, method: 'item/tool/requestApproval', params: { threadId: T, requestedAt: 1, order: i + 1, kind: 'shell', tool: tool ?? 'bash', request } };
    });
    if (steps.length === first) steps.push(note('thread/frame', {}));
    // The requests and host's jobs a frame has take effect from its first step; the last step of the frame is the one compared.
    steps[first] = { ...steps[first], requests: pending, ...(first === 0 && hostShell !== undefined ? { hostShellJobs: hostShell } : {}) };
    nodeOf.set(steps.length - 1, { step: frameName, d });
    prev = d;
  }
  const feed = record(name, steps);
  // The state Node recorded for the step that ends a frame, with the fields the fold starts with when the daemon's snapshot omits them
  // (as the parity test states them); `structureRevision` is the fold's own count, not a recorded field.
  for (const [at, { step, d }] of withNode ? nodeOf : []) {
    const expected = {
      streamingTail: null,
      sessionProvider: null,
      sessionModel: null,
      promptRestore: null,
      workspace: null,
      goal: null,
      quotaResume: null,
      todo: null,
      agentScope: null,
      remoteEnabled: false,
      shellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
      hostShellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
      toolApproval: null,
      toolApprovalsWaiting: 0,
      promptHistoryList: [],
      transcriptViewItems: null,
      transcriptViewRevision: 0,
      transcriptHistoryBefore: false,
      transcriptHistoryAfter: false,
      transcriptArchive: null,
      ...(d.items.length ? { transcriptSpilled: { epoch: 0, rows: 0 } } : {}),
      lastTurn: null,
      themeEpoch: 0,
      ...clone(d),
    };
    expected.remoteSessionId = null;
    feed.steps[at].node = { step, state: expected };
  }
  return feed;
}

// ───────────────────────────── feeds: recorded turns and rows ─────────────────────────────

function liveTurnFeeds() {
  const frames = readJson('packages/protocol-client/test/live-turn-items.json');
  const steps = frames.map((f) => ({ method: f.method, params: f.params }));
  const first = steps.findIndex((s) => s.method === 'thread/snapshot');
  const begin = first < 0 ? [snapshot([])] : [];
  const restored = steps.map((s) => (s.params.item ? { ...s, params: { ...s.params, item: JSON.parse(JSON.stringify(s.params.item, (k, v) => (k === 'live' ? undefined : v))) } } : s));
  return [record('live-turn', [...begin, ...steps]), record('live-turn-restored', [...begin, ...restored])];
}

function rowsGoldenFeeds() {
  const golden = readJson('packages/protocol-client/test/rows-golden.json');
  const feeds = [];
  golden.cases.forEach((c, at) => {
    feeds.push(record(`rows-golden/${at}-snapshot`, [snapshot(c.items, {}, false, 'rows')]));
    feeds.push(record(`rows-golden/${at}-completed`, [snapshot([], {}, false, 'rows'), ...c.items.map((item) => ({ method: 'item/completed', params: { threadId: 'rows', turnId: 'turn', item } }))]));
  });
  return feeds;
}

// ───────────────────────────── synthetic feeds ─────────────────────────────

const call = (id, name, input, output, status = 'completed', at = 1000, run) => ({
  type: 'toolCall',
  id,
  name,
  input,
  ...(output === undefined ? {} : { output }),
  ...(run ? { run } : {}),
  meta: { status, at },
});
const user = (id, text, at = 900, ext = {}) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], meta: { at, ext } });
const said = (id, text, at = 1100, meta = {}) => ({ type: 'agentMessage', id, text, meta: { at, ...meta } });
const turnEnd = (id, extra = {}) => ({ type: 'turnEnd', id, elapsedMs: 1234, status: 'completed', meta: { at: 2000 }, ...extra });

const ask = (id, order, extra = {}, thread = T) => ({
  id,
  method: 'item/tool/requestApproval',
  params: { threadId: thread, requestedAt: 1, order, kind: 'shell', tool: 'bash', request: { command: `run ${id}` }, ...extra },
});
const question = (id, order, extra = {}) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: T, requestedAt: 1, order, questions: [{ question: `q ${id}` }], ...extra } });

function restoredRun() {
  const items = [user('u1', 'tidy the repo')];
  for (let i = 0; i < 9; i++) items.push(call(`r${i}`, 'read', { path: `src/f${i}.ts` }, `1\tline ${i}`, 'completed', 1000 + i));
  for (let i = 0; i < 4; i++) items.push(call(`g${i}`, 'grep', { pattern: `needle${i}` }, `src/a.ts:${i}:hit`, 'completed', 1100 + i));
  items.push(said('a1', 'looking', 1200));
  items.push(call('p1', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch' }, 'Updated a.ts', 'completed', 1210, { uiDiff: '-x\n+y' }));
  items.push(call('p2', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: b.ts\n+z\n*** End Patch' }, 'Added b.ts', 'completed', 1211));
  items.push(call('s1', 'bash', { command: 'npm test' }, '[exit code: 1]\nfailing', 'failed', 1220));
  items.push(call('s2', 'bash', { command: 'ls' }, '[exit code: 0]\na b', 'completed', 1221));
  items.push(call('w1', 'web_fetch', { url: 'https://example.com' }, 'Error: HTTP 500', 'failed', 1230));
  items.push(call('t1', 'todo', { items: [] }, 'ok', 'completed', 1231));
  items.push(call('t2', 'task', { action: 'wait' }, 'waited', 'completed', 1232));
  items.push(call('m1', 'mcp__srv__lookup', { q: 1 }, 'found', 'completed', 1233));
  items.push({ type: 'mcpToolCall', id: 'm2', server: 'srv', tool: 'other', arguments: { a: 1 }, result: { ok: true }, meta: { status: 'completed', at: 1234 } });
  items.push({ type: 'webSearch', id: 'ws', query: 'rust twin', meta: { status: 'completed', at: 1235 } });
  items.push({ type: 'subAgentActivity', id: 'sa', agent: 'worker', threadId: 'th2', meta: { status: 'completed', at: 1236 } });
  items.push({ type: 'agentJob', id: 'aj', tag: 'job', taskId: 't9', meta: { status: 'completed', at: 1237 } });
  items.push({ type: 'contextCompaction', id: 'cc', meta: { at: 1300 } });
  items.push({ type: 'reasoning', id: 'rs', summary: ['x'], content: [], meta: {} });
  items.push(turnEnd('te', { checkpointId: 'u1', verb: 'Worked', meta: { at: 2000, ext: { clientSubmissionId: 'sub-u1', toolCount: 15 } } }));
  return items;
}

function liveRun() {
  const live = (callId, extra = {}) => ({ live: true, callId, ...extra });
  return [
    snapshot([user('u1', 'read some files')]),
    note('turn/started', { turn: { id: 'turn' } }),
    started(call('c1', 'read', { path: 'a.ts' }, undefined, 'inProgress', 1000, live('k1', { startedAt: 1000 }))),
    started(call('c2', 'grep', { pattern: 'x' }, undefined, 'inProgress', 1001, live('k2', { startedAt: 1001 }))),
    completed(call('c2', 'grep', { pattern: 'x' }, 'a.ts:1:x', 'completed', 1001, live('k2', { startedAt: 1001, completedAt: 1050 }))),
    completed(call('c1', 'read', { path: 'a.ts' }, '1\tone', 'completed', 1000, live('k1', { startedAt: 1000, completedAt: 1060 }))),
    started(call('c3', 'bash', { command: 'false' }, undefined, 'inProgress', 1002, live('k3', { startedAt: 1002 }))),
    completed(call('c3', 'bash', { command: 'false' }, '[exit code: 1]\nnope', 'failed', 1002, live('k3', { startedAt: 1002, completedAt: 1070 }))),
    started({ type: 'agentMessage', id: 'am', text: '', meta: { at: 1100, model: 'm1' } }),
    delta('am', 'Done.\nNext'),
    delta('am', ' line'),
    completed(said('am', 'Done.\nNext line', 1100, { model: 'm1' })),
    started(call('c4', 'edit', { path: 'b.ts' }, undefined, 'inProgress', 1200, live('k4'))),
    completed(call('c4', 'edit', { path: 'b.ts' }, 'Updated b.ts', 'completed', 1200, live('k4', { uiDiff: '-a\n+b', completedAt: 1210 }))),
    completed(turnEnd('te')),
    note('turn/completed', { turn: { id: 'turn', status: 'completed' } }),
  ];
}

function stopDuringTools() {
  const live = (callId, extra = {}) => ({ live: true, callId, ...extra });
  return [
    snapshot([user('u1', 'run it')]),
    note('turn/started', { turn: { id: 'turn' } }),
    started(call('c1', 'bash', { command: 'sleep 100' }, undefined, 'inProgress', 1000, live('k1'))),
    started(call('c2', 'read', { path: 'a' }, undefined, 'inProgress', 1001, live('k2'))),
    completed(call('c1', 'bash', { command: 'sleep 100' }, 'Error: aborted', 'interrupted', 1000, live('k1', { completedAt: 1500 }))),
    completed(call('c2', 'read', { path: 'a' }, '[Request interrupted by user]', 'interrupted', 1001, live('k2', { completedAt: 1500 }))),
    completed(user('u2', '[Request interrupted by user]', 1600, {})),
    completed(turnEnd('te', { status: 'interrupted' })),
    note('turn/completed', { turn: { id: 'turn', status: 'interrupted' } }),
  ];
}

const FEEDS = () => [
  record('interleaved-deltas', [
    snapshot([]),
    note('turn/started', { turn: { id: 'turn' } }),
    started({ type: 'agentMessage', id: 'm1', text: '', meta: { at: 1, provider: 'p', model: 'm' } }),
    delta('m1', 'Hel'),
    started({ type: 'agentMessage', id: 'm2', text: 'seed', meta: { at: 2 } }),
    delta('m1', 'lo'),
    delta('m2', ' 😀\nsecond'),
    delta('m2', ' line\n'),
    completed(said('m1', 'Hello', 1)),
    completed(said('m2', 'seed 😀\nsecond line\n', 2)),
    delta('ghost', 'unknown id'),
    delta('ghost', '\nmore'),
    note('turn/completed', { turn: { id: 'turn', status: 'completed' } }),
    delta('after', '   '),
    completed(said('after', '   ')),
  ]),
  record('out-of-order-results', [
    snapshot([user('u1', 'go')]),
    completed(call('c2', 'read', { path: 'two' }, '2\ttwo', 'completed', 1002)),
    started(call('c1', 'read', { path: 'one' }, undefined, 'inProgress', 1001)),
    completed(call('c3', 'grep', { pattern: 'x' }, 'f:1:x', 'completed', 1003)),
    completed(call('c1', 'read', { path: 'one' }, '1\tone', 'completed', 1001)),
    completed(call('c1', 'read', { path: 'one' }, '1\tone again', 'completed', 1001)),
    completed(call('c4', 'bash', { command: 'x' }, 'Error: boom', 'failed', 1004)),
    started(call('c5', 'bash', { command: 'sleep 1' }, undefined, 'inProgress', 1005)),
    completed(said('a1', 'fine', 1100)),
    completed(call('c5', 'bash', { command: 'sleep 1' }, '[exit code: 0]\nok', 'completed', 1005)),
    completed({ type: 'toolCall', id: 'noid-1', name: 'read', input: { path: 'z' }, output: 'z', meta: { status: 'completed' } }),
    completed({ type: 'weird', id: 'x' }),
    note('thread/unknown', { value: 1 }),
  ]),
  record('aggregate-merges-restored', [snapshot(restoredRun())]),
  record('aggregate-merges-restored-by-completion', [snapshot([]), ...restoredRun().map((item) => completed(item))]),
  record('aggregate-merges-live', liveRun()),
  record('stop-during-tools', stopDuringTools()),
  record('history-reset', [
    snapshot([user('u1', 'one'), said('a1', 'two'), user('u2', 'three'), said('a2', 'four')], { title: 'Reset me' }, true),
    note('turn/started', { turn: { id: 'turn' } }),
    started({ type: 'agentMessage', id: 'live', text: 'typing\npar', meta: {} }),
    note('thread/historyReset', { reason: 'rewind', fromItemId: 'a1', hasOlder: true }),
    started({ type: 'agentMessage', id: 'live2', text: 'again', meta: {} }),
    note('thread/historyReset', { reason: 'rewind', fromItemId: 'gone', hasOlder: false }),
    completed(user('u9', 'after the reset')),
    note('thread/historyReset', { reason: 'clear', hasOlder: false }),
    completed(said('a9', 'fresh')),
    note('thread/historyReset', { reason: 'clear', fromItemId: null }),
  ]),
  record('approvals', [
    snapshot([user('u1', 'run things')]),
    { ...note('thread/runtime/updated', { value: { busy: true } }), requests: [ask('r2', 2), ask('r1', 1), ask('far', 0, {}, 'elsewhere'), ask('sub', 3, { surfaceThreadId: T, threadId: 'worker' })] },
    { ...note('thread/approvals/updated', { value: { toolApprovalResult: { id: 'r1', decision: 'allow' }, handoffQuestions: [{ q: 1 }] } }), requests: [ask('r2', 2), ask('sub', 3, { surfaceThreadId: T, threadId: 'worker' })] },
    { ...note('thread/frame', {}), requests: [question('q1', 1), ask('r2', 2)] },
    { ...note('thread/approvals/updated', { value: {} }), requests: [] },
    { ...note('thread/frame', { structureChanged: true }), requests: [ask('same-a', 5, { expiresAt: 9 }), ask('same-b', 5)] },
  ]),
  record('sections', [
    snapshot(
      [user('u1', 'hi')],
      {
        runtime: { busy: true, spinner: { label: 'Thinking', since: 1 }, toasts: [{ id: 't' }] },
        route: { sessionProvider: 'anthropic', sessionModel: 'm', cwd: '/w', effort: 'high' },
        context: { contextPercent: 12, stats: { a: 1 } },
        agents: { agentWorkers: [{ id: 'w' }] },
        workflow: { workflow: 'w1', orchestrationMode: 'solo' },
        approvals: { handoffQuestions: [] },
        todo: { items: [1] },
        goal: { objective: 'o' },
        quotaResume: { at: 1 },
        shellJobs: { count: 1, elapsedLabel: '1s', jobs: [], finished: [] },
        workspace: { root: '/w' },
        promptRestore: { text: 'p' },
        providerAccountChange: { from: 'a', to: 'b' },
        remoteEnabled: true,
        setupUiRequest: { id: 's', at: 1 },
        title: 'Titled',
        promptHistoryList: ['b', 'a'],
        queued: [{ id: 'q1', clientSubmissionId: 'sub1', enqueuedAt: 7, text: 'next', mode: 'steer', priority: 'now', images: [{ n: 1 }], source: 'bot' }, { id: 'shaped', text: 'kept' }],
      },
      true
    ),
    note('thread/runtime/updated', { value: { busy: false } }),
    note('thread/runtime/updated', {}),
    note('thread/route/updated', { value: { sessionProvider: null, model: 'x' } }),
    note('thread/context/updated', { value: { contextTokens: 5 } }),
    note('thread/agents/updated', { value: null }),
    note('thread/workflow/updated', { value: { pendingWorkflowSwitch: { to: 'x' } } }),
    note('thread/todo/updated', { value: null }),
    note('thread/goal/updated', { value: { objective: 'o2' } }),
    note('thread/goal/cleared'),
    note('thread/quotaResume/updated', { value: { at: 2 } }),
    note('thread/shellJobs/updated', { value: null }),
    note('thread/workspace/updated', { value: { root: '/x' } }),
    note('thread/promptRestore', { value: null }),
    note('thread/providerAccount/changed', { value: { from: 'b', to: 'c' } }),
    note('thread/remote/updated', { value: false }),
    note('thread/setupUiRequest/updated', { value: null }),
    note('thread/name/updated', { title: 'Renamed' }),
    note('thread/name/updated', { title: 5 }),
    note('thread/queue/changed', { queued: [{ id: 'q2', enqueuedAt: 8, text: 'later', mode: '', priority: 0 }, 'odd', null] }),
    note('thread/queue/changed', {}),
    note('thread/promptHistory/updated', { value: { kind: 'added', prompt: '  a  ' } }),
    note('thread/promptHistory/updated', { value: { kind: 'added', prompt: 'c\td' } }),
    note('thread/promptHistory/updated', { value: { kind: 'replaced', prompts: ['x', 'y'] } }),
    note('thread/promptHistory/updated', { value: { kind: 'added', prompt: 5 } }),
    note('thread/promptHistory/updated', { value: { kind: 'other', prompt: 'z' } }),
    note('thread/frame', {}),
    note('thread/frame', { structureChanged: true }),
    { ...note('thread/roomView/updated', { value: { busy: true, toolApproval: { id: 'room-card' }, typing: { kind: 'typing', id: 'ty', speaker: 'bo' }, handoffQuestions: [{ q: 2 }] } }), hostShellJobs: { count: 2, elapsedLabel: '2s', jobs: [{ id: 'j' }], finished: [] } },
    note('thread/roomView/updated', { value: { busy: false, handoffQuestions: [] } }),
    note('thread/roomView/updated', { value: null }),
    note('thread/remote/updated', { value: 'yes' }),
  ]),
  record('user-rows', [
    snapshot([
      { type: 'userMessage', id: 'core-1', clientSubmissionId: 'sub-1', content: [{ type: 'text', text: 'see ' }, { type: 'pastedText', text: 'this' }, { type: 'attachment', kind: 'image', filename: 'p.png', blob: { digest: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 12 }, original: { digest: `sha256:${'b'.repeat(64)}`, mediaType: 'image/jpeg' } }, { type: 'attachment', blob: { digest: 'zz', mediaType: '' } }], appliedSkills: ['s1', '', 5], device: 'phone', checkpointId: 'cp', details: { sender: 'bo', fromAgent: 'ag' }, meta: { at: 5, messageId: 'mid', model: 'm', ext: { extra: true } } },
      { type: 'userMessage', id: 'st', content: [{ type: 'text', text: 'steer' }], meta: { source: 'steering', at: 6 } },
      { type: 'userMessage', id: 'tn', content: [{ type: 'text', text: 'Error: nope' }], meta: { source: 'task-notification', at: 7, ext: { messageId: 'm7', execution: { id: 'x1', surface: 'Shell', status: 'Done' } } } },
      { type: 'userMessage', id: 'hr', content: [], details: { source: 'held-request', heldRequest: { id: 'h1', status: 'denied', tool: 'bash', target: 'rm' } }, meta: { at: 8 } },
      { type: 'statusRow', id: 'sr', kind: 'notice', meta: { label: 'L', detail: 'D', at: 9, agent: 'a' } },
      { type: 'roomRow', id: 'rr', text: 'hello', room: { kind: 'user', fromSession: true, fromAgent: 'ag', to: ['x', 'y'], toName: ['X'] }, attachments: [{ id: 'c'.repeat(64), kind: 'file', name: 'f', size: 1 }], images: [{ i: 1 }], reactions: [{ agentId: 'a1', emoji: '👍', at: 3 }], meta: { messageId: 'rm', at: 10 } },
    ]),
  ]),
  record('second-thread', [snapshot([said('a', 'first')], {}, false, 'one'), snapshot([said('b', 'second')], { title: 'Two' }, false, 'two'), completed({ ...said('c', 'third') })]),
];

// ───────────────────────────── the recording ─────────────────────────────

const feeds = [...sessionStateFeeds(), ...liveTurnFeeds(), ...rowsGoldenFeeds(), ...FEEDS()];
// One feed per line group and one step per line, so a difference reads as one line of a diff.
const text = ['{', ' "feeds": [', feeds.map((feed) => `  {"name": ${JSON.stringify(feed.name)}, "steps": [\n${feed.steps.map((step) => `   ${JSON.stringify(step)}`).join(',\n')}\n  ]}`).join(',\n'), ' ]', '}', ''].join('\n');
const check = flag('--check');
const out = flag('--out');
if (check) {
  if (readFileSync(resolve(check), 'utf8').replace(/\r\n/g, '\n') !== text) {
    console.error(`record-fold: ${check} differs from the recording of ${tree}`);
    process.exit(1);
  }
} else if (out) writeFileSync(resolve(out), text);
else process.stdout.write(text);
