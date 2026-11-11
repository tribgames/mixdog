#!/usr/bin/env node
// Records Node's tool dispatch for the k1 UNTESTED eager-dispatch.test.mjs (gaps-tools.md row 16, section 3
// `mixdog-agent`): the barrier order of calls started together, the Computer Use cardinality, and the repeat-failure
// signature.
//
// The order cases run the test's own calls through Node's real `createEagerDispatcher` with tools that block until the
// recorder releases them, and record what had started and ended at each point the test checks; the cardinality batch
// runs through Node's `processToolBatch`. The signature case drives Node's `agentLoop` (the guard's production path)
// with failing calls on a relative and an absolute path and on two alternating paths, and records every answer.
//
//   node benchmarks/rust-core/recorders/record-eager-dispatch-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/eager-dispatch-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-eager-dispatch-cases.mjs';
const SESSION = 'src/runtime/agent/orchestrator/session';
const TEST = `${SESSION}/eager-dispatch.test.mjs`;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-eager-dispatch-cases-'));

const { createEagerDispatcher } = await importFrom(tree, `${SESSION}/eager-dispatch.mjs`);
const { processToolBatch } = await importFrom(tree, `${SESSION}/tool-batch.mjs`);
const { agentLoop } = await importFrom(tree, `${SESSION}/agent-loop.mjs`);
const { setInternalToolsProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-tools.mjs');

function gate() {
  let release;
  return { promise: new Promise((resolve) => (release = resolve)), release };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function dispatcher(executeToolFn) {
  return createEagerDispatcher({
    tools: [],
    cwd: process.cwd(),
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    crossTurnCalls: new Map(),
    getIterations: () => 1,
    getNextIteration: () => 1,
    repeatFailLimit: 3,
    executeToolFn,
  });
}
const settleAll = (d) => Promise.all([...d.pending.values()].map((entry) => entry.promise));

const cases = [];
const excluded = {};

// Git mutation, then file patch, then shell verification: each waits for the one before.
{
  const gates = { git: gate(), apply_patch: gate() };
  const events = [];
  const d = dispatcher(async (name) => {
    events.push(`${name}:start`);
    await gates[name]?.promise;
    events.push(`${name}:end`);
    return { result: 'ok', explicitSuccess: true };
  });
  const calls = [
    { id: 'git', name: 'git', arguments: { command: 'git add --all' } },
    { id: 'patch', name: 'apply_patch', arguments: { patch: 'test' } },
    { id: 'shell', name: 'shell', arguments: { command: 'git status' } },
  ];
  const checkpoints = [];
  d.startEagerRun(calls, 0, new Set());
  await tick();
  checkpoints.push({ released: null, events: [...events] });
  gates.git.release();
  await tick();
  checkpoints.push({ released: 'git', events: [...events] });
  gates.apply_patch.release();
  await settleAll(d);
  checkpoints.push({ released: 'apply_patch', events: [...events] });
  cases.push({ case: 'eager dispatch serializes Git mutations, file edits, and shell verification', kind: 'order', calls, checkpoints });
}

// Same-file edits (case variants) wait for each other; an edit of another file runs alongside.
{
  const first = gate();
  const events = [];
  const d = dispatcher(async (_name, a) => {
    events.push(`start:${a.file_path}#${a.old_string}`);
    if (a.old_string === 'a1') await first.promise;
    events.push(`end:${a.file_path}#${a.old_string}`);
    return { result: 'ok', explicitSuccess: true };
  });
  const calls = [
    { id: 'e1', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'a1', new_string: 'x' } },
    { id: 'e2', name: 'edit', arguments: { file_path: 'A.TXT', old_string: 'a2', new_string: 'y' } },
    { id: 'e3', name: 'edit', arguments: { file_path: 'b.txt', old_string: 'b1', new_string: 'z' } },
  ];
  const checkpoints = [];
  d.startEagerRun(calls, 0, new Set());
  await tick();
  // Sorted: the different-file edits run in parallel, so their relative order is scheduling, not behaviour; the
  // serialization shows as A.TXT absent while a.txt is held, present once it is released.
  checkpoints.push({ released: null, events: [...events].sort() });
  first.release();
  await settleAll(d);
  checkpoints.push({ released: 'e1', events: [...events].sort() });
  cases.push({ case: 'same-file edits serialize while different-file edits stay parallel', kind: 'edits', calls, checkpoints });
}

// Only the first Computer Use call of a turn runs; the shell call beside it is not held back.
{
  const computer = gate();
  const executed = [];
  const d = dispatcher(async (name, a) => {
    executed.push(`${name}:${a.value}`);
    if (name === 'computer') await computer.promise;
    return 'ok';
  });
  const calls = [
    { id: 'computer-1', name: 'computer', arguments: { value: 1 } },
    { id: 'computer-2', name: 'computer', arguments: { value: 2 } },
    { id: 'shell-1', name: 'shell', arguments: { value: 3 } },
  ];
  const checkpoints = [];
  d.startEagerRun(calls, 0, new Set());
  await tick();
  checkpoints.push({ released: null, events: [...executed].sort() });
  computer.release();
  await settleAll(d);
  checkpoints.push({ released: 'computer-1', events: [...executed].sort() });
  cases.push({ case: 'Computer Use limits its own calls without delaying independent tools', kind: 'computer', calls, checkpoints });
}

// The batch answers every Computer Use call past the first with the cardinality error.
{
  const executed = [];
  const results = [];
  const calls = [
    { id: 'computer-1', name: 'computer', arguments: { value: 1 } },
    { id: 'computer-2', name: 'computer', arguments: { value: 2 } },
  ];
  await processToolBatch({
    calls,
    messages: [],
    tools: [],
    cwd: process.cwd(),
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    iterations: 1,
    assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
    pending: new Map(),
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
    executeToolFn: async (name, a) => {
      executed.push(`${name}:${a.value}`);
      return 'ok';
    },
  });
  cases.push({
    case: 'Computer Use batch returns an error result for every blocked extra call',
    kind: 'batch',
    calls,
    recorded: {
      executed,
      answered: results.map((m) => ({ toolCallId: m.toolCallId, toolKind: m.toolKind, content: m.content })),
    },
  });
}

excluded[`${TEST} :: structured explicit failure reaches the transcript as an error with media intact`] =
  "difference: Node answers a tool's explicit failure with its structured content, text and image, as an error result; a Rust tool failure is a ToolError whose model text is the whole answer, so the image cannot reach the transcript";

// The repeat-failure guard through the loop: a path is one signature whether relative or absolute, and two paths that
// alternate are one cycle.
{
  const CWD = process.cwd();
  const probe = { name: 'probe', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } };
  const runs = {
    paths: ['missing/file.txt', '<cwd>/missing/file.txt', 'missing/file.txt', '<cwd>/missing/file.txt'],
    cycles: ['missing/file.txt', 'missing/other.txt', 'missing/file.txt', 'missing/other.txt', 'missing/file.txt', 'missing/other.txt', 'missing/file.txt', 'missing/other.txt'],
  };
  for (const [label, paths] of Object.entries(runs)) {
    const script = [
      ...paths.map((path, i) => ({ content: '', toolCalls: [{ id: `p${i + 1}`, name: 'probe', arguments: { file_path: path } }] })),
      { content: 'done', toolCalls: [], stopReason: 'end_turn' },
    ];
    let sends = 0;
    const provider = {
      async send() {
        const entry = structuredClone(script[sends++]);
        for (const c of entry.toolCalls) c.arguments.file_path = c.arguments.file_path.replace('<cwd>', CWD);
        return entry;
      },
    };
    const unregister = setInternalToolsProvider({
      tools: [probe],
      executor: async () => {
        throw new Error('missing');
      },
    });
    const messages = [{ role: 'user', content: 'go' }];
    let result;
    try {
      result = await agentLoop(provider, messages, 'fake-model', [probe], null, CWD, {
        session: { id: `repeat-${label}`, owner: 'cli', compaction: { auto: false } },
        sessionId: `repeat-${label}`,
      });
    } finally {
      unregister?.();
      setInternalToolsProvider({ tools: [], executor: async () => null });
    }
    const unCwd = (text) => String(text).split(CWD).join('<cwd>');
    cases.push({
      case: `repeat failure signatures normalize paths and detect alternating cycles (${label})`,
      kind: 'repeat',
      script,
      recorded: {
        content: result.content,
        answered: messages
          .filter((m) => m.role === 'tool')
          .map((m) => ({ toolCallId: m.toolCallId, toolKind: m.toolKind ?? null, content: unCwd(m.content) })),
      },
    });
  }
}

const finalDir = join(FIXTURES_ROOT, 'eager-dispatch-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's tool dispatch at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'eager-dispatch-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "order cases: every start and end at each point the test checks (the parallel-edits and Computer Use cases: sorted, as their parallel calls' order is scheduling); the batch: the calls that ran and every answer (id, kind, text); the repeat cases: every tool answer (id, kind, text with the cwd as <cwd>) and the final text",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`eager-dispatch-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
