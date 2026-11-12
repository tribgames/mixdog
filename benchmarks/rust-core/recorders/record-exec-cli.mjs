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
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  // The text case with Node's daemon running on the same data folder and temp folder (the folders of a user who has the app open).
  'beside-daemon': { argv: [...ARGV, 'go'], replies: ['read', 'done'], daemon: true },
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
// The recording keeps every stderr line and every request. The replay leaves out of a side only the stderr lines named here, each
// by its exact text (after the normalization below) with its side and reason, and the requests named in OTHERS_NOT_COMPARED, each
// by its exact text; it compares the rest whole, in order, and fails when a named line or request is not in what it was named for.
const STDERR_NOT_COMPARED = [
  { side: 'node', name: 'node process warning', line: '(node:<pid>) ExperimentalWarning: SQLite is an experimental feature and might change at any time', reason: 'Node writes its own process warning for the built-in SQLite module; no other runtime has the module' },
  { side: 'node', name: 'node warning hint', line: '(Use `node --trace-warnings ...` to show where the warning was created)', reason: 'the second line of the same Node process warning' },
  { side: 'node', name: 'model listing diagnostic', line: '[anthropic] listModels fetch failed (list_models 404)', reason: 'Node logs its background model listing that the stand-in answers 404 (twice per run); the core writes no such line' },
  { side: 'node', name: 'titling start diagnostic (session)', line: '[mixdog] llm-title start id=<session> stage=first chars=2', reason: 'Node logs the start of its background session titling; the core has no titling in the exec' },
  { side: 'node', name: 'titling start diagnostic (thread)', line: '[mixdog] llm-title start id=<thread> stage=first chars=2', reason: 'the same line of the --json run, which names the thread by its exec id' },
  { side: 'node', name: 'titling disabled diagnostic', line: '[mixdog] llm-title disabled stage=first (maintenance route unresolved; llm titling off)', reason: 'Node logs that its titling has no maintenance route; the core has no titling in the exec' },
  { side: 'node', name: 'titling generated diagnostic', line: '[mixdog] llm-title generated id=<session> stage=first title=""', reason: 'Node logs the empty title its titling got from the stand-in\'s refused request; the core has no titling in the exec' },
  { side: 'node', name: 'ask error diagnostic (stream error)', line: '[ask-error] session=<session> name=AnthropicSseError status=400 code=invalid_request_error type=invalid_request_error kind=permanent msg="Anthropic SSE error invalid_request_error: the turn broke"', reason: 'Node logs the failed ask a second time in its diagnostic form, beside the `mixdog: ` line the exec writes' },
  { side: 'node', name: 'ask error diagnostic (refused request)', line: '[ask-error] session=<session> name=Error status=400 code=invalid_request_error kind=permanent msg="400 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"the request was refused\\"}}"', reason: 'Node logs the failed ask a second time in its diagnostic form, beside the `mixdog: ` line the exec writes' },
  { side: 'node', name: 'lock wait diagnostic', timing: true, line: '[atomic-file] async lock wait <ms>: queueWaitMs=<ms> osAcquireMs=<ms> <sandbox>\\tmp\\mixdog-headless-pristine-<id>\\data\\session-summaries.json.lock', reason: 'Node logs a wait on its own session-summary lock file when the OS is slow to grant it; whether and for how long is a timing fact of its file layer (the durations and the throwaway folder\'s name are normalized)' },
  { side: 'core', name: 'goal recovery line', line: '[daemon] active Goal recovery found=0 resumed=0 skipped=0 failed=0', reason: 'the core logs its boot-time goal recovery summary to the exec\'s stderr; Node\'s exec keeps its daemon log in a file' },
  { side: 'core', name: 'model catalog fetch failure (models.dev)', line: '[model-catalog] models.dev fetch failed: fetch failed', reason: 'the core fetches the models.dev catalog at start, which Node\'s exec does not, and logs the failed connect (the stand-in\'s certificate does not cover the host)' },
  { side: 'core', name: 'model catalog fetch failure (GitHub)', line: '[model-catalog] fetch failed: fetch failed', reason: 'the core fetches the GitHub model catalog at start, which Node\'s exec does not, and logs the failed connect (the stand-in\'s certificate does not cover the host)' },
];
// The requests that are not the turn's, answered 404 (but the runtime, below). The replay compares the rest of them whole, as a sorted set (their
// order follows background timers), after leaving out of each side the ones named here.
const OTHERS_NOT_COMPARED = [
  { side: 'node', name: 'graph binary download', request: 'GET https://github.com/tribgames/mixdog/releases/download/graph-v0.1.35/mixdog-graph-win32-x64.exe', reason: 'Node fetches its graph tool binary on first use; the core ships its tools natively and downloads nothing here' },
  { side: 'node', name: 'patch binary download', request: 'GET https://github.com/tribgames/mixdog/releases/download/patch-v0.7.34/mixdog-patch-win32-x64.exe', reason: 'Node fetches its patch tool binary on first use; the core ships its tools natively and downloads nothing here' },
  { side: 'node', name: 'spawn binary download', request: 'GET https://github.com/tribgames/mixdog/releases/download/spawn-v0.1.12/mixdog-spawn-win32-x64.exe', reason: 'Node fetches its spawn tool binary on first use; the core ships its tools natively and downloads nothing here' },
  { side: 'node', name: 'memory runtime download', timing: true, request: 'GET https://github.com/tribgames/mixdog/releases/download/runtime-v0.4.1/mixdog-runtime-win32-x64-pg16.4-pgvector0.8.2.tar.gz', reason: 'Node\'s exec ingests its session into the memory runtime, downloading it into its throwaway data folder (served here as the release serves it); whether the exec asks before it ends follows timing, the core keeps no such runtime' },
  { side: 'core', name: 'models.dev connect', request: 'CONNECT models.dev', reason: 'the core fetches the models.dev model catalog at start (the stand-in\'s certificate does not cover the host, so the connect is the record); Node\'s exec does not' },
  { side: 'core', name: 'GitHub catalog connect', request: 'CONNECT raw.githubusercontent.com', reason: 'the core fetches the GitHub model catalog at start (the stand-in\'s certificate does not cover the host, so the connect is the record); Node\'s exec does not' },
  { side: 'core', name: 'provider cost report', request: 'GET https://api.anthropic.com/v1/organizations/cost_report', reason: 'the core reads the provider\'s cost report at start; Node\'s exec does not' },
];// What the recording leaves out of what the process did, each with its reason (the replay compares everything else whole).
const EXCLUSIONS = {
  chunking: 'consecutive chunks of one stream are joined: the size of one pipe read depends on the OS, only the order of the streams is a fact of the process',
  ...Object.fromEntries(STDERR_NOT_COMPARED.map(({ name, side, reason }) => [`stderr (${side} only): ${name}`, reason])),
  ...Object.fromEntries(OTHERS_NOT_COMPARED.map(({ name, side, reason }) => [`others (${side} only): ${name}`, reason])),
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
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/(\[atomic-file\] async lock wait )\d+ms: queueWaitMs=\d+ms osAcquireMs=\d+ms/g, '$1<ms>: queueWaitMs=<ms> osAcquireMs=<ms>')
    .replace(/mixdog-headless-pristine-[A-Za-z0-9]+/g, 'mixdog-headless-pristine-<id>')
    .replace(/sess_[A-Za-z0-9_]+/g, '<session>')
    .replace(/exec_[0-9a-f]{32}/g, '<thread>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(/"(duration_ms|duration_api_ms|queue_ms|dispatch_ms|execution_ms|batch_wait_ms|postprocess_ms|total_ms)":\d+(?:\.\d+)?/g, '"$1":0');
}

/** The exec's output as the recording keeps it: every stdout and stderr line, consecutive chunks of one stream joined, each normalized. */
function ordered(chunks, sandbox) {
  const joined = [];
  for (const { stream: name, text } of chunks) {
    if (joined.at(-1)?.stream === name) joined.at(-1).text += text;
    else joined.push({ stream: name, text });
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

/** `deadline`: the promise, or a rejection naming `what` when it has not settled in `ms`. */
function bounded(what, promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not done after ${ms} ms`)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * The daemon's PostgreSQL runtime, installed as `ensureRuntime` leaves one (`runtime-fetcher.mjs`): the daemon downloads the
 * runtime on boot unless `cachedRuntimeDir` (`runtime-fetcher.mjs:494,675`) finds, in `<data>/runtime`, an `active-version`
 * naming `runtime-<version>-<sha256 prefix>` whose `.version-sha256` stamp is the asset's digest. A copy of an unpacked runtime
 * (MIXDOG_PG_RUNTIME, the one the PostgreSQL tests use) is laid out so.
 */
function installRuntime(tree, source, data) {
  const manifest = JSON.parse(readFileSync(join(tree, 'src/runtime/memory/data/runtime-manifest.json'), 'utf8'));
  const asset = manifest.assets[`${process.platform}-${process.arch}`];
  const key = `pg${manifest.pg.major}.${manifest.pg.minor}+pgvector-${manifest.pgvector.version}-${asset.sha256.slice(0, 12)}`;
  const target = join(data, 'runtime', `runtime-${key}`);
  cpSync(source, target, { recursive: true });
  writeFileSync(join(target, '.version-sha256'), asset.sha256);
  writeFileSync(join(data, 'runtime', 'active-version'), key);
  return target;
}

/**
 * The release asset of the memory runtime (the manifest's url for this platform) as bytes: the archive beside the unpacked runtime
 * (`<runtime>/../runtime.tar.gz`, the one it was unpacked from), whose digest must be the manifest's.
 */
function runtimeAsset(tree, source) {
  const manifest = JSON.parse(readFileSync(join(tree, 'src/runtime/memory/data/runtime-manifest.json'), 'utf8'));
  const { url, sha256 } = manifest.assets[`${process.platform}-${process.arch}`];
  const bytes = readFileSync(join(source, '..', 'runtime.tar.gz'));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${join(source, '..', 'runtime.tar.gz')} is not the manifest's runtime asset (${sha256})`);
  return { url, bytes };
}

/** Node's daemon on the case's own data and temp folders, started as the desktop starts one for session views; resolves once it published `daemon.json`. */
async function startDaemon(tree, sandbox, runtimeDir) {
  const root = join(sandbox, 'tmp', 'mixdog');
  const env = {
    ...envFor(sandbox),
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    MIXDOG_DISABLE_MCP: '1',
    MIXDOG_DISABLE_PROVIDER_WARMUP: '1',
    MIXDOG_DISABLE_MODEL_PREFETCH: '1',
    MIXDOG_DISABLE_MODEL_CATALOG_WARMUP: '1',
  };
  const child = spawn(process.execPath, [join(tree, 'src', 'standalone', 'daemon.mjs')], { cwd: join(sandbox, 'work'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const daemon = { child, runtimeDir, sandbox, doc: null, stderr: '' };
  child.stderr.on('data', (chunk) => { daemon.stderr += chunk; });
  const read = () => {
    try {
      const doc = JSON.parse(readFileSync(join(root, 'daemon.json'), 'utf8'));
      if (doc.pid === child.pid && doc.endpoints?.session?.port) return doc;
    } catch {}
    return null;
  };
  let watcher;
  const ready = new Promise((resolve, reject) => {
    watcher = watch(join(sandbox, 'tmp'), { recursive: true }, () => {
      const doc = read();
      if (doc) resolve(doc);
    });
    child.once('exit', (code) => reject(new Error(`the daemon exited ${code} before it was ready: ${daemon.stderr}`)));
    const doc = read();
    if (doc) resolve(doc);
  });
  try {
    daemon.doc = await bounded('the daemon to publish daemon.json', ready, 60_000);
  } catch (error) {
    endTree(child.pid);
    throw error;
  } finally {
    watcher.close();
  }
  return daemon;
}

/** A session-transport request of the daemon, answered within `ms`. */
async function daemonPost(doc, path, body, ms) {
  const response = await fetch(`http://127.0.0.1:${doc.endpoints.session.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': doc.endpoints.session.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  return response.status;
}

/** Whether the daemon still answers a client registering (as a desktop session view does), the exec having ended. */
async function daemonAnswers(tree, daemon) {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return false;
  const { SESSION_PROTOCOL, SESSION_REVISION } = await import(pathToFileURL(join(tree, 'src/standalone/session-wire.mjs')).href);
  return (await daemonPost(daemon.doc, '/client/register', { protocol: SESSION_PROTOCOL, revision: SESSION_REVISION, clientKind: 'desktop', lifecycle: false }, 30_000)) === 200;
}

/** Ends the daemon (a stop request, then its process tree) and the postmaster it may have left in the data folder. */
async function endDaemon(daemon) {
  const { child } = daemon;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise((resolve) => (gone() ? resolve() : child.once('exit', resolve)));
  if (!gone()) await daemonPost(daemon.doc, '/stop', { force: true }, 15_000).catch(() => {});
  await bounded('the daemon to exit after its stop request', exited, 60_000).catch(() => endTree(child.pid));
  await bounded(`the daemon pid ${child.pid} to exit`, exited, 15_000);
  stopPostmaster(daemon.sandbox, daemon.runtimeDir);
}

/** The postmaster a run left in the case's data folder, stopped (a run that started none leaves nothing to stop). */
function stopPostmaster(sandbox, runtimeDir) {
  const pgdata = join(sandbox, 'host-data', 'pgdata');
  if (existsSync(join(pgdata, 'postmaster.pid'))) {
    const stop = spawnSync(join(runtimeDir, 'bin', 'pg_ctl.exe'), ['stop', '-m', 'fast', '-w', '-t', '30', '-D', pgdata], { stdio: 'ignore', timeout: 40_000, windowsHide: true });
    if (stop.status !== 0 && existsSync(join(pgdata, 'postmaster.pid'))) throw new Error(`pg_ctl stop failed; the postmaster in ${pgdata} is still running`);
  }
}

async function runCase(tree, name, runtimeSource, asset) {
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
      // The memory runtime the exec's session ingest downloads, served as the release serves it: the recording environment must not make
      // Node's ingest fail where an installed machine's would not.
      if (req.method === 'GET' && `${req.headers['x-bench-origin']}${path}` === asset.url) {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': asset.bytes.length }).end(asset.bytes);
        return;
      }
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
  const runtimeDir = spec.daemon ? installRuntime(tree, runtimeSource, join(sandbox, 'host-data')) : null;
  const daemon = spec.daemon ? await startDaemon(tree, sandbox, runtimeDir) : null;
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
  const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => { endTree(child.pid); if (daemon) endTree(daemon.child.pid); reject(new Error(`${name}: the run did not end in ${RUN_DEADLINE_MS} ms`)); }, RUN_DEADLINE_MS); });
  let left = null;
  if (spec.interrupt) {
    await Promise.race([held, timedOut]);
    if (spec.interrupt === 'ctrl-c') ctrlC(child.pid);
    else child.kill();
  }
  const code = await Promise.race([exited, timedOut]);
  clearTimeout(deadline);
  // What the exec did to the daemon beside it: whether it still answers a client.
  const beside = daemon ? { aliveAfterExec: await daemonAnswers(tree, daemon) } : null;
  if (daemon) await endDaemon(daemon);
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
  // `others`: the requests that are not the turn's, answered 404; their order follows background timers, so they are kept as a
  // sorted set.
  return { case: name, argv: spec.argv, stdin: '', env: ENV, replies, repeat: spec.repeat === true, code, output: ordered(chunks, sandbox), requests, others: [...new Set(others)].sort(), files, ...(left ? { left } : {}), ...(beside ? { daemon: beside } : {}) };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('the CLI recording sends console control events: Windows only');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = exactProductIdentity(tree, args.get('commit'));
  const finalDir = join(FIXTURES_ROOT, 'exec-cli');
  const stage = stageSet(finalDir);
  const runtimeSource = args.get('runtime') ?? process.env.MIXDOG_PG_RUNTIME;
  if (!runtimeSource || !existsSync(join(runtimeSource, 'bin'))) throw new Error('--runtime <unpacked PostgreSQL runtime> (or MIXDOG_PG_RUNTIME) is required: the daemon of the beside-daemon case installs it instead of downloading one');
  const asset = runtimeAsset(tree, runtimeSource);
  for (const name of Object.keys(CASES)) writeJson(join(stage, `${name}.json`), await runCase(tree, name, runtimeSource, asset));
  writeSetManifest(stage, { set: 'exec-cli', recorder, command: `node ${recorder} --tree <tree> --commit ${args.get('commit')}`, identity, extra: { exact: true, ...recorderProvenance(import.meta.url), besideDaemon: 'the beside-daemon case starts Node\'s daemon (src/standalone/daemon.mjs, MIXDOG_DAEMON_SPAWNED_FOR=session) on the case\'s data and temp folders, with an unpacked PostgreSQL runtime laid out in <data>/runtime as an installed one is (active-version and the digest stamp that runtime-fetcher.mjs cachedRuntimeDir, :494 and :675, accepts) so it downloads none; the daemon\'s own network is not tapped and not recorded; the recording keeps whether the daemon still answers a client registering once the exec has ended', exclusions: EXCLUSIONS, stderrNotCompared: STDERR_NOT_COMPARED, othersNotCompared: OTHERS_NOT_COMPARED } });
  commitStage(stage, finalDir);
}
await main();
