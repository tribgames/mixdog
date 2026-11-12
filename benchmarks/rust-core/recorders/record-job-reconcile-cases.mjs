#!/usr/bin/env node
// Records Node's job reconcile for the k1 UNTESTED job-task-reconcile.test.mjs (gaps-rest.md section 3, mixdog-agent
// `agent_tool/` flow/reconcile.rs): the test's job through Node's real `reconcileJobWatchdogPartial` then
// `reconcileJobFinally`, and the settled task (status, terminal reason, error, result) with the owner's notification
// Node's `renderBackgroundTaskNotification` renders for it. The task id is fixed so the notification is stable.
//
//   node benchmarks/rust-core/recorders/record-job-reconcile-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/job-reconcile-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-job-reconcile-cases.mjs';
const TEST = 'src/session-runtime/services/agent-tool/job-task-reconcile.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-job-reconcile-cases-'));

const bt = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { reconcileJobFinally, reconcileJobWatchdogPartial } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-task-reconcile.mjs');

const value = { tag: 'worker', content: 'partial findings', stallAbort: true };
const task = bt.registerBackgroundTask({ taskId: 'task_watchdog', surface: 'agent', operation: 'spawn', label: 'worker' });
const job = { taskId: task.taskId, _terminalResultValue: structuredClone(value) };
reconcileJobWatchdogPartial(job, job._terminalResultValue);
reconcileJobFinally(job, 'idle');
const settled = bt.getBackgroundTask(task.taskId);

const cases = [
  {
    case: 'a watchdog stop that recovered partial output reaches the owner as a failure, not a completion',
    taskId: task.taskId,
    label: 'worker',
    value,
    finalStatus: 'idle',
    recorded: {
      status: settled.status,
      terminalReason: settled.terminalReason ?? null,
      error: settled.error ?? null,
      result: settled.result ?? null,
      notification: bt.renderBackgroundTaskNotification(settled),
    },
  },
];

const finalDir = join(FIXTURES_ROOT, 'job-reconcile-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's job reconcile at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'job-reconcile-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "the settled task's status, terminal reason, error and result, and the whole owner notification",
    excluded: {},
  },
});
commitStage(stage, finalDir);
console.log(`job-reconcile-cases: ${cases.length} case(s)`);
process.exit(0);
