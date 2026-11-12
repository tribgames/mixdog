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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, nodeTreeIdentity, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from '../lib/common.mjs';
import { recorderProvenance } from '../lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const tree = resolveTree(args);
const head = execFileSync('git', ['--git-dir', join(tree, '.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== NODE_COMMIT) throw new Error(`the tree is at ${head}, the recording is of ${NODE_COMMIT}`);

const PROVIDER = 'custom-harness';
const MODEL = 'harness-model';
const SEED_PROMPT = 'Seed the transcript. HARNESS-CAP-SEED';
// `--work <dir>`: where the run's folder goes (default the OS temp dir). Its path is in the recorded prompts, whose token
// counts Node priced at its real length, so the folder must be as long as the one the recording names (RECORDED_ROOT):
// `--work C:\mixdog-build\tmp\control-materialize-tmp` gives it on the build PC.
const RECORDED_ROOT = 'D:\\mixdog-build\\tmp\\control-materialize-tmp\\context-status-route-vH0Vs0';
const root = mkdtempSync(join(args.get('work') ?? tmpdir(), 'context-status-route-'));
if (realpathSync(root).length !== RECORDED_ROOT.length) {
  throw new Error(`the run folder ${realpathSync(root)} is not as long as ${RECORDED_ROOT}: pass --work <dir> of ${RECORDED_ROOT.length - 'context-status-route-vH0Vs0'.length - 1} characters`);
}
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

// Node's own functions on the second session the daemon left, run in a child of this process (sequence-child.mjs): the route
// change, then the installation's compaction sync and a folder change in both orders, as the live session holds them.
const SAVED_AFTER = { auto: false };
// The folder change is the write `applyResolvedCwd` makes on the live session: `session.cwd = <next>`.
const MOVED_TO = 'C:\\moved-folder';
const sequenceFile = join(root, 'sequence.json');
writeFileSync(sequenceFile, JSON.stringify({ provider: PROVIDER, model: MODEL, providers: CONFIG.agent.providers, saved: SAVED_AFTER, movedTo: MOVED_TO, stored: result.stored }));
const sequenceRun = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', join(HERE, 'sequence-child.mjs'), tree, sequenceFile], { env, cwd: workspace, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240_000 });
const sequenceLine = (sequenceRun.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
if (!sequenceLine) throw new Error(`no sequence result (exit ${sequenceRun.status})\n${sequenceRun.stdout}\n${sequenceRun.stderr}`);
let sequenceText = sequenceLine.slice(7);
for (const [raw, token] of tokens.slice(0, 2)) sequenceText = sequenceText.replaceAll(JSON.stringify(raw).slice(1, -1), token);
const inFlight = JSON.parse(sequenceText);

// What a run makes up is replaced by a value of the same length and character class (so the token counts Node priced stay the
// ones of the text recorded), in order of first appearance: uuids, `msg_`/`it_`/scratch-folder ids, epoch-millisecond times
// (rebased on one origin, their distances kept), the MCP pid and the elapsed time; the run folder becomes RECORDED_ROOT.
const stable = (value) => {
  let text = JSON.stringify(value);
  const numbered = (pattern, make) => {
    const seen = new Map();
    text = text.replace(pattern, (match) => {
      if (!seen.has(match)) seen.set(match, make(seen.size + 1));
      return seen.get(match);
    });
  };
  const hex = (n, width) => n.toString(16).padStart(width, '0');
  numbered(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (n) => `00000000-0000-4000-8000-${hex(n, 12)}`);
  numbered(/msg_[0-9a-f]{32}/g, (n) => `msg_${hex(n, 32)}`);
  numbered(/\bit_[0-9a-f]{8}_/g, (n) => `it_${hex(n, 8)}_`);
  numbered(/\bs\.[0-9a-f]{16}\b/g, (n) => `s.${hex(n, 16)}`);
  // A round value (1800000000000) is a clock the scenario set, not the run's own.
  const ran = (m) => Number(m) % 1e6 !== 0;
  const times = [...text.matchAll(/(?<![\d.])1[5-9]\d{11}(?![\d.])/g)].map((m) => m[0]).filter(ran).map(Number);
  const origin = Math.min(...times);
  text = text.replace(/(?<![\d.])1[5-9]\d{11}(?![\d.])/g, (m) => (ran(m) ? String(1794206055000 + Number(m) - origin) : m));
  text = text.replace(/"(mcpPid|clientHostPid)":\d+/g, '"$1":40320').replace(/"elapsedMs":\d+/g, '"elapsedMs":15327');
  const real = realpathSync(root);
  const escaped = (path) => JSON.stringify(path).slice(1, -1);
  text = text.replaceAll(escaped(real), escaped(RECORDED_ROOT)).replaceAll(real.replaceAll('\\', '/'), RECORDED_ROOT.replaceAll('\\', '/'));
  return JSON.parse(text);
};
const NORMALISED = [
  'uuids, `msg_`, `it_` and scratch-folder ids: numbered in order of first appearance, same length',
  'epoch-millisecond times: rebased on one origin, distances kept',
  '`mcpPid`, `clientHostPid` and `elapsedMs`: one constant each',
  'the run folder of the recording: named as the integration recordings name it (RECORDED_ROOT), after checking it is as long',
];

const rel = 'benchmarks/rust-core/recorders/context-status-route/record.mjs';
const patch = args.get('patch') ? nodeTreeIdentity(args, tree, NODE_COMMIT).patch.file : null;
const finalOut = join(FIXTURES_ROOT, 'context-status-route');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), stable({
  domain: 'context-status-route',
  recorder: rel,
  nodeCommit: NODE_COMMIT,
  route: { provider: PROVIDER, model: MODEL },
  seedPrompt: SEED_PROMPT,
  config: CONFIG,
  stored,
  afterRoute: { compaction: result.afterRoute.compaction },
  inFlight,
  steps,
}));
writeSetManifest(out, {
  set: 'context-status-route',
  recorder: rel,
  command: `node ${rel} --tree <git clone of the Node product at ${NODE_COMMIT}${patch ? ` with ${patch} applied` : ''}>${patch ? ` --patch ${patch}` : ''}`,
  // `--patch <file>`: the clone's working tree carries that Node fix (a clear Node bug fixed on both sides).
  ...(patch ? { identity: nodeTreeIdentity(args, tree, NODE_COMMIT) } : { identityTree: tree, identityRef: NODE_COMMIT }),
  extra: { ...recorderProvenance(import.meta.url), normalised: NORMALISED },
});
commitStage(out, finalOut);
rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
console.log(`recorded ${steps.length} steps: ${steps.map((s) => `${s.session}.${s.action}${s.ok ? '' : '(error)'}`).join(' ')}`);
