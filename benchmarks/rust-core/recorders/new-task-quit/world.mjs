// One recorded case of the app's quit while a new task is in flight, on Node b6f10295a run unchanged: this process is the app's main process
// (`process.type` is `browser`, so its daemon is forked into its own tree on Windows: session-client.mjs:59-63), its local connection is the app's
// own `DesktopServiceClient` over a `SessionTransport` (connections/desktop-connection.ts:300-330), and the daemon it starts loads the desktop
// service the app names (`daemon.cjs`, built from the export by the app's own scripts/build-daemon.mjs; desktop-service-registry.mjs:111-205), so
// the SessionHost runs in the daemon as the app's does. The quit is the app's: the local connection is disposed (index.ts:1684-1685
// `localConnection.dispose()` → desktop-connection.ts:513-523 `client.dispose()`), then the in-tree daemon is asked to stop
// (index.ts:1710-1712 `transport.stopInTreeDaemon(DESKTOP_DAEMON_STOP_TIMEOUT_MS)` → session-client.mjs:667-707 `POST /stop {force:true}`), and
// the daemon's own `shutdown('SIGTERM')` (routes.mjs:200-209, daemon.mjs:272-413) runs to its `process.exit`.
//
// A held step is held where its call waits on something outside the daemon, through a seam the product has: `requestWorktree`'s last git
// command (cases.mjs says why) through the `git` on the daemon's PATH (git-shim.cs; git-launch.mjs runs a bare `git` that is not Git for Windows' layout as found on
// PATH). The held command is let go once the daemon has answered the stop request (routes.mjs:208 answers, :209 then raises SIGTERM), so the call
// settles while the daemon shuts down.
//
//   node --import tsx world.mjs <export dir> <case json> <out file>      (cwd: <export dir>/apps/desktop)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [exportDir, caseJson, outFile] = process.argv.slice(2);
const c = JSON.parse(caseJson);
const root = c.root;
const paths = {
  home: join(root, 'home'),
  dataDir: join(root, 'home', '.mixdog', 'data'),
  mixdogHome: join(root, 'home', '.mixdog'),
  runtimeRoot: join(root, 'runtime'),
  appData: join(root, 'home', 'AppData', 'Roaming'),
  localAppData: join(root, 'home', 'AppData', 'Local'),
  tmp: join(root, 'tmp'),
  workspace: join(root, 'ws'),
};
const userData = join(paths.appData, 'Mixdog');
const project = join(paths.workspace, 'proj');
for (const dir of [...Object.values(paths), userData, project]) mkdirSync(dir, { recursive: true });

const trace = [];
const note = (what) => {
  trace.push(`${new Date().toISOString().slice(11, 23)} ${what}`);
  process.stderr.write(`${c.name}: ${what}\n`);
};

/** One deadline per wait, naming what it waits for. */
const within = (ms, promise, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${c.name}: ${what}: not within ${ms} ms; seen: ${trace.slice(-12).join(' | ')}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const latch = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// The model endpoint (a turn's answer: one short text) on loopback. `streamed` counts the turn streams it finished.
let streamed = 0;
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    note(`provider ${req.method} ${req.url}`);
    if (held.armed && !held.release && c.hold?.provider === `${req.method} ${req.url}`) {
      held.release = () => answer(req, res, raw);
      held.reached.resolve();
      return;
    }
    answer(req, res, raw);
  });
});
function answer(req, res, raw) {
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'harness-model', object: 'model' }] }));
    return;
  }
  const body = JSON.parse(raw || '{}');
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  if (body.stream !== true) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion', model: 'harness-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }));
    return;
  }
  res.once('finish', () => (streamed += 1));
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion.chunk', created: 1700000000, model: 'harness-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(chunk({ role: 'assistant', content: '' }));
  res.write(chunk({ content: 'ok' }));
  res.write(chunk({}, 'stop'));
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-quit', object: 'chat.completion.chunk', model: 'harness-model', choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${provider.address().port}/v1`;

// The `git` the daemon runs (git-shim.cs asks here before it runs the real one). The case's hold names the command held.
const held = { armed: false, release: null, reached: latch() };
const gitServer = net.createServer((socket) => {
  let asked = '';
  socket.on('data', (chunk) => {
    asked += chunk;
    if (!asked.includes('\n')) return;
    const [cwd, args] = asked.trim().split('\t');
    note(`git ${args} (in ${cwd === project ? '<project>' : cwd})`);
    if (held.armed && !held.release && c.hold?.git && args.startsWith(c.hold.git)) {
      held.release = () => socket.end('go\n');
      held.reached.resolve();
      return;
    }
    socket.end('go\n');
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => gitServer.listen(0, '127.0.0.1', resolve));

const REAL_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const SHIM_DIR = c.shimDir;
// The parent's variables that could route the daemon to a real service, a user daemon or a real key are left out (as the harness's env.mjs).
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
for (const name of Object.keys(process.env)) if (DROP.test(name)) delete process.env[name];
Object.assign(process.env, {
  MIXDOG_DATA_DIR: paths.dataDir,
  MIXDOG_HOME: paths.mixdogHome,
  MIXDOG_CONFIG_DIR: paths.mixdogHome,
  MIXDOG_DESKTOP_USER_DATA: userData,
  MIXDOG_RUNTIME_ROOT: paths.runtimeRoot,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_SUPERVISOR_BIN: c.supervisor,
  MIXDOG_DAEMON_SKIP_MEMORY: '1',
  MIXDOG_DISABLE_MCP: '1',
  HOME: paths.home,
  USERPROFILE: paths.home,
  APPDATA: paths.appData,
  LOCALAPPDATA: paths.localAppData,
  TEMP: paths.tmp,
  TMP: paths.tmp,
  TMPDIR: paths.tmp,
  NO_PROXY: '127.0.0.1,localhost',
  GIT_CEILING_DIRECTORIES: paths.workspace,
  PATH: `${SHIM_DIR};${process.env.PATH}`,
  MIXDOG_QUIT_GIT_PORT: String(gitServer.address().port),
  MIXDOG_QUIT_REAL_GIT: REAL_GIT,
});
writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
// The task's project: a git repository with one commit (made with the real git, before any daemon runs).
const git = (...args) => execFileSync(REAL_GIT, args, { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: 'rec', GIT_AUTHOR_EMAIL: 'rec@example.invalid', GIT_COMMITTER_NAME: 'rec', GIT_COMMITTER_EMAIL: 'rec@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }, stdio: 'pipe', windowsHide: true, timeout: 60_000 });
git('init', '-q', '-b', 'main');
writeFileSync(join(project, 'README.md'), 'project\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'first');

// This process is the app's main process.
Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
const load = (path) => import(pathToFileURL(join(exportDir, path)).href);
const { DesktopServiceClient } = await load('apps/desktop/src/main/desktop-service-client.ts');
const { SessionTransport } = await load('apps/desktop/src/main/session-transport.ts');
const { DESKTOP_DAEMON_STOP_TIMEOUT_MS } = await load('apps/desktop/src/main/quit-sequence.ts');
// The daemon is forked with this process's flags; it runs as a plain script, as the app's does.
process.execArgv = [];
const moduleUrl = pathToFileURL(c.serviceModule).href;

// The stop request's answer (routes.mjs:208) is seen where session-client.mjs:122 sends it.
let stopAnswered = latch();
const request = http.request;
http.request = (options, ...rest) => {
  const req = request(options, ...rest);
  if (options?.path === '/stop') req.once('response', () => stopAnswered.resolve());
  return req;
};

/** The app's local connection (desktop-connection.ts:300-330 with no remote binding), started. */
async function openApp() {
  let transport = null;
  const client = new DesktopServiceClient({
    connect: () => (transport = new SessionTransport(moduleUrl, paths.workspace, null, Promise.resolve(), null)),
    sessionOptions: () => ({ userDataPath: userData, packaged: false, resourcesPath: join(exportDir, 'apps', 'desktop'), appPath: join(exportDir, 'apps', 'desktop') }),
  });
  await within(120_000, client.start(), 'the app to attach to its daemon');
  return { client, transport: () => transport };
}

/** The app's quit: the local connection disposed, then the in-tree daemon stopped. */
async function quitApp(app) {
  await within(60_000, app.client.dispose(), 'the local connection to dispose');
  stopAnswered = latch();
  const stopped = within(120_000, app.transport().stopInTreeDaemon(DESKTOP_DAEMON_STOP_TIMEOUT_MS), 'the in-tree daemon to stop').then(appExits);
  return { stopped, answered: stopAnswered.promise };
}

/** The app exits once the stop's wait is over; a daemon it forked into its own tree that outlived the wait dies with it
 *  (session-client.mjs:658-659), here ended by its pid's tree, bounded. */
function appExits(outcome) {
  if (outcome.stopped) return outcome;
  note(`the daemon outlived the app's wait: ${JSON.stringify(outcome)}`);
  for (const pid of outcome.inTree) {
    const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    // 128: the process ended between the wait and the kill.
    if (ended.error || (ended.status !== 0 && ended.status !== 128)) throw new Error(`${c.name}: ending the daemon tree of pid ${pid} at the app's exit failed: ${ended.error?.message ?? ended.stderr}`);
  }
  return outcome;
}

const receipts = () => {
  const dir = join(userData, 'new-task-receipts');
  try {
    return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString('latin1')]));
  } catch {
    return null;
  }
};
/** The sessions the daemon stored (`<data>/sessions/<id>.log.jsonl`), by id. */
const stored = () => {
  try {
    return readdirSync(join(paths.dataDir, 'sessions')).filter((name) => name.endsWith('.log.jsonl')).map((name) => name.slice(0, -'.log.jsonl'.length)).sort();
  } catch {
    return [];
  }
};
/** The daemon's own lines about the session's creation and actions (daemon.log), for the trace. */
const daemonActions = () => {
  try {
    return readFileSync(join(paths.dataDir, 'daemon.log'), 'utf8').split('\n').filter((line) => /session (created|action|submit|disposed)|shutting down/.test(line)).map((line) => line.replace(/^\[[^\]]*\] \[daemon\] /, '').replace(/sess_desktop_[0-9a-f]{64}/g, 'S').slice(0, 120));
  } catch {
    return [];
  }
};
/** The accepted task's first turn has ended: the model endpoint answered its stream and the session's state then shows it idle
 *  (the state the app receives for a visible session). */
async function turnSettled(app, sessionId) {
  const done = latch();
  const check = (update) => {
    if (update?.sessionId === sessionId && streamed > 0 && update.snapshot && update.snapshot.busy === false) done.resolve();
  };
  const unsubscribe = app.client.subscribeSessionStates(check);
  try {
    await within(60_000, app.client.setVisibleSessions([sessionId]), 'setVisibleSessions');
    await within(120_000, done.promise, `the first turn of ${sessionId} to end`);
  } finally {
    unsubscribe();
  }
}
/** An answer less the session snapshot it carries (COMPARISON.notRecorded). */
const unsnapshotted = ({ snapshot: _snapshot, ...rest }) => rest;
const asReceived = {
  answer: (result) => ({ ok: true, ...result }),
  rejection: (error) => ({ ok: false, error: String(error?.message ?? error), ...(error && typeof error === 'object' ? { ...error } : {}) }),
};
const submit = (app) =>
  app.client.submitNewTask(c.content.prompt, { ...c.content.options, id: c.id }, { ...structuredClone(c.content.draft), projectPath: project }).then(asReceived.answer, asReceived.rejection);
const recorded = { name: c.name, steps: [] };
let failure = null;
try {
  // The interrupted request.
  let app = await openApp();
  note('attached');
  // The task's project is a registered one (the phone offers the registered projects).
  await within(60_000, app.client.addProject(project), 'addProject');
  if (c.hold) {
    held.armed = true;
    const answer = submit(app);
    const early = await within(120_000, Promise.race([held.reached.promise.then(() => null), answer]), `the attempt to reach its held ${c.hold.step}`);
    if (early) throw new Error(`the attempt ended before it was held at ${c.hold.step}: ${JSON.stringify(early)}`);
    note(`held at ${c.hold.step}; the daemon logged: ${daemonActions().join(' | ')}`);
    // What the app lists while the attempt is held (a reservation is no listed session in Node: session-views.mjs:31-45).
    const listed = (await within(60_000, app.client.listSessions(), 'listSessions while held')).map((row) => row.id);
    const quit = await quitApp(app);
    await within(60_000, quit.answered, 'the daemon to answer the stop request');
    note('stop answered; the held call goes on');
    held.release();
    const outcome = await quit.stopped;
    note(`daemon stop: ${JSON.stringify(outcome)}`);
    note(`after the stop the daemon logged: ${daemonActions().join(' | ')}`);
    recorded.steps.push({ listed: listed, reply: unsnapshotted(await answer), stop: { stopped: outcome.stopped, request: outcome.request }, receipts: receipts(), stored: stored() });
  } else {
    const answer = await within(120_000, submit(app), 'the submission');
    // The workflow and orchestration mode the draft gave the new session, as its snapshot shows them (contract-session.ts:289-290).
    const settings = answer.ok ? { workflow: answer.snapshot?.workflow ?? null, orchestrationMode: answer.snapshot?.orchestrationMode ?? null } : null;
    if (answer.ok) await turnSettled(app, answer.sessionId);
    const quit = await quitApp(app);
    const outcome = await quit.stopped;
    recorded.steps.push({ reply: unsnapshotted(answer), settings, stop: { stopped: outcome.stopped, request: outcome.request }, receipts: receipts(), stored: stored() });
  }
  if (c.hold) {
    // The app starts again over the same folders; the same request comes in again.
    app = await openApp();
    note('attached again');
    const retry = await within(120_000, submit(app), 'the retry');
    if (retry.ok) await turnSettled(app, retry.sessionId);
    const quit = await quitApp(app);
    const outcome = await quit.stopped;
    recorded.steps.push({ reply: unsnapshotted(retry), stop: { stopped: outcome.stopped, request: outcome.request }, receipts: receipts(), stored: stored() });
  }
} catch (error) {
  failure = error;
} finally {
  provider.close();
  provider.closeAllConnections();
  gitServer.close();
}
writeFileSync(outFile, JSON.stringify({ recorded, trace, failure: failure ? String(failure.stack ?? failure) : null }, null, 2));
process.exit(failure ? 1 : 0);
