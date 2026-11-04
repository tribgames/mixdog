// A busy-scenario run that fails after its setup (here: the probe window
// cannot start) must not leave anything running: no sampler interval, no
// workload timers, no daemon process, no lock file, no temp root.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runBusyScenario } from './daemon-busy-scenario.mjs';
import { createFixtureRepo, seedBusyStore } from './daemon-busy-seed.mjs';
import { NO_DEADLINE_MS, launchObservedDaemon } from './daemon-steady-harness.mjs';

const TREE = fileURLToPath(new URL('../../../', import.meta.url));
const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

test('a failed window start leaves no interval, daemon, lock or temp root behind', async () => {
  const baseline = timeouts();
  let seeded;
  let repoDir;
  const daemon = await launchObservedDaemon({
    prepare: async ({ root, dataDir }) => {
      repoDir = createFixtureRepo(join(root, 'repo'));
      seeded = await seedBusyStore({
        treeRoot: TREE,
        dataDir,
        cwd: root,
        busyCwd: repoDir,
        busy: 1,
        files: 2,
        seed: 1,
        sizeScale: 0.02,
      });
    },
  });
  const { root, dataDir } = daemon;
  const pid = Number(daemon.discovery.pid);
  daemon.window.start = () => Promise.reject(new Error('probe start disconnected'));
  const config = {
    seed: 1,
    durationMs: 5000,
    saveIntervalMs: 100,
    listIntervalMs: 100,
    workspaceIntervalMs: 100,
    createIntervalMs: 100,
    worktreeIntervalMs: 0,
    turnIntervalMs: 0,
    agentIntervalMs: 100,
    lockHoldMs: 100,
    lockEveryMs: 200,
    listRefresh: false,
  };
  await assert.rejects(
    runBusyScenario({ daemon, treeRoot: TREE, seeded, repoDir, config, summarize: () => ({}) }),
    /probe start disconnected/
  );
  assert.equal(existsSync(join(dataDir, 'session-summaries.json.lock')), false);
  await daemon.dispose();
  assert.equal(alive(pid), false, 'the daemon process is gone');
  assert.equal(existsSync(root), false, 'the temp root is removed');
  assert.equal(timeouts(), baseline, 'no timer or interval is left');
});

test('a probe that stays connected but never answers stop cannot hold the cleanup', async () => {
  const baseline = timeouts();
  let seeded;
  let repoDir;
  const daemon = await launchObservedDaemon({
    prepare: async ({ root, dataDir }) => {
      repoDir = createFixtureRepo(join(root, 'repo'));
      seeded = await seedBusyStore({
        treeRoot: TREE,
        dataDir,
        cwd: root,
        busyCwd: repoDir,
        busy: 1,
        files: 2,
        seed: 1,
        sizeScale: 0.02,
      });
    },
  });
  const { root } = daemon;
  // The window starts, then a later attachment fails; the probe never answers `stop`.
  const attach = daemon.attach.bind(daemon);
  let attached = 0;
  daemon.attach = (...args) => (++attached > 1 ? Promise.reject(new Error('attachment failed')) : attach(...args));
  daemon.window.stop = () => new Promise(() => {});
  const realClose = daemon.window.close;
  let probeClosed = false;
  daemon.window.close = () => {
    probeClosed = true;
    realClose();
  };
  const config = {
    seed: 1,
    durationMs: 5000,
    saveIntervalMs: 100,
    listIntervalMs: 100,
    workspaceIntervalMs: 100,
    createIntervalMs: 100,
    worktreeIntervalMs: 0,
    turnIntervalMs: 0,
    agentIntervalMs: 100,
    lockHoldMs: 100,
    lockEveryMs: 200,
    listRefresh: false,
  };
  const guard = new AbortController();
  let failure = null;
  const outcome = await Promise.race([
    // `cleanupProbeDeadlineMs` is the test-only override of the 150 s bound.
    runBusyScenario({ daemon, treeRoot: TREE, seeded, repoDir, config, summarize: () => ({}), cleanupProbeDeadlineMs: 500 }).then(
      () => 'resolved',
      (error) => {
        failure = error;
        return error.message;
      }
    ),
    delay(20_000, 'cleanup still pending after 20 s', { signal: guard.signal }),
  ]);
  guard.abort();
  try {
    assert.equal(outcome, 'attachment failed');
    assert.equal(probeClosed, true, 'the unresponsive probe connection is closed');
    assert.equal(failure.cleanupProbeUnanswered, true, 'the unanswered cleanup is reported');
    assert.ok(failure.cleanupProbeWaitedMs >= 400, `waited ${failure.cleanupProbeWaitedMs} ms`);
  } finally {
    await daemon.dispose();
  }
  assert.equal(existsSync(root), false, 'the temp root is removed');
  assert.equal(timeouts(), baseline, 'no timer or interval is left');
});

// A stalled daemon answers `stop` late; that is a result, never an error. 12 s
// is past the 10 s deadline the measured path once had.
test('a stop answered late on the measured path succeeds and reports its round trip', async () => {
  let seeded;
  let repoDir;
  const daemon = await launchObservedDaemon({
    prepare: async ({ root, dataDir }) => {
      repoDir = createFixtureRepo(join(root, 'repo'));
      seeded = await seedBusyStore({
        treeRoot: TREE,
        dataDir,
        cwd: root,
        busyCwd: repoDir,
        busy: 1,
        files: 2,
        seed: 1,
        sizeScale: 0.02,
      });
    },
  });
  try {
    const realStop = daemon.window.stop.bind(daemon.window);
    const LATE_MS = 12_000;
    daemon.window.stop = async () => {
      await delay(LATE_MS);
      return realStop();
    };
    const config = {
      seed: 1,
      durationMs: 1500,
      saveIntervalMs: 200,
      listIntervalMs: 200,
      workspaceIntervalMs: 500,
      createIntervalMs: 500,
      worktreeIntervalMs: 0,
      turnIntervalMs: 0,
      agentIntervalMs: 500,
      lockHoldMs: 100,
      lockEveryMs: 500,
      listRefresh: false,
    };
    const run = await runBusyScenario({ daemon, treeRoot: TREE, seeded, repoDir, config, summarize: (report) => report });
    assert.ok(run.probeStopMs >= LATE_MS, `probeStopMs ${run.probeStopMs} records the late answer`);
    assert.equal(typeof run.probeStartMs, 'number');
    assert.ok(run.eventLoop.delayMs, 'the window report arrived');
    assert.equal(run.cleanupProbeUnanswered, undefined);
  } finally {
    await daemon.dispose();
  }
});

test('openSessions creates sessions without the client default deadline', async () => {
  const daemon = await launchObservedDaemon();
  const timeouts = [];
  const realRequest = http.request;
  http.request = function spy(options, ...rest) {
    if (options?.path === '/call') timeouts.push(options.timeout);
    return realRequest.call(this, options, ...rest);
  };
  try {
    await daemon.openSessions(1);
  } finally {
    http.request = realRequest;
    await daemon.dispose();
  }
  assert.ok(timeouts.length > 0, 'a /call request was made');
  assert.ok(
    timeouts.every((timeout) => timeout === NO_DEADLINE_MS),
    `every session.create call has no deadline (saw ${timeouts})`
  );
});

test('the probe connection failing rejects what waits on it', async () => {
  const daemon = await launchObservedDaemon();
  try {
    daemon.window.close();
    await assert.rejects(daemon.window.start(), /probe disconnected/);
  } finally {
    await daemon.dispose();
  }
});
