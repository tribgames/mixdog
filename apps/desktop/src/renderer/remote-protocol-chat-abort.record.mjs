// Records what Node's phone gets back from a Stop (`abortSession`), for every case Node's abort distinguishes (abort.mjs:112-221): Node's own
// daemon and SessionHost from the exact export of b6f10295a, run unchanged, with a model endpoint that holds the turn open
// (remote-protocol-chat-abort-provider.mjs). Each case is a fresh thread: the first prompt starts a turn the endpoint holds, the phone's Stop
// (`host.abortSession`) is sent once the turn is in the state the case names, and the host's whole reply and the thread's stored row after the
// turn ended are recorded.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-abort.record.mjs <export dir> <out file> <real-turn-harness dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ABORT_CASES } from './remote-protocol-chat-abort-cases.mjs';
import { startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

const [exportDir, outFile, harness] = process.argv.slice(2);
if (!harness) throw new Error('usage: <export dir> <out file> <real-turn-harness dir>');
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const NODE_CHECKOUT = 'C:/Project/mixdog';

// The export is exact only if every file of the commit's tree is in it: byte for byte (git blob ids), or, for a text file the archive wrote
// with CRLF (* text=auto), the same bytes once CRLF is read as the LF the repository stores.
const listing = execFileSync('git', ['-C', NODE_CHECKOUT, 'ls-tree', '-r', COMMIT], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
const blobId = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const mismatched = [];
let checked = 0;
for (const line of listing) {
  const [meta, path] = line.split('\t');
  const [mode, , sha] = meta.split(' ');
  if (mode === '160000' || mode === '120000') continue;
  let body;
  try { body = readFileSync(join(exportDir, path)); } catch { mismatched.push(`${path} (missing)`); continue; }
  checked += 1;
  if (blobId(body) !== sha && blobId(Buffer.from(body.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) !== sha) mismatched.push(path);
}
if (mismatched.length) throw new Error(`the export is not b6f10295a: ${mismatched.length} files differ, e.g. ${mismatched.slice(0, 3).join(', ')}`);

const load = (path) => import(pathToFileURL(join(exportDir, 'apps/desktop/src', path)).href);
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-abort-node');
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { createDeadline, latch } = await hload('deadline.mjs');
const envPaths = isolatedPaths();
rmSync(envPaths.envRoot, { recursive: true, force: true });
for (const d of [envPaths.dataDir, envPaths.runtimeRoot, envPaths.appData, envPaths.localAppData, envPaths.tmp, envPaths.workspace]) mkdirSync(d, { recursive: true });
const project = join(envPaths.workspace, 'a');
mkdirSync(project, { recursive: true });
// Everything started is ended on every path: the model endpoint, the host and the daemon are closed by `end`, whichever step failed.
let deadline;
let discovery;
let host;
const provider = await startAbortProvider();
const end = async () => {
  deadline?.clear();
  const ended = createDeadline(60_000, () => 'ending the abort recording');
  try {
    if (host) await ended.race(host.dispose(), 'the host to dispose');
    // Node's own bounded wait for the daemon to exit.
    if (discovery) await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 });
    await ended.race(provider.close(), 'the model endpoint to close');
  } finally {
    ended.clear();
  }
};
let sessionClient;
let frames;
try {
writeFileSync(join(envPaths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };
for (const key of Object.keys(process.env)) if (/^MIXDOG_/i.test(key)) delete process.env[key];
Object.assign(process.env, daemonEnv(envPaths));
// The daemon is forked with this process's flags; it runs as a plain script.
process.execArgv = [];
const { SessionHost } = await load('main/session-host.ts');
sessionClient = await import(pathToFileURL(join(exportDir, 'src/standalone/session-client.mjs')).href);
const { createSessionProtocolClient } = await import(pathToFileURL(join(exportDir, 'src/standalone/session-protocol.mjs')).href);
const { createDesktopRuntime } = await import(pathToFileURL(join(exportDir, 'src/standalone/daemon-desktop-runtime.mjs')).href);

deadline = createDeadline(240_000, () => `node abort recording; frames seen: ${frames.length}; last frame: ${frames.at(-1)?.slice(0, 600)}; snapshot: ${JSON.stringify(Object.keys(host?.getSnapshot(lastId) ?? {}))} ${host?.getSnapshot(lastId)?.status}; provider requests: ${JSON.stringify(provider.requests.map((r) => [r.held, r.prompt.slice(0, 40)]))}`);
frames = [];
discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: envPaths.workspace, attempts: 1, readyTimeoutMs: 60_000 }), 'the Node daemon');
const waiters = new Set();
const wake = () => waiters.forEach((check) => check());
const until = (ready, what) => {
  const done = latch();
  const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
  waiters.add(check);
  check();
  return deadline.race(done.promise, what);
};
const runtime = {
  ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
  attachSessionClient: async (options) => {
    const attached = await sessionClient.attachSession({
      discovery,
      cwd: envPaths.workspace,
      onFrame: (frame) => { frames.push(JSON.stringify(frame)); options.onFrame(frame); wake(); },
      onFatal: options.onFatal,
    });
    return createSessionProtocolClient({ call: (name, args, callOptions) => attached.call(name, args, callOptions), close: (reason) => attached.close(reason) });
  },
};
host = await deadline.race(SessionHost.create({ userDataPath: envPaths.appData, resourcesPath: envPaths.workspace, appPath: envPaths.workspace, packaged: false }, runtime), 'the session host');
let published = [];
host.subscribeSessions((rows) => { published = rows; wake(); });
const plain = (value) => JSON.parse(JSON.stringify(value));
/** The session is idle: the host's own state for it says no turn runs. */
const idle = (id) => host.getSnapshot(id)?.busy === false;

const cases = [];
let lastId = '';
  for (const c of ABORT_CASES) {
    const at = (what) => process.stderr.write(`${c.name}: ${what}\n`);
    at('startProject');
    await deadline.race(host.startProject(project), 'startProject');
    const submit = { id: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}) };
    at('submitNewTask');
    const accepted = await deadline.race(host.submitNewTask(c.prompt, submit, { projectPath: project, route }), 'submitNewTask of '+c.name);
    const id = accepted.sessionId;
    lastId = id;
    await deadline.race(provider.held(c.prompt), `the model endpoint to receive the held turn of ${c.name}`);
    if (c.output) await until(() => frames.some((f) => f.includes(c.output)), `the streamed text of ${c.name} to reach the host`);
    if (c.then) {
      await deadline.race(host.submitToSession(id, c.then, { id: `sub-${c.name}-2` }), `submitToSession of the queued prompt of ${c.name}`);
      await until(() => frames.some((f) => f.includes(c.then)), `the queued prompt of ${c.name} to reach the host`);
    }
    at('abort');
    const reply = plain(await deadline.race(host.abortSession(id, c.stop), 'abortSession of '+c.name));
    const turns = c.then ? 2 : 1;
    await until(() => frames.some((f) => f.includes(id) && f.includes(`"turns":${turns}`)) && idle(id), `the turn(s) of ${c.name} to close after its Stop`);
    const second = c.again ? plain(await deadline.race(host.abortSession(id, c.again), `the second abortSession of ${c.name}`)) : undefined;
    // What the stopped turn left in the stored thread, whole: the transcript rows the host holds and the thread's list row.
    await until(() => published.some((r) => r.id === id), `the thread row of ${c.name} to be published`);
    const row = plain((await deadline.race(host.listSessions(), `listSessions after ${c.name}`)).find((r) => r.id === id) ?? null);
    const items = plain((await deadline.race(host.readSessionTranscript(id), `readSessionTranscript after ${c.name}`)).items);
    cases.push({ name: c.name, id, stop: c.stop, ...(c.again ? { again: c.again } : {}), node: { reply, ...(second ? { second } : {}), items, row } });
  }
  writeFileSync(outFile, `${JSON.stringify({
    manifest: { exact: true, commit: COMMIT, filesVerified: checked, source: 'Node daemon + SessionHost from the exact export, run unchanged; model endpoint remote-protocol-chat-abort-provider.mjs' },
    cases,
  }, null, 2)}\n`);
  console.log(`recorded ${cases.length} abort cases`);
} finally {
  await end();
}
process.exit(0);
