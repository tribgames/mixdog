// Records what Node b6f10295a's request-without-sending (`nextMainRequest`, session/side-question.mjs:59-99, reached
// through the exported `lastSentMainRequest`) does to the startup-probe cache (`runtime-capabilities.mjs`): the git
// processes started at each step and the data folder's files before and after it. Node has no `snapshot` call; this
// is the one path that builds the request a session's next turn would send without sending it, so it is what the
// core's request snapshot must match in its side effects.
//
// Steps, in a fresh git repository: the session's creation (`prewarmGitStartupProbes` then the composition's two
// startup lines, as `session-create.mjs` composes), the request built without sending, then the next turn's
// composition (whose cached answers are served and refreshed off-thread, `settleGitStartupProbes` waits for them). Each
// git process is seen where Node asks for it: the probes hand their argv to a pool of four worker threads
// (`runGitOffThread`, shared/git-runner.mjs), whose `postMessage` is observed here, and a step records the subcommand
// of each request in the order the main thread made it. The order the processes then start in is the pool's race (four
// threads spawning side by side, run-child.mjs `CHILD_SPAWN_WORKERS`) and differs from run to run; the core's
// counterpart is the order of its `ProcessManager::spawn` calls.
// Usage: node record.mjs --tree <git archive export of b6f10295a, with node_modules>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..', '..', '..');
const { commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } = await import(
  pathToFileURL(join(repoRoot, 'benchmarks/rust-core/recorders/lib/common.mjs')).href
);

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const finalDir = join(repoRoot, 'native/core/fixtures/request-snapshot-effects');
const recorder = relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, COMMIT);

const runDir = fs.mkdtempSync(join(tmpdir(), 'snapshot-effects-'));
const repo = join(runDir, 'repo');
const data = join(runDir, 'data');
fs.mkdirSync(repo);
fs.mkdirSync(data);
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(join(repo, 'note.txt'), 'x');
fs.writeFileSync(join(repo, '.gitignore'), 'build/\n');
fs.mkdirSync(join(repo, 'build'));
fs.writeFileSync(join(repo, 'build', 'out.txt'), 'y');
const requested = [];
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  const args = message?.payload?.args;
  // A `runGitOffThread` request: the startup probes' argv, `--no-optional-locks -C <dir> <subcommand> ...`.
  if (Array.isArray(args) && args[0] === '--no-optional-locks' && args[1] === '-C') requested.push(args[3]);
  return post.call(this, message, ...rest);
};
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
globalThis[Symbol.for('mixdog.providerAuthBindings')] = { 'grok-oauth': join(data, 'grok-oauth.json') };
fs.writeFileSync(join(data, 'grok-oauth.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 0, token_endpoint: 'https://auth.x.ai/oauth2/token' }));

const capabilities = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs');
const side = await importFrom(tree, 'src/runtime/agent/orchestrator/session/side-question.mjs');
const store = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const registry = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');
const { GrokOAuthProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/grok-oauth.mjs');

/** The subcommands of the git processes asked for since the last call, in order. */
const started = () => requested.splice(0);

/** Every file of the data folder with its sha256. */
function files() {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(data, path).replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(path)).digest('hex');
    }
  };
  walk(data);
  return out;
}

const compose = () => {
  capabilities.describeGitStartupState({ cwd: repo });
  capabilities.describeCwdStartupEntries({ cwd: repo });
};

const steps = [];
// The session's creation: the boot-time prewarm, awaited, then the composition.
capabilities.prewarmGitStartupProbes([repo]);
await capabilities.settleGitStartupProbes();
compose();
await capabilities.settleGitStartupProbes();
steps.push({ step: 'creation', gitRequested: started() });

const session = {
  id: 'sess-snapshot-effects',
  provider: 'grok-oauth',
  model: 'grok-4',
  cwd: repo,
  tools: [],
  lastProviderSendAt: Date.now(),
  messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
  ],
};
await store.saveSessionAsync(session, { immediate: true });
const provider = new GrokOAuthProvider({ preconnect: false });
const before = files();
const request = await registry._withRegisteredProviderForTestAsync('grok-oauth', provider, async () => side.lastSentMainRequest(session.id));
await capabilities.settleGitStartupProbes();
const after = files();
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
steps.push({ step: 'request-without-sending', requestBuilt: Boolean(request?.messages?.length), gitRequested: started(), dataFilesChanged: changed });

compose();
await capabilities.settleGitStartupProbes();
steps.push({ step: 'next-turn-composition', gitRequested: started() });

// The run directory is left in the temp folder: the product's session store still holds files in it open.
console.log(`run directory: ${runDir}`);
for (const step of steps) console.log(JSON.stringify(step));

const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { steps });
const extra = { recorderSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), runtime: { node: process.versions.node, electron: process.versions.electron ?? null } };
writeSetManifest(stage, { set: 'request-snapshot-effects', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
process.exit(0);
