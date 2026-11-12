#!/usr/bin/env node
// Records Node's deferred tool surface for the cases of src/session-runtime/tool-catalog-rebuild.test.mjs,
// through Node's real `applyDeferredToolSurface`, `deferredCatalogUnion`, `renderToolSearch` and
// `selectDeferredTools` (runtime-core/tool-catalog.mjs) over `BUILTIN_TOOLS`. Each case is the test's steps in
// order; every step records the whole session afterwards and what the call returned, whole.
//
//   node benchmarks/rust-core/recorders/record-tool-catalog-rebuild-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/tool-catalog-rebuild-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-catalog-rebuild-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';

const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tool-catalog-rebuild-cases.mjs';
const TEST = 'src/session-runtime/tool-catalog-rebuild.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const U = (rel) => importFrom(tree, `src/runtime/${rel}`);
const { BUILTIN_TOOLS } = await U('agent/orchestrator/tools/builtin/builtin-tools.mjs');
const { applyDeferredToolSurface, deferredCatalogUnion, renderToolSearch, selectDeferredTools } = await U('agent/orchestrator/runtime-core/tool-catalog.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
const deferredGitNames = ['github'];

function run(name, build) {
  const steps = [];
  let current = null;
  const push = (step) => steps.push({ ...step, session: json(current) });
  const api = {
    // The test's `session(provider)`.
    open(provider = 'openai-oauth') {
      current = { provider, tools: BUILTIN_TOOLS.slice(), messages: [] };
      applyDeferredToolSurface(current, 'lead');
      push({ op: 'open', provider, tools: json(BUILTIN_TOOLS) });
    },
    // A direct change the test makes to the session; `patch` is each changed key's whole new value.
    change(mutate) {
      const before = json(current);
      mutate(current);
      const after = json(current);
      const patch = Object.fromEntries(Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])).map((key) => [key, after[key]]));
      push({ op: 'set', patch });
    },
    apply(mode, extra, options) {
      applyDeferredToolSurface(current, mode, extra, options);
      push({ op: 'apply', mode, extra: json(extra ?? []), options: json(options ?? {}) });
    },
    union() {
      steps.push({ op: 'union', result: json(deferredCatalogUnion(current)) });
    },
    render(names, mode) {
      const result = renderToolSearch({ names }, current, mode);
      push({ op: 'render', names, mode, result });
    },
    select(names, mode) {
      const result = selectDeferredTools(current, names, mode);
      push({ op: 'select', names, mode, result: json(result) });
    },
  };
  build(api);
  return { name, steps };
}

const cases = [];
for (const provider of ['openai-oauth', 'anthropic-oauth']) {
  cases.push(run(`${provider} rebuilds retain unloaded built-ins without eagerly exposing their schemas`, (t) => {
    t.open(provider);
    for (let rebuild = 0; rebuild < 3; rebuild += 1) {
      t.apply('lead');
      t.union();
    }
    t.render(deferredGitNames, 'lead');
    t.render(deferredGitNames, 'lead');
  }));
}
for (const denySource of ['session', 'options']) {
  cases.push(run(`rebuilding cannot restore a retained built-in denied by ${denySource}`, (t) => {
    t.open();
    const denied = ['github'];
    const options = denySource === 'options' ? { disallowed: denied } : {};
    if (denySource === 'session') t.change((s) => { s.disallowedTools = denied; });
    t.apply('lead', BUILTIN_TOOLS, options);
    t.union();
    t.render(deferredGitNames, 'lead');
  }));
}
cases.push(run('retained mutating tools remain blocked when the surface is rebuilt readonly', (t) => {
  t.open();
  t.apply('readonly');
  t.render(deferredGitNames, 'readonly');
}));
cases.push(run('current and extra definitions override retained schemas without losing other built-ins', (t) => {
  t.open();
  t.change((s) => { s.tools = s.tools.map((tool) => (tool.name === 'git' ? { ...tool, description: 'Current git schema.' } : tool)); });
  const github = BUILTIN_TOOLS.find((tool) => tool.name === 'github');
  t.apply('lead', [{ ...github, description: 'Updated GitHub schema.' }]);
  t.union();
}));
cases.push(run('selecting git does not load GitHub or a separate staging schema', (t) => {
  t.open();
  t.select(['git'], 'lead');
}));
cases.push(run('resumed catalogs drop legacy staging tools but retain GitHub on demand', (t) => {
  t.open();
  const legacy = { name: 'git_stage', description: 'Old staging schema.' };
  t.change((s) => { s.tools.push(legacy); s.deferredToolCatalog.push(legacy); s.deferredLateToolCatalog = [legacy]; });
  t.apply('lead');
  t.union();
  t.render(['git_stage'], 'lead');
}));

const finalDir = join(FIXTURES_ROOT, 'tool-catalog-rebuild-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's deferred tool surface at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'tool-catalog-rebuild-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      'per open/set/apply step: the whole session afterwards; per union step: the whole catalog union; per render step ' +
      '(renderToolSearch, the native load_tool): the whole answer text and the whole session afterwards; per select step: ' +
      'the whole selection and the session afterwards',
    excluded: {},
  },
});
commitStage(stage, finalDir);
console.log(`tool-catalog-rebuild-cases: ${cases.length} case(s), ${cases.reduce((n, c) => n + c.steps.length, 0)} step(s)`);
process.exit(0);
