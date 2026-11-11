#!/usr/bin/env node
// Records the Node tool-failure row for the smoke's scripted turn (a model call of `read` with arguments `{}`).
// Run against a Node tree (b6f10295a, the last Node core): the REAL `validateBuiltinArgs` produces the tool's error text and
// the REAL `traceAgentToolFailure` writes the row, with the arguments the Node loop passes at its call site
// (session/tool-batch/finalize.mjs traceAgentTool -> agent-trace-format.mjs traceAgentToolFailure): iteration is the first
// request's `state.iterations + 1` (session/loop/send-phase.mjs:99), toolKind is getToolKind('read') = 'builtin'
// (loop/tool-helpers.mjs:79), agent is null for a task thread without a named agent.
// Usage: node scripts/rust-core/record-node-tool-failure-row.mjs <node-tree> [out]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = resolve(process.argv[2]);
const out = resolve(process.argv[3] ?? new URL('./recorded/node_tool_failure_row.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const spool = join(mkdtempSync(join(tmpdir(), 'node-tool-failure-')), 'tool-failures.jsonl');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = spool;
const orchestrator = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator')).href;
const { validateBuiltinArgs } = await import(`${orchestrator}/tools/builtin/arg-guard.mjs`);
const { traceAgentToolFailure } = await import(`${orchestrator}/agent-trace-format.mjs`);
const args = {};
const resultText = validateBuiltinArgs('read', args);
traceAgentToolFailure({ sessionId: 'SESSION', iteration: 1, toolName: 'read', toolKind: 'builtin', toolMs: 0, toolArgs: args, agent: null, model: 'smoke', cwd: 'CWD', resultText, resultKind: 'error' });
// The row is written when the process exits (agent-trace-io.mjs flushes its buffer on 'exit').
process.on('exit', () => {
  const row = JSON.parse(readFileSync(spool, 'utf8').trim());
  writeFileSync(out, `${JSON.stringify(row, null, 2)}\n`);
});
