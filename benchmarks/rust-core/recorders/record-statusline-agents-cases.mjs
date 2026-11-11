#!/usr/bin/env node
// Records Node's statusline agent payload for the k1 UNTESTED statusline-agents.test.mjs (gaps-rest.md section 3,
// mixdog-core-session `status_rows.rs`). Each case's workers and jobs go through Node's real `agentStatuslinePayload`
// (and the maintenance case through `classifyAgentWorkers`); the whole payloads are recorded. Every case is named in the
// manifest: the payload is merged by the UI's statusline (`src/ui/statusline.mjs`), which stays in Node; the core only
// publishes the worker and job rows it merges.
//
//   node benchmarks/rust-core/recorders/record-statusline-agents-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/statusline-agents-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-statusline-agents-cases.mjs';
const TEST = 'src/ui/statusline-agents.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { agentStatuslinePayload, classifyAgentWorkers } = await importFrom(tree, 'src/ui/statusline-agents.mjs');

const runs = {
  'a live worker stays authoritative over its own spawn job': [
    [[{ tag: 'worker-a', status: 'streaming', startedAt: 1000 }], [{ tag: 'worker-a', status: 'running', task_id: 'task-1' }]],
  ],
  'a worker whose status is running stays running while its runtime phase reads idle/done/error': [
    ...['idle', 'done', 'error'].map((stage) => [
      [{ tag: 'worker-p', status: 'running', stage, startedAt: 1000 }],
      [{ tag: 'worker-p', status: 'running', stage, task_id: 'task-p' }],
    ]),
    [[{ tag: 'w', status: 'idle', stage: 'streaming' }], []],
    [[{ tag: 'w', status: 'running', stage: 'cancelled' }], []],
  ],
  'a queued job replaces an idle worker until the new worker starts': [
    [[{ tag: 'worker-b', status: 'idle' }], [{ tag: 'worker-b', status: 'queued', task_id: 'task-2' }]],
  ],
  'terminal jobs leave the worker list and stay ordered newest first': [
    [[], [{ tag: 'a', status: 'done', startedAt: 1, finishedAt: 100 }, { tag: 'b', status: 'error', startedAt: 1, finishedAt: 300 }]],
  ],
};
const cases = Object.entries(runs).map(([name, inputs]) => ({
  case: name,
  recorded: inputs.map(([workers, jobs]) => ({ workers, jobs, payload: agentStatuslinePayload(workers, jobs) })),
}));
const maintenanceWorkers = [
  { tag: 'cycle1:1', agent: 'cycle1-agent', status: 'running' },
  { tag: 'cycle1:2', agent: 'cycle1-agent', status: 'running' },
  { tag: 'worker-c', status: 'running' },
  { tag: 'worker-d', status: 'idle' },
];
cases.push({
  case: 'maintenance agents are labelled once and idle workers drop out',
  recorded: [{ workers: maintenanceWorkers, classified: classifyAgentWorkers(maintenanceWorkers) }],
});

const ui =
  'not core logic: the product runs the unchanged renderer src/ui/statusline-agents.mjs (identical to b6f10295a), which the TUI ' +
  'loads through src/tui/components/statusline-module-loader.mjs -> src/ui/statusline.mjs; the core only publishes the worker and ' +
  'job rows it merges (status_rows.rs)';
const excluded = Object.fromEntries(cases.map((c) => [c.case, c.case.startsWith('maintenance') ? `GONE (gaps-rest.md): renderer label; ${ui}` : ui]));

const finalDir = join(FIXTURES_ROOT, 'statusline-agents-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's statusline agent payload at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'statusline-agents-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: { ...recorderProvenance(import.meta.url), compared: 'nothing in the core: every case is named', excluded },
});
commitStage(stage, finalDir);
console.log(`statusline-agents-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
