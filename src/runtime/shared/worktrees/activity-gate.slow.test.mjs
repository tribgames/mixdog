import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { admitWorkspaceActivity, holdWorkspaceActivity, tryAdmitWorkspaceActivity } from './activity-gate.mjs';
import { admitTurn, retainAdmittedTurnWorkspace } from '../../../session-runtime/workspace/admission-gate.mjs';
import {
  completeShellJobRecord,
  publishShellJobRecord,
} from '../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';
import { withFileLockSync } from '../atomic-file.mjs';
import { putRecord } from './registry.mjs';
import { spawnShellChild } from '../../agent/orchestrator/tools/lib/shell-run-spawn.mjs';

beforeEach(useTempDataDir);
after(cleanupTempDirs);
const moduleUrl = new URL('./activity-gate.mjs', import.meta.url).href;

function reader(t, repo, waiting = false, command = false) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { tryAdmitWorkspaceActivity, admitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
    const cwd = process.argv[1];
    let leave = tryAdmitWorkspaceActivity('child', cwd, { kind: ${JSON.stringify(command ? 'command' : 'turn')} });
    if (!leave) {
      process.send('blocked');
      if (${waiting}) leave = await admitWorkspaceActivity('child', cwd);
      else process.exit(0);
    }
    process.send('active');
    process.on('message', () => { leave(); process.exit(0); });
  `,
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return child;
}

test('same-folder readers remain parallel across processes and prevent a writer', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const leave = tryAdmitWorkspaceActivity('parent', repo);
  const child = reader(t, repo);
  assert.equal((await once(child, 'message'))[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
  holdWorkspaceActivity([repo])();
});

test('a published writer excludes a later foreign reader until release', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const release = holdWorkspaceActivity([repo]);
  const child = reader(t, repo, true);
  assert.equal((await once(child, 'message'))[0], 'blocked');
  const active = once(child, 'message');
  release();
  assert.equal((await active)[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
});

test('only a proven-dead reader is reclaimed, and an ownerless mutex is not reclaimed', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  const child = reader(t, repo);
  assert.equal((await once(child, 'message'))[0], 'active');
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  holdWorkspaceActivity([repo])();
  const lock = join(repo, '.git', 'ownerless.lock');
  writeFileSync(lock, 'corrupt');
  assert.throws(() =>
    withFileLockSync(lock, () => assert.fail('must not enter'), {
      strictOwner: true,
      timeoutMs: 0,
      staleMs: 0,
    })
  );
  assert.equal(existsSync(lock), true);
});

test('a command lease whose pid is proven dead no longer blocks after a restart', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const child = reader(t, repo, false, true);
  assert.equal((await once(child, 'message'))[0], 'active');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  holdWorkspaceActivity([repo])();
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), 'utf8')).leases, []);
});

test('only a dead command lease is reclaimed; a live one keeps the folder reserved', () => {
  const repo = makeRepo();
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = tryAdmitWorkspaceActivity('restarted', repo, { kind: 'command', pid: deadPid });
  const live = tryAdmitWorkspaceActivity('running', repo, { kind: 'command' });
  assert.throws(
    () => holdWorkspaceActivity([repo]),
    (error) => error.code === 'WORKTREE_BUSY_JOBS' && error.details.reason === 'folder-in-use'
  );
  live();
  holdWorkspaceActivity([repo])();
  stale();
});

test('a provisioning turn protects its destination before moving, and releases both roots', async () => {
  const repo = makeRepo();
  const target = join(tempDir(), 'linked');
  git(repo, 'worktree', 'add', '-b', 'feature/next', target);
  // A Mixdog-created destination: only those are ever lock-blocked.
  await putRecord({ id: 'next', path: target });
  let cwd = repo;
  const leave = await admitTurn({ sessionId: 'moving', cwd: () => cwd });
  const writer = holdWorkspaceActivity([target]);
  assert.throws(() => retainAdmittedTurnWorkspace('moving', target), { code: 'WORKTREE_BUSY_JOBS' });
  assert.equal(cwd, repo);
  writer();
  retainAdmittedTurnWorkspace('moving', target);
  cwd = target;
  assert.throws(() => holdWorkspaceActivity([target]), { code: 'WORKTREE_BUSY_JOBS' });
  leave();
  holdWorkspaceActivity([repo, target])();
});

test('an external checkout is never held, yet its running reader still refuses a writer', () => {
  const repo = makeRepo();
  const external = join(tempDir(), 'external');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/external', external);
  const writer = holdWorkspaceActivity([repo, external]);
  const reader = tryAdmitWorkspaceActivity('external-turn', external);
  assert.ok(reader, 'the external folder admits new work');
  assert.equal(tryAdmitWorkspaceActivity('project-turn', repo), null, 'the project folder waits');
  writer();
  assert.throws(
    () => holdWorkspaceActivity([repo, external]),
    (error) => error.code === 'WORKTREE_BUSY_JOBS' && error.details.reason === 'folder-in-use'
  );
  reader();
  holdWorkspaceActivity([repo, external])();
});

test('a background command retains admission after its parent turn finishes', async () => {
  const repo = makeRepo();
  const leave = await admitWorkspaceActivity('parent', repo);
  publishShellJobRecord({ jobId: 'job_workspace_handoff', cwd: repo, pid: process.pid }, { ownerSessionId: 'parent' });
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  await completeShellJobRecord('job_workspace_handoff', { status: 'completed', cwd: repo, exitCode: 0 });
  holdWorkspaceActivity([repo])();
});

test('a shell targeting a different checkout waits before spawning and cancels without creating a child', async () => {
  const repo = makeRepo();
  const release = holdWorkspaceActivity([repo]);
  const controller = new AbortController();
  const run = { foregroundRecordId: 'job_before_spawn' };
  const pending = spawnShellChild({
    run,
    cwd: repo,
    shell: process.execPath,
    directArgv: ['-e', 'process.exit(0)'],
    command: 'node',
    abortSignal: controller.signal,
    ownerSessionId: 'different-workspace',
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(run.child, undefined);
  release();
  holdWorkspaceActivity([repo])();
});

test('cancellation while waiting registers nothing', async () => {
  const repo = makeRepo();
  const writer = holdWorkspaceActivity([repo]);
  const controller = new AbortController();
  const pending = admitWorkspaceActivity('cancelled', repo, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  writer();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).leases, []);
  holdWorkspaceActivity([repo])();
});

test('malformed ledgers preserve unknown ownership across readers, releases and fresh processes', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  const intact = readFileSync(path);
  const refusal = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } };
  for (const damaged of [
    Buffer.alloc(intact.length),
    Buffer.from('{broken'),
    Buffer.alloc(0),
    Buffer.from('{"version":1,"leases":[null]}'),
  ]) {
    writeFileSync(path, damaged);
    for (const attempt of [
      () => holdWorkspaceActivity([repo]),
      () => tryAdmitWorkspaceActivity('later-reader', repo),
      leave,
    ]) {
      assert.throws(attempt, refusal);
      assert.deepEqual(readFileSync(path), damaged, 'failed operations preserve the evidence and refusal');
    }
    // A new profile cannot interpret a prior failed repair as a missing ledger.
    const next = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
          const cwd = process.argv[1];
          assert.throws(() => tryAdmitWorkspaceActivity('new-process', cwd), ${JSON.stringify(refusal)});
          assert.throws(() => holdWorkspaceActivity([cwd]), ${JSON.stringify(refusal)});
        `,
        repo,
      ],
      { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
    );
    assert.equal(next.error, undefined);
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(readFileSync(path), damaged);
  }

  // Only this fixture's exact, unchanged ownership record is restored. A
  // failed release must still release its token once the record is readable.
  writeFileSync(path, intact);
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  leave();
  holdWorkspaceActivity([repo])();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).leases, []);
});

test('a damaged management ledger refuses new readers and keeps its release retryable', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const release = holdWorkspaceActivity([repo]);
  const intact = readFileSync(path);
  const damaged = Buffer.alloc(intact.length);
  writeFileSync(path, damaged);
  const refusal = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } };
  assert.throws(() => tryAdmitWorkspaceActivity('reader', repo), refusal);
  assert.throws(release, refusal);
  assert.deepEqual(readFileSync(path), damaged);
  writeFileSync(path, intact);
  assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the original writer still owns the folder');
  release();
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(leave);
  leave();
  holdWorkspaceActivity([repo])();
});

test('an unreadable ledger is not overwritten and admission resumes after access is restored', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  holdWorkspaceActivity([repo])();
  unlinkSync(path);
  mkdirSync(path);
  assert.throws(() => tryAdmitWorkspaceActivity('blocked', repo), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assert.throws(() => holdWorkspaceActivity([repo]), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  rmdirSync(path);
  holdWorkspaceActivity([repo])();
});
