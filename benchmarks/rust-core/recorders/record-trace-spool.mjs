#!/usr/bin/env node
// What the agent-trace spool leaves in its file when rows arrive faster than its writes finish (`_appendLocalTrace` /
// `_flushLocalTrace`, src/runtime/agent/orchestrator/agent-trace-io.mjs): the REAL `appendAgentTrace` + `drainAgentTrace` writing an
// explicit trace path. Two thousand rows are appended in one tick, so the 100-line flush starts while its predecessor is still being
// written; a row queued during a write must reach the file once and after the rows before it. Recorded: the rows as given and the
// file's text.
// Rust `mixdog_trace::AgentTrace` (append + flush, from threads) must leave the same text.
//   node benchmarks/rust-core/recorders/record-trace-spool.mjs [--tree <dir>]
// Output: native/core/fixtures/trace-spool/golden.json.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const ROWS = 2000;
const T0 = 1_700_000_000_000;

const sandbox = mkdtempSync(join(tmpdir(), 'trace-spool-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tracePath = join(sandbox, 'trace', 'agent-trace.jsonl');
process.env.MIXDOG_AGENT_TRACE_PATH = tracePath;
process.env.MIXDOG_DIAGNOSTICS = '1';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const recorder = 'benchmarks/rust-core/recorders/record-trace-spool.mjs';
const io = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-trace-io.mjs');

const rows = Array.from({ length: ROWS }, (_, i) => ({ kind: 'spool', ts: T0 + i, sessionId: 'spool', payload: { n: i, text: `row ${i}` } }));
for (const row of rows) io.appendAgentTrace(structuredClone(row));
await io.drainAgentTrace();
const jsonl = readFileSync(tracePath, 'utf8');
if (jsonl.split('\n').length !== ROWS + 1) throw new Error('the trace file does not hold every row once');

const finalDir = join(FIXTURES_ROOT, 'trace-spool');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { rows, jsonl });
writeSetManifest(stage, {
  set: 'trace-spool',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identity,
  extra: { ...recorderProvenance(import.meta.url), exclusions: 'none' },
});
commitStage(stage, finalDir);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
