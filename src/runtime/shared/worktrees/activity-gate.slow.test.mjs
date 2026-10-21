import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

const asideCopies = (repo) =>
  readdirSync(join(repo, '.git'))
    .filter((name) => name.startsWith('mixdog-workspace-admission.json.corrupt-'))
    .map((name) => join(repo, '.git', name));

const RECOVERY_MS = 400;
// The gate reads Date.now() directly, so a test that asserts a refusal INSIDE
// the window needs one long enough that a loaded CI disk cannot outrun it.
const LOAD_PROOF_RECOVERY_MS = 3500;
async function withShortRecovery(run, windowMs = RECOVERY_MS) {
  const saved = [process.env.MIXDOG_ADMISSION_RECOVERY_MS, process.env.MIXDOG_ADMISSION_HEAL_MS];
  process.env.MIXDOG_ADMISSION_RECOVERY_MS = String(windowMs);
  process.env.MIXDOG_ADMISSION_HEAL_MS = '100';
  try {
    await run();
  } finally {
    const [recovery, heal] = saved;
    if (recovery === undefined) delete process.env.MIXDOG_ADMISSION_RECOVERY_MS;
    else process.env.MIXDOG_ADMISSION_RECOVERY_MS = recovery;
    if (heal === undefined) delete process.env.MIXDOG_ADMISSION_HEAL_MS;
    else process.env.MIXDOG_ADMISSION_HEAL_MS = heal;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ledgerOf = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), 'utf8'));

test('a damaged ledger is kept aside: readers continue, a live holder is never lost, management resumes by itself', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    const leave = tryAdmitWorkspaceActivity('reader', repo);
    const intact = readFileSync(path);
    for (const damaged of [
      Buffer.alloc(intact.length),
      Buffer.from('{broken'),
      Buffer.alloc(0),
      Buffer.from('{"version":1,"leases":[null]}'),
    ]) {
      writeFileSync(path, damaged);
      const later = tryAdmitWorkspaceActivity('later-reader', repo);
      assert.ok(later, 'a damaged ledger admits readers');
      assert.ok(
        asideCopies(repo).some((copy) => readFileSync(copy).equals(damaged)),
        'the damaged bytes are kept aside, not overwritten'
      );
      later();
      // The holder in this process republished its lease: management still refuses on it.
      assert.throws(() => holdWorkspaceActivity([repo]), {
        code: 'WORKTREE_BUSY_JOBS',
        details: { reason: 'folder-in-use' },
      });

      // A fresh profile meets the same damage: its reader continues, its writer waits.
      writeFileSync(path, damaged);
      const next = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import assert from 'node:assert/strict';
            import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
            const cwd = process.argv[1];
            tryAdmitWorkspaceActivity('new-process', cwd)();
            assert.throws(() => holdWorkspaceActivity([cwd]), { details: { reason: 'workspace-admission-unreadable' } });
          `,
          repo,
        ],
        { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
      );
      assert.equal(next.error, undefined);
      assert.equal(next.status, 0, next.stderr);
      for (const copy of asideCopies(repo)) unlinkSync(copy);
    }
    leave();
    await sleep(RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
    assert.deepEqual(ledgerOf(repo).leases, []);
    assert.equal(ledgerOf(repo).recoveredAt, undefined, 'the unknown-lease state cleared on its own');
  });
});

test('a recovered ledger refuses management only for the unknown window, then the block clears', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), Buffer.alloc(64));
    tryAdmitWorkspaceActivity('reader', repo)();
    assert.throws(() => holdWorkspaceActivity([repo]), {
      code: 'WORKTREE_BUSY_JOBS',
      details: { reason: 'workspace-admission-unreadable' },
    });
    await sleep(LOAD_PROOF_RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
    assert.equal(ledgerOf(repo).recoveredAt, undefined);
  }, LOAD_PROOF_RECOVERY_MS);
});

test('a writer that meets the damage first keeps the recovery, so the next writer still waits', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), Buffer.alloc(64));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(() => holdWorkspaceActivity([repo]), {
        code: 'WORKTREE_BUSY_JOBS',
        details: { reason: 'workspace-admission-unreadable' },
      });
    }
    assert.ok(Number.isFinite(ledgerOf(repo).recoveredAt), 'the refused writer published the recovery');
    await sleep(RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
  });
});

// Runs `interleave` once, right after the ledger lock is first released: the
// instant another process can take the lock. A throw inside the release is
// swallowed by the lock, so `interleave` records its own outcome.
function afterLedgerLockRelease(interleave) {
  const unlink = fs.unlinkSync;
  let fired = false;
  fs.unlinkSync = function (path, ...rest) {
    const result = unlink.call(this, path, ...rest);
    if (!fired && String(path).endsWith('mixdog-workspace-admission.json.lock')) {
      fired = true;
      interleave();
    }
    return result;
  };
  syncBuiltinESMExports();
  return () => {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  };
}

test('a writer that takes the lock the instant a recovery releases it still waits for the recovery window', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), Buffer.alloc(64));
    let interleaved = { error: new Error('no writer ran at the lock release') };
    const stop = afterLedgerLockRelease(() => {
      try {
        interleaved = { release: holdWorkspaceActivity([repo]) };
      } catch (error) {
        interleaved = { error };
      }
    });
    try {
      holdWorkspaceActivity([repo])();
    } catch {
      // The first writer is refused for the window; only the interleaved one is under test.
    } finally {
      stop();
    }
    interleaved.release?.();
    assert.equal(
      interleaved.error?.details?.reason,
      'workspace-admission-unreadable',
      `a writer admitted between the move-aside and the recovery read the missing ledger as empty: ${interleaved.error?.message ?? 'admitted'}`
    );
    assert.ok(Number.isFinite(ledgerOf(repo).recoveredAt), 'the recovery marker is published');
    await sleep(RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
  });
});

test('a crash between keeping the damaged ledger aside and publishing the recovery still refuses management', async () => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const damaged = Buffer.alloc(64);
    writeFileSync(join(repo, '.git', 'mixdog-workspace-admission.json'), damaged);
    const crashed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
          const rename = fs.renameSync;
          // The process dies as the recovered ledger is about to be published.
          fs.renameSync = (from, to) => {
            if (String(to).endsWith('mixdog-workspace-admission.json')) process.exit(86);
            return rename(from, to);
          };
          syncBuiltinESMExports();
          holdWorkspaceActivity([process.argv[1]]);
        `,
        repo,
      ],
      { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
    );
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.ok(
      asideCopies(repo).some((copy) => readFileSync(copy).equals(damaged)),
      'the damaged bytes were kept before the crash'
    );
    assert.throws(() => holdWorkspaceActivity([repo]), {
      code: 'WORKTREE_BUSY_JOBS',
      details: { reason: 'workspace-admission-unreadable' },
    });
    await sleep(RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
  });
});

test('a damaged ledger cannot hide a foreign management operation from readers', { timeout: 20000 }, async (t) => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
          const release = holdWorkspaceActivity([process.argv[1]]);
          process.on('message', () => { release(); process.exit(0); });
          process.send('active');
        `,
        repo,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // No self-heal in the holder: only the management mirror can restore its lease.
        env: { ...process.env, MIXDOG_DATA_DIR: tempDir(), MIXDOG_ADMISSION_HEAL_MS: '600000' },
      }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    assert.equal((await once(child, 'message'))[0], 'active');
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    writeFileSync(path, Buffer.alloc(readFileSync(path).length));
    assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the operation in progress still excludes readers');
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
    const leave = tryAdmitWorkspaceActivity('reader', repo);
    assert.ok(leave, 'readers resume once the operation ended');
    leave();
  });
});

test('a ledger of a newer build is left in place: readers go unrecorded, management refuses', () => {
  const repo = makeRepo();
  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const newer = '{"version":2,"leases":[],"future":true}';
  writeFileSync(path, newer);
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(leave, 'prompts are never blocked by it');
  leave();
  assert.throws(() => holdWorkspaceActivity([repo]), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assert.equal(readFileSync(path, 'utf8'), newer);
  assert.deepEqual(asideCopies(repo), []);
});

test('one invalid lease record is dropped without discarding the valid leases', { timeout: 20000 }, async (t) => {
  await withShortRecovery(async () => {
    const repo = makeRepo();
    const child = reader(t, repo);
    assert.equal((await once(child, 'message'))[0], 'active');
    const path = join(repo, '.git', 'mixdog-workspace-admission.json');
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.leases.push({ kind: 'turn', token: 7 });
    writeFileSync(path, JSON.stringify(ledger));
    const leave = tryAdmitWorkspaceActivity('parent', repo);
    assert.ok(leave);
    assert.ok(
      ledgerOf(repo).leases.some((lease) => lease.pid === child.pid),
      'the valid foreign lease survived'
    );
    assert.ok(asideCopies(repo).some((copy) => JSON.parse(readFileSync(copy, 'utf8')).leases.length === 2));
    leave();
    assert.throws(() => holdWorkspaceActivity([repo]), {
      code: 'WORKTREE_BUSY_JOBS',
      details: { reason: 'folder-in-use' },
    });
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
    await sleep(RECOVERY_MS + 100);
    holdWorkspaceActivity([repo])();
  });
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
