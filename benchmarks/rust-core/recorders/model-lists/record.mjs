// Records Node's model-list reads (listProviderModels quick and full, listWebSearchModels) for the scenarios in
// scenarios.json, each in its own isolated env under the OS temp dir (temp MIXDOG_* roots, no real key, no network: the
// custom provider's endpoint is a loopback stub answering an empty model list). Writes
// native/core/fixtures/model-lists/node-model-lists.json.
//   node benchmarks/rust-core/recorders/model-lists/record.mjs --tree <tree>
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const treeAt = process.argv.indexOf('--tree');
if (treeAt < 0 || !process.argv[treeAt + 1]) throw new Error('usage: record.mjs --tree <tree>');
const NODE_TREE = resolve(process.argv[treeAt + 1]);
const RUN_ROOT = mkdtempSync(join(tmpdir(), 'model-lists-'));
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? null : process.argv[onlyAt + 1];
const scenarios = JSON.parse(readFileSync(join(HERE, 'scenarios.json'), 'utf8')).filter((s) => !only || s.name === only);
const hits = [];
// The metadata layers a Node daemon would fetch from models.dev and LiteLLM (and the update check it runs) are
// seeded fresh instead, so no run reaches a network and the Rust test seeds the same files.
const seeds = JSON.parse(readFileSync(join(HERE, 'seeds.json'), 'utf8'));

let routes = {};
const stub = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  hits.push(path);
  const answer = routes[path] ?? { object: 'list', data: [] };
  // `{ "__status": n }` answers that HTTP status with an empty object.
  response.statusCode = answer.__status ?? 200;
  response.end(JSON.stringify(answer.__status ? {} : answer));
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
  const now = Date.now();
  writeFileSync(join(paths.dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.modelsDev }));
  writeFileSync(join(paths.dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.litellm }));
  writeFileSync(join(paths.dataDir, 'update-check-cache.json'), JSON.stringify({ latestVersion: '1.4.5', lastCheckedAt: now }));
  const agent = JSON.parse(JSON.stringify(scenario.agent).replaceAll('__BASE_URL__', baseURL));
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent }, null, 2));
  const file = join(root, 'scenario.json');
  writeFileSync(file, JSON.stringify({ name: scenario.name, calls: scenario.calls }));
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
  recorded.push({ name: scenario.name, agent: scenario.agent, ...(scenario.env ? { env: scenario.env } : {}), stub: scenario.stub ?? {}, calls: result.calls });
  console.log(`${scenario.name} (stub hits: ${hits.splice(0).join(' ') || 'none'}): ${result.calls.map((c) => `${c.action}:${c.ok ? (Array.isArray(c.value) ? c.value.length : 'ok') : 'ERR ' + c.error}`).join(' ')}`);
}
stub.close();
const OUT = join(HERE, '..', '..', '..', '..', 'native', 'core', 'fixtures', 'model-lists', 'node-model-lists.json');
mkdirSync(dirname(OUT), { recursive: true });
if (process.argv.includes('--keep')) console.log(`kept: ${RUN_ROOT}`);
else rmSync(RUN_ROOT, { recursive: true, force: true });
writeFileSync(OUT, JSON.stringify({ baseURL: '__BASE_URL__', seeds, scenarios: recorded }, null, 2).replaceAll(baseURL, '__BASE_URL__'));
