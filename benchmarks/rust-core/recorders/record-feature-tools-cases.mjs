#!/usr/bin/env node
// Records the case of src/session-runtime/internal-tool-executor/feature-tools.test.mjs through Node's real
// `createFeatureToolHandlers().media`. As the test does, `getSession` is replaced (the caller session's
// `sourceType` is 'schedule') and `executeMediaTool` is intercepted; the interceptor records the options the
// handler passed, whole, then runs Node's real `executeMediaTool` with them over one injected media graph
// (one lane, a job that finishes at once), so the job start the graph saw (where the attribution lands)
// and the reply are recorded whole too.
//
//   node benchmarks/rust-core/recorders/record-feature-tools-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/feature-tools-cases/{golden.json,MANIFEST.json}.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FLAG = '--experimental-test-module-mocks';
if (!process.execArgv.includes(FLAG)) {
  const run = spawnSync(process.execPath, [FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'feature-tools-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { mock } = await import('node:test');
const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-feature-tools-cases.mjs';
const TEST = 'src/session-runtime/internal-tool-executor/feature-tools.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const at = (rel) => pathToFileURL(join(tree, rel)).href;

// Node's real tool, loaded under another URL so the interception below does not replace it.
const { executeMediaTool: realExecuteMediaTool } = await import(`${at('src/runtime/media/tool.mjs')}?real`);

const T0 = 1_700_000_000_000;
const LANE = {
  id: 'xai', label: 'Grok Imagine', authType: 'api-key', authenticated: true, supportedKinds: ['image'], kinds: ['image'],
  image: { models: [{ id: 'grok-imagine-image', label: 'Grok Imagine Image', controls: { maxReferences: 5 } }], defaultModel: 'grok-imagine-image', controls: {} },
  video: null,
};
const base = join(sandbox, 'case');
const cwd = join(base, 'cwd');
mkdirSync(cwd, { recursive: true });
mkdirSync(join(base, 'assets'), { recursive: true });
writeFileSync(join(base, 'assets', 'asset-1.png'), 'asset:asset-1');
const starts = [];
const jobs = new Map();
const deps = {
  lanes: { listMediaLanes: async () => structuredClone([LANE]), mediaLaneAccountProvider: () => '' },
  accounts: { withProviderAccount: async (_p, _a, fn) => await fn() },
  defaults: { getMediaDefault: () => null, getMediaPin: () => null },
  store: { resolveMediaFile: async (assetId) => ({ path: join(base, 'assets', `${assetId}.png`) }) },
  jobs: {
    startMediaJob: async (input) => {
      starts.push(structuredClone(input));
      const job = { id: `job-${starts.length}`, status: 'running', kind: input.kind, lane: input.lane, model: input.model, options: input.options, progress: 0, assetId: null, error: null, startedAt: T0, endedAt: null };
      jobs.set(job.id, job);
      return structuredClone(job);
    },
    getMediaJob: (id) => {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: 'done', progress: 100, assetId: 'asset-1', endedAt: T0 + 1234 });
      return structuredClone(job);
    },
    cancelMediaJob: (id) => ({ id, canceled: false }),
  },
};

const handed = [];
mock.module(at('src/runtime/media/tool.mjs'), {
  namedExports: {
    executeMediaTool: async (args, opts) => {
      handed.push({ ...opts, signal: opts.signal ? { aborted: opts.signal.aborted } : opts.signal ?? null });
      return await realExecuteMediaTool(args, { ...opts, deps });
    },
  },
});
mock.module(at('src/runtime/agent/orchestrator/session/manager/session-crud.mjs'), {
  namedExports: { getSession: (id) => (id === 'caller-session' ? { sourceType: 'schedule' } : null) },
});
const { createFeatureToolHandlers } = await import(at('src/session-runtime/internal-tool-executor/feature-tools.mjs'));

const handlers = createFeatureToolHandlers({ rt: { session: null }, setupTool: {} });
const args = { action: 'generate', kind: 'image', prompt: 'a red fox', path: 'out/fox.png' };
const reply = await handlers.media(args, { callerCtx: { sessionId: 'caller-session' }, callerCwd: cwd });

const slash = (path) => path.replaceAll('\\', '/');
const norm = (value) =>
  typeof value === 'string' ? value.replaceAll(slash(base), '{root}').replaceAll(base, '{root}')
    : Array.isArray(value) ? value.map(norm)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v)])) : value;

const cases = [{
  name: 'media generation is attributed to the calling session and its source',
  session: 'caller-session',
  sessions: { 'caller-session': 'schedule' },
  lane: LANE,
  args,
  handed: norm(handed),
  starts: norm(starts),
  reply: norm(JSON.parse(reply.content[0].text)),
  isError: reply.isError === true,
}];

const finalDir = join(FIXTURES_ROOT, 'feature-tools-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's media handler at ${NODE_COMMIT}; {root} is the case folder`, test: TEST, clock: T0, cases });
writeSetManifest(stage, {
  set: 'feature-tools-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'per case: the options the handler passed to executeMediaTool (cwd, signal, sessionId, sourceType), the job start the graph saw, and the reply, each whole',
    excluded: {},
  },
});
commitStage(stage, finalDir);
console.log(`feature-tools-cases: ${cases.length} case(s), ${starts.length} start(s)`);
process.exit(0);
