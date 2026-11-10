#!/usr/bin/env node
// Records `classifyResultKind(result, false, toolName)` (session/result-classification.mjs): the one place Node turns a tool's returned
// text into 'error' / 'zero-match' / 'normal'. A tool that returns `Error: …` instead of throwing (the agent tool, the skill tools, MCP
// text results) is an error call, and so a row of history/tool-failures.jsonl, only through this classification.
//
//   node benchmarks/rust-core/recorders/record-result-classification.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/result-classification/golden.json (+ MANIFEST.json).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-result-classification.mjs';
const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { classifyResultKind } = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/session/result-classification.mjs')).href);

const TEXTS = [
  '',
  'ok',
  'Error: it broke',
  'error: lower',
  'ERROR: upper',
  'Error : spaced colon',
  'Error [code 2]: structured',
  'Error [code',
  'Errors: plural',
  'Error without colon',
  '   \n\tError: leading whitespace',
  '[error something]',
  '[ERROR x]',
  '[errors]',
  'prefix then Error: not at the start',
  'Error: [shell-tool-failed] x',
  'Error: [shell-run-failed] x',
  '[exit code: 3]\nExit three',
  '(no matches)',
  '(no files found)',
  '(no symbol matches for x)',
  '(no symbols)',
  '(no references)',
  '(no callers)',
  '(no call sites)',
  '(no imports)',
  '(no dependents)',
  '(no entries match filter)',
  '(no lines in range 9-12)',
  '  (no matches)',
  '(No matches)',
  'Error: ENOENT: no such file or directory',
  'Error: path does not exist: /x',
  'Error: directory does not exist',
  'Error: no such file',
  'Error: file not found',
  'Error: not found at this path',
  'Error: symbol "x" not found in a.rs',
  'Error: ENOTDIR',
  'Error: EACCES: permission denied, ENOENT',
  'Error: operation not permitted: no such file',
  'Error: access is denied: path does not exist',
  'Error: EPERM no such path',
  'skill "x" not found',
  'Error: agent: unknown type "bogus"',
];
const TOOLS = ['', 'read', 'READ', 'grep', 'find', 'glob', 'list', 'code_graph', 'edit', 'shell', 'agent', 'Skill', 'mcp__fx__fail'];
const cases = [];
for (const tool of TOOLS) for (const text of TEXTS) cases.push({ tool, text, kind: classifyResultKind(text, false, tool) });
// A result that is not text is 'normal'; the host's tool outputs are always text, so only that one is recorded.
cases.push({ tool: 'read', text: null, kind: classifyResultKind(null, false, 'read') });

const finalDir = join(FIXTURES_ROOT, 'result-classification');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: 'classifyResultKind(text, false, tool) at b6f10295a', cases });
writeSetManifest(stage, { set: 'result-classification', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { cases: cases.length } });
commitStage(stage, finalDir);
console.log(`cases=${cases.length} error=${cases.filter((c) => c.kind === 'error').length} zero=${cases.filter((c) => c.kind === 'zero-match').length}`);
