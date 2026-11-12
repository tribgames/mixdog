#!/usr/bin/env node
// Records Node's session adoption for the k1 UNTESTED session-adopt-hooks.test.mjs (gaps-rest.md section 3:
// mixdog-agent `compact/settings.rs` adopt_session_compaction, reached in the core through the run host's
// `synced_compaction`; mixdog-mcp `hook_bus`). Each case runs the test's steps through Node's real `beginBoot`,
// `resolveConfig`, `createStandaloneHookBus`, `sessionAdopter` and (the deny hook) `executeTool`:
//   compaction: the session's `compaction` before and after adoption, with the runtime's compaction section and
//     whether the config was injected (headless);
//   hooks: the PreToolUse answer of each call while rules are saved and deleted, and the deny hook's tool result and
//     run count for a resumed and a fresh session.
//
//   node benchmarks/rust-core/recorders/record-session-adopt-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/session-adopt-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-session-adopt-cases.mjs';
const TEST = 'src/session-runtime/boot/session-adopt-hooks.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-session-adopt-cases-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
delete process.env.MIXDOG_HOOKS_FILE;

const { createStandaloneHookBus } = await importFrom(tree, 'src/session-runtime/services/hook-bus.mjs');
const { beginBoot } = await importFrom(tree, 'src/session-runtime/boot/begin.mjs');
const { resolveConfig } = await importFrom(tree, 'src/session-runtime/boot/config.mjs');
const { sessionAdopter } = await importFrom(tree, 'src/session-runtime/boot/infrastructure.mjs');
const { executeTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/loop/tool-exec.mjs');

let dirs = 0;
const freshDir = (prefix) => mkdtempSync(join(root, `${prefix}-${dirs++}-`));

// The test's `bootedRuntime`.
async function bootedRuntime(dataDir, initialConfig = { providers: {}, modelSettings: {} }) {
  const boot = beginBoot({ provider: 'openai', model: 'gpt-5.4', toolMode: 'full', cwd: dataDir, ...(initialConfig ? { initialConfig } : {}) });
  boot.cfgMod = { getConfigSnapshot: () => ({}) };
  boot.sharedCfgMod = { pendingConfigWrites: async () => {} };
  await resolveConfig(boot);
  boot.bindRuntimeNotificationSession = () => {};
  boot.workspaceApi = {};
  boot.hooks = createStandaloneHookBus({ dataDir });
  boot.adoptSession = sessionAdopter(boot);
  return boot;
}

const cases = [];

// Compaction: adopt `session` under a runtime whose compaction section is `section` (none: left as resolved).
async function adoption(name, { initialConfig, section, session }) {
  const dataDir = freshDir('compaction');
  const boot = await bootedRuntime(dataDir, initialConfig);
  if (section !== undefined) boot.rt.config = { ...boot.rt.config, compaction: section };
  const adopted = structuredClone(session);
  boot.adoptSession(adopted);
  cases.push({
    case: name,
    kind: 'compaction',
    injected: Boolean(initialConfig),
    section: section ?? null,
    before: session.compaction,
    recorded: { compaction: adopted.compaction },
  });
}

await adoption('an adopted session follows the current global compaction settings, keeping its own fields', {
  initialConfig: null,
  section: { auto: true, mainBufferPercent: 20 },
  session: { id: 'sess_old_compaction', compaction: { auto: false, mainBufferTokens: 8000, conversationThresholdTokens: 5, archive: { nextSeq: 3 } } },
});
await adoption('a headless runtime on an injected config keeps its session compaction fixed on adoption', {
  initialConfig: { providers: {}, modelSettings: {}, compaction: { auto: true } },
  section: { auto: true, mainBufferPercent: 20 },
  session: { id: 'sess_headless', compaction: { auto: false, mainBufferTokens: 8000 } },
});

// Hooks: rules saved and deleted while the adopted session is open.
{
  const dataDir = freshDir('hooks');
  const settings = createStandaloneHookBus({ dataDir });
  const boot = await bootedRuntime(dataDir);
  const resumed = { id: 'sess_resumed' };
  boot.adoptSession(resumed);
  const call = async (name) => (await resumed.beforeToolHook({ name, args: {}, cwd: dataDir })) ?? null;
  const steps = [];
  const ask = async (tool) => steps.push({ op: 'call', tool, answer: await call(tool) });
  await ask('setup');
  settings.addRule({ tool: 'setup', action: 'ask' });
  steps.push({ op: 'addRule', rule: { tool: 'setup', action: 'ask' } });
  settings.addRule({ tool: 'mcp__cal__*', action: 'ask' });
  steps.push({ op: 'addRule', rule: { tool: 'mcp__cal__*', action: 'ask' } });
  await ask('setup');
  await ask('mcp__cal__create');
  settings.deleteRule(0);
  steps.push({ op: 'deleteRule', index: 0 });
  await ask('setup');
  await ask('mcp__cal__create');
  cases.push({
    case: 'an adopted (resumed) session sees hook rules saved while it is open, and stops when they are removed',
    kind: 'rules',
    recorded: { steps },
  });
}

// Hooks: the configured PreToolUse deny command runs once per call for a resumed and a fresh session.
{
  const dataDir = freshDir('deny');
  const log = join(dataDir, 'hook-calls.log');
  const script = join(dataDir, 'deny.mjs');
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'x');\nprocess.stderr.write('blocked by policy');\nprocess.exit(2);\n`
  );
  const hooksFile = join(dataDir, 'hooks.json');
  const hooks = { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: '<node>', args: ['<deny.mjs>'], timeout: 10 }] }] };
  writeFileSync(
    hooksFile,
    JSON.stringify({ hooks: { PreToolUse: [{ ...hooks.PreToolUse[0], hooks: [{ ...hooks.PreToolUse[0].hooks[0], command: process.execPath, args: [script] }] }] } })
  );
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  const boot = await bootedRuntime(dataDir);
  const runs = [];
  for (const id of ['sess_resumed', 'sess_fresh']) {
    writeFileSync(log, '');
    const session = { id };
    boot.adoptSession(session);
    boot.adoptSession(session);
    const result = await executeTool('shell', { command: 'echo hi' }, dataDir, id, session, {});
    runs.push({ id, result: String(result), hookRuns: readFileSync(log, 'utf8').length });
  }
  delete process.env.MIXDOG_HOOKS_FILE;
  cases.push({
    case: 'a resumed and a fresh session both run the PreToolUse deny hook for shell exactly once',
    kind: 'deny',
    hooks,
    deny: { stderr: 'blocked by policy', exit: 2 },
    command: 'echo hi',
    recorded: { runs },
  });
}

const excluded = {
  'adopting a session that already carries its bridge leaves it in place':
    'GONE (gaps-rest.md): the core attaches no per-session PreToolUse bridge; one hook bus serves every thread',
  'an adopted session follows the current global compaction settings, keeping its own fields (no compaction section)':
    'DIFFERENCE: a runtime config without a compaction section leaves Node\'s session at {"auto":false}; the core ' +
    'syncs it to the empty section\'s defaults ({"auto":true,"onModelChange":true,"summaryMode":"smart"})',
};

const finalDir = join(FIXTURES_ROOT, 'session-adopt-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's session adoption at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'session-adopt-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "compaction: the session's whole compaction record after adoption; rules: every PreToolUse answer in order; deny: each session's whole tool result text and the hook's run count",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`session-adopt-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
