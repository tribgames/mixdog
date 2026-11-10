// Records what Node b6f10295a's request-without-sending, `nextMainRequest` (session/side-question.mjs:64-99, the
// function the core's `tools/toolsStatus` `snapshot` corresponds to; Node's `toolsStatus` has no snapshot,
// session-runtime/turn/agent-ops.mjs:142), returns and does, in the cases a review used: a session with no user
// conversation yet; a session with a transcript; both after the startup probes were settled over a repository and a new
// ignored directory was added (so a composition would have to probe again); both after the skill catalog was
// invalidated (so a composition would scan the skills again). The function is not exported: a load hook appends an
// export of it to the module's own source, which is otherwise the commit's.
//
// What each call returns is recorded whole (the provider name, the model, every message, the tools, the options'
// tool-snapshot fields), and what it does is observed at the file-system call level for the whole call: every call of
// `node:fs` (sync, callback and promise forms) that writes, renames, removes or creates anything, and every directory
// listing (a skill scan lists the skill folders), with its path relative to the sandbox; and every git process the
// startup probes ask for (their `runGitOffThread` requests to the git worker pool, whose `postMessage` is observed).
// Every await of the probes' settlement has a deadline and a message.
// Usage: node record.mjs --tree <git archive export of b6f10295a, with node_modules>
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire, register, syncBuiltinESMExports } from 'node:module';
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
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata', 'repo'].map((name) => [name, join(runDir, name)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_QUIET_PROVIDER_LOG: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const repo = dirs.repo;
execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe', windowsHide: true });
fs.writeFileSync(join(repo, 'note.txt'), 'x');
fs.writeFileSync(join(repo, '.gitignore'), 'build/\ngenerated/\n');
fs.mkdirSync(join(repo, 'build'));
fs.writeFileSync(join(repo, 'build', 'out.txt'), 'y');
fs.mkdirSync(join(repo, '.mixdog', 'skills', 'demo'), { recursive: true });
fs.writeFileSync(join(repo, '.mixdog', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill.\n---\nbody\n');

// The git processes the startup probes ask the worker pool for.
const requested = [];
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  const args = message?.payload?.args;
  if (Array.isArray(args) && args[0] === '--no-optional-locks' && args[1] === '-C') requested.push(args[3]);
  return post.call(this, message, ...rest);
};

// Every writing call of node:fs, and every directory listing, while `observing` is set.
const require = createRequire(import.meta.url);
const fsc = require('node:fs');
const fsp = require('node:fs/promises');
let observing = null;
const where = (path) => {
  if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return `<fd ${path}>`;
  const text = String(path instanceof URL ? fileURLToPath(path) : path);
  const rel = relative(runDir, text).replaceAll('\\', '/');
  return rel.startsWith('..') ? text.replaceAll('\\', '/') : rel;
};
const WRITES = ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'copyFile', 'cp', 'link', 'symlink', 'truncate', 'utimes', 'chmod', 'mkdtemp'];
const LISTS = ['readdir', 'opendir'];
function wrap(target, name, kind) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function (path, ...rest) {
    if (observing) observing.push({ call: name, kind, path: where(path) });
    return original.call(this, path, ...rest);
  };
}
for (const base of [...WRITES, ...LISTS]) {
  const kind = LISTS.includes(base) ? 'list' : 'write';
  wrap(fsc, base, kind);
  wrap(fsc, `${base}Sync`, kind);
  wrap(fsp, base, kind);
}
for (const target of [fsc, fsp]) {
  for (const name of target === fsc ? ['open', 'openSync', 'createWriteStream'] : ['open']) {
    const original = target[name];
    target[name] = function (path, flags, ...rest) {
      const writing = name === 'createWriteStream' || (typeof flags === 'string' && /[wa+]/.test(flags)) || (typeof flags === 'number' && (flags & 3) !== 0);
      if (observing && writing) observing.push({ call: name, kind: 'write', path: where(path) });
      return original.call(this, path, flags, ...rest);
    };
  }
}
syncBuiltinESMExports();

// `nextMainRequest` exported from the module's own source.
const sideUrl = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/session/side-question.mjs')).href;
const hook = `
export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (url === ${JSON.stringify(sideUrl)}) return { ...loaded, source: String(loaded.source) + '\\nexport { nextMainRequest as __recorderNextMainRequest };\\n' };
  return loaded;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const capabilities = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs');
const side = await import(sideUrl);
const { loadSession } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const { setLiveSession } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/live-state.mjs');
const { invalidateSkillsCache } = await importFrom(tree, 'src/runtime/agent/orchestrator/context/skill-catalog.mjs');
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');

/** `settleGitStartupProbes()`, failing with a message when it has not settled within 60 s of real time. */
async function settled(what) {
  let timer;
  const deadline = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`settleGitStartupProbes did not settle within 60000 ms (${what})`)), 60_000);
  });
  try {
    await Promise.race([capabilities.settleGitStartupProbes(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// The startup probes as a session's creation leaves them: the boot prewarm settled, then the composition's lines.
capabilities.prewarmGitStartupProbes([repo]);
await settled('the boot prewarm');
capabilities.describeGitStartupState({ cwd: repo });
capabilities.describeCwdStartupEntries({ cwd: repo });
await settled('the creation composition');
// The observers see what they are for: the creation asked for git processes, and a write and a listing through the
// ESM namespace, the CommonJS module and the promise API are each seen.
const creationGit = requested.splice(0);
if (!creationGit.length) throw new Error('the git request observer saw no request of the creation');
observing = [];
fs.writeFileSync(join(runDir, 'probe-a.txt'), 'a');
require('node:fs').readdirSync(runDir);
await fsp.writeFile(join(runDir, 'probe-b.txt'), 'b');
const observerCheck = { creationGit, fsCalls: observing };
observing = null;
if (observerCheck.fsCalls.length !== 3) throw new Error(`the fs observer saw ${JSON.stringify(observerCheck.fsCalls)}`);

const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
const SYSTEM = { role: 'system', content: 'You are the Lead.' };
const transcript = [SYSTEM, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }];
const session = (id, messages) => ({
  id,
  provider: 'anthropic',
  model: 'claude-test',
  effort: 'high',
  status: 'idle',
  cwd: repo,
  promptCacheKey: `cache-${id}`,
  promptIdentity: { systemPrompt: '', skipAgentRules: false, profileSkip: {}, agent: null },
  tools: TOOLS.map((tool) => ({ ...tool })),
  messages: structuredClone(messages),
});
const steps = [
  { name: 'no-user-conversation', before: null, messages: [SYSTEM] },
  { name: 'existing-transcript', before: null, messages: transcript },
  { name: 'no-user-conversation-after-a-new-ignored-directory', before: 'ignored-directory', messages: [SYSTEM] },
  { name: 'existing-transcript-after-a-new-ignored-directory', before: 'ignored-directory', messages: transcript },
  { name: 'no-user-conversation-after-the-skill-catalog-was-invalidated', before: 'invalidate-skills', messages: [SYSTEM] },
  { name: 'existing-transcript-after-the-skill-catalog-was-invalidated', before: 'invalidate-skills', messages: transcript },
];

const provider = { name: 'anthropic', async send() { return { usage: {} }; } };
const cases = [];
await _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
  for (const [n, step] of steps.entries()) {
    if (step.before === 'ignored-directory' && !fs.existsSync(join(repo, 'generated'))) {
      fs.mkdirSync(join(repo, 'generated'));
      fs.writeFileSync(join(repo, 'generated', 'g.txt'), 'z');
    }
    if (step.before === 'invalidate-skills') invalidateSkillsCache(repo);
    const id = `snapshot-${n + 1}`;
    setLiveSession(session(id, step.messages));
    loadSession(id);
    observing = [];
    const request = side.__recorderNextMainRequest(id);
    const fsCalls = observing;
    observing = null;
    await settled(step.name);
    cases.push({
      name: step.name,
      before: step.before,
      request: request
        ? {
            provider: request.provider?.name ?? null,
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            providerToolSnapshotAuthoritative: request.opts?.providerToolSnapshotAuthoritative ?? null,
            providerNativeToolPrefixCount: request.opts?.providerNativeToolPrefixCount ?? null,
            iteration: request.opts?.iteration ?? null,
          }
        : null,
      fsCalls,
      gitRequested: requested.splice(0),
    });
  }
});

// The run directory is left in the temp folder: the product's session store still holds files in it open.
console.log(`run directory: ${runDir}`);
for (const c of cases) console.log(`${c.name}: ${c.request ? `${c.request.messages.length} messages` : 'null'}, fs ${JSON.stringify(c.fsCalls)}, git ${JSON.stringify(c.gitRequested)}`);

const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { observerCheck, cases });
const extra = { scripts: { 'benchmarks/rust-core/recorders/lib/common.mjs': sha256(fs.readFileSync(join(repoRoot, 'benchmarks/rust-core/recorders/lib/common.mjs'))) }, recorderSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), runtime: { node: process.version, electron: process.versions.electron ?? null } };
writeSetManifest(stage, { set: 'request-snapshot-effects', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
process.exit(0);
