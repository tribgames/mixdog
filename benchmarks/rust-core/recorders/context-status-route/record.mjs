#!/usr/bin/env node
// Genuine Node answers of `contextStatus` for the desktop's control session and for a task session, around a route change,
// recorded from the real Node daemon of a git clone of C:\Project\mixdog at b6f10295a2f698afc85332467192de28500bd146
// (the Node commit the Rust core is ported against): the control session before and after `setFast`/`setRoute`, and a
// session with a failed seed turn before and after `setRoute`. The daemon runs in an isolated env under the OS temp dir with
// one custom provider whose endpoint has no listener, and with the model-catalog fetches blocked (model-lists/offline.mjs).
// The session ids and the two folders are recorded as $control, $second, $workspace and $taskWorkspace.
//
//   git clone <C:\Project\mixdog> <clone>; git -C <clone> checkout b6f10295a2f698afc85332467192de28500bd146
//   (a junction <clone>\node_modules -> the product's node_modules; remove it with `rmdir` before deleting the clone)
//   node benchmarks/rust-core/recorders/context-status-route/record.mjs --tree <clone>
// Output: native/core/fixtures/context-status-route/golden.json (+ MANIFEST.json, identity = the commit above, exact)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from '../lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const HERE = dirname(fileURLToPath(import.meta.url));
const tree = resolveTree(parseArgs());
const head = execFileSync('git', ['--git-dir', join(tree, '.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== NODE_COMMIT) throw new Error(`the tree is at ${head}, the recording is of ${NODE_COMMIT}`);

const PROVIDER = 'custom-harness';
const MODEL = 'harness-model';
const SEED_PROMPT = 'Seed the transcript. HARNESS-CAP-SEED';
const root = mkdtempSync(join(tmpdir(), 'context-status-route-'));
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
// The desktop's control session works in `<userData>/workspace/unclassified`.
const taskWorkspace = join(paths.dataDir, 'userdata', 'workspace', 'unclassified');
for (const dir of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace, taskWorkspace]) mkdirSync(dir, { recursive: true });
const workspace = realpathSync(paths.workspace);
const task = realpathSync(taskWorkspace);
// The daemon's whole config file; the golden keeps it so a replay opens the same config.
const CONFIG = {
  agent: {
    providers: {
      [PROVIDER]: {
        type: 'custom',
        schemaVersion: 2,
        name: 'harness',
        protocol: 'openai-chat',
        baseURL: 'http://127.0.0.1:9/v1',
        auth: 'none',
        enabled: true,
        modelOverrides: { [MODEL]: { manual: true } },
      },
    },
  },
};
writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify(CONFIG));
const scenario = join(root, 'scenario.json');
writeFileSync(scenario, JSON.stringify({ provider: PROVIDER, model: MODEL, seedPrompt: SEED_PROMPT }));

const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
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
  NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, '..', 'model-lists', 'offline.mjs')).href}`,
});
const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', join(HERE, 'child.mjs'), tree, workspace, task, scenario], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
const code = await new Promise((done) => child.once('exit', done));
clearTimeout(timer);
const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
if (!line) throw new Error(`no result (exit ${code})\n${stdout}\n${stderr}`);
const result = JSON.parse(line.slice(7));
if (result.failed) throw new Error(result.failed);

// The ids and the folders are run-specific: recorded as tokens (the longer path first, the task folder is not inside the workspace).
const tokens = [
  [result.ids.control, '$control'],
  [result.ids.second, '$second'],
  [task, '$taskWorkspace'],
  [workspace, '$workspace'],
];
const tokenized = (value) => {
  let text = JSON.stringify(value);
  for (const [raw, token] of tokens) text = text.replaceAll(JSON.stringify(raw).slice(1, -1), token);
  return JSON.parse(text);
};
const steps = tokenized(result.steps);
// The second session as the seed turn left it: the ids are tokens, the folder paths stay raw (the prompt's token count prices them).
let storedText = JSON.stringify(result.stored);
for (const [raw, token] of tokens.slice(0, 2)) storedText = storedText.replaceAll(JSON.stringify(raw).slice(1, -1), token);
const stored = JSON.parse(storedText);

// What Node's session holds after the route change and then a config change of the compaction (`syncSessionCompaction`, which
// Node runs on the live session after the route change's one synchronous pass): the sequential result a write submitted
// while the route change is in flight must reach. The route change's own result is `afterRoute`, read from the daemon.
const { syncSessionCompaction } = await import(pathToFileURL(join(tree, 'src', 'session-runtime', 'session-compaction-sync.mjs')).href);
const SAVED_AFTER = { auto: false };
const sequential = { compaction: structuredClone(result.afterRoute.compaction) };
syncSessionCompaction(sequential, { compaction: SAVED_AFTER });
const afterRouteThenSync = { saved: SAVED_AFTER, compaction: sequential.compaction };

const rel = 'benchmarks/rust-core/recorders/context-status-route/record.mjs';
const finalOut = join(FIXTURES_ROOT, 'context-status-route');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  domain: 'context-status-route',
  recorder: rel,
  nodeCommit: NODE_COMMIT,
  route: { provider: PROVIDER, model: MODEL },
  seedPrompt: SEED_PROMPT,
  config: CONFIG,
  stored,
  afterRoute: result.afterRoute,
  afterRouteThenSync,
  steps,
});
writeSetManifest(out, {
  set: 'context-status-route',
  recorder: rel,
  command: `node ${rel} --tree <git clone of the Node product at ${NODE_COMMIT}>`,
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(out, finalOut);
rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
console.log(`recorded ${steps.length} steps: ${steps.map((s) => `${s.session}.${s.action}${s.ok ? '' : '(error)'}`).join(' ')}`);
