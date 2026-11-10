import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { shellJobsStatus, shellJobsStatusFresh } from './statusline-segments.mjs';

test('foreground commands stay out of the shell job list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-foreground-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const write = (jobId, record) => {
      writeFileSync(
        join(dir, `${jobId}.json`),
        JSON.stringify({ pid: process.pid, ownerSessionId: 'sess-fg', ...record })
      );
      writeFileSync(join(dir, `${jobId}.owner-${process.pid}`), '');
    };
    write(`job_${Date.now()}_bg`, { command: 'npm run dev' });
    write(`job_${Date.now()}_fg`, { command: 'git status', foreground: true });
    // Another owner pid than the other test so its cache entry starts cold.
    const ownerPid = process.pid + 200_000;
    let status = shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'sess-fg' });
    for (let attempt = 0; attempt < 40 && status.count === 0; attempt += 1) {
      await delay(25);
      status = shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'sess-fg' });
    }
    assert.equal(status.count, 1);
    assert.deepEqual(
      status.jobs.map((job) => job.command),
      ['npm run dev']
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('recently finished background jobs ride in the session bucket without counting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-finished-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const write = (jobId, record, done) => {
      writeFileSync(
        join(dir, `${jobId}.json`),
        JSON.stringify({ pid: process.pid, ownerSessionId: 'sess-fin', ...record })
      );
      writeFileSync(join(dir, `${jobId}.owner-${process.pid + 300_000}`), '');
      if (done) writeFileSync(join(dir, `${jobId}.done`), '');
    };
    write(`job_${now}_run`, { command: 'npm run dev' });
    write(
      `job_${now - 1}_ok`,
      { command: 'make', status: 'completed', exitCode: 0, finishedAt: new Date(now - 1000).toISOString() },
      true
    );
    write(
      `job_${now - 2}_fg`,
      {
        command: 'git status',
        foreground: true,
        status: 'completed',
        exitCode: 0,
        finishedAt: new Date(now).toISOString(),
      },
      true
    );
    write(
      `job_${now - 3}_old`,
      { command: 'old', status: 'completed', exitCode: 0, finishedAt: new Date(now - 3 * 3600_000).toISOString() },
      true
    );
    const ownerPid = process.pid + 300_000;
    const get = () => shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'sess-fin' });
    let status = get();
    for (let attempt = 0; attempt < 40 && status.count === 0; attempt += 1) {
      await delay(25);
      status = get();
    }
    assert.equal(status.count, 1);
    assert.equal(shellJobsStatus({ clientHostPid: ownerPid }).count, 1);
    assert.equal(status.finished.length, 1);
    assert.equal(status.finished[0].command, 'make');
    assert.equal(status.finished[0].status, 'completed');
    assert.equal(status.finished[0].exitCode, 0);
    assert.ok(status.finished[0].finishedAt);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session keeps its shell jobs while the polling owner pid alternates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-owners-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const jobId = `job_${Date.now()}_owners`;
    writeFileSync(
      join(dir, `${jobId}.json`),
      JSON.stringify({ pid: process.pid, command: 'npm run dev', ownerSessionId: 'sess-a', startedAt: Date.now() })
    );
    writeFileSync(join(dir, `${jobId}.owner-${process.pid}`), '');
    const ownerA = process.pid;
    const ownerB = process.pid + 100_000;
    const sessionCount = (pid) => shellJobsStatus({ clientHostPid: pid, sessionId: 'sess-a' }).count;

    // Warm both owners' caches.
    for (let attempt = 0; attempt < 40 && (sessionCount(ownerA) !== 1 || sessionCount(ownerB) !== 1); attempt += 1) {
      await delay(25);
    }
    for (let poll = 0; poll < 6; poll += 1) {
      assert.equal(sessionCount(poll % 2 ? ownerB : ownerA), 1, `poll ${poll}`);
      await delay(10);
    }
    // The owner-wide aggregate stays pid-scoped.
    assert.equal(shellJobsStatus({ clientHostPid: ownerA }).count, 1);
    assert.equal(shellJobsStatus({ clientHostPid: ownerB }).count, 0);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('shellJobsStatusFresh awaits a new scan so a just-finished shell is visible on the same call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-fresh-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const jobId = `job_${Date.now()}_fresh`;
    const ownerPid = process.pid + 400_000;
    const record = { pid: process.pid, command: 'npm run dev', ownerSessionId: 'sess-fresh', startedAt: Date.now() };
    writeFileSync(join(dir, `${jobId}.json`), JSON.stringify(record));
    writeFileSync(join(dir, `${jobId}.owner-${ownerPid}`), '');
    const running = await shellJobsStatusFresh({ clientHostPid: ownerPid });
    assert.equal(running.sessions['sess-fresh'].count, 1, 'the first call already sees the running shell');

    writeFileSync(
      join(dir, `${jobId}.json`),
      JSON.stringify({ ...record, status: 'completed', exitCode: 0, finishedAt: new Date().toISOString() })
    );
    writeFileSync(join(dir, `${jobId}.done`), '');
    rmSync(join(dir, `${jobId}.owner-${ownerPid}`));
    const settled = await shellJobsStatusFresh({ clientHostPid: ownerPid });
    assert.equal(settled.sessions['sess-fresh'].count, 0, 'no one-interval lag after the shell settles');
    assert.equal(settled.sessions['sess-fresh'].finished[0].status, 'completed');
    assert.deepEqual(await shellJobsStatusFresh({}), shellJobsStatus({}), 'no owner pid owns nothing');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// Runs last: the skewed clock leaves a future-dated cache entry behind.
test('finished shells do not blink out when an owner is polled again after its cache entry aged out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-evict-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const realNow = Date.now;
  let skewMs = 0;
  process.env.MIXDOG_DATA_DIR = root;
  Date.now = () => realNow() + skewMs;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const jobId = `job_${realNow()}_blink`;
    writeFileSync(
      join(dir, `${jobId}.json`),
      JSON.stringify({
        pid: process.pid,
        command: 'make',
        ownerSessionId: 'sess-blink',
        status: 'completed',
        exitCode: 0,
        finishedAt: new Date(realNow() - 1000).toISOString(),
      })
    );
    writeFileSync(join(dir, `${jobId}.done`), '');
    const ownerA = process.pid + 400_000;
    const ownerB = process.pid + 500_000;
    // The desktop poller asks for the owner aggregate and reads its session buckets.
    const finished = (pid) => shellJobsStatus({ clientHostPid: pid }).sessions?.['sess-blink']?.finished.length ?? 0;
    // Both owners' entries from the earlier tests stay fresh for up to a
    // second before a poll rescans this data dir: wait past that window.
    for (let attempt = 0; attempt < 100 && (finished(ownerA) !== 1 || finished(ownerB) !== 1); attempt += 1) {
      await delay(25);
    }
    assert.equal(finished(ownerA), 1);
    assert.equal(finished(ownerB), 1);

    // Past the owner cache retention only owner B keeps polling: its refresh
    // evicts owner A's entry. Owner A's next poll must still see the shell.
    skewMs = 61_000;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      finished(ownerB);
      await delay(25);
    }
    assert.equal(finished(ownerA), 1);
  } finally {
    Date.now = realNow;
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreground command whose termination is unconfirmed stays listed after its root exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-unconfirmed-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const jobId = `job_${Date.now()}_unconfirmed`;
    // The root pid is gone; a descendant may still be alive. The owner lives.
    writeFileSync(
      join(dir, `${jobId}.json`),
      JSON.stringify({
        pid: 2_147_483_646,
        ownerSessionId: 'sess-unconfirmed',
        command: 'node server.js',
        foreground: true,
        terminationUnconfirmed: true,
      })
    );
    writeFileSync(join(dir, `${jobId}.owner-${process.pid}`), '');
    const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
    assert.equal(status.count, 1);
    assert.deepEqual(
      status.sessions['sess-unconfirmed'].jobs.map((job) => [job.command, job.terminationUnconfirmed]),
      [['node server.js', true]]
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a closed session’s unconfirmed shells stay listed until their records retire or complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-orphan-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const write = (jobId, record, ownerPid = process.pid) => {
      writeFileSync(
        join(dir, `${jobId}.json`),
        JSON.stringify({
          ownerSessionId: 'sess-closed',
          foreground: true,
          terminationUnconfirmed: true,
          ownerSessionClosed: true,
          cwd: root,
          ...record,
        })
      );
      writeFileSync(join(dir, `${jobId}.owner-${ownerPid}`), '');
    };
    const orphan = `job_${Date.now()}_orphan`;
    const survivor = `job_${Date.now()}_survivor`;
    const deadOwner = `job_${Date.now()}_dead-owner`;
    // Missing or empty survivor lists cannot confirm a failed observation.
    // The owner host still owns the hold after its session has closed.
    write(orphan, { pid: 2_147_483_646, command: 'npm test' });
    write(survivor, { pid: 2_147_483_645, survivorPids: [process.pid], command: 'node server.js' });
    write(deadOwner, { pid: process.pid, command: 'stale hold' }, 2_147_483_644);
    let status = await shellJobsStatusFresh({ clientHostPid: process.pid });
    const heldIds = new Set([orphan, survivor]);
    assert.equal(status.count, 2);
    assert.deepEqual(
      new Set(status.orphaned.map((job) => job.taskId)),
      heldIds,
      'both unresolved holds are offered to other sessions, but a dead host owns no hold'
    );
    assert.deepEqual(new Set(status.sessions['sess-closed'].jobs.map((job) => job.taskId)), heldIds);
    assert.ok(status.orphaned.every((job) => job.terminationUnconfirmed === true));

    write(orphan, { pid: 2_147_483_646, survivorPids: [], command: 'npm test' });
    status = await shellJobsStatusFresh({ clientHostPid: process.pid });
    assert.deepEqual(
      new Set(status.orphaned.map((job) => job.taskId)),
      heldIds,
      'an empty observation does not retire the hold'
    );

    // Explicitly releasing a foreground hold retires its record.
    rmSync(join(dir, `${orphan}.json`));
    rmSync(join(dir, `${orphan}.owner-${process.pid}`));
    status = await shellJobsStatusFresh({ clientHostPid: process.pid });
    assert.equal(status.count, 1);
    assert.deepEqual(
      status.orphaned.map((job) => job.taskId),
      [survivor]
    );

    // Completion is authoritative even if the last record still names a pid.
    writeFileSync(join(dir, `${survivor}.done`), '');
    status = await shellJobsStatusFresh({ clientHostPid: process.pid });
    assert.equal(status.count, 0);
    assert.deepEqual(status.jobs, []);
    assert.deepEqual(status.orphaned || [], []);
    assert.equal(status.sessions['sess-closed'], undefined);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
