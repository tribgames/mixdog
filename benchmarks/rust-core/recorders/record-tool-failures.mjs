#!/usr/bin/env node
// Records `history/tool-failures.jsonl` as Node's production path writes it: real `askSession` turns (the loop, the tool
// executor, `traceAgentTool` -> `traceAgentToolFailure` -> the buffered writer of agent-trace-io.mjs, flushed by its exit hook) against
// a scripted provider (only the provider's `send` is scripted), over every class of failed call the contract names. The scenarios
// are lib/tool-failure-scenarios.mjs, the same file the Rust replay (replay-tool-failures.mjs) is given.
//
// The turns run in a child process, twice, in two fresh profiles but the same workspace path (the workspace path is part of the
// rows: it is `cwd` and it is inside the tool texts). Two recordings of the same input show which values vary on their own; the
// golden names them, and the replay may replace only those.
//
//   node benchmarks/rust-core/recorders/record-tool-failures.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/tool-failures/golden.json (+ MANIFEST.json).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-tool-failures.mjs';
const scratch = process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir();
const WORKSPACE = join(scratch, 'mixdog-tool-failures-ws');
const { FILES, MODEL, scenarios } = await import('./lib/tool-failure-scenarios.mjs');

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { abortSessionTurn } = await imp(`${S}session/manager/session-close.mjs`);
  const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
  const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { makeInvalidToolArgsMarker } = await imp(`${S}providers/lib/openai-tool-args.mjs`);

  const reply = (step) => ({
    content: step.text,
    ...(step.calls.length
      ? {
          toolCalls: step.calls.map((c) => ({
            id: c.id,
            name: c.name,
            // The provider's own parse of an argument text that is not JSON (parseCompletedToolCallArgumentsJson).
            arguments: c.raw === undefined ? c.args : makeInvalidToolArgsMarker(c.raw, parseError(c.raw)),
          })),
          stopReason: 'tool_use',
        }
      : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const parseError = (raw) => {
    try {
      JSON.parse(raw);
    } catch (error) {
      return error.message;
    }
    throw new Error(`${raw} parses`);
  };
  const results = [];
  for (const [index, scenario] of scenarios(WORKSPACE).entries()) {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(WORKSPACE, name), text);
    const providerName = `tool-failures-${index}`;
    const sends = [];
    const provider = {
      name: providerName,
      contextWindow: 128000,
      async send(messages) {
        sends.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return JSON.parse(JSON.stringify(reply(scenario.replies[sends.length - 1])));
      },
    };
    let sessionId;
    let outcome;
    await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
      const session = createSession({ provider: providerName, model: MODEL, cwd: WORKSPACE, skipSkills: true, schemaAllowedTools: modelToolSchemaAllowlist('headless'), workflow: { id: 'headless', delegatesAgents: false } });
      sessionId = session.id;
      if (scenario.hook) session.beforeToolHook = async () => scenario.hook;
      const turn = askSession(session.id, 'go', null, null, null, null, scenario.approval ? { onToolApproval: async () => scenario.approval } : {});
      turn.catch(() => {});
      if (scenario.abortWhenFile) {
        // The tool has started when it has made its file: a directory event, not a wait.
        await new Promise((resolve) => {
          const watcher = watch(WORKSPACE, (_event, name) => {
            if (name !== scenario.abortWhenFile) return;
            watcher.close();
            resolve();
          });
        });
        abortSessionTurn(session.id);
      }
      try {
        outcome = { answer: (await turn).content };
      } catch (error) {
        outcome = { threw: error.message.split(sessionId).join('<session>') };
      }
    });
    const toolMessages = sends.slice(1).map((messages) => {
      const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
      return messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    });
    results.push({ name: scenario.name, session: sessionId, outcome, sends: sends.length, toolMessages });
  }
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'results.json'), JSON.stringify(results));
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);

function record(label) {
  const sandbox = mkdtempSync(join(scratch, `rec-tool-failures-${label}-`));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, MIXDOG_RECORDER_SCRATCH: scratch, MIXDOG_SKIP_USER_DATA_BACKUP: '1' };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[name] = join(sandbox, name.toLowerCase());
  mkdirSync(env.MIXDOG_DATA_DIR, { recursive: true });
  const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--child'], { env, encoding: 'utf8', timeout: 300_000 });
  if (run.status !== 0) throw new Error(`recording ${label} failed (${run.status}): ${run.stderr || run.stdout}`);
  const file = readFileSync(join(env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl'), 'utf8');
  const results = JSON.parse(readFileSync(join(env.MIXDOG_DATA_DIR, 'results.json'), 'utf8'));
  rmSync(sandbox, { recursive: true, force: true });
  return { file, results };
}

const a = record('a');
const b = record('b');
const rowsA = a.file.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const rowsB = b.file.split('\n').filter(Boolean).map((line) => JSON.parse(line));
if (rowsA.length !== rowsB.length) throw new Error(`two recordings wrote ${rowsA.length} and ${rowsB.length} rows`);
// What differs between the two recordings, key by key; anything else differing is a fact of the scenario, not noise.
const varying = new Set();
rowsA.forEach((row, i) => {
  if (JSON.stringify(Object.keys(row)) !== JSON.stringify(Object.keys(rowsB[i]))) throw new Error(`row ${i}: key order differs between recordings`);
  for (const key of Object.keys(row)) if (JSON.stringify(row[key]) !== JSON.stringify(rowsB[i][key])) varying.add(key);
});
const named = [...varying].sort();
const allowed = ['session_id', 'tool_ms', 'ts'];
if (named.some((key) => !allowed.includes(key))) throw new Error(`unexpected varying keys ${named.join(', ')}: look at them before replacing anything`);
// The session ids: one per scenario, never shared, and different between the recordings.
const sessionsOf = (rows) => [...new Set(rows.map((r) => r.session_id))];
if (sessionsOf(rowsA).some((id) => sessionsOf(rowsB).includes(id))) throw new Error('a session id repeated between recordings');

const finalDir = join(FIXTURES_ROOT, 'tool-failures');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'history/tool-failures.jsonl as the Node tool loop writes it (real askSession turns over a scripted provider), recorded twice at b6f10295a',
  workspace: WORKSPACE,
  scenarios: scenarios(WORKSPACE),
  files: FILES,
  model: MODEL,
  recordings: [a, b].map((r) => ({ file: r.file, results: r.results.map(({ session, ...rest }) => rest), sessions: r.results.map((x) => x.session) })),
  varying: named,
});
writeSetManifest(stage, { set: 'tool-failures', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { rows: rowsA.length, varying: named } });
commitStage(stage, finalDir);
console.log(`rows=${rowsA.length} varying=${named.join(',')}`);
process.exit(0);
