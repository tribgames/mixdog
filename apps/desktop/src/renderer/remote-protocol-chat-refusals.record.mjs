// Records what a RUNNING mixdogd answers to the phone's chat requests that Node answers with a refusal or an "unknown" (the cases of
// remote-protocol-chat.recorded.json whose core side was only scripted): an abort of an idle thread, a submit of an empty prompt, a start of
// an unregistered Project, the home of an unknown agent, a secret for a request the core never minted. Each case keeps the request the
// phone's adapter sends (the route it takes) and the core's whole reply or error body, as the core sent it.
//
// Usage: node remote-protocol-chat-refusals.record.mjs <mixdogd.exe> <real-turn-harness dir>
// Every wait has a deadline that names what it waits for (the harness deadline), and nothing waits for time.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, watch, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';
import { routeService } from '../main/protocol/service-route.ts';

const [bin, harness] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => join(harness, 'lib', name);
const PINNED = ['env.mjs', 'scenarios.mjs', 'stage.mjs', 'fake-provider.mjs', 'proc.mjs', 'deadline.mjs', 'pg-version.json'];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-refusals');
const load = (name) => import(pathToFileURL(lib(name)).href);
const { daemonEnv, isolatedPaths } = await load('env.mjs');
const { seedPgRuntime, killStrayPostgres } = await load('stage.mjs');
const { startFakeProvider } = await load('fake-provider.mjs');
const { launch } = await load('proc.mjs');
const { createDeadline, latch } = await load('deadline.mjs');

const paths = isolatedPaths();
rmSync(paths.envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
const project = join(paths.workspace, 'a');
const unregistered = join(paths.workspace, 'never-registered');
mkdirSync(project, { recursive: true });
mkdirSync(unregistered, { recursive: true });
seedPgRuntime(paths.dataDir);
const provider = await startFakeProvider({ workspace: paths.workspace });
writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };

const core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
const deadline = createDeadline(240_000, () => core.tail());

const daemonDoc = () => {
  const file = join(paths.runtimeRoot, 'daemon.json');
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d?.core?.state === 'blocked') throw new Error(`blocked ${JSON.stringify(d.core.blocked)}`);
    return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
  } catch (e) {
    if (String(e.message).startsWith('blocked')) throw e;
    return null;
  }
};
const served = latch();
const watcher = watch(paths.runtimeRoot, () => {
  try { const d = daemonDoc(); if (d) served.resolve(d); } catch (e) { served.reject(e); }
});
const early = daemonDoc();
if (early) served.resolve(early);
const doc = await deadline.race(served.promise, 'the core to serve');
watcher.close();

const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
await deadline.race(new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), 'the app-server socket to open');
const pending = new Map();
const notified = new Set();
const waiters = new Set();
let nextId = 1;
socket.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'));
  if (frame.id !== undefined && pending.has(frame.id)) { const p = pending.get(frame.id); pending.delete(frame.id); p.resolve(frame); }
  else if (frame.method) {
    if (frame.method === 'turn/completed') notified.add(frame.params.threadId);
    for (const check of [...waiters]) check();
  }
});
/** The whole frame the core answered (a result or an error body). */
const ask = (method, params) => deadline.race(new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, { resolve });
  socket.send(JSON.stringify({ id, method, params }));
}), `the reply to ${method}`);
const op = (method, params) => ask(method, { ...params, opId: uuidv7(Date.now()) });
const ok = (frame) => { if (frame.error) throw new Error(JSON.stringify(frame.error)); return frame.result; };
const until = (ready, what) => {
  const done = latch();
  const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
  waiters.add(check);
  check();
  return deadline.race(done.promise, what);
};

const cases = [];
/** Records the request the adapter's route builds for `call`, as the core answered it. */
async function phoneRequest(name, call, args) {
  const [request] = routeService(call, args).requests;
  const frame = await op(request.method, request.params);
  cases.push({ name, call, args, request, reply: frame.error ? { error: frame.error } : { result: frame.result } });
}

let out;
try {
  ok(await ask('initialize', { clientInfo: { name: 'ph2-chat-refusals', title: 'PH-2 refusals', version: '1.4.5', kind: 'tui' }, capabilities: {} }));
  socket.send(JSON.stringify({ method: 'initialized' }));
  // One idle thread with an answered turn: the phone's Stop and Send go to it.
  const threadId = ok(await op('thread/start', { kind: 'project', projectPath: project, draft: { route } })).thread.id;
  ok(await op('thread/resume', { threadId, window: { lastItems: 200 } }));
  ok(await op('turn/start', { threadId, input: { prompt: 'hello', options: { clientSubmissionId: 'refusals-first' } } }));
  await until(() => notified.has(threadId), 'the first turn of the thread to complete');

  await phoneRequest('abortSession-idle', 'abortSession', [threadId, {}]);
  await phoneRequest('submitToSession-empty', 'submitToSession', [threadId, '', { id: 'refusals-empty' }]);
  await phoneRequest('submitToSession-blank', 'submitToSession', [threadId, '   ', { id: 'refusals-blank' }]);
  await phoneRequest('submitNewTask-empty', 'submitNewTask', ['', { id: 'refusals-new-empty' }, {}]);
  await phoneRequest('openAgentHome-unknown-agent', 'openAgentHome', ['nobody']);
  // provideSecretInput is not a routed service call: the adapter sends `approval/provideSecret` itself (remote-protocol-chat-host.ts).
  const secret = { method: 'approval/provideSecret', params: { requestId: 'secret_abcdefgh12345', secret: 'value' } };
  const secretFrame = await op(secret.method, secret.params);
  cases.push({ name: 'provideSecretInput-unknown-id', call: 'provideSecretInput', args: ['secret_abcdefgh12345', 'value'], request: secret, reply: secretFrame.error ? { error: secretFrame.error } : { result: secretFrame.result } });
  // startProjectTask: the folder of a Project the core never registered (startFolder asks `project/directory` with owner).
  cases.push({ name: 'startProjectTask-unknown', call: 'startProjectTask', args: [unregistered], request: { method: 'project/directory', params: { path: unregistered, owner: true } } });
  const directory = cases.at(-1);
  const frame = await op(directory.request.method, directory.request.params);
  directory.reply = frame.error ? { error: frame.error } : { result: frame.result };
  out = {
    manifest: {
      binary: bin, binarySha256: sha256(bin), binaryBuilt: statSync(bin).mtime.toISOString(),
      harness: Object.fromEntries(PINNED.map((name) => [`lib/${name}`, sha256(lib(name))])),
      source: 'running mixdogd serve, isolated env (real-turn harness env.mjs / stage.mjs / fake-provider.mjs, pinned above), driven over the WebSocket JSON-RPC protocol',
    },
    thread: threadId, project, unregistered, cases,
  };
  writeFileSync(join(here, 'remote-protocol-chat-refusals.recorded.json'), JSON.stringify(out, null, 2));
  console.log(`recorded ${cases.length} cases`);
  for (const c of cases) console.log(c.name, JSON.stringify(c.request.method), JSON.stringify(c.reply).slice(0, 300));
} finally {
  deadline.clear();
  socket.close();
  core.kill();
  await core.exited;
  killStrayPostgres(paths.dataDir);
}
process.exit(0);
