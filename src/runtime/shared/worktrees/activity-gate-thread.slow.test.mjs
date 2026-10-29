// Workspace admission runs its ledger updates on one admission thread per
// process: the safety properties that design relies on, and the event loop
// it keeps free while the disk is slow.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  admitWorkspaceActivity,
  holdWorkspaceActivity,
  holdWorkspaceActivityAsync,
  tryAdmitWorkspaceActivity,
  tryAdmitWorkspaceActivityAsync,
} from './activity-gate.mjs';
import { setAdmissionFaults } from './activity-gate-faults.test-hook.mjs';
import { withFileLock, withFileLockSync } from '../file-lock.mjs';
import { cleanupTempDirs, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';

const moduleUrl = new URL('./activity-gate.mjs', import.meta.url).href;
const faultsUrl = new URL('./activity-gate-faults.test-hook.mjs', import.meta.url).href;
// Faults reach this process's admission thread, and the child processes below.
process.env.MIXDOG_ADMISSION_TEST_FAULT_HOOK = '1';

beforeEach(useTempDataDir);
after(cleanupTempDirs);

const FILE = 'mixdog-workspace-admission.json';
const MIRROR = `${FILE}.management`;
const admissionPath = (repo) => join(repo, '.git', FILE);
const mirrorPath = (repo) => join(repo, '.git', MIRROR);
const lockPath = (repo) => `${admissionPath(repo)}.lock`;
const sessionsIn = (text) => (text ? JSON.parse(text).leases.map((lease) => lease.sessionId ?? lease.kind) : []);
const copySessions = (repo) =>
  [admissionPath(repo), mirrorPath(repo)].map((path) => sessionsIn(readFileSync(path, 'utf8')));
const UNVERIFIED = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } };

async function until(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'the condition was not reached');
    await sleep(10);
  }
}

/** A process that stays alive until the test ends: a command a lease may name. */
function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return child.pid;
}

/** Runs a module script in a new Node process without this one's fault plan. */
async function runScript(script, args, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIXDOG_ADMISSION_TEST_FAULTS: '', MIXDOG_DATA_DIR: tempDir(), ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [status, signal] = await once(child, 'exit');
  return { status, signal, stdout, stderr };
}

/** What a management writer in an independent process meets: 'held' or the refusal reason. */
async function independentManagement(repo) {
  const result = await runScript(
    `
      import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
      try {
        holdWorkspaceActivity([process.argv[1]])();
        console.log('held');
      } catch (error) {
        console.log(error.details?.reason ?? error.message);
      }
    `,
    [repo]
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Counts the turns a 10 ms timer of this thread gets while `work` runs. */
async function timerTicksDuring(work) {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  const startedAt = Date.now();
  try {
    const value = await work();
    return { ticks, value, elapsedMs: Date.now() - startedAt };
  } finally {
    clearInterval(timer);
  }
}

test('the event loop keeps running while a grant and its release are written slowly', async (t) => {
  const repo = makeRepo();
  t.after(() => setAdmissionFaults());
  setAdmissionFaults(
    { op: 'rename', file: FILE, action: 'delay', ms: 300 },
    { op: 'rename', file: MIRROR, action: 'delay', ms: 300 }
  );
  const grant = await timerTicksDuring(() => admitWorkspaceActivity('slow', repo, undefined, { kind: 'command' }));
  assert.ok(grant.elapsedMs >= 550, `both copies were written slowly (${grant.elapsedMs} ms)`);
  assert.ok(grant.ticks >= 15, `a timer fired ${grant.ticks} times during a ${grant.elapsedMs} ms grant`);
  assert.deepEqual(copySessions(repo), [['slow'], ['slow']]);
  const release = await timerTicksDuring(() => grant.value());
  assert.ok(release.ticks >= 15, `a timer fired ${release.ticks} times during a ${release.elapsedMs} ms release`);
  assert.deepEqual(copySessions(repo), [[], []]);
});

test('a lease acknowledged while an older publication is in flight survives its writes and a forced kill', async (t) => {
  const repo = makeRepo();
  const command = liveProcess(t);
  const probe = await runScript(
    `
      import { writeSync } from 'node:fs';
      import { tryAdmitWorkspaceActivity, tryAdmitWorkspaceActivityAsync } from ${JSON.stringify(moduleUrl)};
      import { setAdmissionFaults } from ${JSON.stringify(faultsUrl)};
      const [cwd, command] = process.argv.slice(1);
      setAdmissionFaults(
        // The older publication is slow to replace the primary copy...
        { op: 'rename', file: ${JSON.stringify(FILE)}, hits: [true], action: 'delay', ms: 600 },
        // ...and an asynchronous one is killed right after its mirror replace.
        { op: 'rename', file: ${JSON.stringify(MIRROR)}, api: 'async', when: 'after', hits: [true], action: 'kill' }
      );
      // A lease of this process (which dies below), then one of a live command.
      const older = tryAdmitWorkspaceActivityAsync('older', cwd, { kind: 'command' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const newer = tryAdmitWorkspaceActivity('newer', cwd, { kind: 'command', pid: Number(command) });
      writeSync(1, newer ? 'acknowledged\\n' : 'refused\\n');
      await older;
      // Forced termination: no exit handler runs.
      process.kill(process.pid, 'SIGKILL');
    `,
    [repo, String(command)]
  );
  assert.match(probe.stdout, /acknowledged/, probe.stderr);
  assert.notEqual(probe.status, 0, 'the probe was killed');
  for (const sessions of copySessions(repo))
    assert.ok(sessions.includes('newer'), `a copy lost the lease: ${sessions}`);
  assert.equal(await independentManagement(repo), 'folder-in-use', 'management ran while the command was alive');
});

test('a failed write of either copy never acknowledges a grant and never drops an acknowledged lease', async (t) => {
  const command = liveProcess(t);
  const prior = liveProcess(t);
  t.after(() => setAdmissionFaults());
  for (const file of [FILE, MIRROR]) {
    for (let index = 0; index < 6; index += 1) {
      const repo = makeRepo();
      const where = `${file} write #${index}`;
      const before = tryAdmitWorkspaceActivity('prior', repo, { kind: 'command', pid: prior });
      const hits = Array.from({ length: index + 1 }, (_, at) => at === index);
      setAdmissionFaults(
        { op: 'rename', file: FILE, hits: [true], action: 'delay', ms: 150 },
        { op: 'rename', file, hits, action: 'fail', code: 'EIO' }
      );
      const older = tryAdmitWorkspaceActivityAsync('older', repo, { kind: 'command' }).then(
        (leave) => ({ leave }),
        (error) => ({ error })
      );
      await sleep(50);
      let newer;
      try {
        newer = { leave: tryAdmitWorkspaceActivity('newer', repo, { kind: 'command', pid: command }) };
      } catch (error) {
        newer = { error };
      }
      const olderOutcome = await older;
      setAdmissionFaults();
      for (const outcome of [olderOutcome, newer]) {
        if (outcome.error) assert.equal(outcome.error.details?.reason, 'workspace-admission-unreadable', where);
        else assert.ok(outcome.leave, `${where}: refused without a management lease`);
      }
      const copies = copySessions(repo);
      for (const sessions of copies) {
        assert.ok(sessions.includes('prior'), `${where}: an acknowledged lease was dropped (${sessions})`);
        if (olderOutcome.leave)
          assert.ok(sessions.includes('older'), `${where}: acknowledged 'older' is missing (${sessions})`);
        if (newer.leave)
          assert.ok(sessions.includes('newer'), `${where}: acknowledged 'newer' is missing (${sessions})`);
      }
      await olderOutcome.leave?.();
      newer.leave?.();
      before();
    }
  }
});

test('the admission thread and this thread exclude each other on the ledger lock without stealing it', async (t) => {
  const repo = makeRepo();
  holdWorkspaceActivity([repo])();
  t.after(() => setAdmissionFaults());

  // This thread holds the lock (same pid, its own token), aged past every stale window.
  let letGo;
  const holding = withFileLock(lockPath(repo), () => new Promise((resolve) => (letGo = resolve)), {
    strictOwner: true,
  });
  await until(() => existsSync(lockPath(repo)) && letGo);
  const owner = readFileSync(lockPath(repo), 'utf8');
  utimesSync(lockPath(repo), new Date(0), new Date(0));
  const waited = await timerTicksDuring(async () => {
    const granting = tryAdmitWorkspaceActivityAsync('waiter', repo);
    await sleep(600);
    assert.equal(readFileSync(lockPath(repo), 'utf8'), owner, 'the admission thread took a lock it does not own');
    assert.deepEqual(copySessions(repo), [[], []], 'the grant was written while the lock was held elsewhere');
    letGo();
    await holding;
    return granting;
  });
  assert.ok(waited.ticks >= 15, `this thread ran ${waited.ticks} timer turns while the admission thread waited`);
  assert.ok(waited.value, 'admitted once the lock was released');
  await waited.value();

  // A lock held past the timeout fails the request; the holder's lock is left alone.
  let letGoLater;
  const holdingLonger = withFileLock(lockPath(repo), () => new Promise((resolve) => (letGoLater = resolve)), {
    strictOwner: true,
  });
  await until(() => existsSync(lockPath(repo)) && letGoLater);
  const longerOwner = readFileSync(lockPath(repo), 'utf8');
  await assert.rejects(tryAdmitWorkspaceActivityAsync('timed-out', repo), { code: 'ELOCKTIMEOUT' });
  assert.equal(readFileSync(lockPath(repo), 'utf8'), longerOwner, 'a foreign token unlocked the lock');
  letGoLater();
  await holdingLonger;
  assert.equal(existsSync(lockPath(repo)), false);

  // Blocked on a lock this thread holds, a synchronous request ends with the lock timeout: no deadlock.
  const startedAt = Date.now();
  withFileLockSync(
    lockPath(repo),
    () => assert.throws(() => tryAdmitWorkspaceActivity('blocked', repo), { code: 'ELOCKTIMEOUT' }),
    { strictOwner: true }
  );
  assert.ok(Date.now() - startedAt < 10_000);

  // The other way round: the admission thread's lock is never taken by this thread, however old.
  setAdmissionFaults({ op: 'rename', file: FILE, hits: [true], action: 'delay', ms: 800 });
  const slow = tryAdmitWorkspaceActivityAsync('slow', repo);
  await until(() => existsSync(lockPath(repo)));
  utimesSync(lockPath(repo), new Date(0), new Date(0));
  assert.throws(
    () =>
      withFileLockSync(lockPath(repo), () => assert.fail('two holders at once'), {
        strictOwner: true,
        timeoutMs: 300,
        staleMs: 0,
      }),
    { code: 'ELOCKTIMEOUT' }
  );
  assert.equal(existsSync(lockPath(repo)), true, "this thread removed the admission thread's lock");
  const leave = await slow;
  assert.deepEqual(copySessions(repo), [['slow'], ['slow']]);
  await leave();
});

test('a release requested before a later grant is answered lands after it, and the folder is never unrecorded', async (t) => {
  const repo = makeRepo();
  const command = liveProcess(t);
  const report = 'MIXDOG_TEST_LEDGER_WRITES';
  delete process.env[report];
  t.after(() => {
    setAdmissionFaults();
    delete process.env[report];
  });
  // As a spawn does: the parent's lease, then the command's, then the parent's release.
  const parent = await tryAdmitWorkspaceActivityAsync('parent', repo, { kind: 'command' });
  const files = [admissionPath(repo), mirrorPath(repo)];
  setAdmissionFaults(
    { op: 'rename', file: FILE, when: 'after', action: 'snapshot', report, files },
    { op: 'rename', file: MIRROR, when: 'after', action: 'snapshot', report, files }
  );
  const child = tryAdmitWorkspaceActivityAsync('child', repo, { kind: 'command', pid: command });
  const parentReleased = parent();
  const childLeave = await child;
  await parentReleased;
  setAdmissionFaults();
  const writes = JSON.parse(process.env[report]);
  assert.equal(writes.length, 4, 'two writes each for the grant and the release');
  for (const { file, copies } of writes) {
    for (const sessions of copies.map(sessionsIn)) {
      assert.ok(sessions.includes('parent') || sessions.includes('child'), `after writing ${file}: ${sessions}`);
    }
  }
  assert.deepEqual(copySessions(repo), [['child'], ['child']]);
  assert.equal(await independentManagement(repo), 'folder-in-use');
  await childLeave();
  assert.deepEqual(copySessions(repo), [[], []]);
});

test('a removal that did not land is retried by the heal tick and never comes back', async (t) => {
  const repo = makeRepo();
  process.env.MIXDOG_ADMISSION_HEAL_MS = '100';
  t.after(() => {
    setAdmissionFaults();
    delete process.env.MIXDOG_ADMISSION_HEAL_MS;
  });
  const keep = await tryAdmitWorkspaceActivityAsync('keep', repo);
  const late = await tryAdmitWorkspaceActivityAsync('late', repo);
  setAdmissionFaults({ op: 'rename', file: MIRROR, hits: [true], action: 'fail', code: 'EIO' });
  await late();
  setAdmissionFaults();
  assert.deepEqual(
    copySessions(repo),
    [['keep'], ['keep', 'late']],
    'the mirror kept the lease its write failed to drop'
  );
  // No other request comes: the heal tick finishes the removal by itself.
  await until(() => !copySessions(repo)[1].includes('late'));
  const next = await tryAdmitWorkspaceActivityAsync('next', repo);
  for (let round = 0; round < 5; round += 1) {
    await sleep(120);
    assert.deepEqual(
      copySessions(repo).map((sessions) => [...sessions].sort()),
      [
        ['keep', 'next'],
        ['keep', 'next'],
      ]
    );
  }
  await next();
  await keep();
});

test('a synchronous request that outlasts its wait reports an unknown outcome and its grant is withdrawn', async (t) => {
  const repo = makeRepo();
  t.after(() => {
    setAdmissionFaults();
    delete process.env.MIXDOG_ADMISSION_SYNC_TIMEOUT_MS;
  });
  setAdmissionFaults({ op: 'rename', file: FILE, hits: [true], action: 'delay', ms: 1200 });
  process.env.MIXDOG_ADMISSION_SYNC_TIMEOUT_MS = '300';
  const startedAt = Date.now();
  assert.throws(() => tryAdmitWorkspaceActivity('abandoned', repo), {
    ...UNVERIFIED,
    details: { reason: 'workspace-admission-unreadable', outcome: 'unknown' },
  });
  assert.ok(Date.now() - startedAt < 1_000, 'the wait is bounded');
  delete process.env.MIXDOG_ADMISSION_SYNC_TIMEOUT_MS;
  setAdmissionFaults();
  // Queued behind it: by now the abandoned grant was written and withdrawn.
  const release = await holdWorkspaceActivityAsync([repo]);
  await release();
  assert.deepEqual(copySessions(repo), [[], []]);
});

test('a reader cancelled while its grant is written registers nothing', async (t) => {
  const repo = makeRepo();
  t.after(() => setAdmissionFaults());
  setAdmissionFaults({ op: 'rename', file: FILE, hits: [true], action: 'delay', ms: 400 });
  const controller = new AbortController();
  const admitting = admitWorkspaceActivity('cancelled', repo, controller.signal, { kind: 'command' });
  await sleep(100);
  controller.abort();
  await assert.rejects(admitting, { name: 'AbortError' });
  assert.deepEqual(copySessions(repo), [[], []]);
  const release = await holdWorkspaceActivityAsync([repo]);
  await release();
});

for (const [article, mode] of [
  ['a', 'synchronous'],
  ['an', 'asynchronous'],
]) {
  test(`an admission thread that dies under ${article} ${mode} request fails closed and is not restarted`, async () => {
    const repo = makeRepo();
    const result = await runScript(
      `
        import { existsSync, readFileSync } from 'node:fs';
        import { tryAdmitWorkspaceActivity, tryAdmitWorkspaceActivityAsync } from ${JSON.stringify(moduleUrl)};
        import { setAdmissionFaults } from ${JSON.stringify(faultsUrl)};
        const [cwd, lock] = process.argv.slice(1);
        const outcome = (error) => [error.details?.reason, error.details?.admission, error.details?.outcome ?? 'none'].join('/');
        // The thread stops in the middle of a grant, between the two copies.
        setAdmissionFaults({ op: 'rename', file: ${JSON.stringify(MIRROR)}, action: 'exit-thread' });
        const report = {};
        try {
          ${mode === 'synchronous' ? "tryAdmitWorkspaceActivity('dying', cwd)" : "await tryAdmitWorkspaceActivityAsync('dying', cwd)"};
          report.dying = 'granted';
        } catch (error) {
          report.dying = outcome(error);
        }
        setAdmissionFaults();
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          tryAdmitWorkspaceActivity('later', cwd);
          report.laterSync = 'granted';
        } catch (error) {
          report.laterSync = outcome(error);
        }
        report.laterAsync = await tryAdmitWorkspaceActivityAsync('later', cwd).then(() => 'granted', outcome);
        report.lockOwner = existsSync(lock) ? Number(readFileSync(lock, 'utf8').split(' ')[0]) : null;
        report.pid = process.pid;
        console.log(JSON.stringify(report));
      `,
      [repo, lockPath(repo)]
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dying, 'workspace-admission-unreadable/stopped/unknown');
    assert.equal(report.laterSync, 'workspace-admission-unreadable/stopped/none');
    assert.equal(report.laterAsync, 'workspace-admission-unreadable/stopped/none');
    assert.ok([null, report.pid].includes(report.lockOwner), 'a lock the thread held was not taken over');
    assert.match(result.stderr, /workspace admission thread stopped/);
    // Once that process is gone, its lock and its half-written grant no longer hold anything.
    assert.equal(await independentManagement(repo), 'held');
  });
}

test('no module named by the environment is ever loaded into the admission thread', async () => {
  const repo = makeRepo();
  const marker = 'MIXDOG_TEST_FOREIGN_MODULE_RAN';
  const foreign = `data:text/javascript,process.env.${marker}='1'`;
  const result = await runScript(
    `
      import { tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
      tryAdmitWorkspaceActivity('isolated', process.argv[1])();
      console.log(process.env.${marker} ?? 'not loaded');
    `,
    [repo],
    // The former preload variable, and the test flag without the fixed hook's control.
    { MIXDOG_ADMISSION_WORKER_PRELOAD: foreign, MIXDOG_ADMISSION_TEST_FAULT_HOOK: '0' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'not loaded');
});

test('a transient sharing violation on a copy is retried; the grant lands', async (t) => {
  const repo = makeRepo();
  t.after(() => setAdmissionFaults());
  setAdmissionFaults({ op: 'rename', file: FILE, hits: [true, true], action: 'fail', code: 'EPERM' });
  const leave = await tryAdmitWorkspaceActivityAsync('retried', repo);
  setAdmissionFaults();
  assert.ok(leave);
  assert.deepEqual(copySessions(repo), [['retried'], ['retried']]);
  await leave();
});
