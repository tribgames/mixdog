// Records what a RUNNING mixdogd answers for the roster sessions of remote-protocol-chat-roster.recorded.json: it starts the daemon in an
// isolated env (the real-turn harness's env and PostgreSQL seeding), builds the same sessions through the protocol (start, name, favorite,
// archive, fork), subscribes to the app feed, and saves the core's `thread/list` rows and every `thread/summary/updated` it pushed.
// Usage: node remote-protocol-chat-live.record.mjs <mixdogd.exe> <js-runtime-package-root>
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';

const HARNESS = 'D:\\mixdog-build\\tmp\\real-turn-harness';
const here = dirname(fileURLToPath(import.meta.url));
const root = 'D:\\mixdog-build\\pool\\w13-live';
process.env.HARNESS_ENV_ROOT = join(HARNESS, 'run', 'env-w13-live');
const { daemonEnv, isolatedPaths } = await import(`file:///${HARNESS.replace(/\\/g, '/')}/lib/env.mjs`);
const { seedPgRuntime, killStrayPostgres } = await import(`file:///${HARNESS.replace(/\\/g, '/')}/lib/stage.mjs`);
const { startFakeProvider } = await import(`file:///${HARNESS.replace(/\\/g, '/')}/lib/fake-provider.mjs`);
const { launch } = await import(`file:///${HARNESS.replace(/\\/g, '/')}/lib/proc.mjs`);

const [bin] = process.argv.slice(2);
const paths = isolatedPaths();
rmSync(paths.envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
const projects = { a: join(paths.workspace, 'a'), b: join(paths.workspace, 'b') };
for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
seedPgRuntime(paths.dataDir);
// thread/start needs a routable model, and a turn needs a provider that answers: the harness's fake OpenAI-compatible provider.
const provider = await startFakeProvider({ workspace: paths.workspace });
// a custom provider that is never called (no turn runs) is the harness's own config.
writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };

const core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
let doc;
for (let i = 0; i < 600 && !doc; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const d = JSON.parse(readFileSync(join(paths.runtimeRoot, 'daemon.json'), 'utf8'));
    if (d?.core?.state === 'blocked') throw new Error(`blocked ${JSON.stringify(d.core.blocked)}`);
    if (d?.core?.state === 'serving' && d.core.rpc?.port) doc = d;
  } catch (e) {
    if (String(e.message).startsWith('blocked')) throw e;
  }
}
if (!doc) throw new Error(`the core never served:\n${core.tail()}`);

const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, { headers: { Authorization: `Bearer ${doc.endpoints.session.token}` }, perMessageDeflate: false });
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const pending = new Map();
const notes = [];
let nextId = 1;
socket.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'));
  if (frame.id !== undefined && pending.has(frame.id)) { const p = pending.get(frame.id); pending.delete(frame.id); frame.error ? p.reject(new Error(JSON.stringify(frame.error))) : p.resolve(frame.result); }
  else if (frame.method) notes.push({ method: frame.method, params: frame.params });
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
// The core requires a lowercase UUIDv7 `opId`: the client library's own generator.
const op = (method, params) => call(method, { ...params, opId: uuidv7(Date.now()) });
const settle = () => new Promise((r) => setTimeout(r, 8000));

try {
  await call('initialize', { clientInfo: { name: 'w13-live', title: 'PH-2 live roster', version: '1.4.5', kind: 'tui' }, capabilities: {} });
  socket.send(JSON.stringify({ method: 'initialized' }));
  await call('app/subscribe', {});
  await settle();
  // The roster's sessions: sess_0 / sess_1 / sess_2 (a fork of sess_0, favorite) / sess_3 (archived) / sess_4.
  const made = {};
  for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
    made[name] = (await op('thread/start', { kind: 'project', projectPath: projects[project], draft: { route } })).thread.id;
    await op('thread/name/set', { threadId: made[name], title: `Title ${name.slice(-1)}` });
  }
  const fork = await op('thread/fork', { threadId: made.sess_0 });
  made.sess_2 = fork.thread.id;
  await op('thread/name/set', { threadId: made.sess_2, title: 'Title 2' });
  await op('thread/metadata/update', { threadId: made.sess_2, favorite: true });
  await op('thread/readState/update', { threadId: made.sess_1, messageCount: 0, consumedUnread: true });
  // A row reaches the index writer (and so the app feed's edges) when a turn is written: one answered turn on sess_1 and sess_0.
  for (const name of ['sess_1', 'sess_0']) {
    await call('thread/resume', { threadId: made[name], window: { lastItems: 200 } });
    const before = notes.filter((n) => n.method === 'turn/completed').length;
    await op('turn/start', { threadId: made[name], input: { prompt: `hello ${name}`, options: { clientSubmissionId: `w13-live-${name}` } } });
    for (let i = 0; i < 240 && notes.filter((n) => n.method === 'turn/completed').length === before; i += 1) await new Promise((r) => setTimeout(r, 250));
  }
  await op('thread/archive', { threadId: made.sess_3 });
  await settle();
  const listed = await call('thread/list', { limit: 1000 });
  const archived = await call('thread/list', { limit: 1000, archived: true });
  const out = {
    manifest: {
      binary: bin, binarySha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), binaryBuilt: statSync(bin).mtime.toISOString(),
      server: (await call('server/info', {}).catch(() => null)) ?? null,
      source: 'running mixdogd serve, isolated env (real-turn harness env.mjs / stage.mjs), driven over the WebSocket JSON-RPC protocol',
    },
    made, listed, archived, notes,
  };
  writeFileSync(join(here, 'remote-protocol-chat-live.recorded.json'), JSON.stringify(out, null, 2));
  console.log(`recorded ${listed.data?.length} listed, ${archived.data?.length} archived, ${notes.length} notifications`);
} finally {
  socket.close();
  core.kill();
  await new Promise((r) => setTimeout(r, 1500));
  killStrayPostgres(paths.dataDir);
}
process.exit(0);
