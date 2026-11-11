#!/usr/bin/env node
// Records Node's agent loop for the k1 UNTESTED agent-loop test files (gaps-rest.md agents rows; gaps-tools.md section 3
// `mixdog-agent`): agent-loop-carried-report, agent-loop-output-escalation, agent-loop-request-boundaries,
// agent-loop-step-limit and agent-loop.test.mjs.
//
// Each case is the test's own provider script, written as data (the `script` entries below) so the Rust replay drives
// the same sends; the recorder runs it through Node's real `agentLoop` at b6f10295a with the test's options and records
// the whole outcome: the transcript, the result (or the thrown error and the report it carries), every request the loop
// built, and what reached the test's callbacks.
//
//   node benchmarks/rust-core/recorders/record-agent-loop-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/agent-loop-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-agent-loop-cases.mjs';
const SESSION = 'src/runtime/agent/orchestrator/session';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-agent-loop-cases-'));
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';

const { agentLoop } = await importFrom(tree, `${SESSION}/agent-loop.mjs`);
const { processToolBatch } = await importFrom(tree, `${SESSION}/tool-batch.mjs`);
const { beginTodoTurn } = await importFrom(tree, `${SESSION}/loop/no-tool-turn/todo-check.mjs`);
const { HIDDEN_AGENT_NAMES } = await importFrom(tree, `${SESSION}/loop/hidden-agents.mjs`);
const { heartbeatTurnLimits } = await importFrom(tree, `${SESSION}/manager/ask-turn-loop-options.mjs`);
const { executeTodoTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/todo-list.mjs');
const { setInternalToolsProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-tools.mjs');
const { markHeartbeatSession } = await importFrom(tree, 'src/runtime/shared/routine-trigger.mjs');

const [HIDDEN] = [...HIDDEN_AGENT_NAMES];

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p?.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
  return String(content ?? '');
}

function normalizeMessage(m) {
  const meta = m.meta && typeof m.meta === 'object' ? m.meta : null;
  return {
    role: m.role,
    content: normalizeContent(m.content),
    source: meta?.source ?? (typeof m.meta === 'string' ? m.meta : null),
    attempt: meta?.attempt ?? null,
    toolCalls: (m.toolCalls || []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    toolCallId: m.toolCallId ?? null,
    toolKind: m.toolKind ?? null,
    turnReminder: m.turnReminder ?? null,
  };
}

const resultOf = (result) =>
  result && {
    content: result.content ?? '',
    historyContent: result.historyContent ?? null,
    reportContent: result.reportContent ?? null,
    terminationReason: result.terminationReason ?? null,
    iterations: result.iterations,
    toolCallsTotal: result.toolCallsTotal,
    maxOutputRecoveryAttempts: result.maxOutputRecoveryAttempts ?? null,
    providerContinuations: result.providerContinuations ?? 0,
  };

// The tools a case's run has: `lookup` answers `Found item <item>.` through the internal-tools provider, `lookup-found`
// answers `Found.` through the loop's executeTool.
const TOOLS = {
  lookup: { name: 'lookup', inputSchema: { type: 'object', properties: { item: { type: 'integer' } } } },
  'lookup-found': { name: 'lookup', inputSchema: { type: 'object', properties: {} } },
};

/**
 * One run of a case through `agentLoop`. Script entries: `{content, toolCalls, stopReason}` as the provider returns
 * it, plus `delta` (the provider streams the content through `onTextDelta` first), `todoDone` (the session's todo item
 * is marked done before the send answers), `abort` (the run's signal is aborted before the send answers, with
 * `abortReason` as the reason when given) and `throw` (the send throws: `{message, incomplete}`).
 */
async function runCase(c, provider, runIndex) {
  const run = c.runs?.[runIndex] ?? {};
  const session = { contextWindow: 200_000, rawContextWindow: 200_000, compaction: { auto: false }, ...c.session };
  if (c.session.agent === '<hidden>') session.agent = HIDDEN;
  if (c.todo) {
    executeTodoTool(session, { op: 'init', items: c.todo });
    beginTodoTurn(session, { genuine: true });
  }
  provider.session = session;
  const messages = structuredClone(run.messages ?? c.messages);
  const out = { deltas: [], resets: [], assistantTexts: [], committed: [], drained: [] };
  const opts = { session, sessionId: session.id };
  const tools = (c.tools ?? []).map((t) => TOOLS[t]);
  let unregister = null;
  if (c.tools?.includes('lookup')) {
    unregister = setInternalToolsProvider({ tools, executor: async (_name, a) => `Found item ${a.item}.` });
  }
  if (c.limits) {
    const { wrapUpOffsetMs, ...limits } = c.limits;
    opts.turnLimits = { ...limits, ...(wrapUpOffsetMs === undefined ? {} : { wrapUpAt: Date.now() + wrapUpOffsetMs }) };
  }
  if (c.steer) {
    let queued = [...c.steer['pre-send']];
    opts.drainSteering = (_id, { stage }) => {
      if (stage !== 'pre-send' || queued.length === 0) return [];
      out.drained.push(stage);
      const taken = queued;
      queued = [];
      return taken;
    };
  }
  if (c.textDelta) opts.onTextDelta = (text) => out.deltas.push(text);
  if (c.textReset === 'withdraw') {
    opts.onTextReset = ({ chars, reason }) => {
      out.resets.push({ chars, reason });
      return true;
    };
  } else if (c.textReset === 'refuse') {
    opts.onTextReset = ({ chars, reason }) => {
      out.resets.push({ chars, reason });
      return false;
    };
  }
  if (c.liveProjection) opts.liveProjection = true;
  if (c.watchAssistant) {
    opts.onAssistantText = (text) => out.assistantTexts.push(text);
    opts.onAssistantMessageCommitted = (message) => out.committed.push(normalizeMessage(message));
  }
  if (c.rewrite) {
    opts.onToolResult = (message) => {
      if (message.role !== 'tool') return;
      if (c.rewrite.toolCallId && message.toolCallId !== c.rewrite.toolCallId) return;
      if (c.rewrite.toolKind) message.toolKind = c.rewrite.toolKind;
      message.content = c.rewrite.content;
    };
  }
  if (c.abortable) {
    provider.controller = new AbortController();
    opts.signal = provider.controller.signal;
  }
  let result;
  try {
    result = await agentLoop(provider, messages, 'fake-model', tools, c.tools?.includes('lookup-found') ? async () => 'Found.' : null, process.cwd(), opts);
    out.result = resultOf(result);
  } catch (error) {
    out.error = { message: String(error?.message ?? error), carriedReport: error?.carriedReport ?? null };
  } finally {
    unregister?.();
  }
  out.messages = messages.map(normalizeMessage);
  for (const key of ['deltas', 'resets', 'assistantTexts', 'committed', 'drained']) if (out[key].length === 0) delete out[key];
  return out;
}

function scriptedProvider(c) {
  const p = {
    sends: 0,
    requests: [],
    escalatedMaxTokens: c.escalated === undefined ? undefined : () => c.escalated,
    async send(sent, _model, _tools, sendOpts) {
      p.sends += 1;
      p.requests.push({
        override: sendOpts?.maxOutputTokensOverride ?? null,
        toolChoice: sendOpts?.toolChoice ?? null,
        messages: sent.map((m) => ({ role: m.role, content: normalizeContent(m.content), toolCallId: m.toolCallId ?? null })),
      });
      const index = c.repeatLast ? Math.min(p.sends, c.script.length) - 1 : p.sends - 1;
      const entry = c.script[index];
      if (!entry) throw new Error(`script exhausted at send ${p.sends}`);
      if (entry.todoDone) executeTodoTool(p.session, { op: 'done', item: entry.todoDone });
      if (entry.abort) p.controller.abort(entry.abortReason === undefined ? undefined : new Error(entry.abortReason));
      if (entry.delta) sendOpts?.onTextDelta?.(entry.content);
      if (entry.throw) {
        if (entry.throw.incomplete) {
          throw Object.assign(new Error(entry.throw.message), {
            providerIncomplete: true,
            code: 'PROVIDER_INCOMPLETE',
            finishReason: 'MALFORMED_FUNCTION_CALL',
            partialContent: '',
          });
        }
        throw new Error(entry.throw.message);
      }
      const { content, toolCalls, stopReason } = entry;
      return { content, toolCalls: structuredClone(toolCalls ?? []), ...(stopReason ? { stopReason } : {}) };
    },
  };
  if (p.escalatedMaxTokens === undefined) delete p.escalatedMaxTokens;
  return p;
}

async function record(c) {
  const provider = scriptedProvider(c);
  const runs = [];
  for (let i = 0; i < (c.runs?.length ?? 1); i++) runs.push(await runCase(c, provider, i));
  return { ...c, recorded: { runs, requests: provider.requests } };
}

const cases = [];
const excluded = {};
const add = (test, name, spec) => cases.push({ test: `${SESSION}/${test}`, case: name, ...spec });
const turn = (content, toolCalls = [], stopReason) => ({ content, toolCalls, ...(stopReason ? { stopReason } : {}) });
const end = (content) => turn(content, [], 'end_turn');
const user = (content) => ({ role: 'user', content });

// agent-loop-carried-report.test.mjs
{
  const T = 'agent-loop-carried-report.test.mjs';
  const REPORT = 'Status: done\n\nFull report.';
  const worker = (n) => ({ id: `sess_carried_report_${n}`, owner: 'cli', agent: 'worker' });
  const call = (send, name) => ({ id: `c${send}`, name, arguments: name === 'todo' ? { op: 'view' } : {} });
  const base = (n, rest) => ({ session: worker(n), todo: ['Only step'], messages: [user('do the work')], script: [end(REPORT), ...rest] });
  add(T, 'an empty end after only todo bookkeeping delivers the report as the result',
    base(1, [{ ...turn('', [call(2, 'todo')]), todoDone: 'Only step' }, end('')]));
  add(T, 'new work after the report that ends empty stays a failure and carries the report',
    { ...base(2, [turn('', [call(2, 'read')]), end('')]), repeatLast: true });
  add(T, 'a Lead question taken in before the next send ends the bookkeeping exemption', {
    ...base(3, [{ ...turn('', [call(2, 'todo')]), todoDone: 'Only step' }, end('')]),
    repeatLast: true,
    steer: { 'pre-send': ['Lead: one more question?'] },
  });
  add(T, 'a capped turn that overruns after the report keeps it: bookkeeping completes, new work fails (bookkeeping)', {
    ...base(4, [2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => turn('', [call(s, 'todo')]))),
    limits: { maxToolCalls: 8, wrapUpOffsetMs: -1 },
  });
  add(T, 'a capped turn that overruns after the report keeps it: bookkeeping completes, new work fails (new work)', {
    ...base(5, [2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => turn('', [call(s, s === 2 ? 'todo' : 'read')]))),
    limits: { maxToolCalls: 8, wrapUpOffsetMs: -1 },
  });
  add(T, 'a turn that throws after the report carries it on the error to the failed task', {
    ...base(6, [turn('', [call(2, 'todo')]), { throw: { message: 'provider exploded' } }]),
  });
  excluded[`${SESSION}/${T} :: a turn that throws after the report carries it on the error to the failed task :: reconcileJobStreamStalled`] =
    "the failed task's settlement from the carried report belongs to the agent tool's reconcile (job-task-reconcile cases); the loop half (the error and its carried report) is replayed";
}

// agent-loop-output-escalation.test.mjs
{
  const T = 'agent-loop-output-escalation.test.mjs';
  const lead = { id: 'output-escalation-test', owner: 'cli' };
  const cut = turn('', [], 'max_tokens');
  const base = (script, extra = {}) => ({ session: lead, escalated: 128_000, messages: [user('go')], script, repeatLast: true, ...extra });
  add(T, 'a transport retry of the escalated send does not carry the override again',
    base([cut, { throw: { message: 'Gemini response incomplete: finishReason=MALFORMED_FUNCTION_CALL', incomplete: true } }, end('done')]));
  add(T, 'a thrown error on the escalated send leaves no override for any later send',
    base([cut, { throw: { message: 'boom: not recoverable' } }, end('later')], { runs: [{ messages: [user('go')] }, { messages: [user('again')] }] }));
  add(T, 'an abort during the escalated send leaves no override behind',
    base([cut, { throw: { message: 'aborted' }, abort: true }, end('later')], { abortable: true }));
  add(T, 'escalating withdraws the text the cut turn already streamed, so the live row shows no stale copy',
    base([{ ...turn('partial text', [], 'max_tokens'), delta: true }, { ...end('full answer'), delta: true }], { textDelta: true, textReset: 'withdraw' }));
  add(T, 'streamed text the owner cannot withdraw is kept: no escalation, the ladder resumes it (no onTextReset)',
    base([{ ...turn('partial text', [], 'max_tokens'), delta: true }, end('rest')], { textDelta: true }));
  add(T, 'streamed text the owner cannot withdraw is kept: no escalation, the ladder resumes it (onTextReset refuses)',
    base([{ ...turn('partial text', [], 'max_tokens'), delta: true }, end('rest')], { textDelta: true, textReset: 'refuse' }));
  add(T, 'a hidden agent that is cut empty at max_tokens recovers like any other turn',
    base([cut, cut, end('chunk-a|chunk-b')], { session: { ...lead, agent: '<hidden>' } }));
  add(T, 'a hidden agent still ends an ordinary empty turn without a nudge', base([end('')], { session: { ...lead, agent: '<hidden>' } }));
  add(T, 'an empty pause_turn is nudged as an incomplete turn, never escalated or treated as an output limit',
    base([turn('', [], 'pause_turn')]));
}

// agent-loop-request-boundaries.test.mjs
{
  const T = 'agent-loop-request-boundaries.test.mjs';
  const session = { id: undefined, owner: 'cli' };
  add(T, 'ordinary requests preserve the opening user message across tool continuation', {
    session,
    tools: ['lookup-found'],
    messages: [user('Inspect the requested item.')],
    script: [turn('', [{ id: 'lookup-1', name: 'lookup', arguments: {} }], 'tool_calls'), end('done')],
  });
  add(T, 'productive work continues beyond 200 iterations', {
    session,
    tools: ['lookup'],
    messages: [user('Inspect.')],
    script: [
      ...Array.from({ length: 205 }, (_, i) => turn('', [{ id: `lookup-${i + 1}`, name: 'lookup', arguments: { item: i + 1 } }], 'tool_calls')),
      end('All 205 items inspected.'),
    ],
  });
  add(T, 'cancellation still stops a productive loop before dispatching further tools', {
    session,
    tools: ['lookup'],
    abortable: true,
    messages: [user('Inspect.')],
    script: [1, 2].map((n) => ({
      ...turn('', [{ id: `lookup-${n}`, name: 'lookup', arguments: { item: n } }], 'tool_calls'),
      ...(n === 2 ? { abort: true, abortReason: 'requested stop' } : {}),
    })),
  });
}

// agent-loop-step-limit.test.mjs
{
  const T = 'agent-loop-step-limit.test.mjs';
  const ROUNDS = 45;
  const script = [
    ...Array.from({ length: ROUNDS }, (_, i) => turn(`step ${i + 1}`, [{ id: `c${i + 1}`, name: 'probe', arguments: { path: 'a.txt' } }])),
    end('final answer'),
  ];
  for (const id of ['sess-uncapped-failing', 'sess-uncapped-replay']) {
    add(T, `${id}: ${ROUNDS} rounds with no new result run to the model's own final answer`, {
      session: { id, owner: 'agent', agent: 'worker' },
      messages: [user('go')],
      script,
      ...(id === 'sess-uncapped-replay' ? { rewrite: { toolKind: 'normal', content: 'same output' } } : {}),
    });
  }
}

// agent-loop.test.mjs
{
  const T = 'agent-loop.test.mjs';
  const agent = (extra = {}) => ({ id: 'agent-live-projection-test', owner: 'agent', agent: 'worker', ...extra });
  excluded[`${SESSION}/${T} :: Agent dispatch preserves text deltas without requiring live projection`] =
    "unreachable through the Rust provider: the test's provider streams 'secret-preamble' and answers 'final'; a Rust model stream's answer is the text it streamed";
  excluded[`${SESSION}/${T} :: explicit liveProjection permits provider onTextDelta without persisting a session flag`] =
    "unreachable through the Rust provider: the test's provider streams 'live-chunk' and answers 'final'; a Rust model stream's answer is the text it streamed";
  add(T, 'live Agent tool-call turns keep preamble text and surface buffered assistant text', {
    session: agent(),
    liveProjection: true,
    watchAssistant: true,
    messages: [user('inspect')],
    script: [{ ...turn('Now let me look', [{ id: 'c1', name: 'definitely_missing_live_proj_tool', arguments: {} }]), delta: true }, end('final-answer')],
  });
  add(T, 'Agent tool-call turns preserve emitted prose in history and buffered text', {
    session: agent(),
    watchAssistant: true,
    messages: [user('inspect')],
    script: [turn('Now let me look', [{ id: 'c1', name: 'definitely_missing_silent_proj_tool', arguments: {} }]), end('final-answer')],
  });
  add(T, 'successive Browser snapshots keep the already-sent provider prefix unchanged', {
    session: agent({ owner: 'cli', agent: 'lead' }),
    messages: [
      user('browse'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'browser-old', name: 'browser', arguments: { action: 'snapshot' } }] },
      { role: 'tool', toolCallId: 'browser-old', content: 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s1\nold state' },
    ],
    rewrite: { toolCallId: 'browser-new', content: 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s2\nnew state' },
    script: [turn('', [{ id: 'browser-new', name: 'browser', arguments: { action: 'snapshot' } }]), end('done')],
  });
  const calls = (send, count) => Array.from({ length: count }, (_, i) => ({ id: `s${send}c${i}`, name: 'missing_capped_tool', arguments: {} }));
  const lead = (id) => agent({ id, owner: 'cli', agent: 'lead' });
  {
    const id = 'sess_daemon_capped';
    markHeartbeatSession(id);
    const now = Date.now();
    const { turnLimits } = heartbeatTurnLimits(id, now);
    markHeartbeatSession(id, true);
    const { wrapUpAt, ...rest } = turnLimits;
    add(T, "a heartbeat turn's tool calls are capped: calls past the cap never run, then it must reply without tools", {
      session: lead(id),
      limits: { ...rest, wrapUpOffsetMs: wrapUpAt - now },
      messages: [user('heartbeat')],
      script: [turn('', calls(1, 3)), turn('', calls(2, 3)), turn('', calls(3, 3)), end('Two routines failed.')],
    });
    excluded[`${SESSION}/${T} :: a heartbeat turn's tool calls are capped: calls past the cap never run, then it must reply without tools :: heartbeatTurnLimits`] =
      "which session is a heartbeat and the limits it gets are mixdog-core's (run_host/settings.rs); the loop replays the limits Node's heartbeatTurnLimits resolved";
  }
  add(T, 'a capped turn that still calls tools after it was told to reply ends with no reply', {
    session: lead('sess_daemon_overrun'),
    limits: { maxToolCalls: 2 },
    messages: [user('heartbeat')],
    script: [turn('', calls(1, 2)), turn('Let me check more.', calls(2, 2)), turn('', calls(3, 2))],
  });
  add(T, "past a capped turn's wrap-up time no call runs and the next request forbids tools", {
    session: lead('sess_daemon_late'),
    limits: { maxToolCalls: 8, wrapUpOffsetMs: -1 },
    messages: [user('heartbeat')],
    script: [turn('', calls(1, 1)), end('Done.')],
  });
  add(T, 'an uncapped turn never limits its tool calls', {
    session: lead('sess_daemon_free'),
    messages: [user('go')],
    script: [1, 2, 3, 4].map((s) => turn('', calls(s, 3))).concat([end('ok')]),
  });
}

// Cases where the Rust loop differs from Node: recorded here, left out of the replay by name.
const DIFFERENCES = {
  'agent-loop-output-escalation.test.mjs :: streamed text the owner cannot withdraw is kept: no escalation, the ladder resumes it (no onTextReset)':
    "Node's fake provider returns 'rest' without streaming it, so onTextDelta sees only 'partial text'; a Rust model stream carries text only as deltas, so the observer also sees 'rest'",
  'agent-loop-output-escalation.test.mjs :: streamed text the owner cannot withdraw is kept: no escalation, the ladder resumes it (onTextReset refuses)':
    "Node's fake provider returns 'rest' without streaming it, so onTextDelta sees only 'partial text'; a Rust model stream carries text only as deltas, so the observer also sees 'rest'",
  'agent-loop-request-boundaries.test.mjs :: cancellation still stops a productive loop before dispatching further tools':
    "Node rejects with the abort reason ('requested stop'); Rust's run fails with its fixed 'agent loop aborted' (the transcript and requests match)",
  "agent-loop-step-limit.test.mjs :: sess-uncapped-replay: 45 rounds with no new result run to the model's own final answer":
    "Node's onToolResult rewrites the result's toolKind to 'normal' as well as its text; Rust's after_tool hook rewrites only the text, so every result stays an error and the repeat guard notes the 13th",
  'agent-loop.test.mjs :: a batch that crosses the wrap-up time starts none of its later calls':
    "Node checks the wrap-up time before starting each call, so s1c1 and s1c2 are refused once s1c0 ran past it; Rust decides every call of the batch before the first runs, so all three run and answer 'ok'",
};
for (const [key, reason] of Object.entries(DIFFERENCES)) excluded[`${SESSION}/${key}`] = `difference: ${reason}`;

const recorded = [];
for (const c of cases) recorded.push(await record(c));

// A batch that crosses the wrap-up time (agent-loop.test.mjs): the test drives Node's processToolBatch with a clock
// that passes the deadline while the first call runs; the replay drives the same batch through the Rust run.
{
  const T = `${SESSION}/agent-loop.test.mjs`;
  const batchCalls = Array.from({ length: 3 }, (_, i) => ({ id: `s1c${i}`, name: 'missing_capped_tool', arguments: {} }));
  const ran = [];
  const results = [];
  const messages = [];
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await processToolBatch({
      calls: batchCalls,
      toolBatchId: 'batch-cross',
      pending: new Map(),
      messages,
      tools: [],
      cwd: process.cwd(),
      sessionId: 'sess_daemon_cross',
      sessionRef: { agent: 'lead' },
      signal: null,
      opts: {},
      iterations: 1,
      assistantTurnMsg: { role: 'assistant', content: '', toolCalls: batchCalls },
      epoch: { mutation: 0 },
      startEagerRun: () => {},
      crossTurnCalls: new Map(),
      crossTurnCap: 100,
      sessionAgent: null,
      pushToolResultMessage: (message) => results.push(message),
      throwIfAborted: () => {},
      repeatFailLimit: 3,
      dedupStubTotal: 0,
      editCount: 0,
      callsAllowed: 8,
      wrapUpAt: now + 30,
      executeToolFn: async (_name, _args, _cwd, _sessionId, _ref, meta) => {
        ran.push(meta?.toolCallId);
        now += 60;
        return 'ok';
      },
    });
  } finally {
    Date.now = realNow;
  }
  recorded.push({
    test: T,
    case: 'a batch that crosses the wrap-up time starts none of its later calls',
    batch: { calls: batchCalls, wrapUpOffsetMs: 30, toolMs: 60, callsAllowed: 8 },
    recorded: { ran, answered: [...results, ...messages].filter((m) => m?.role === 'tool').map(normalizeMessage) },
  });
}

for (let i = recorded.length - 1; i >= 0; i--) {
  if (`${recorded[i].test} :: ${recorded[i].case}` in excluded) recorded.splice(i, 1);
}

const finalDir = join(FIXTURES_ROOT, 'agent-loop-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's agentLoop at ${NODE_COMMIT}, per case of ${RECORDER}`, hiddenAgent: HIDDEN, cases: recorded });
writeSetManifest(stage, {
  set: 'agent-loop-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "per run: the whole transcript, the result or the thrown error with its carried report, and what reached the test's callbacks; per case: every request the loop built (output override, tool choice, messages); the crossing batch: the calls that ran and every answered tool message",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`agent-loop-cases: ${recorded.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
