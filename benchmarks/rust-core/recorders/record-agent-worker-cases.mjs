#!/usr/bin/env node
// Records Node's standalone agent tool for the k1 UNTESTED agent-worker.test.mjs (gaps-tools.md section 3: mixdog-agent
// row 10 :204, mixdog-cli row 10 :38). Each case runs the test's steps through Node's real `createStandaloneAgent`:
//   errors: `execute` of a read of a missing task and of an unknown type; the whole result texts;
//   notify: a spawn whose worker turn emits a nested shell completion and an early terminal result; what the worker's
//     queue and the owner received (session, whole text, meta), once the owner has its completion.
// Task ids are masked as <task>; the clock is fixed.
//
//   node benchmarks/rust-core/recorders/record-agent-worker-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/agent-worker-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-agent-worker-cases.mjs';
const TEST = 'scripts/tool-contracts/agent-worker.test.mjs';
const NOW = Date.parse('2026-03-01T10:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-worker-cases-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
const realNow = Date.now;
Date.now = () => NOW;

const { createStandaloneAgent } = await importFrom(tree, 'src/standalone/agent-tool.mjs');
const { initProviders } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');

const cases = [];
{
  const agent = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => ({ providers: {}, presets: [] }),
      resolveRuntimeSpec: () => {
        throw new Error('agent smoke should not resolve runtime for read/list errors');
      },
    },
    reg: { initProviders: async () => {} },
    mgr: { getSession: () => null, listSessions: () => [], closeSession: () => false },
    dataDir: root,
    cwd: root,
    defaultMode: 'async',
  });
  const calls = [
    { args: { type: 'read', task_id: 'task_missing_smoke' } },
    { args: { type: 'definitely_bad_type' } },
  ];
  for (const call of calls) call.result = String(await agent.execute(call.args, { invocationSource: 'model-tool', cwd: root }));
  agent.closeAll('tool-contracts-agent-errors-complete');
  cases.push({ case: 'agent read/list errors surface as Error results without runtime resolve', kind: 'errors', recorded: { calls } });
}

{
  const ownerNotifications = [];
  const workerQueued = [];
  const nestedText = (sessionId) =>
    `background task\ntask_id: task_shell_notify_smoke\nsurface: shell\noperation: shell\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:01.000Z\n\nnested background done for ${sessionId}`;
  const nestedMeta = { type: 'shell_task_result', execution_surface: 'shell', execution_id: 'task_shell_notify_smoke', status: 'completed' };
  const agent = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => ({
        default: 'sonnet-high',
        providers: { 'openai-oauth': { enabled: true } },
        presets: [
          { id: 'sonnet-high', name: 'sonnet-high', provider: 'openai-oauth', model: 'smoke-model', type: 'agent', tools: 'full' },
          { id: 'haiku', name: 'HAIKU', provider: 'openai-oauth', model: 'smoke-haiku', type: 'agent', tools: 'full' },
        ],
      }),
      resolveRuntimeSpec: () => ({ scopeKey: 'smoke-notify', lane: 'agent' }),
    },
    reg: { initProviders },
    mgr: {
      askSession: async (sessionId, _prompt, _context, _onToolCall, _cwdOverride, _prefetch, askOpts = {}) => {
        askOpts.notifyFn?.(nestedText(sessionId), nestedMeta);
        askOpts.onTerminalResult?.({ content: 'worker completed' }, { sessionId, beforeSave: true });
        return { content: 'worker completed' };
      },
      enqueuePendingMessage: (sessionId, message) => {
        workerQueued.push({ sessionId, message });
        return 1;
      },
      getSession: () => null,
      listSessions: () => [],
      closeSession: () => false,
      hideSessionFromList: () => false,
    },
    dataDir: join(root, 'notify'),
    cwd: root,
    defaultMode: 'async',
    notifySessionCompletion: (sessionId, text, meta) => {
      ownerNotifications.push({ sessionId, text, meta });
      return true;
    },
  });
  const context = { invocationSource: 'model-tool', callerCwd: root, callerSessionId: 'sess_owner_notify_smoke', clientHostPid: 424242 };
  const start = String(await agent.execute({ type: 'spawn', agent: 'worker', tag: 'notify-smoke', prompt: 'notify smoke' }, context));
  const deadline = realNow() + 30_000;
  while (!ownerNotifications.some((n) => /worker completed/.test(n.text))) {
    if (realNow() > deadline) throw new Error('no owner completion');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const taskId = /agent task: (\S+)/i.exec(start)[1];
  const fixed = new Date(NOW).toISOString();
  // The worker's session id (pid, clock and random bytes), a queued message's random id and a time read from `new Date()`
  // (not the fixed `Date.now`) are this run's own values.
  const text = JSON.stringify({ start, workerQueued, ownerNotifications })
    .split(taskId)
    .join('<task>')
    .replace(/sess_\d+_\d+_\d+_[0-9a-f]+/g, '<session>')
    .replace(/completion_[0-9a-f]+/g, '<completion>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (at) => (at === fixed || at.startsWith('2026-01-01') ? at : '<time>'));
  const recorded = JSON.parse(text);
  await agent.execute({ type: 'cleanup', force: true }, context);
  agent.closeAll('tool-contracts-agent-notify-complete');
  cases.push({ case: 'agent completion notifications route to the owner exactly once', kind: 'notify', recorded });
}

const excluded = {
  'headless exec parser accepts the exec form and needs a message':
    'COVERED (gaps-tools.md row 10): mixdog-cli exec/tests.rs replays the exec parser',
  'channel worker daemon spawn env advertises host identity':
    "Node's standalone channel worker spawning its own daemon: the core is the daemon, and no worker spawns it",
};

const finalDir = join(FIXTURES_ROOT, 'agent-worker-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's standalone agent tool at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'agent-worker-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "errors: each call's whole result text; notify: what the worker's queue and the owner received",
    masked:
      "task ids as <task>, the worker's session id as <session>, a queued message's id as <completion>, a time read from the wall clock as <time>; the clock is fixed at 2026-03-01T10:00:00.000Z",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`agent-worker-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
