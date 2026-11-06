#!/usr/bin/env node
// Goldens of the shell-job actions the Rust core answers itself (WP-AI-FIX), each from the real Node code:
//   listStoppableShellJobs / stopBackgroundShellJob(s)   task-tool.mjs (what `/stop` lists, and the stop answers that
//                                                         need no live process)
//   forceReleaseTerminationHold                          shell-job-records.mjs (the "Release anyway" answer)
//   [session-close] line of tool-events.log              markSessionClosed -> _logSessionCloseMetric
// The rows of `listShellJobs` come from `shellJobsStatusFresh`, which the engine golden
// native/mixdog-spawn/tests/fixtures/shell-jobs.json already records; they are not repeated here.
//   node benchmarks/rust-core/recorders/record-shell-job-actions.mjs [--tree <tree>]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-shell-job-actions-'));
process.env.MIXDOG_DATA_DIR = join(scratch, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });

// The close line stamps `new Date()`: freeze the clock so the line is reproducible.
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(NOW);
  }
  static now() {
    return NOW;
  }
};

const { registerBackgroundTask } = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { listStoppableShellJobs, stopBackgroundShellJob, stopBackgroundShellJobs } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/tools/builtin/task-tool.mjs'
);
const { registerTerminationHold, noteShellOwnerSessionClosed, forceReleaseTerminationHold } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/tools/builtin/lib/shell-job-records.mjs'
);
const { shellJobsStatusFresh } = await importFrom(tree, 'src/runtime/shared/statusline/statusline-segments.mjs');
const { saveSessionAsync, markSessionClosed } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const { flushSessionCloseMetrics } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs');

const outDir = join(FIXTURES_ROOT, 'shell-job-actions');

// ---- the stoppable list and the stop answers ------------------------------------------------------
const shell = (taskId, owner, input, label) =>
  registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'shell',
    label,
    input,
    context: { callerSessionId: owner, clientHostPid: process.pid },
  });
shell('job_a1', 'sess_a', { command: '  npm run dev ' }, 'label a1');
shell('job_a2', 'sess_a', {}, 'the label stands in');
shell('job_a3', 'sess_a', undefined, undefined);
shell('job_b1', 'sess_b', { command: 'tail -f log' }, 'b1');
registerBackgroundTask({ taskId: 'agent_x', surface: 'agent', label: 'not a shell', context: { callerSessionId: 'sess_a', clientHostPid: process.pid } });
const scope = (callerSessionId) => ({ callerSessionId, clientHostPid: process.pid });
const stoppable = {};
for (const caller of ['sess_a', 'sess_b', 'sess_none', null]) stoppable[String(caller)] = listStoppableShellJobs(scope(caller));
const stops = [];
for (const [taskId, caller] of [['', 'sess_a'], ['   ', 'sess_a'], ['nope', 'sess_a'], [' nope ', 'sess_a'], ['agent_x', 'sess_a'], ['job_b1', 'sess_a']]) {
  stops.push({ taskId, caller, answer: await stopBackgroundShellJob(taskId, scope(caller)) });
}
const clean = [];
for (const caller of ['sess_none', null]) clean.push({ caller, answer: await stopBackgroundShellJobs(scope(caller)) });

// ---- the release-anyway answers --------------------------------------------------------------------
const ws = join(scratch, 'ws');
const folders = { a: join(ws, 'a'), inside: join(ws, 'a', 'sub'), far: join(ws, 'far') };
for (const dir of Object.values(folders)) mkdirSync(dir, { recursive: true });
const holdRelease = async () => {};
const releases = [];
const release = async (name, jobId, caller, callerCwd, expectHeld) => {
  const answer = await forceReleaseTerminationHold(jobId, { callerSessionId: caller, callerCwd });
  releases.push({ name, jobId, caller, callerCwd: callerCwd && callerCwd.slice(ws.length + 1).replace(/\\/g, '/'), answer });
};
await release('nothing is held', 'job_none', 'sess_a', folders.a);
await release('a blank id', '  ', 'sess_a', folders.a);
registerTerminationHold('job_h1', { ownerSessionId: 'sess_a', cwd: folders.a, release: holdRelease });
await release('another session while the owner is open', 'job_h1', 'sess_b', folders.inside);
noteShellOwnerSessionClosed('sess_a');
await release('the owner has closed but the folder is not seen', 'job_h1', 'sess_c', folders.far);
await release('the owner has closed and the folder is seen', ' job_h1 ', 'sess_b', folders.inside);
await release('released once', 'job_h1', 'sess_b', folders.inside);
registerTerminationHold('job_h2', { ownerSessionId: 'sess_d', cwd: folders.far, release: holdRelease });
await release('the owner releases its own hold', 'job_h2', 'sess_d', null);
registerTerminationHold('job_h3', { ownerSessionId: null, cwd: folders.far, release: holdRelease });
await release('a hold without an owner', 'job_h3', 'sess_e', null);

// ---- the rows of listShellJobs ----------------------------------------------------------------------
const jobsDir = join(process.env.MIXDOG_DATA_DIR, 'shell-jobs');
mkdirSync(jobsDir, { recursive: true });
const record = (id, owner, extra) => {
  writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({ command: `  run ${id} `, cwd: `  /ws/${owner} `, pid: process.pid, startedAt: 1_767_323_000_000, ownerSessionId: owner, ...extra }));
  writeFileSync(join(jobsDir, `${id}.owner-${process.pid}`), '');
};
record('job_b', 'sess_b', {});
record('job_gone', 'sess_gone', { ownerSessionClosed: true, terminationUnconfirmed: true });
const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
const rows = { own: status.sessions.sess_b.jobs, orphaned: status.orphaned };
// ---- the [session-close] line -----------------------------------------------------------------------
const logPath = join(process.env.MIXDOG_DATA_DIR, 'tool-events.log');
const lines = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
const closes = [];
const closeCase = async (name, record, reason) => {
  await saveSessionAsync(record);
  const before = lines();
  const generation = await markSessionClosed(record.id, reason);
  await flushSessionCloseMetrics();
  closes.push({ name, record: { id: record.id, owner: record.owner, agent: record.agent, createdAt: record.createdAt }, reason, generation, line: lines().slice(before.length) });
};
const base = (id, extra) => ({ id, status: 'idle', createdAt: NOW - 90_000, updatedAt: NOW - 1000, messages: [{ role: 'user', content: 'hi' }], ...extra });
await closeCase('an agent session', base('sess_close_agent', { owner: 'lead', agent: 'worker' }), 'cli-agent-close');
await closeCase('no owner or agent', base('sess_close_plain', {}), 'manual');
await closeCase('no creation time', base('sess_close_zero', { owner: 'lead', createdAt: 0 }), 'manual');
await closeCase('the desktop delete reason', base('sess_close_delete', { agent: 'worker' }), 'desktop-session-delete');
{
  const again = await markSessionClosed('sess_close_agent', 'cli-agent-close');
  await flushSessionCloseMetrics();
  closes.push({ name: 're-closing a tombstone', record: { id: 'sess_close_agent' }, reason: 'cli-agent-close', generation: again, line: lines().slice(closes.reduce((n, c) => n + c.line.length, 0)) });
}

const stage = stageSet(outDir);
writeJson(join(stage, 'shell-job-actions.json'), { stoppable, stops, clean, releases, rows, closes });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'shell-job-actions',
  recorder: 'benchmarks/rust-core/recorders/record-shell-job-actions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-shell-job-actions.mjs [--tree <tree>]',
  identityTree: tree,
});
rmSync(scratch, { recursive: true, force: true });
console.log(`recorded ${stops.length} stop, ${releases.length} release, ${closes.length} close cases`);
process.exit(0);

