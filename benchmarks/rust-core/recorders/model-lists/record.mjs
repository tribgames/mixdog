// Records Node's model-list reads (listProviderModels quick and full, listWebSearchModels) for the scenarios in
// scenarios.json, each in its own isolated env under the OS temp dir (temp MIXDOG_* roots, no real key, no network: the
// custom provider's endpoint is a loopback stub answering an empty model list). Writes
// native/core/fixtures/model-lists/node-model-lists.json.
//   node benchmarks/rust-core/recorders/model-lists/record.mjs --tree <tree>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const treeAt = process.argv.indexOf('--tree');
if (treeAt < 0 || !process.argv[treeAt + 1]) throw new Error('usage: record.mjs --tree <tree>');
const NODE_TREE = resolve(process.argv[treeAt + 1]);
const RUN_ROOT = mkdtempSync(join(tmpdir(), 'model-lists-'));
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? null : process.argv[onlyAt + 1];
const setAt = process.argv.indexOf('--set');
const setName = setAt < 0 ? null : process.argv[setAt + 1];
const scenarios = JSON.parse(readFileSync(join(HERE, setName ? `scenarios-${setName}.json` : 'scenarios.json'), 'utf8')).filter((s) => !only || s.name === only);
const hits = [];
// The metadata layers a Node daemon would fetch from models.dev and LiteLLM (and the update check it runs) are
// seeded fresh instead, so no run reaches a network and the Rust test seeds the same files.
const seeds = JSON.parse(readFileSync(join(HERE, 'seeds.json'), 'utf8'));

let routes = {};
let stubFile = null;
// The running scenario's hold folder. While child.mjs has written `hold-endpoint` there, the next request is held (its
// arrival written to `endpoint-held`) until child.mjs writes `release-endpoint`: a directory watch and one deadline.
let endpointHold = null;
let endpointHeld = false;
const stub = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  hits.push(path);
  // A call of the scenario that carries `stub` swaps what the endpoint answers from then on (child.mjs writes it here).
  const live = stubFile && existsSync(stubFile) ? JSON.parse(readFileSync(stubFile, 'utf8')) : routes;
  const answer = live[path] ?? { object: 'list', data: [] };
  // `{ "__status": n }` answers that HTTP status with an empty object.
  const reply = () => {
    response.statusCode = answer.__status ?? 200;
    response.end(JSON.stringify(answer.__status ? {} : answer));
  };
  const dir = endpointHold;
  if (!dir || endpointHeld || !existsSync(join(dir, 'hold-endpoint'))) return reply();
  endpointHeld = true;
  const released = () => existsSync(join(dir, 'release-endpoint'));
  const finish = (error) => {
    clearTimeout(timer);
    watcher.close();
    if (error) response.destroy(error);
    else reply();
  };
  const watcher = watch(dir, () => released() && finish());
  const timer = setTimeout(() => finish(new Error(`the held ${path} request was not released within 170 s`)), 170_000);
  writeFileSync(join(dir, 'endpoint-held'), path);
  if (released()) finish();
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
const baseURL = `http://127.0.0.1:${stub.address().port}`;

const recorded = [];
for (const scenario of scenarios) {
  const root = join(RUN_ROOT, scenario.name);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, 'home');
  const paths = {
    home,
    mixdogHome: join(home, '.mixdog'),
    dataDir: join(home, '.mixdog', 'data'),
    runtimeRoot: join(root, 'runtime'),
    appData: join(home, 'AppData', 'Roaming'),
    localAppData: join(home, 'AppData', 'Local'),
    tmp: join(root, 'tmp'),
    workspace: join(root, 'ws'),
  };
  for (const dir of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(dir, { recursive: true });
  routes = scenario.stub ?? {};
  stubFile = join(root, 'stub.json');
  const now = Date.now();
  writeFileSync(join(paths.dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.modelsDev }));
  writeFileSync(join(paths.dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.litellm }));
  writeFileSync(join(paths.dataDir, 'update-check-cache.json'), JSON.stringify({ latestVersion: '1.4.5', lastCheckedAt: now }));
  const agent = JSON.parse(JSON.stringify(scenario.agent).replaceAll('__BASE_URL__', baseURL));
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent }, null, 2));
  // `hold`: the statusline-usage warm-up waits for the scenario's `statuslineUsageWarmup` call, or for its end (hold.mjs).
  const holdDir = scenario.hold ? join(root, 'hold') : null;
  if (holdDir) mkdirSync(holdDir, { recursive: true });
  endpointHold = holdDir;
  endpointHeld = false;
  const file = join(root, 'scenario.json');
  writeFileSync(file, JSON.stringify({ name: scenario.name, calls: JSON.parse(JSON.stringify(scenario.calls).replaceAll('__BASE_URL__', baseURL)), stubFile, holdDir, afterBootLoad: scenario.afterBootLoad, waitListed: scenario.waitListed, recordConfig: scenario.recordConfig }));
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!DROP.test(name)) env[name] = value;
  Object.assign(env, {
    MIXDOG_DATA_DIR: paths.dataDir,
    MIXDOG_HOME: paths.mixdogHome,
    MIXDOG_RUNTIME_ROOT: paths.runtimeRoot,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
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
    // offline.mjs in every Node process the daemon starts: without it the daemon replaces the seeded catalogs with the live
    // models.dev / LiteLLM ones and the recording depends on the day it was made.
    NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, 'offline.mjs')).href} --import ${pathToFileURL(join(HERE, 'hold.mjs')).href}`,
    // The boot-profile marks are what the child waits on (`statusline-usage:warm-ready`).
    ...(scenario.waitListed || holdDir || scenario.afterBootLoad ? { MIXDOG_BOOT_PROFILE: '1' } : {}),
    ...(holdDir ? { MIXDOG_RECORDER_HOLD_DIR: holdDir } : {}),
    ...(scenario.env ?? {}),
  });
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', join(HERE, 'child.mjs'), NODE_TREE, paths.workspace, file], { env, cwd: paths.workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`${scenario.name}: no result (exit ${code})\n${stdout}\n${stderr}`);
  const result = JSON.parse(line.slice(7));
  if (result.failed) throw new Error(`${scenario.name}: ${result.failed}`);
  recorded.push({ name: scenario.name, agent: scenario.agent, ...(scenario.env ? { env: scenario.env } : {}), ...(scenario.hold ? { hold: scenario.hold } : {}), ...(scenario.afterBootLoad ? { afterBootLoad: true } : {}), stub: scenario.stub ?? {}, ...(result.waited ? { waited: result.waited } : {}), calls: result.calls });
  console.log(`${scenario.name} (stub hits: ${hits.splice(0).join(' ') || 'none'}): ${result.calls.map((c) => `${c.action}${c.configure ? '(configure)' : ''}:${c.ok ? (Array.isArray(c.value) ? c.value.length : 'ok') : 'ERR ' + c.error}`).join(' ')}`);
}
stub.close();
const OUT = join(HERE, '..', '..', '..', '..', 'native', 'core', 'fixtures', setName ? `model-lists-${setName}` : 'model-lists', 'node-model-lists.json');
mkdirSync(dirname(OUT), { recursive: true });
if (process.argv.includes('--keep')) console.log(`kept: ${RUN_ROOT}`);
else rmSync(RUN_ROOT, { recursive: true, force: true });
// `--only` re-records one scenario into the fixture and leaves the others as they were recorded.
const kept = only ? JSON.parse(readFileSync(OUT, 'utf8')).scenarios.filter((s) => s.name !== only) : [];
writeFileSync(OUT, JSON.stringify({ baseURL: '__BASE_URL__', seeds, scenarios: [...kept, ...recorded] }, null, 2).replaceAll(baseURL, '__BASE_URL__'));
// Why the anthropic-search / anthropic-floor-empty scenarios come in four orderings (lines of the 7f633e730 tree).
const WEB_SEARCH_READ_ORDERINGS = [
  'The web-search read after the full read picks its rows by state alone: it syncs the catalog revision (src/session-runtime/provider-models/web-search-catalog.mjs:112; a moved revision drops both caches, provider-models/model-meta.mjs:18-29), then answers cached web-search rows (:117, none before this first web-search read), else the full-catalog rows (:122), else quick rows (:129).',
  'After the full read (which awaited the shared load, so the full-catalog cache is filled) only three events change that state, in this order: (1) the statusline-usage warm-up applies a config with the OAuth provider enabled and the revision moves (src/runtime/agent/orchestrator/providers/registry.mjs:312); (2) the catalog refresh it started (src/session-runtime/provider-readiness.mjs:149) completes: the revision moves (registry.mjs:717) and, in the same promise chain with no macrotask between, the caches are dropped and the re-warm started (provider-readiness.mjs:160-171); (3) the re-warm adopts its rows (src/session-runtime/provider-models.mjs:107-114).',
  'A read is an IPC request (a macrotask), so it lands in one of the four windows those events bound and nowhere else: before (1) -> *-before-statusline-warm-up (full-catalog rows); between (1) and (2) -> *-after-statusline-warm-up-moved-catalog-revision (quick rows); between (2) and (3) -> *-after-catalog-refresh-completed-while-rewarm-loads (quick rows); after (3) -> *-after-catalog-refresh-completed-and-rewarmed (the re-warm\'s full-catalog rows). These four are all the orderings Node allows for this read.',
  'Each window is pinned by an event barrier: the warm-up held at its start (hold.mjs), the refresh request held at the endpoint (record.mjs), the re-warm\'s load held at its start (hold.mjs __mixdogRecorderLoadHold), and the boot-profile marks past a log offset (child.mjs).',
];
// Every set is a recording of its own: its manifest names the Node commit and says whether the loaded tree is exactly it.
// The unnamed set got one only from 7f633e730 on, and only from a full run.
if (setName || !only) {
  const { writeSetManifest, exactProductIdentity, recordingProvenance } = await import('../lib/common.mjs');
  const commitAt = process.argv.indexOf('--commit');
  const NODE_COMMIT = commitAt < 0 ? 'b6f10295a2f698afc85332467192de28500bd146' : process.argv[commitAt + 1];
  const dirOf = 'benchmarks/rust-core/recorders/model-lists';
  const recorder = `${dirOf}/record.mjs`;
  const setArg = setName ? ` --set ${setName}` : '';
  const inputs = [setName ? `scenarios-${setName}.json` : 'scenarios.json', 'seeds.json', 'child.mjs', 'offline.mjs', 'hold.mjs', 'hold-hooks.mjs'].map((f) => `${dirOf}/${f}`);
  writeSetManifest(dirname(OUT), {
    set: setName ? `model-lists-${setName}` : 'model-lists',
    recorder,
    command: `node ${recorder} --tree <tree>${setArg} --commit ${NODE_COMMIT}`,
    identity: exactProductIdentity(NODE_TREE, NODE_COMMIT),
    extra: {
      ...recordingProvenance(recorder, [...inputs, 'benchmarks/rust-core/recorders/lib/common.mjs']),
      ...(setName ? {} : { webSearchReadOrderings: WEB_SEARCH_READ_ORDERINGS }),
    },
  });
}
