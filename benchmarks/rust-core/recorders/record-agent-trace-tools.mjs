// Records the tool rows of Node's trace (`traceAgentTool`: the `tool` and `tool_slow` rows and the
// `tool-failures.jsonl` row) and the helpers they are built from, for
// native/core/fixtures/agent-trace/tools-golden.json.
//
//   MIXDOG_REPO=<node tree> node record-agent-trace-tools.mjs <out.json>
//
// Child process with MIXDOG_DATA_DIR/HOME/APPDATA on a fresh temp dir set before any Mixdog module is
// imported; Date.now is fixed; the failure log is flushed by the child's exit hook and read by the parent.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = 1700000000000;
const cmd =
  'curl -H "Authorization: Bearer abc123" https://user:pw123@host/x?token=zz&ok=1 --password hunter2 -p pw TOKEN=abc API_KEY = k2 --api-key=k3';
const grepOut = [
  '# grep pattern:foo',
  '# src/a.mjs:10 [lines 9-11]',
  'line nine',
  'line ten foo',
  'line eleven',
  'src/b.mjs:7:hit foo',
  'src/b.mjs-8-context',
  'C:\\proj\\c.mjs:3:win foo',
  '# grep src/d.mjs',
  '12:omitted foo',
  '13-omitted ctx',
].join('\n');

const toolCases = [
  { sessionId: 't1', iteration: 1, toolName: 'read', toolKind: 'builtin', toolMs: 12, toolArgs: { file_path: '/a.txt', offset: 1, limit: 10, api_key: 'sekret', extra: 1 }, agent: 'lead', resultKind: 'ok', model: 'm', resultText: 'file content', cwd: '/w' },
  { sessionId: 't2', iteration: 2, toolName: 'shell', toolKind: 'builtin', toolMs: 40, toolArgs: { command: cmd, cwd: '/w', timeout_ms: 1000, other: 'x' }, resultKind: 'ok', resultText: 'done' },
  { sessionId: 't3', iteration: 3, toolName: 'write', toolKind: 'builtin', toolMs: 5, toolArgs: { path: '/f', content: 'c'.repeat(500) }, resultKind: 'ok', resultText: '' },
  { sessionId: 't4', iteration: 4, toolName: 'grep', toolKind: 'builtin', toolMs: 5000, toolArgs: { pattern: 'foo', path: 'src', output_mode: 'content_with_context' }, agent: 'w', resultKind: 'ok', resultText: grepOut, cwd: '/w' },
  { sessionId: 't4b', iteration: 4, toolName: 'grep', toolMs: 10, toolArgs: { pattern: 'foo', path: 'src/z.mjs' }, resultKind: 'ok', resultText: '5:five foo\n6-six\n7:seven foo' },
  { sessionId: 't4c', toolName: 'grep', toolMs: 10, toolArgs: { pattern: 'foo', output_mode: 'files_with_matches' }, resultKind: 'ok', resultText: 'a.mjs\nb.mjs' },
  { sessionId: 't5', iteration: 5, toolName: 'shell', toolKind: 'builtin', toolMs: 100, toolArgs: { command: 'false' }, agent: 'w', resultKind: 'error', model: 'm', resultText: 'Error: [shell-run-failed] exit 1\n[exit code: 1]\nstderr: Authorization: Bearer topsecret token=abc', cwd: '/w' },
  { sessionId: 't6', iteration: 6, toolName: 'edit', toolKind: 'builtin', toolMs: 3, toolArgs: { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false }, resultKind: 'error', resultText: 'Error: edit failed (old_string not found in file; unreadable text follows)' },
  { sessionId: 't7', iteration: 7, toolName: 'shell', toolMs: 1, toolArgs: { command: 'x' }, resultKind: 'error', resultText: 'Session "abc" closed: aborted during call' },
  { sessionId: 't8', iteration: 8, toolName: 'read', toolMs: 2, toolArgs: { path: '/nope' }, resultKind: 'error', resultText: { content: [{ type: 'text', text: 'Error: ENOENT no such file' }, { type: 'image' }, { type: 'text', text: 'second' }] } },
  { sessionId: 't9', iteration: 9, toolName: 'web_fetch', toolMs: 2, toolArgs: { url: 'https://x' }, resultKind: 'error', resultText: '{"ok":false,"error":"errorCode: HTTP_ERROR 500"}' },
  { sessionId: 't10', iteration: 10, toolName: 'apply_patch', toolMs: 2, toolArgs: { base_path: '/w', patch: 'x'.repeat(100), dry_run: false }, resultKind: 'error', resultText: 'apply_patch failed: patch partially applied; rollback was incomplete' },
  { sessionId: 't11', iteration: 11, toolName: 'read', toolMs: 2000, toolArgs: { path: '/a' }, resultKind: 'ok', resultText: 'x next_call: read({"path": "b", "n": {"k": ")"}}) y next_call: grep({"bad": ) z next_call: glob( {"p":"q"} )' },
  { sessionId: 't12', iteration: 12, toolName: 'code_graph', toolKind: 'mcp', toolMs: 3000, toolArgs: { mode: 'search', symbols: ['a', 'b'], files: Array.from({ length: 8 }, (_, i) => `f${i}`), body: true }, resultKind: 'ok', resultText: 'ok',
    localSearchTelemetry: { hits: 3, ms: 4 }, toolTiming: { dispatchStartedAt: 100, executionStartedAt: 150.4, executionCompletedAt: 400, postprocessStartedAt: '410', resultCompletedAt: 450 },
    toolBatchId: 'b1', toolCallId: 'c1', executionIntervals: [[1, 2], [3, 4]], resultTelemetry: { integrity: { checked: true }, shellMisuse: ['m1'] } },
  { sessionId: 't13', iteration: 13, toolName: 'custom', toolKind: 'mcp', toolMs: 1, toolArgs: { a: { b: { c: 1 } }, list: [1, 2, 3, 4, 5, 6, 7, 8], '10': 'ten', '2': 'two', nested: [[1, [2]]], k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8, k9: 9, k10: 10 }, resultKind: 'ok', resultText: 'r' },
  { sessionId: 't14', toolName: 'x' },
  { sessionId: 't15', iteration: null, toolName: 'edit_many', toolMs: 1, toolArgs: { edits: Array.from({ length: 8 }, (_, i) => ({ file_path: `f${i}`, old_string: 'o', new_string: 'n' })), writes: [1], path: ['p1', 'p2'] }, resultKind: 'ok', resultText: 'r' },
  { sessionId: 't16', iteration: 16, toolName: 'shell', toolMs: 1, toolArgs: { command: `${'a'.repeat(179)}😀tail` }, resultKind: 'error', resultText: `Error: boom ${'é'.repeat(700)}😀` },
  { sessionId: 't17', iteration: 17, toolName: 'task', toolMs: '7.5', toolArgs: ['positional', { action: 'status' }], resultKind: 'ok', resultText: 'r' },
  { sessionId: 't18', iteration: 18, toolName: 'recall', toolMs: 'x', toolArgs: 'text args', resultKind: 'error', resultText: '' },
  { sessionId: 't19', iteration: 19, toolName: 'grep', toolMs: 3000, toolArgs: { pattern: 'p' }, resultKind: 'ok', resultText: 'no matches' },
];

const classifyCases = [
  ['[shell-tool-failed] shell arg "x" is unsupported here', 'shell'],
  ['Error: [shell-tool-failed] spawn broke', 'shell'],
  ['[shell-run-failed] [timeout: 5s] x', 'shell'],
  ['[shell-run-failed] cause: timeout', 'shell'],
  ['[shell-run-failed] cause: output-limit', 'shell'],
  ['[shell-run-failed] [signal: SIGKILL]', 'shell'],
  ['[shell-run-failed] exit 2', 'shell'],
  ['edit failed (old_string not found in file: unreadable)', 'edit'],
  ['edit failed (old_string found 3 times)', 'edit'],
  ['read compacted-history placeholder', 'read'],
  ['x [tool-input-validation] bad', 'read'],
  ['Browser command interrupted by local user input.', 'browser'],
  ['Error: computer_session_aborted: closed', 'computer'],
  ['The arguments provided to `edit` are invalid JSON and could not be parsed: x', 'edit'],
  ['goal task exceeds 500 characters', 'goal'],
  ['goal tasks support at most 20 entries; got 30', 'goal'],
  ['Unsupported field for GitHub issues.list.', 'github'],
  ['browser action "click" requires input.', 'browser'],
  ['Computer Use click must be integer', 'computer'],
  ['regex parse error: oops', 'grep'],
  ['errorCode: HTTP_ERROR 502', 'web_fetch'],
  ['generation failed on x provider failed (503): y', 'media'],
  ['Web search failed: native web search failed: x: runtime is closing', 'web_search'],
  ['apply_patch: patch partially applied', 'apply_patch'],
  ['apply_patch: add file target already exists', 'apply_patch'],
  ['advisory lock timeout waiting', 'edit'],
  ['EACCES: permission denied', 'read'],
  ['apply_patch: patch too large (byte cap)', 'apply_patch'],
  ['apply_patch: multiple operations target one file', 'apply_patch'],
  ['apply_patch: hunk rejected: nearest line 4', 'apply_patch'],
  ['apply_patch: context not found', 'apply_patch'],
  ['apply_patch: V4A parse failed', 'apply_patch'],
  ['apply_patch: contained no file sections', 'apply_patch'],
  ['apply_patch: target(s) fall outside the write root', 'apply_patch'],
  ['apply_patch: target unreadable', 'apply_patch'],
  ['apply_patch: preflight rejected: x', 'apply_patch'],
  ['apply_patch: stat x for delete y (os error 2)', 'apply_patch'],
  ['requires either path or query', 'recall'],
  ['value must be a string', 'recall'],
  ['tool is not allowed here', 'x'],
  ['anything', 'shell'],
  ['[exit code: 2]\nout', 'x'],
  ['Error: no such file or directory', 'read'],
  ['symbol "foo" not found in graph', 'code_graph'],
  ['executable not found in this environment', 'x'],
  ['file not found in graph', 'x'],
  ['request timed out', 'x'],
  ['unknown tool abc', 'x'],
  ['something odd', 'x'],
  ['{"ok":false,"error":"permission denied"}', 'x'],
  ['Session "s" closed: closed during call', 'x'],
  // toLowerCase() specials: the Kelvin sign lowers to k, İ lowers to i + a combining dot (so it does
  // not match the ASCII keyword), a capitalised tool name is lowered before the set test.
  ['UN\u212aNOWN TOOL abc', 'x'],
  ['T\u0130MEOUT happened', 'x'],
  ['TIMEOUT happened', 'x'],
  ['ENOENT no such file', 'GREP'],
  ['ENOENT no such file', 'GR\u0130P'],
  ['\u0130NVALID ARGUMENTS', 'x'],
  ['INVALID ARGUMENTS', 'x'],
  ['\u0391\u03a3 NOT ALLOWED', 'x'],
  [{ content: [{ type: 'text', text: 'Error: ENOENT' }] }, 'read'],
  [null, 'x'],
  [['a', 'b'], 'x'],
  [{ a: 1 }, 'x'],
];

const summarizeCases = [
  ['read', { file_path: '/a', secret: 'x', offset: 3 }],
  ['custom', { a: 1, token: 'z', body: 'q'.repeat(200), list: [1, 2, 3, 4, 5, 6, 7], deep: { x: { y: 1 } }, deeper: [[[1]]] }],
  ['shell', { command: 'run --token=abc' }],
  ['x', null],
  ['x', 'str'],
  ['x', []],
  ['x', {}],
  ['', { only: 'one' }],
];

const nextCallCases = [
  '', 'none', 'next_call: read({"a":1})', 'next_call:read( {"a":{"b":")"}} )', 'next_call: read({"a":1}', 'next_call: read({"a":})', 'next_call: 1x({})', 'next_call: a({}) next_call: b({"x":"\\"}"})',
];

if (process.argv[2] === '--child') {
  Date.now = () => T0;
  const root = resolve(process.env.MIXDOG_REPO);
  const orch = (name) => import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator', name)).href);
  const io = await orch('agent-trace-io.mjs');
  const fmt = await orch('agent-trace-format.mjs');
  const next = await orch('tools/next-call-utils.mjs');
  for (const c of toolCases) fmt.traceAgentTool(structuredClone(c));
  await io.drainAgentTrace();
  const classify = classifyCases.map(([text, tool]) => ({ text, tool, out: fmt.classifyToolFailure(structuredClone(text), tool) }));
  const summarize = summarizeCases.map(([tool, args]) => ({ tool, args, out: fmt.summarizeToolArgs(tool, structuredClone(args)) }));
  const nextCalls = nextCallCases.map((text) => ({ text, n: next.countJsonNextCalls(text) }));
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'pure.json'), JSON.stringify({ classify, summarize, nextCalls }));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'agent-trace-tools-'));
const data = join(dir, 'data');
mkdirSync(data);
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  MIXDOG_REPO: process.env.MIXDOG_REPO,
  MIXDOG_DATA_DIR: data,
  HOME: dir,
  USERPROFILE: dir,
  APPDATA: dir,
  LOCALAPPDATA: dir,
  MIXDOG_DIAGNOSTICS: '1',
  MIXDOG_QUIET_MEMORY_LOG: '1',
};
const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env, encoding: 'utf8' });
if (run.status !== 0) {
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`child failed: ${run.stderr || run.stdout}`);
}
const history = join(data, 'history');
const pure = JSON.parse(readFileSync(join(data, 'pure.json'), 'utf8'));
writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      note: 'recorded by benchmarks/rust-core/recorders/record-agent-trace-tools.mjs against Node (fake clock)',
      now: T0,
      cases: toolCases,
      jsonl: readFileSync(join(history, 'agent-trace.jsonl'), 'utf8'),
      failures: readFileSync(join(history, 'tool-failures.jsonl'), 'utf8'),
      ...pure,
    },
    null,
    1,
  )}\n`,
);
rmSync(dir, { recursive: true, force: true });
