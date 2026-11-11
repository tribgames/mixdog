// Records Node's real `mixdog exec` CLI process: `node src/cli.mjs exec ...` started with an argv, an environment and a
// closed stdin, against a scripted provider endpoint, as a user's shell or a script starts it. What is recorded is the
// process's: its stdout and stderr as ordered chunks with their stream, its exit code, the provider requests it sent,
// and, for a run interrupted by Ctrl+C or killed, what it left behind (pristine roots, live child processes).
//
// The one instrument inside the process is `lib/exec-cli-tap.mjs`, loaded with `--import` before the CLI: provider
// fetches go to this recorder's loopback endpoint, and each stdout/stderr write is logged in order with its stream (the
// pipes carry the same bytes; the recorder checks it). Consecutive chunks of one stream are joined: a reader of two pipes
// sees the order of the streams, not the writes within one.
//
// Windows only: Ctrl+C is a console control event (CTRL_C_EVENT) sent to the process's own hidden console by a helper
// that attaches to it; a kill is TerminateProcess.
//
//   node benchmarks/rust-core/recorders/record-exec-cli.mjs --tree <exact export of the commit> --commit <40 hex>
//
// Output: native/core/fixtures/exec-cli/.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
// The child's tap (loaded there with --import); imported here so the manifest lists it.
import './lib/exec-cli-tap.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const recorder = 'benchmarks/rust-core/recorders/record-exec-cli.mjs';
// A run that has not ended in this long has hung: it is killed and the recording fails.
const RUN_DEADLINE_MS = 180_000;

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (index) => sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20 + index, output_tokens: 1 } } });
function message(index, { text = '', calls = [] }) {
  const parts = [start(index)];
  let block = 0;
  if (text) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  for (const [name, input] of calls) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: `toolu_${index}_${block}`, name, input: {} } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 + index } }));
  parts.push(sse('message_stop', { type: 'message_stop' }));
  return parts.join('');
}

// The provider's answers, by name; the n-th request of a case gets the n-th answer, a request past them a 404.
const stream = (body) => ({ status: 200, contentType: 'text/event-stream', body });
const REPLIES = {
  read: (index) => stream(message(index, { calls: [['read', { path: 'a.txt' }]] })),
  done: (index) => stream(message(index, { text: 'done' })),
  // A provider error before any stream: a 400 the adapter does not retry.
  refused: () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'the request was refused' } }) }),
  // A failed turn: after a tool ran, the next response's stream breaks with an error event.
  broken: (index) => stream(start(index) + sse('error', { type: 'error', error: { type: 'invalid_request_error', message: 'the turn broke' } })),
  // Never answered: the run is waiting on the provider when it is interrupted.
  hold: () => ({ hold: true }),
};
const NO_SCRIPT = { status: 404, contentType: 'text/plain', body: 'no script' };

const ARGV = ['exec', '--provider', 'anthropic', '--model', 'claude-sonnet-4-6'];
const CASES = {
  text: { argv: [...ARGV, 'go'], replies: ['read', 'done'] },
  json: { argv: [...ARGV, '--json', 'go'], replies: ['read', 'done'] },
  // Every request is refused, the retries the adapter makes included.
  'provider-error': { argv: [...ARGV, 'go'], replies: ['refused'], repeat: true },
  'failed-turn': { argv: [...ARGV, 'go'], replies: ['read', 'broken'] },
  'ctrl-c': { argv: [...ARGV, 'go'], replies: ['read', 'hold'], interrupt: 'ctrl-c' },
  kill: { argv: [...ARGV, 'go'], replies: ['read', 'hold'], interrupt: 'kill' },
};

// The environment both CLIs are started with (`<sandbox>` is the case's own folder; `<host>` is the value this process
// has): no host data, a key for the selected provider, no proxy for the loopback endpoint.
const ENV = {
  PATH: '<host>',
  SystemRoot: '<host>',
  HOME: '<sandbox>/home',
  USERPROFILE: '<sandbox>/home',
  APPDATA: '<sandbox>/home/AppData/Roaming',
  LOCALAPPDATA: '<sandbox>/home/AppData/Local',
  MIXDOG_DATA_DIR: '<sandbox>/host-data',
  TEMP: '<sandbox>/tmp',
  TMP: '<sandbox>/tmp',
  TZ: 'UTC',
  ANTHROPIC_API_KEY: 'sk-fake',
  NO_PROXY: '127.0.0.1,localhost',
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_DISABLE_TOOL_PREWARM: '1',
};
// What the recording leaves out of what the process did, each with its reason (the replay compares everything else whole).
const EXCLUSIONS = {
  chunking: 'consecutive chunks of one stream are joined: the size of one pipe read depends on the OS, only the order of the streams is a fact of the process',
  stderr: 'stderr is kept to the exec\'s own `mixdog: ` lines: the other lines are the runtime\'s diagnostic log (Node\'s process warnings, `[tag] ...` lines of background work), whose place follows background timers',
  others: 'the requests that are not the turn\'s (model listing, tool binary and update checks) are a sorted set, not compared: Node fetches its tool binaries there and the core does not need them, while it lists models.dev and the provider\'s cost report',
};
const FOLDERS = ['home/AppData/Roaming', 'home/AppData/Local', 'host-data', 'tmp', 'work'];

/** The case's environment: `<sandbox>` replaced, `<host>` read from this process. */
function envFor(sandbox) {
  return Object.fromEntries(Object.entries(ENV).map(([name, value]) => [name, value === '<host>' ? process.env[name] : value.replace('<sandbox>', sandbox).replaceAll('/', '\\')]));
}

/** A chunk as the recording keeps it: the sandbox, session and thread ids, times and durations of the run replaced. */
function normalize(text, sandbox) {
  let out = text;
  for (const form of [JSON.stringify(sandbox).slice(1, -1), sandbox, sandbox.replaceAll('\\', '/')]) out = out.split(form).join('<sandbox>');
  return out
    .replace(/sess_[A-Za-z0-9_]+/g, '<session>')
    .replace(/exec_[0-9a-f]{32}/g, '<thread>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(/"(duration_ms|duration_api_ms|queue_ms|dispatch_ms|execution_ms|batch_wait_ms|postprocess_ms|total_ms)":\d+(?:\.\d+)?/g, '"$1":0');
}

/**
 * The exec's output: stdout, and the stderr lines the exec itself writes (`mixdog: ...`), consecutive chunks of one
 * stream joined, each normalized. The other stderr lines are the runtime's diagnostic log (Node's process warnings, the
 * `[tag] ...` lines of background work such as titling or model listing): their place among the output follows
 * background timers, so they are not part of the recording.
 */
function ordered(chunks, sandbox) {
  const joined = [];
  for (const { stream: name, text } of chunks) {
    const kept = name === 'stdout' ? text : text.split(/(?<=\n)/).filter((line) => line.startsWith('mixdog: ')).join('');
    if (!kept) continue;
    if (joined.at(-1)?.stream === name) joined.at(-1).text += kept;
    else joined.push({ stream: name, text: kept });
  }
  return joined.map(({ stream: name, text }) => ({ stream: name, text: normalize(text, sandbox) }));
}

/** What one provider request carried, in the recording's shape. */
function heard(body) {
  return {
    model: body.model,
    tools: (body.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    toolResults: (body.messages?.at(-1)?.content ?? []).filter?.((block) => block.type === 'tool_result').map((block) => ({ tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content })) ?? [],
  };
}

/** The live processes whose parent is `pid`, by image name (Win32_Process). */
function childrenOf(pid) {
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (listed.status !== 0) throw new Error(`listing the children of ${pid} failed: ${listed.stderr}`);
  return listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), name: line.slice(line.indexOf(' ') + 1) }));
}

/** `pid` and every process it started, ended (taskkill /T), within a bound. */
function endTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 60_000 });
}

/** CTRL_C_EVENT to the console of `pid` (its own hidden console), from a helper attached to it. */
function ctrlC(pid) {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class Ctl {',
    '  [DllImport("kernel32.dll")] public static extern bool FreeConsole();',
    '  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);',
    '  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);',
    '  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);',
    '}',
    '"@',
    '[Ctl]::FreeConsole() | Out-Null',
    `if (-not [Ctl]::AttachConsole(${pid})) { exit 2 }`,
    '[Ctl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null',
    'if (-not [Ctl]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }',
    'exit 0',
  ].join('\n');
  const sent = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (sent.status !== 0) throw new Error(`Ctrl+C to ${pid} was not sent (${sent.status}): ${sent.stderr}`);
}

async function runCase(tree, name) {
  const spec = CASES[name];
  const sandbox = mkdtempSync(join(tmpdir(), 'exec-cli-'));
  for (const folder of FOLDERS) mkdirSync(join(sandbox, folder), { recursive: true });
  writeFileSync(join(sandbox, 'work', 'a.txt'), 'hello\n');
  const replies = spec.replies.map((reply, index) => REPLIES[reply](index + 1));
  const requests = [];
  const others = [];
  let heldNow;
  const held = new Promise((resolve) => { heldNow = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = req.url.split('?')[0];
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      others.push(`${req.method} ${req.headers['x-bench-origin']}${path}`);
      res.writeHead(NO_SCRIPT.status, { 'content-type': NO_SCRIPT.contentType }).end(NO_SCRIPT.body);
      return;
    }
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    requests.push({ origin: req.headers['x-bench-origin'], path, ...heard(JSON.parse(body.toString('utf8'))) });
    const reply = replies[requests.length - 1] ?? (spec.repeat ? replies.at(-1) : NO_SCRIPT);
    if (reply.hold) {
      heldNow();
      return;
    }
    res.writeHead(reply.status, { 'content-type': reply.contentType }).end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const log = join(sandbox, 'chunks.jsonl');
  writeFileSync(log, '');
  const tap = `data:text/javascript,import { installExecCliTap } from ${JSON.stringify(new URL('./lib/exec-cli-tap.mjs', import.meta.url).href)}; installExecCliTap();`;
  const child = spawn(process.execPath, ['--import', tap, join(tree, 'src', 'cli.mjs'), ...spec.argv], {
    cwd: join(sandbox, 'work'),
    env: { ...envFor(sandbox), BENCH_PROVIDER_PORT: String(server.address().port), BENCH_CHUNK_LOG: log },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end();
  const pipes = { stdout: [], stderr: [] };
  child.stdout.on('data', (chunk) => pipes.stdout.push(chunk));
  child.stderr.on('data', (chunk) => pipes.stderr.push(chunk));
  // A killed run has no exit code of its own: `null`.
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(spec.interrupt === 'kill' ? null : code)));
  let deadline;
  const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => { endTree(child.pid); reject(new Error(`${name}: the run did not end in ${RUN_DEADLINE_MS} ms`)); }, RUN_DEADLINE_MS); });
  let left = null;
  if (spec.interrupt) {
    await Promise.race([held, timedOut]);
    if (spec.interrupt === 'ctrl-c') ctrlC(child.pid);
    else child.kill();
  }
  const code = await Promise.race([exited, timedOut]);
  clearTimeout(deadline);
  if (spec.interrupt) {
    const children = childrenOf(child.pid);
    const roots = readdirSync(join(sandbox, 'tmp')).filter((entry) => entry.startsWith('mixdog-headless-pristine-'));
    left = { roots: roots.length, children: children.map((c) => c.name).sort() };
    for (const { pid } of children) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 60_000 });
  }
  server.closeAllConnections();
  server.close();
  const chunks = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (const name2 of ['stdout', 'stderr']) {
    const tapped = chunks.filter((chunk) => chunk.stream === name2).map((chunk) => chunk.text).join('');
    if (tapped !== Buffer.concat(pipes[name2]).toString('utf8')) throw new Error(`${name}: the ${name2} writes are not what its pipe carried`);
  }
  const files = Object.fromEntries(readdirSync(join(sandbox, 'work')).sort().map((file) => [file, readFileSync(join(sandbox, 'work', file), 'utf8')]));
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // `others`: the requests that are not the turn's (model listing, tool binary and update checks), answered 404; their
  // order follows background timers, so they are kept as a sorted set.
  return { case: name, argv: spec.argv, stdin: '', env: ENV, replies, repeat: spec.repeat === true, code, output: ordered(chunks, sandbox), requests, others: [...new Set(others)].sort(), files, ...(left ? { left } : {}) };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('the CLI recording sends console control events: Windows only');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = exactProductIdentity(tree, args.get('commit'));
  const finalDir = join(FIXTURES_ROOT, 'exec-cli');
  const stage = stageSet(finalDir);
  for (const name of Object.keys(CASES)) writeJson(join(stage, `${name}.json`), await runCase(tree, name));
  writeSetManifest(stage, { set: 'exec-cli', recorder, command: `node ${recorder} --tree <tree> --commit ${args.get('commit')}`, identity, extra: { exact: true, ...recorderProvenance(import.meta.url), exclusions: EXCLUSIONS } });
  commitStage(stage, finalDir);
}
await main();
