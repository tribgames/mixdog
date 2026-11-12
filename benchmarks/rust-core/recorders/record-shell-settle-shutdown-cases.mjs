#!/usr/bin/env node
// Node's foreground-shell settle (`shell-run-settle.slow.test.mjs`, b6f10295a) when the runtime shuts down while the run's kill is
// unconfirmed: the real child, the real descendant observation and the real activity gate, as the slow test builds them, then the
// shutdown the daemon performs (`noteShellOwnerSessionClosed`, `shutdownShellJobs`). What a client could see is recorded in order:
// whether the owner's folder is still reserved, the shutdown's own answer, and how the reservation ends (the child's confirmed exit,
// or another session's explicit force-release).
//
//   node benchmarks/rust-core/recorders/record-shell-settle-shutdown-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/shell-settle-shutdown-cases/{golden.json,MANIFEST.json}.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-shell-settle-shutdown-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/tools/lib/shell-run-settle.slow.test.mjs';
const DEADLINE_MS = 30_000;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const T = 'src/runtime/agent/orchestrator/tools/';
await importFrom(tree, `${T}lib/isolated-test-env.mjs`);
const { holdWorkspaceActivityAsync, tryAdmitWorkspaceActivityAsync } = await importFrom(tree, 'src/runtime/shared/worktrees/activity-gate.mjs');
const { cleanupTempDirs, makeRepo } = await importFrom(tree, 'src/runtime/shared/worktrees/test-support.mjs');
const { createProcessTreeTracker } = await importFrom(tree, `${T}lib/shell-descendants.mjs`);
const { createSettle } = await importFrom(tree, `${T}lib/shell-run-settle.mjs`);
const { forceReleaseTerminationHold, noteShellOwnerSessionClosed, shellOwnerEpoch } = await importFrom(tree, `${T}builtin/lib/shell-job-records.mjs`);
const { shutdownShellJobs } = await importFrom(tree, `${T}builtin/shell-jobs.mjs`);

const within = (what, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`waited ${DEADLINE_MS} ms for ${what}`)), DEADLINE_MS).unref())]);

/** Whether the folder can be held now: the refusal's code, else null (and the hold is given back). */
async function busy(repo) {
  try {
    (await holdWorkspaceActivityAsync([repo]))();
    return null;
  } catch (error) {
    return error.code;
  }
}

async function scenario(end) {
  const repo = makeRepo();
  const owner = 'owner-1';
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const observed = [];
  const see = (what, value) => observed.push({ what, value });
  try {
    const run = {
      child,
      killed: true,
      killUnconfirmed: true,
      foregroundRecordId: `job_shutdown_${end}`,
      foregroundRecordInput: { ownerSessionId: owner, cwd: repo, ownerEpoch: shellOwnerEpoch(owner) },
      workspaceAdmission: await tryAdmitWorkspaceActivityAsync(owner, repo, { kind: 'command', pid: child.pid }),
      stdoutDecoder: { end: () => '' },
      stderrDecoder: { end: () => '' },
      taskOutput: { spilled: false, getStdout: async () => '', getStderr: async () => '', closeFds() {}, writeStdout() {}, writeStderr() {} },
      resolveResult() {},
    };
    run.terminationTracker = createProcessTreeTracker({ pid: child.pid });
    if ((await run.terminationTracker.capture()) !== true) throw new Error('the tree was not captured');
    await createSettle(run, () => {})(1, 'SIGKILL');
    see('the folder after the unconfirmed settle', await busy(repo));
    noteShellOwnerSessionClosed(owner);
    const shutdown = await within('the runtime shutdown', shutdownShellJobs('runtime-close'));
    see('the shutdown answer', shutdown);
    see('the folder after the shutdown', await busy(repo));
    if (end === 'exit') {
      child.kill();
      await within('the child to exit', exited);
      await within('the tree to be confirmed gone', run.treeSettled);
    } else {
      see('the release by another session', await forceReleaseTerminationHold(run.foregroundRecordId, { callerSessionId: 'other-1', callerCwd: repo }));
      see('the child after the release', child.exitCode === null && child.signalCode === null ? 'running' : 'exited');
    }
    see('the folder at the end', await busy(repo));
  } finally {
    if (child.exitCode === null) child.kill();
    await within('the child to exit', exited);
  }
  return observed;
}

const cases = [];
cases.push({ case: 'the shutdown during the unconfirmed wait, then the confirmed exit', observed: await scenario('exit') });
cases.push({ case: 'the shutdown during the unconfirmed wait, then another session\'s release', observed: await scenario('release') });
cleanupTempDirs();

const finalDir = `${FIXTURES_ROOT}/shell-settle-shutdown-cases`;
const stage = stageSet(finalDir);
writeJson(`${stage}/golden.json`, { note: `Node's foreground settle across the runtime shutdown at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'shell-settle-shutdown-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'per case: every observation in order, whole',
    excluded: {
      'the 60 s capture and resource clean-up ceiling (shell-run-settle.mjs:28)':
        "bounds the capture files' close and the resource lease only; the core's output is spilled files it never holds open, so there is nothing to bound",
    },
  },
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases, null, 1));
process.exit(0);
