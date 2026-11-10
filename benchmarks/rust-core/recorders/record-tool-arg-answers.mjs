#!/usr/bin/env node
// Node's answers to the argument-validation and read-failure cases of `task` and `edit`, through the production entry
// (`executeBuiltinTool`: guards, normalisation, then the tool), for the Rust tools to match.
//
//   node benchmarks/rust-core/recorders/record-tool-arg-answers.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/tools/arg-answers/answers.json. The workspace root is written as <ROOT>.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-arg-answers-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
const ws = join(work, 'ws');
mkdirSync(join(ws, 'sub'), { recursive: true });
writeFileSync(join(ws, 'a.txt'), 'hello\n');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
const fwd = ws.replace(/\\/g, '/');
const scrub = (text) => String(text).replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');

const task = (name, input) => ({ name: `task-${name}`, tool: 'task', input });
const edit = (name, input) => ({ name: `edit-${name}`, tool: 'edit', input });
const cases = [
  task('args-null', null),
  task('args-array', []),
  task('args-string', 'list'),
  task('no-action', {}),
  task('action-null', { action: null, task_id: 'x' }),
  task('action-empty', { action: '', task_id: 'x' }),
  task('action-blank', { action: '  ', task_id: 'x' }),
  task('action-number', { action: 5, task_id: 'x' }),
  task('action-object', { action: { a: 1 } }),
  task('action-unknown', { action: 'bogus' }),
  task('action-unknown-with-id', { action: 'poke', task_id: 'x' }),
  task('action-unknown-cased', { action: 'Bogus ', task_id: 'x' }),
  task('list-timeout', { action: 'list', timeout_ms: 5 }),
  task('list-unsupported-key', { action: 'list', foo: 1 }),
  task('list-output', { action: 'list', output: 'tail' }),
  task('read-no-id', { action: 'read' }),
  task('read-id-empty', { action: 'read', task_id: '' }),
  task('read-id-blank', { action: 'read', task_id: '   ' }),
  task('read-id-number', { action: 'read', task_id: 5 }),
  task('read-id-array', { action: 'read', task_id: ['a'] }),
  task('read-id-null', { action: 'read', task_id: null }),
  task('read-unsupported-key', { action: 'read', task_id: 'x', foo: 1 }),
  task('read-timeout-dropped', { action: 'read', task_id: 'nope', timeout_ms: 'x' }),
  task('read-output-bad', { action: 'read', task_id: 'x', output: 'all' }),
  task('read-output-number', { action: 'read', task_id: 'x', output: 1 }),
  task('wait-timeout-string', { action: 'wait', task_id: 'x', timeout_ms: 'soon' }),
  task('wait-timeout-negative', { action: 'wait', task_id: 'x', timeout_ms: -1 }),
  task('wait-timeout-float', { action: 'wait', task_id: 'x', timeout_ms: 1.5 }),
  task('wait-timeout-null', { action: 'wait', task_id: 'nope', timeout_ms: null }),
  task('wait-output-bad', { action: 'wait', task_id: 'x', output: 'none' }),
  task('cancel-no-id', { action: 'cancel' }),
  task('cancel-output', { action: 'cancel', task_id: 'x', output: 'new' }),
  task('cancel-timeout-dropped', { action: 'cancel', task_id: 'nope', timeout_ms: 5 }),
  task('cancel-not-found', { action: 'cancel', task_id: 'nope' }),
  task('read-not-found', { action: 'read', task_id: 'nope' }),
  task('read-session-id', { action: 'read', task_id: 'sess_abc' }),
  task('action-cased-not-found', { action: ' READ ', task_id: ' nope ' }),
  edit('missing-file', { path: 'nofile.txt', old_string: 'a', new_string: 'b' }),
  edit('missing-file-file_path', { file_path: 'nofile.txt', old_string: 'a', new_string: 'b' }),
  edit('missing-in-missing-dir', { path: 'no/dir/file.txt', old_string: 'a', new_string: 'b' }),
  edit('directory', { path: 'sub', old_string: 'a', new_string: 'b' }),
  edit('long-name-300', { path: `${'z'.repeat(300)}.txt`, old_string: 'a', new_string: 'b' }),
  edit('long-name-1500', { path: 'z'.repeat(1500), old_string: 'a', new_string: 'b' }),
  edit('secret-in-name', { path: 'nofile-token=abc123.txt', old_string: 'a', new_string: 'b' }),
  edit('access-denied', { path: process.platform === 'win32' ? 'C:\\Windows\\System32\\config\\SAM' : '/proc/1/mem', old_string: 'a', new_string: 'b' }),
  edit('no-match', { path: 'a.txt', old_string: 'zzz', new_string: 'b' }),
];

const recorded = [];
for (const c of cases) {
  let outcome;
  try {
    const raw = await executeBuiltinTool(c.tool, c.input, ws);
    const env = normalizeToolEnvelope(raw);
    outcome = { text: scrub(env.result ?? ''), isError: env.isError === true || /^Error[\s:[]/.test(String(env.result ?? '')) };
  } catch (e) {
    outcome = { thrown: scrub(String(e?.message ?? e)) };
  }
  recorded.push({ ...c, ...outcome });
}
writeJson(join(FIXTURES_ROOT, 'tools', 'arg-answers', 'answers.json'), {
  node: process.version,
  platform: process.platform,
  recorder: 'benchmarks/rust-core/recorders/record-tool-arg-answers.mjs',
  tree: 'b6f10295a',
  cases: recorded,
});
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases`);
