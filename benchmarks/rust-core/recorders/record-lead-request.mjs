#!/usr/bin/env node
// What the model receives on a desktop lead thread, whole: Node's daemon (b6f10295a) is started as a child process over a throwaway profile
// whose settings the scenario sets, a desktop client creates a task the way the desktop does (`session.create` with a `desktopSession`, then
// `session.configure setRoute`) and submits one prompt, and the request the provider endpoint receives is kept as the provider adapter sent
// it: the whole system prompt, the whole tool list in its order, and (on the Anthropic wire) every `cache_control` breakpoint.
//
// The provider is a loopback endpoint of this recorder (a `custom` provider, `auth: none`), so no network and no key is involved. The
// paths of the profile are the tokens `{DATA}` (the data directory), `{WS}` (the workspace) and `{HOME}` of the recording; a replay builds
// its own folders and maps its own paths to the same tokens, so the text compared is the text of both sides with only the folder named.
//
//   node benchmarks/rust-core/recorders/record-lead-request.mjs --tree <export of b6f10295a with node_modules> --patch <node-fix-spawn-model-settings.patch>,<node-fix-deferred-listing-trigger.patch> [--only <scenario>]
//
// Each scenario is run twice: the first run is the recording, the second a check that it is byte-identical (a difference fails the recorder and names where).
//
// Output: native/core/fixtures/lead-request/golden.json (+ MANIFEST.json). Each scenario holds the settings it was recorded under (`config`,
// the files of the data directory and of the workspace), the route, and the recorded request.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, nodeTreeIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';
import { LEAD_SCENARIOS, PROMPT_TOKEN, ROUTES } from './lib/lead-request-scenarios.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-lead-request.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { SESSION_PROTOCOL, SESSION_REVISION } = await imp('src/standalone/session-wire.mjs');
const scratchRoot = process.env.MIXDOG_RECORDER_SCRATCH ?? process.env.TEMP;
const DEADLINE_MS = 120_000;
const OFFLINE_NETWORK = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'offline-network.mjs');

const withDeadline = (promise, label, ms = DEADLINE_MS) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not done after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

const sse = (events) => events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join('');

/** A loopback provider of one wire: every POST body is kept, and the answer is one short text. */
async function provider(route) {
  const posts = [];
  let waiting = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: route.model, object: 'model', type: 'model' }], has_more: false }));
        return;
      }
      const post = { url: req.url, body: JSON.parse(raw || '{}') };
      posts.push(post);
      if (waiting?.match(post)) waiting.resolve(post);
      if (route.wire === 'anthropic') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          sse([
            ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: route.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
            ['message_stop', { type: 'message_stop' }],
          ])
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: route.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.end(
        sse([
          [null, chunk({ role: 'assistant', content: '' })],
          [null, chunk({ content: 'ok' })],
          [null, chunk({}, 'stop')],
          [null, { id: 'c1', object: 'chat.completion.chunk', model: route.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }],
        ]) + 'data: [DONE]\n\n'
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    /** The first POST `match` accepts: the one that already arrived, else the one whose arrival the server signals. */
    arrival: (match) => {
      const early = posts.find(match);
      if (early) return Promise.resolve(early);
      return new Promise((resolve) => {
        waiting = { match, resolve };
      });
    },
    close: () =>
      new Promise((resolve) => {
        waiting = null;
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** The programs a scenario puts on the PATH: git always, and what it names. */
const scenarioPrograms = (scenario) => ['git', ...(scenario.path ?? [])];

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** The profile of one scenario: every root the daemon resolves is inside `sandbox`; the settings and files are the scenario's. */
function seed(sandbox, scenario, route, baseURL) {
  const home = join(sandbox, 'home');
  const data = join(home, '.mixdog', 'data');
  const ws = join(sandbox, 'ws');
  const env = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    PATH: [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'),
    TEMP: join(sandbox, 'tmp'),
    TMP: join(sandbox, 'tmp'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    HOME: home,
    USERPROFILE: home,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_DATA_DIR: data,
    MIXDOG_CONFIG_DIR: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(sandbox, 'runtime'),
    MIXDOG_DESKTOP_USER_DATA: join(home, 'AppData', 'Roaming', 'Mixdog'),
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    // As the desktop starts it: the channels (and their PostgreSQL stores) start only when a channels client registers.
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    NO_PROXY: '127.0.0.1,localhost',
    TZ: 'UTC',
    // The catalogs are fetched from the network and change daily: the daemon starts without them, as a replay's core does.
    NODE_OPTIONS: `--import ${pathToFileURL(OFFLINE_NETWORK).href}`,
    ...(scenario.mcp ? {} : { MIXDOG_DISABLE_MCP: '1' }),
    ...scenario.env,
  };
  for (const dir of [env.TEMP, env.APPDATA, env.LOCALAPPDATA, data, env.MIXDOG_RUNTIME_ROOT, ws]) mkdirSync(dir, { recursive: true });
  const config = {
    ...scenario.config,
    agent: {
      ...scenario.config?.agent,
      ...(scenario.settingsRoute ? { default: 'main', presets: [{ id: 'main', name: 'main', provider: route.provider, model: route.model }] } : {}),
      providers: {
        [route.provider]: {
          type: 'custom',
          schemaVersion: 2,
          name: 'lead',
          protocol: route.protocol,
          baseURL,
          auth: 'none',
          enabled: true,
          modelOverrides: { [route.model]: { manual: true } },
        },
      },
    },
  };
  writeFileSync(join(data, 'mixdog-config.json'), JSON.stringify(config, null, 2).replaceAll('{DATA}', data.replaceAll('\\', '/')));
  for (const [rel, text] of Object.entries(scenario.data ?? {})) put(data, rel, text);
  for (const [rel, text] of Object.entries(scenario.workspace ?? {})) put(ws, rel, text);
  // A developer's machine has git (and node, for a server started with `node`) on its PATH: the folders of the programs the scenario names are added.
  const programs = { git: () => spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0], node: () => process.execPath };
  for (const name of scenarioPrograms(scenario)) env.PATH = `${env.PATH};${dirname(programs[name]())}`;
  if (scenario.gitInit) spawnSync('git', ['init', '-b', 'main'], { cwd: ws, env, windowsHide: true, stdio: 'ignore' });
  return { env, data, ws, home };
}

async function oneScenario(scenario) {
  const route = ROUTES[scenario.route];
  const sandbox = mkdtempSync(join(scratchRoot, 'lead-req-'));
  const server = await provider(route);
  let child = null;
  let doc = null;
  let watcher = null;
  let attached = null;
  let stderr = '';
  try {
    const { env, data, ws, home } = seed(sandbox, scenario, route, server.baseURL);
    child = spawn(process.execPath, [join(tree, 'src/standalone/daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: ws });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const read = () => {
      try {
        const found = JSON.parse(readFileSync(join(env.MIXDOG_RUNTIME_ROOT, 'daemon.json'), 'utf8'));
        if (found.pid === child.pid && found.endpoints?.session?.port) return found;
      } catch {}
      return null;
    };
    const ready = new Promise((resolve, reject) => {
      watcher = watch(env.MIXDOG_RUNTIME_ROOT, () => {
        const found = read();
        if (found) resolve(found);
      });
      child.once('exit', (code) => reject(new Error(`the daemon exited ${code} before it was ready: ${stderr}`)));
      const found = read();
      if (found) resolve(found);
    });
    doc = await withDeadline(ready, 'the daemon to publish daemon.json');
    watcher.close();
    const client = await imp('src/standalone/session-client.mjs');
    attached = await withDeadline(
      client.attachSession({
        discovery: { ...doc.endpoints.session, pid: doc.pid },
        cwd: ws,
        clientKind: 'desktop',
      }),
      'attachSession'
    );
    const created = await withDeadline(attached.call('session.create', { cwd: ws, desktopSession: { classification: 'project', projectPath: ws } }), 'session.create');
    const sessionId = String(created?.sessionId ?? '');
    if (!sessionId) throw new Error(`session.create: ${JSON.stringify(created)}`);
    // A new task whose draft names no route starts on the model the settings choose (configureDraft returns before setRoute).
    if (!scenario.settingsRoute) await withDeadline(attached.call('session.configure', { sessionId, action: 'setRoute', args: [{ provider: route.provider, model: route.model, applyToCurrentSession: true, keepMainModel: false }] }), 'setRoute');
    await withDeadline(attached.call('session.subscribe', { sessionId }), 'session.subscribe');
    const submitted = await withDeadline(attached.call('session.submit', { sessionId, prompt: `${PROMPT_TOKEN} ${scenario.prompt ?? 'hello'}` }), 'session.submit');
    if (submitted?.accepted !== true) throw new Error(`session.submit: ${JSON.stringify(submitted)}`);
    const request = await withDeadline(server.arrival((post) => JSON.stringify(post.body).includes(PROMPT_TOKEN)), 'the provider to receive the lead request');
    return { request, paths: { data, ws, home }, sessionId };
  } catch (error) {
    console.error(`daemon stderr:\n${stderr}`);
    throw error;
  } finally {
    // Every step below runs whatever the one before it did: a failed stop request or close never leaves the daemon, its watcher or the endpoint running.
    watcher?.close();
    await withDeadline(attached?.close() ?? Promise.resolve(), 'the client to close', 10_000).catch(() => {});
    if (doc) {
      await fetch(`http://127.0.0.1:${doc.endpoints.session.port}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': doc.endpoints.session.token }, body: JSON.stringify({ force: true }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await withDeadline(exited, 'the daemon to exit', 60_000).catch(() => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }));
    }
    await server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const scratchName = (id) => `s.${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;

/** One recording of a scenario, with its folders and its session's scratch folder as the tokens a replay maps its own to. */
async function recordOnce(scenario) {
  const got = await oneScenario(scenario);
  // Longest folder first (the data folder is inside the home folder); a folder is also written with forward slashes in places.
  const folders = [[got.paths.data, '{DATA}'], [got.paths.ws, '{WS}'], [got.paths.home, '{HOME}']].flatMap(([path, token]) => [[path, token], [path.replaceAll('\\', '/'), token]]);
  const tokenize = (value) => {
    // The session's scratch folder is named by a digest of its id (`session-scratch.mjs` `scratchName`), and each side's thread has an id of its own.
    if (typeof value === 'string') return folders.reduce((text, [path, token]) => text.replaceAll(path, token), value.replaceAll(got.sessionId, '{SESSION}').replaceAll(scratchName(got.sessionId), 's.{SCRATCH}'));
    if (Array.isArray(value)) return value.map(tokenize);
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, tokenize(inner)])) : value;
  };
  return tokenize(got.request);
}

/** Where two recorded values differ, as `path: first | second` lines (at most 10), so a failed check names its cause. */
function differences(path, first, second, out = []) {
  if (out.length >= 10 || JSON.stringify(first) === JSON.stringify(second)) return out;
  if (first && second && typeof first === 'object' && typeof second === 'object') {
    for (const key of new Set([...Object.keys(first), ...Object.keys(second)])) differences(`${path}.${key}`, first[key], second[key], out);
  } else if (typeof first === 'string' && typeof second === 'string') {
    const [a, b] = [first.split('\n'), second.split('\n')];
    for (let at = 0; at < Math.max(a.length, b.length) && out.length < 10; at += 1) if (a[at] !== b[at]) out.push(`${path} line ${at}: ${JSON.stringify(a[at])} | ${JSON.stringify(b[at])}`);
  } else out.push(`${path}: ${JSON.stringify(first)} | ${JSON.stringify(second)}`);
  return out;
}

/** The recording of a scenario is its one run; a second run is the check that the world the recorder builds is deterministic, and it must be byte-identical. */
async function recordChecked(scenario) {
  const recording = await recordOnce(scenario);
  const check = await recordOnce(scenario);
  if (JSON.stringify(recording) !== JSON.stringify(check)) throw new Error(`${scenario.name}: a second run differs from the first:\n${differences('request', recording, check).join('\n')}`);
  return recording;
}

const PATCHES = ['spawn-model-settings', 'deferred-listing-trigger'].map((topic) => `benchmarks/rust-core/recorders/node-patches/node-fix-${topic}.patch`).join(',');

/** Every text of the recorded request that is replaced, and why: each side builds its own folders and its own thread id, and nothing else is replaced. */
const MAPPINGS = {
  '{DATA}': 'the profile\'s data directory (the recorder\'s throwaway folder, the replay\'s own), in its backslash and forward-slash spellings',
  '{WS}': 'the workspace folder of the thread, in both spellings',
  '{HOME}': 'the profile\'s home folder (HOME, USERPROFILE, APPDATA, LOCALAPPDATA live in it), in both spellings; the data folder is inside it, so it is replaced after {DATA}',
  '{SESSION}': 'the id of the thread: each side creates its own (Node a session id, the core a thread id)',
  's.{SCRATCH}': 'the name of the session scratch folder, a digest of the thread id (session-scratch.mjs scratchName), so it differs with the id',
};

/** What the matrix does not cover. */
const SCOPE = {
  covered: 'the desktop lead thread (session.create with a desktopSession, then submit)',
  notCovered: ['agent-mode threads (a separate task)', 'phone threads (out of scope)'],
};

const only = args.get('only');
const recorded = [];
for (const scenario of LEAD_SCENARIOS.filter((s) => !only || s.name === only)) {
  const request = await recordChecked(scenario);
  recorded.push({ name: scenario.name, route: scenario.route, routeSpec: ROUTES[scenario.route], path: scenarioPrograms(scenario), prompt: scenario.prompt ?? 'hello', config: scenario.config ?? {}, data: scenario.data ?? {}, workspace: scenario.workspace ?? {}, gitInit: scenario.gitInit ?? false, env: scenario.env ?? {}, settingsRoute: scenario.settingsRoute ?? false, mcp: scenario.mcp ?? null, request });
  console.log(`${scenario.name}: ${JSON.stringify(request.body).length} bytes`);
}
if (only) {
  console.log(JSON.stringify(recorded[0], null, 2));
} else {
  const setDir = join(FIXTURES_ROOT, 'lead-request');
  mkdirSync(setDir, { recursive: true });
  writeJson(join(setDir, 'golden.json'), { scenarios: recorded });
  writeSetManifest(setDir, { set: 'lead-request', recorder: RECORDER, command: `node ${RECORDER} --tree <b6f10295a export with node_modules> --patch ${PATCHES}`, identity, extra: { ...recorderProvenance(import.meta.url, ['benchmarks/rust-core/recorders/lib/offline-network.mjs']), mappings: MAPPINGS, scope: SCOPE } });
}