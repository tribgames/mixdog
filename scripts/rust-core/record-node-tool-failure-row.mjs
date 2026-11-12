#!/usr/bin/env node
// Records the Node tool-failure row for the smoke's scripted turn (a model call of `read` with arguments `{}`).
// Run against a Node tree (b6f10295a, the last Node core): the REAL `validateBuiltinArgs` produces the tool's error text and
// the REAL `traceAgentToolFailure` writes the row, with the arguments the Node loop passes at its call site
// (session/tool-batch/finalize.mjs traceAgentTool -> agent-trace-format.mjs traceAgentToolFailure): iteration is the first
// request's `state.iterations + 1` (session/loop/send-phase.mjs:99), toolKind is getToolKind('read') = 'builtin'
// (loop/tool-helpers.mjs:79), agent is the session's (below).
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
const { sessionOptions } = await import(pathToFileURL(join(tree, 'src/session-runtime/session-create/session-options.mjs')).href);
const { workflowHelpers } = await import(pathToFileURL(join(tree, 'src/session-runtime/boot/shared.mjs')).href);
const { modelToolSchemaAllowlist } = await import(`${orchestrator}/runtime-core/tool-profile.mjs`);
const cfgMod = await import(`${orchestrator}/config.mjs`);
// The row's `agent` is the session's own (`batch.sessionRef?.agent || null`, finalize.mjs:236), and the session is made from the
// options the product's builder gives a user's session (the smoke's thread is a Lead's task thread): the Lead's is `lead`
// (session-options.mjs:89), a sub-agent's its own agent name (`sessionProfile.agent || 'worker'`).
const agent = sessionOptions(
  { rt: { route: { provider: 'smoke', model: 'smoke' }, config: {}, mode: 'full', toolProfile: 'interactive', sessionProfile: null, currentCwd: process.cwd() }, cfgMod, activeWorkflowContext: workflowHelpers.activeWorkflowContext, schemaAllowedTools: modelToolSchemaAllowlist('interactive'), featureDisallowedTools: () => [] },
  null,
).agent;
const args = {};
const resultText = validateBuiltinArgs('read', args);
traceAgentToolFailure({ sessionId: 'SESSION', iteration: 1, toolName: 'read', toolKind: 'builtin', toolMs: 0, toolArgs: args, agent, model: 'smoke', cwd: 'CWD', resultText, resultKind: 'error' });
// The row is written when the process exits (agent-trace-io.mjs flushes its buffer on 'exit').
process.on('exit', () => {
  const row = JSON.parse(readFileSync(spool, 'utf8').trim());
  writeFileSync(out, `${JSON.stringify(row, null, 2)}\n`);
});
