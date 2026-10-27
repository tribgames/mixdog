import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  admitWorkspaceActivity,
  holdWorkspaceActivity,
  holdWorkspaceActivityAsync,
  tryAdmitWorkspaceActivity,
  tryAdmitWorkspaceActivityAsync,
} from './activity-gate.mjs';
import { setAdmissionFaults } from './activity-gate-faults.test-hook.mjs';
import { admitTurn, retainAdmittedTurnWorkspace } from '../../../session-runtime/workspace/admission-gate.mjs';
import {
  completeShellJobRecord,
  publishShellJobRecord,
} from '../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';
import { withFileLockSync } from '../atomic-file.mjs';
import { putRecord, registryPath } from './registry.mjs';
import { spawnShellChild } from '../../agent/orchestrator/tools/lib/shell-run-spawn.mjs';

beforeEach(useTempDataDir);
after(cleanupTempDirs);
const moduleUrl = new URL('./activity-gate.mjs', import.meta.url).href;
// Faults are injected into the admission thread of this process (and of the
// child processes below, which inherit the environment).
const faultsUrl = new URL('./activity-gate-faults.test-hook.mjs', import.meta.url).href;
process.env.MIXDOG_ADMISSION_TEST_FAULT_HOOK = '1';
const killedMarker = '[admission-faults] killed';

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

test('an external checkout admits readers whatever is held outside it, yet its running reader still refuses a writer', () => {
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

test('an external checkout nested inside a held main folder stays admitted', () => {
  const repo = makeRepo();
  const nested = join(repo, 'nested-checkout');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/nested', nested);
  const writer = holdWorkspaceActivity([repo]);
  const nestedReader = tryAdmitWorkspaceActivity('nested-turn', nested);
  assert.ok(nestedReader, 'a lease on the enclosing folder does not hold the nested external checkout');
  nestedReader();
  writer();
});

// Another profile (an empty registry) sees a Mixdog-managed checkout as external.
function foreignProbe(checkout, sub) {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
        const [root, sub] = process.argv.slice(1);
        const out = {};
        for (const kind of ['turn', 'command']) {
          for (const [name, cwd] of [['root', root], ['sub', sub]]) {
            const leave = tryAdmitWorkspaceActivity('foreign-' + kind, cwd, { kind });
            out[kind + ':' + name] = leave === null;
            if (leave) leave();
          }
        }
        console.log(JSON.stringify(out));
      `,
      checkout,
      sub,
    ],
    { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
  );
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

test('a management lease inside an external checkout refuses its readers from another profile', async () => {
  const repo = makeRepo();
  const checkout = await managedWorktree(repo);
  const sub = join(checkout, 'sub');
  mkdirSync(sub);
  const release = holdWorkspaceActivity([checkout]);
  assert.deepEqual(foreignProbe(checkout, sub), {
    'turn:root': true,
    'turn:sub': true,
    'command:root': true,
    'command:sub': true,
  });
  assert.deepEqual(
    ledgerOf(repo).leases.map((lease) => lease.kind),
    ['management'],
    'no reader lease is left'
  );
  release();
  assert.deepEqual(foreignProbe(checkout, sub), {
    'turn:root': false,
    'turn:sub': false,
    'command:root': false,
    'command:sub': false,
  });
});

test('a management lease still refuses readers of its checkout after the registry is recovered empty', async () => {
  const repo = makeRepo();
  const checkout = await managedWorktree(repo);
  const release = holdWorkspaceActivity([checkout]);
  writeFileSync(registryPath(), JSON.stringify({ version: 1, entries: {} }));
  assert.equal(tryAdmitWorkspaceActivity('after-recovery', checkout), null);
  assert.equal(tryAdmitWorkspaceActivity('after-recovery', checkout, { kind: 'command' }), null);
  assert.deepEqual(
    ledgerOf(repo).leases.map((lease) => lease.kind),
    ['management']
  );
  release();
  tryAdmitWorkspaceActivity('after-release', checkout)();
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

const FILE = 'mixdog-workspace-admission.json';
const admissionPath = (repo) => join(repo, '.git', FILE);
const mirrorPath = (repo) => `${admissionPath(repo)}.management`;
const asideCopies = (repo, path = admissionPath(repo)) =>
  readdirSync(join(repo, '.git'))
    .filter((name) => name.startsWith(`${basename(path)}.corrupt-`))
    .map((name) => join(repo, '.git', name));
const ledgerOf = (repo) => JSON.parse(readFileSync(admissionPath(repo), 'utf8'));
const mirrorOf = (repo) => JSON.parse(readFileSync(mirrorPath(repo), 'utf8'));
const sessions = (ledger) => ledger.leases.map((lease) => lease.sessionId);
const zeroFill = (path) => writeFileSync(path, Buffer.alloc(readFileSync(path).length));
const UNVERIFIED = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'workspace-admission-unreadable' } };
const IN_USE = { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'folder-in-use' } };

/** Both copies of the ledger, which agree after every completed mutation. */
function copiesOf(repo) {
  const primary = readFileSync(admissionPath(repo), 'utf8');
  assert.equal(readFileSync(mirrorPath(repo), 'utf8'), primary, 'both copies hold the same ledger');
  return JSON.parse(primary);
}

/** Moves every recovery stamp far into the past: the former 15 s window is long over. */
function ageRecovery(repo) {
  for (const path of [admissionPath(repo), mirrorPath(repo)]) {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if ('recoveredAt' in ledger) writeFileSync(path, JSON.stringify({ ...ledger, recoveredAt: 0 }));
  }
}

async function until(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'the condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A process whose leases are never healed (its heal tick is far away), like a
 * suspended one: only the ledger's copies keep them. `holds` lists
 * `[kind, folder]`; any message releases them all and exits.
 */
async function holding(t, holds, dataDir = tempDir()) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
        const releases = JSON.parse(process.argv[1]).map(([kind, folder]) =>
          kind === 'management'
            ? holdWorkspaceActivity([folder])
            : tryAdmitWorkspaceActivity('silent-' + kind, folder, { kind })
        );
        process.on('message', () => {
          for (const leave of releases) leave();
          process.exit(0);
        });
        process.send('active');
      `,
      JSON.stringify(holds),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, MIXDOG_DATA_DIR: dataDir, MIXDOG_ADMISSION_HEAL_MS: '600000' },
    }
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  assert.equal((await once(child, 'message'))[0], 'active');
  return child;
}

/** A linked worktree Mixdog manages, so management takes a lease on it. */
async function managedWorktree(repo) {
  const path = join(tempDir(), 'managed');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/managed', path);
  await putRecord({ id: 'managed', path });
  return path;
}

test('a damaged primary copy is restored from the mirror: readers continue and a live holder is never lost', () => {
  const repo = makeRepo();
  const path = admissionPath(repo);
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  const intact = readFileSync(path);
  for (const damaged of [
    Buffer.alloc(intact.length),
    Buffer.from('{broken'),
    Buffer.alloc(0),
    Buffer.from('{"version":2,"leases":[null]}'),
  ]) {
    writeFileSync(path, damaged);
    const later = tryAdmitWorkspaceActivity('later-reader', repo);
    assert.ok(later, 'a damaged ledger admits readers');
    assert.ok(
      asideCopies(repo).some((copy) => readFileSync(copy).equals(damaged)),
      'the damaged bytes are kept aside, not overwritten'
    );
    later();
    assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);

    // A fresh profile meets the same damage: the mirror still names the holder.
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
          assert.throws(() => holdWorkspaceActivity([cwd]), { details: { reason: 'folder-in-use' } });
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
  holdWorkspaceActivity([repo])();
  assert.deepEqual(copiesOf(repo).leases, []);
  assert.equal(ledgerOf(repo).recoveredAt, undefined, 'an intact mirror leaves nothing unknown');
});

test('a writer that meets the damage first publishes the uncertainty to both copies, so the next writer still waits', () => {
  const repo = makeRepo();
  writeFileSync(admissionPath(repo), Buffer.alloc(64));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
  }
  assert.ok(Number.isFinite(copiesOf(repo).recoveredAt), 'the refused writer published the uncertainty');
});

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

test('a writer that takes the lock the instant a recovery releases it still waits', async (t) => {
  const repo = makeRepo();
  writeFileSync(admissionPath(repo), Buffer.alloc(64));
  const released = 'MIXDOG_TEST_LEDGER_LOCK_RELEASED';
  delete process.env[released];
  t.after(() => setAdmissionFaults());
  // The writer that meets the damage stops right after releasing the ledger
  // lock: the instant another process can take it.
  setAdmissionFaults(
    { op: 'unlink', file: `${FILE}.lock`, when: 'after', hits: [true], action: 'snapshot', report: released, files: [] },
    { op: 'unlink', file: `${FILE}.lock`, when: 'after', hits: [true], action: 'delay', ms: 3000 }
  );
  const first = holdWorkspaceActivityAsync([repo]).then(
    (release) => release(),
    () => {
      // The first writer is refused; only the interleaved one is under test.
    }
  );
  await until(() => process.env[released]);
  const interleaved = await runScript(
    `
      import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
      try {
        holdWorkspaceActivity([process.argv[1]])();
        console.log('admitted');
      } catch (error) {
        console.log(error.details?.reason ?? error.message);
      }
    `,
    [repo]
  );
  await first;
  assert.equal(
    interleaved.stdout.trim(),
    'workspace-admission-unreadable',
    `a writer admitted between the move-aside and the recovery read the missing ledger as empty: ${interleaved.stderr}`
  );
  assert.ok(Number.isFinite(copiesOf(repo).recoveredAt), 'the uncertainty is published to both copies');
});

test('a crash between keeping the damaged ledger aside and publishing the recovery still refuses management', async () => {
  const repo = makeRepo();
  const damaged = Buffer.alloc(64);
  writeFileSync(admissionPath(repo), damaged);
  // The process dies (no exit handler runs) as the recovered ledger is about to be published.
  const crashed = await runScript(
    `
      import { holdWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
      import { setAdmissionFaults } from ${JSON.stringify(faultsUrl)};
      setAdmissionFaults({ op: 'rename', file: ${JSON.stringify(FILE)}, action: 'kill' });
      holdWorkspaceActivity([process.argv[1]]);
    `,
    [repo]
  );
  assert.ok(crashed.stderr.includes(killedMarker), crashed.stderr);
  assert.ok(
    asideCopies(repo).some((copy) => readFileSync(copy).equals(damaged)),
    'the damaged bytes were kept before the crash'
  );
  assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
});

test('a damaged ledger cannot hide a foreign management operation from readers', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const child = await holding(t, [['management', repo]]);
  zeroFill(admissionPath(repo));
  assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the operation in progress still excludes readers');
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
  const leave = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(leave, 'readers resume once the operation ended');
  leave();
});

test('invalid lease records drop only themselves; without an intact copy the rest stays uncertain', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  const child = reader(t, repo);
  assert.equal((await once(child, 'message'))[0], 'active');
  const withInvalidRecord = () => {
    const ledger = ledgerOf(repo);
    ledger.leases.push({ kind: 'turn', token: 7 });
    return JSON.stringify(ledger);
  };
  writeFileSync(admissionPath(repo), withInvalidRecord());
  const leave = tryAdmitWorkspaceActivity('parent', repo);
  assert.ok(leave);
  assert.ok(
    ledgerOf(repo).leases.some((lease) => lease.pid === child.pid),
    'the valid foreign lease survived'
  );
  assert.ok(asideCopies(repo).some((copy) => JSON.parse(readFileSync(copy, 'utf8')).leases.length === 2));
  leave();
  assert.equal(ledgerOf(repo).recoveredAt, undefined, 'the intact mirror accounts for the invalid record');
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);

  // The same invalid record in both copies: the valid leases stay, the rest is unknown.
  const damaged = withInvalidRecord();
  writeFileSync(admissionPath(repo), damaged);
  writeFileSync(mirrorPath(repo), damaged);
  tryAdmitWorkspaceActivity('parent', repo)();
  assert.ok(copiesOf(repo).leases.some((lease) => lease.pid === child.pid));
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
  assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED, 'its release does not prove the ledger whole');
});

test('an unreadable copy is never overwritten and admission resumes after access is restored', () => {
  const repo = makeRepo();
  holdWorkspaceActivity([repo])();
  for (const path of [admissionPath(repo), mirrorPath(repo)]) {
    unlinkSync(path);
    mkdirSync(path);
    assert.throws(() => tryAdmitWorkspaceActivity('blocked', repo), UNVERIFIED);
    assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
    rmdirSync(path);
    holdWorkspaceActivity([repo])();
  }
});

// ── #181: no live owner loses its protection to a damaged ledger ─────────

for (const kind of ['turn', 'command']) {
  test(`#181-1 a suspended foreign ${kind} keeps management refused past the former recovery window`, {
    timeout: 20000,
  }, async (t) => {
    const repo = makeRepo();
    await holding(t, [[kind, repo]]);
    zeroFill(admissionPath(repo));
    assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
    ageRecovery(repo);
    assert.throws(() => holdWorkspaceActivity([repo]), IN_USE, 'the mirror still names the live holder');
    assert.ok(copiesOf(repo).leases.some((lease) => lease.kind === kind && lease.sessionId === `silent-${kind}`));
  });
}

test('#181-2 a recorded background command outlives its publisher until the command is confirmed dead', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  t.after(() => {
    if (command.exitCode === null) command.kill();
  });
  const records = new URL('../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs', import.meta.url).href;
  const publisher = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { publishShellJobRecord } from ${JSON.stringify(records)};
        const [cwd, pid] = process.argv.slice(1);
        await publishShellJobRecord({ jobId: 'job_survivor', cwd, pid: Number(pid), command: 'node' }, { ownerSessionId: 'publisher' });
        process.exit(0);
      `,
      repo,
      String(command.pid),
    ],
    { stdio: 'ignore', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
  );
  assert.deepEqual(await once(publisher, 'exit'), [0, null]);
  assert.ok(ledgerOf(repo).leases.some((lease) => lease.kind === 'command' && lease.pid === command.pid));
  zeroFill(admissionPath(repo));
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  ageRecovery(repo);
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE, 'no process is left to republish the command');
  assert.ok(copiesOf(repo).leases.some((lease) => lease.kind === 'command' && lease.pid === command.pid));
  const exited = once(command, 'exit');
  command.kill();
  await exited;
  holdWorkspaceActivity([repo])();
});

test('#181-3 a damaged mirror is restored from the intact primary with every kind of lease', {
  timeout: 30000,
}, async (t) => {
  const repo = makeRepo();
  const managed = await managedWorktree(repo);
  await holding(
    t,
    [
      ['turn', repo],
      ['command', repo],
      ['management', managed],
    ],
    process.env.MIXDOG_DATA_DIR
  );
  const damaged = Buffer.alloc(readFileSync(mirrorPath(repo)).length);
  writeFileSync(mirrorPath(repo), damaged);
  tryAdmitWorkspaceActivity('probe', repo)();
  assert.deepEqual(
    copiesOf(repo)
      .leases.map((lease) => lease.kind)
      .sort(),
    ['command', 'management', 'turn']
  );
  assert.ok(asideCopies(repo, mirrorPath(repo)).some((copy) => readFileSync(copy).equals(damaged)));
  // The repaired mirror alone now carries all of them.
  zeroFill(admissionPath(repo));
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
  assert.equal(tryAdmitWorkspaceActivity('blocked', managed), null, 'the management operation still excludes readers');
  assert.equal(copiesOf(repo).recoveredAt, undefined);
});

test('#181-4 with both copies damaged the uncertainty survives mutations, releases, restarts and any age', () => {
  const repo = makeRepo();
  const keep = tryAdmitWorkspaceActivity('keep', repo);
  zeroFill(admissionPath(repo));
  zeroFill(mirrorPath(repo));
  const reader = tryAdmitWorkspaceActivity('reader', repo);
  assert.ok(reader, 'readers still run');
  // This process put `keep` back: some leases came back, which proves nothing about the rest.
  assert.deepEqual(sessions(copiesOf(repo)).sort(), ['keep', 'reader']);
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
  reader();
  keep();
  for (let round = 0; round < 3; round += 1) {
    tryAdmitWorkspaceActivity(`round-${round}`, repo)();
    ageRecovery(repo);
    assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
  }
  const restarted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
        const cwd = process.argv[1];
        tryAdmitWorkspaceActivity('restarted', cwd)();
        assert.throws(() => holdWorkspaceActivity([cwd]), { details: { reason: 'workspace-admission-unreadable' } });
      `,
      repo,
    ],
    { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok('recoveredAt' in copiesOf(repo));
});

test('#181-5 a missing copy is restored from the other in both directions, never read as empty', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  await holding(t, [
    ['turn', repo],
    ['command', repo],
  ]);
  for (const missing of [mirrorPath(repo), admissionPath(repo)]) {
    unlinkSync(missing);
    assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
    const ledger = copiesOf(repo);
    assert.deepEqual(sessions(ledger).sort(), ['silent-command', 'silent-turn']);
    assert.equal(ledger.recoveredAt, undefined, 'the remaining copy was complete');
  }
});

// Fails planned writes of one copy: `plan.primary[i]` / `plan.mirror[i]` say
// whether that copy's i-th write during `run` fails.
function withFailingWrites(plan, run) {
  setAdmissionFaults(
    { op: 'rename', file: FILE, hits: plan.primary ?? [], action: 'fail', code: 'EIO' },
    { op: 'rename', file: `${FILE}.management`, hits: plan.mirror ?? [], action: 'fail', code: 'EIO' }
  );
  try {
    return run();
  } finally {
    setAdmissionFaults();
  }
}

test('#181-6 publication faults never acknowledge an unprotected grant, lose a lease, or revive a released one', {
  timeout: 30000,
}, async (t) => {
  const repo = makeRepo();
  const managed = await managedWorktree(repo);
  // An existing lease of a process that cannot put it back by itself.
  await holding(t, [['turn', repo]]);
  const inPrimary = (session) => sessions(ledgerOf(repo)).includes(session);
  const inMirror = (session) => sessions(mirrorOf(repo)).includes(session);
  const settled = (...expected) =>
    assert.deepEqual(sessions(copiesOf(repo)).sort(), ['silent-turn', ...expected].sort());

  // A grant whose write of either copy fails returns no handle and leaves no lease.
  for (const plan of [{ primary: [true] }, { mirror: [true] }]) {
    assert.throws(() => withFailingWrites(plan, () => tryAdmitWorkspaceActivity('attempt', repo)), UNVERIFIED);
    settled();
  }
  assert.throws(() => withFailingWrites({ mirror: [true] }, () => holdWorkspaceActivity([managed])), UNVERIFIED);
  settled();
  const probe = tryAdmitWorkspaceActivity('probe', managed);
  assert.ok(probe, 'the failed management grant left no lease behind');
  probe();

  // Its rollback fails too: the attempt stays recorded (a conservative claim of
  // this live process) and no grant succeeds while the copies cannot be made whole.
  assert.throws(
    () =>
      withFailingWrites({ mirror: [true], primary: [false, true] }, () => tryAdmitWorkspaceActivity('attempt', repo)),
    UNVERIFIED
  );
  assert.ok(inPrimary('attempt') && !inMirror('attempt'));
  assert.throws(
    () => withFailingWrites({ mirror: [true, true] }, () => tryAdmitWorkspaceActivity('refused', repo)),
    UNVERIFIED
  );
  assert.ok(!inPrimary('refused') && !inMirror('refused'));
  // The next mutation withdraws exactly the pending attempts.
  const kept = tryAdmitWorkspaceActivity('kept', repo);
  assert.ok(kept);
  settled('kept');

  // A release whose write of either copy fails stays pending and is retried by
  // the next mutation; the released lease is never put back.
  for (const plan of [{ primary: [true] }, { mirror: [true] }]) {
    const done = tryAdmitWorkspaceActivity('done', repo);
    withFailingWrites(plan, done);
    assert.ok(inPrimary('done') || inMirror('done'), 'a removal that did not land keeps the lease recorded');
    tryAdmitWorkspaceActivity('next', repo)();
    settled('kept');
  }

  // Without another mutation, the heal tick retries the removal by itself.
  const late = tryAdmitWorkspaceActivity('late', repo);
  withFailingWrites({ mirror: [true] }, late);
  assert.ok(inMirror('late'));
  await until(() => !inMirror('late'));
  settled('kept');
  kept();
  settled();
});

// Runs `step` in a new process that dies (no exit handler runs) as it is
// about to replace the mirror, after the primary copy was written.
function dieBetweenWrites(repo, step) {
  const crashed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { tryAdmitWorkspaceActivity } from ${JSON.stringify(moduleUrl)};
        import { setAdmissionFaults } from ${JSON.stringify(faultsUrl)};
        setAdmissionFaults({ op: 'rename', file: ${JSON.stringify(`${FILE}.management`)}, action: 'kill' });
        const cwd = process.argv[1];
        ${step}
      `,
      repo,
    ],
    { encoding: 'utf8', env: { ...process.env, MIXDOG_ADMISSION_TEST_FAULTS: '', MIXDOG_DATA_DIR: tempDir() } }
  );
  assert.ok(crashed.stderr.includes(killedMarker), crashed.stderr);
}

test('#181-7 a process dying between the two writes never lets management run over acknowledged work', {
  timeout: 30000,
}, async (t) => {
  const repo = makeRepo();
  await holding(t, [['turn', repo]]);
  const grant = `tryAdmitWorkspaceActivity('interrupted', cwd);`;
  dieBetweenWrites(repo, grant);
  assert.ok(sessions(ledgerOf(repo)).includes('interrupted') && !sessions(mirrorOf(repo)).includes('interrupted'));
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
  // The copy the dead process wrote is damaged afterwards: the older mirror still names the holder.
  dieBetweenWrites(repo, grant);
  zeroFill(admissionPath(repo));
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);
  assert.deepEqual(sessions(copiesOf(repo)), ['silent-turn']);
  // Both copies damaged, and the process persisting that dies halfway: the next one still refuses.
  zeroFill(admissionPath(repo));
  zeroFill(mirrorPath(repo));
  dieBetweenWrites(repo, grant);
  assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
});

test('#181-8 a version 1 ledger keeps every lease; a damaged one beside a management-only mirror stays uncertain', () => {
  const repo = makeRepo();
  const lease = (kind, path) => ({ kind, sessionId: `v1-${kind}`, pid: process.pid, token: `v1-${kind}`, path });
  const management = lease('management', tempDir());
  const v1 = { version: 1, leases: [lease('turn', repo), lease('command', repo), management] };
  const v1Mirror = JSON.stringify({ version: 1, leases: [management] });
  writeFileSync(admissionPath(repo), JSON.stringify(v1));
  writeFileSync(mirrorPath(repo), v1Mirror);
  tryAdmitWorkspaceActivity('probe', repo)();
  const migrated = copiesOf(repo);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.leases, v1.leases);
  assert.equal(migrated.recoveredAt, undefined, 'an intact version 1 ledger is complete');
  assert.throws(() => holdWorkspaceActivity([repo]), IN_USE);

  writeFileSync(admissionPath(repo), Buffer.alloc(64));
  writeFileSync(mirrorPath(repo), v1Mirror);
  tryAdmitWorkspaceActivity('probe', repo)();
  const recovered = copiesOf(repo);
  assert.deepEqual(recovered.leases, [management], 'the mirrored management lease is kept');
  assert.ok('recoveredAt' in recovered, 'a management-only mirror is not a complete ledger');
  ageRecovery(repo);
  assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
});

test('#181-10 a ledger of a newer build refuses every admission and is left byte-identical', () => {
  const repo = makeRepo();
  const newer = '{"version":3,"leases":[],"future":true}';
  for (const primary of [newer, '{"version":2,"leases":[]}\n']) {
    writeFileSync(admissionPath(repo), primary);
    writeFileSync(mirrorPath(repo), newer);
    assert.throws(() => tryAdmitWorkspaceActivity('reader', repo), UNVERIFIED);
    assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
    assert.equal(readFileSync(admissionPath(repo), 'utf8'), primary);
    assert.equal(readFileSync(mirrorPath(repo), 'utf8'), newer);
  }
  assert.deepEqual([...asideCopies(repo), ...asideCopies(repo, mirrorPath(repo))], []);
});

test('#181-11 a new repository and a quiescent reset start clean; two missing copies read as a new repository', {
  timeout: 20000,
}, async (t) => {
  const repo = makeRepo();
  holdWorkspaceActivity([repo])();
  tryAdmitWorkspaceActivity('first', repo)();
  assert.deepEqual(copiesOf(repo), { version: 2, leases: [] });

  zeroFill(admissionPath(repo));
  zeroFill(mirrorPath(repo));
  tryAdmitWorkspaceActivity('reader', repo)();
  ageRecovery(repo);
  assert.throws(() => holdWorkspaceActivity([repo]), UNVERIFIED);
  // The documented reset, with nothing running: remove the pair, keep the `.corrupt-` copies.
  const kept = [...asideCopies(repo), ...asideCopies(repo, mirrorPath(repo))];
  assert.equal(kept.length, 2);
  unlinkSync(admissionPath(repo));
  unlinkSync(mirrorPath(repo));
  holdWorkspaceActivity([repo])();
  assert.deepEqual(copiesOf(repo), { version: 2, leases: [] });
  assert.ok(kept.every((copy) => existsSync(copy)));

  // The documented limitation: both copies removed while work runs reads as a new repository.
  await holding(t, [['turn', repo]]);
  unlinkSync(admissionPath(repo));
  unlinkSync(mirrorPath(repo));
  holdWorkspaceActivity([repo])();
});

test('a copy that keeps refusing its replace (EPERM) fails the grant after the bounded retries and is never removed', {
  timeout: 90000,
}, async (t) => {
  const repo = makeRepo();
  const keep = tryAdmitWorkspaceActivity('keep', repo);
  const before = readFileSync(admissionPath(repo));
  t.after(() => setAdmissionFaults());
  setAdmissionFaults({ op: 'rename', file: FILE, action: 'fail', code: 'EPERM' });
  await assert.rejects(tryAdmitWorkspaceActivityAsync('refused', repo), UNVERIFIED);
  setAdmissionFaults();
  assert.ok(readFileSync(admissionPath(repo)).equals(before), 'the refusing copy was replaced or removed');
  // Once the copy accepts writes again, nothing of the refused grant remains.
  tryAdmitWorkspaceActivity('after', repo)();
  assert.deepEqual(sessions(copiesOf(repo)), ['keep']);
  keep();
});
