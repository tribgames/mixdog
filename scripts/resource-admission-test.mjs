import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  RESOURCE_ADMISSION_DEFAULTS,
  ResourceAdmissionController,
} from '../src/runtime/shared/resource-admission.mjs';
import { execShellCommand } from '../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import { executeBashTool } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import {
  attachShellJobResourceLease,
  killShellJob,
  startBackgroundShellJob,
  waitForShellJob,
} from '../src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs';
import { trackProcessTreeQuiescence } from '../src/runtime/agent/orchestrator/tools/builtin/shell-job-process.mjs';
import { makeAgentDispatch } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';

const healthy = () => ({
  rssBytes: 100 * 1024 * 1024,
  freeMemoryBytes: 8 * 1024 * 1024 * 1024,
});

function fakeChild({ pid = 424242, event = 'spawn', killMode = 'exit' } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (killMode === 'error-exit') {
      queueMicrotask(() => child.emit('error', new Error('kill-time child error')));
    }
    if (killMode === 'none') return;
    queueMicrotask(() => {
      child.signalCode = 'SIGKILL';
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
    });
  };
  queueMicrotask(() => {
    if (event === 'error') child.emit('error', Object.assign(new Error('async spawn denied'), { code: 'EACCES' }));
    else child.emit('spawn');
  });
  return child;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition not met within ${timeoutMs}ms`);
    await delay(25);
  }
}

test('safe defaults bound agents, shells, combined work, queue, and memory', () => {
  assert.deepEqual(RESOURCE_ADMISSION_DEFAULTS, {
    maxAgents: 4,
    maxShells: 4,
    maxHighLoad: 6,
    maxQueue: 32,
    minFreeMemoryMb: 1024,
    maxRssMb: 3072,
  });
});

test('combined and per-kind limits queue without revoking in-flight work', async () => {
  let now = 10;
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 2, maxShells: 2, maxHighLoad: 2, maxQueue: 3 },
    metrics: healthy,
    now: () => now,
  });
  const agent = await admission.acquire('agent');
  const shell = await admission.acquire('shell');
  let thirdStarted = false;
  const third = admission.acquire('agent').then((lease) => {
    thirdStarted = true;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdStarted, false);
  assert.deepEqual(admission.snapshot().active, { agent: 1, shell: 1 });
  now = 25;
  shell.release();
  const queuedLease = await third;
  assert.equal(queuedLease.queuedMs, 15);
  assert.deepEqual(admission.snapshot().active, { agent: 2, shell: 0 });
  agent.release();
  queuedLease.release();
});

test('saturated parent agents yield their permits while awaited nested work progresses', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 2, maxShells: 2, maxHighLoad: 2, maxQueue: 4 },
    metrics: healthy,
  });
  const parents = await Promise.all([
    admission.acquire('agent'),
    admission.acquire('agent'),
  ]);
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let nestedStarted = 0;
  const nested = parents.map((parent, index) => admission.runWithLease(parent, async () => {
    const child = await admission.acquire('agent');
    nestedStarted += 1;
    await gates[index].promise;
    await child.release();
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nestedStarted, 2);
  assert.deepEqual(admission.snapshot().active, { agent: 2, shell: 0 });
  gates.forEach((gate) => gate.resolve());
  await Promise.all(nested);
  assert.deepEqual(admission.snapshot().active, { agent: 2, shell: 0 });
  parents.forEach((lease) => lease.release());
});

test('yielded parent waits for bounded re-admission after a sibling steals its slot', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 2, maxHighLoad: 2, maxQueue: 4 },
    metrics: healthy,
  });
  const parent = await admission.acquire('agent');
  const blocker = await admission.acquire('agent');
  let parentContinued = false;
  const childReady = Promise.withResolvers();
  const releaseChild = Promise.withResolvers();
  const dependency = admission.runWithLease(parent, async () => {
    const child = await admission.acquire('agent');
    childReady.resolve();
    await releaseChild.promise;
    await child.release();
  }).then(() => { parentContinued = true; });
  await childReady.promise;
  const sibling = admission.acquire('agent');
  releaseChild.resolve();
  const siblingLease = await sibling;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parentContinued, false);
  await siblingLease.release();
  await dependency;
  assert.equal(parentContinued, true);
  assert.ok(admission.snapshot().active.agent <= 2);
  await blocker.release();
  await parent.release();
});

test('cancellation rejects a queued parent restoration without over-counting', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 2, maxHighLoad: 2, maxQueue: 4 },
    metrics: healthy,
  });
  const controller = new AbortController();
  const parent = await admission.acquire('agent', { signal: controller.signal });
  const blocker = await admission.acquire('agent');
  const childReady = Promise.withResolvers();
  const releaseChild = Promise.withResolvers();
  const outcome = admission.runWithLease(parent, async () => {
    const child = await admission.acquire('agent');
    childReady.resolve();
    await releaseChild.promise;
    await child.release();
  });
  await childReady.promise;
  const sibling = admission.acquire('agent');
  releaseChild.resolve();
  const siblingLease = await sibling;
  controller.abort(new Error('parent restoration cancelled'));
  await assert.rejects(outcome, /parent restoration cancelled/);
  await siblingLease.release();
  await blocker.release();
  await parent.release();
  assert.ok(admission.snapshot().active.agent <= 2);
});

test('detached nested lifetime keeps parent admitted or refuses without capacity', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 2, maxShells: 1, maxHighLoad: 2 },
    metrics: healthy,
  });
  const parent = await admission.acquire('agent');
  await admission.runWithLease(parent, async () => {
    const detached = await admission.acquire('shell', { dependency: 'detached' });
    assert.deepEqual(admission.snapshot().active, { agent: 1, shell: 1 });
    await detached.release();
  });
  const blocker = await admission.acquire('agent');
  await admission.runWithLease(parent, async () => {
    await assert.rejects(
      admission.acquire('shell', { dependency: 'detached' }),
      (error) => error?.code === 'ERESOURCEDEPENDENCY',
    );
    assert.equal(parent.counted, true);
  });
  await blocker.release();
  await parent.release();
});

test('memory pressure rejects only new and queued work with actionable errors', async () => {
  let sample = healthy();
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 1, maxHighLoad: 1, maxQueue: 2, minFreeMemoryMb: 1024, maxRssMb: 512 },
    metrics: () => sample,
  });
  const running = await admission.acquire('agent');
  const queued = admission.acquire('agent');
  sample = { rssBytes: 600 * 1024 * 1024, freeMemoryBytes: 8 * 1024 * 1024 * 1024 };
  running.release();
  await assert.rejects(queued, (error) => (
    error?.code === 'ERESOURCEPRESSURE' && /RSS 600 MB reached 512 MB limit/.test(error.message)
  ));
  assert.deepEqual(admission.snapshot().active, { agent: 0, shell: 0 });
  await assert.rejects(admission.acquire('shell'), /resource pressure: Mixdog RSS/);
});

test('queued cancellation removes work without affecting the running lease', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 1, maxHighLoad: 1, maxQueue: 2 },
    metrics: healthy,
  });
  const running = await admission.acquire('agent');
  const controller = new AbortController();
  const queued = admission.acquire('agent', { signal: controller.signal });
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(queued, /caller cancelled/);
  assert.equal(admission.snapshot().active.agent, 1);
  assert.equal(admission.snapshot().queued, 0);
  running.release();
});

test('shell refusal is a normal tool result and starts no child process', async () => {
  let acquireCalls = 0;
  const refusal = Object.assign(new Error('resource pressure: test limit reached'), {
    code: 'ERESOURCEPRESSURE',
  });
  const result = await execShellCommand({
    shell: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: process.platform === 'win32' ? '/c' : '-c',
    command: 'echo must-not-run',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 1000,
    admission: {
      acquire() {
        acquireCalls += 1;
        return Promise.reject(refusal);
      },
    },
  });
  assert.equal(acquireCalls, 1);
  assert.equal(result.failureReason, 'resource pressure');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /resource pressure: test limit reached/);
});

test('real shell lifetime holds and releases one lease', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxShells: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const isWindows = process.platform === 'win32';
  const result = await execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: 'echo admitted',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    admission,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(admission.snapshot().active, { agent: 0, shell: 0 });
});

test('process-tree quiescence tracker retains ownership and confirms exactly once', async () => {
  let alive = true;
  let confirmed = 0;
  const tracker = trackProcessTreeQuiescence(123, () => { confirmed += 1; }, {
    pollMs: 5,
    probe: () => alive,
  });
  assert.equal(tracker.pending, true);
  await delay(15);
  assert.equal(confirmed, 0);
  alive = false;
  await waitUntil(() => confirmed === 1);
  await delay(15);
  assert.equal(confirmed, 1);
  assert.equal(tracker.pending, false);
});

test('Windows tree tracking seeds ownership before an absent root snapshot', async () => {
  let rows = [
    { pid: 124, parentPid: 123, identity: 'child-a' },
    { pid: 125, parentPid: 124, identity: 'grandchild-a' },
  ];
  let confirmed = 0;
  const tracker = trackProcessTreeQuiescence(123, () => { confirmed += 1; }, {
    platform: 'win32',
    pollMs: 5,
    waitForRootExit: true,
    windowsSnapshot: () => rows,
  });
  tracker.rootExited();
  await delay(20);
  assert.equal(confirmed, 0);
  rows = [];
  await waitUntil(() => confirmed === 1);
  await delay(15);
  assert.equal(confirmed, 1);
});

test('delayed asynchronous Windows snapshots keep timers moving and coalesce trackers onto one CIM request', async () => {
  let cimRequests = 0;
  let timerProgressed = false;
  const spawnFn = (_file, args) => {
    cimRequests += 1;
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', '123\t1\troot-a\n');
      child.emit('close', 0);
    }, 40);
    return child;
  };
  const first = trackProcessTreeQuiescence(123, () => assert.fail('root is present'), {
    platform: 'win32',
    pollMs: 5,
    windowsSnapshotSpawn: spawnFn,
    waitForRootExit: true,
  });
  const second = trackProcessTreeQuiescence(123, () => assert.fail('root is present'), {
    platform: 'win32',
    pollMs: 5,
    windowsSnapshotSpawn: spawnFn,
    waitForRootExit: true,
  });
  first.rootExited();
  second.rootExited();
  setTimeout(() => { timerProgressed = true; }, 5);
  await delay(20);
  assert.equal(timerProgressed, true);
  assert.equal(cimRequests, 1);
  await delay(40);
  assert.equal(cimRequests, 1);
  assert.equal(first.cancel(), true);
  assert.equal(second.cancel(), true);
});

test('quiescence cleanup rejection is consumed after one callback', async () => {
  let callbacks = 0;
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    trackProcessTreeQuiescence(123, async () => {
      callbacks += 1;
      throw new Error('fixture cleanup rejection');
    }, { probe: () => false });
    await delay(20);
    assert.equal(callbacks, 1);
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('rejected foreground lease cleanup still returns one shell result', async () => {
  let releases = 0;
  const isWindows = process.platform === 'win32';
  const result = await execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: 'echo cleanup-result',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    admission: {
      async acquire() {
        return {
          release() {
            releases += 1;
            return Promise.reject(new Error('fixture release rejection'));
          },
        };
      },
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(releases, 1);
});

test('spawn failure contains rejected lease cleanup and returns one result', async () => {
  let releases = 0;
  const result = await execShellCommand({
    shell: `mixdog-missing-shell-${process.pid}`,
    shellArg: '-c',
    command: 'echo unreachable',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 1000,
    admission: {
      async acquire() {
        return {
          release() {
            releases += 1;
            return Promise.reject(new Error('spawn cleanup rejected'));
          },
        };
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.failureReason, 'spawn failed');
  assert.match(result.stderr, /resource cleanup failed: spawn cleanup rejected/);
  assert.equal(releases, 1);
});

for (const trigger of ['threshold', 'timeout']) {
  test(`background ${trigger} promotion contains detach rejection and returns once`, async () => {
    let releases = 0;
    let detachCalls = 0;
    const isWindows = process.platform === 'win32';
    const result = await execShellCommand({
      shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
      shellArg: isWindows ? '/c' : '-c',
      command: isWindows ? 'ping 127.0.0.1 -n 4 > nul' : 'sleep 2',
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: trigger === 'timeout' ? 20 : 5000,
      autoBackgroundMs: trigger === 'threshold' ? 20 : undefined,
      backgroundOnTimeout: trigger === 'timeout',
      admission: {
        async acquire() {
          return {
            release() { releases += 1; },
            detachDependency() {
              detachCalls += 1;
              return Promise.reject(new Error('detach restoration rejected'));
            },
          };
        },
      },
    });
    assert.equal(result.backgrounded, false);
    assert.equal(result.failureReason, 'resource cleanup failed');
    assert.match(result.stderr, /detach restoration rejected/);
    assert.equal(detachCalls, 1);
    await waitUntil(() => releases === 1);
  });
}

test('abort during adoption detaches once, resolves once, and releases once', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let abortedReads = 0;
  Object.defineProperty(signal, 'aborted', {
    configurable: true,
    get() {
      abortedReads += 1;
      if (abortedReads === 2) controller.abort(new Error('cancelled during adoption'));
      return abortedReads >= 2;
    },
  });
  let detachCalls = 0;
  let releases = 0;
  let results = 0;
  const isWindows = process.platform === 'win32';
  const pending = execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'ping 127.0.0.1 -n 4 > nul' : 'sleep 2',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    autoBackgroundMs: 20,
    abortSignal: signal,
    admission: {
      async acquire() {
        return {
          detachDependency() { detachCalls += 1; },
          release() { releases += 1; },
        };
      },
    },
  }).then((result) => {
    results += 1;
    return result;
  });
  const result = await pending;
  assert.equal(result.backgrounded, false);
  assert.equal(result.killed, true);
  assert.equal(result.killCause, 'cancellation');
  assert.equal(results, 1);
  assert.equal(detachCalls, 1);
  await waitUntil(() => releases === 1);
  await delay(30);
  assert.equal(results, 1);
  assert.equal(detachCalls, 1);
  assert.equal(releases, 1);
});

test('foreground shell lease follows a surviving POSIX process group', {
  skip: process.platform === 'win32' ? 'Node cannot prove Windows descendant quiescence after root exit' : false,
}, async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxShells: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const result = await execShellCommand({
    shell: '/bin/sh',
    shellArg: '-c',
    command: 'sleep 1 &',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    admission,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(admission.snapshot().active.shell, 1);
  await waitUntil(() => admission.snapshot().active.shell === 0, 3000);
});

test('background completion marker does not release before POSIX group quiescence', {
  skip: process.platform === 'win32' ? 'Node cannot prove Windows descendant quiescence after root exit' : false,
}, async () => {
  const job = await startBackgroundShellJob({
    command: 'sleep 1 &',
    timeoutMs: 5000,
    workDir: process.cwd(),
    mergeStderr: false,
    spawnEnv: process.env,
    shell: '/bin/sh',
    shellArg: '-c',
    shellType: 'posix',
  });
  let releases = 0;
  assert.equal(attachShellJobResourceLease(job.jobId, { release() { releases += 1; } }), true);
  const completed = await waitForShellJob(job.jobId, { timeoutMs: 2000, pollMs: 20 });
  assert.equal(completed.status, 'completed');
  assert.equal(releases, 0);
  await waitUntil(() => releases === 1, 3000);
  await delay(50);
  assert.equal(releases, 1);
});

test('promotion detaches caller abort listener and holds lease until child close', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxShells: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const controller = new AbortController();
  let listeners = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { listeners += 1; return add(...args); };
  signal.removeEventListener = (...args) => { listeners -= 1; return remove(...args); };
  const isWindows = process.platform === 'win32';
  const result = await execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'ping 127.0.0.1 -n 4 > nul' : 'sleep 2',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    autoBackgroundMs: 25,
    abortSignal: signal,
    admission,
  });
  assert.equal(result.backgrounded, true);
  assert.equal(listeners, 0);
  assert.equal(admission.snapshot().active.shell, 1);
  killShellJob(result.jobId);
  await waitUntil(() => admission.snapshot().active.shell === 0, 3000);
});

test('explicit async shell is admitted for its background lifetime', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxShells: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const isWindows = process.platform === 'win32';
  const output = await executeBashTool({
    command: isWindows ? 'ping 127.0.0.1 -n 4 > nul' : 'sleep 2',
    mode: 'async',
    shell: isWindows ? 'powershell' : 'bash',
  }, process.cwd(), { resourceAdmission: admission });
  const jobId = /task_id:\s*(\S+)/i.exec(String(output))?.[1];
  assert.ok(jobId, String(output));
  assert.equal(admission.snapshot().active.shell, 1);
  killShellJob(jobId);
  await waitUntil(() => admission.snapshot().active.shell === 0);
});

for (const shellType of ['posix', 'powershell']) {
  test(`${shellType} background spawn handles asynchronous child errors`, async () => {
    const child = fakeChild({ event: 'error' });
    const result = await startBackgroundShellJob({
      command: 'echo unreachable',
      timeoutMs: 1000,
      workDir: process.cwd(),
      mergeStderr: false,
      spawnEnv: process.env,
      shell: shellType === 'powershell' ? 'pwsh' : '/bin/sh',
      shellArg: '-c',
      shellType,
      spawnFn: () => child,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /async spawn denied/);
    assert.equal(child.listenerCount('error'), 0);
  });
}

for (const shellType of ['posix', 'powershell']) {
  test(`${shellType} post-readiness process error retains admission until confirmed exit`, async () => {
    const child = fakeChild({ killMode: 'none' });
    const result = await startBackgroundShellJob({
      command: 'echo runtime-error',
      timeoutMs: 1000,
      workDir: process.cwd(),
      mergeStderr: false,
      spawnEnv: process.env,
      shell: shellType === 'powershell' ? 'pwsh' : '/bin/sh',
      shellArg: '-c',
      shellType,
      spawnFn: () => child,
      rollbackTimeoutMs: 100,
    });
    let releases = 0;
    assert.equal(attachShellJobResourceLease(result.jobId, { release() { releases += 1; } }), true);
    child.emit('error', new Error('runtime pipe failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 0);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await waitUntil(() => releases === 1);
  });
}

for (const shellType of ['posix', 'powershell']) {
  test(`${shellType} persistence failure kills and awaits the spawned child`, async () => {
    const child = fakeChild();
    const result = await startBackgroundShellJob({
      command: 'echo rollback',
      timeoutMs: 1000,
      workDir: process.cwd(),
      mergeStderr: false,
      spawnEnv: process.env,
      shell: shellType === 'powershell' ? 'pwsh' : '/bin/sh',
      shellArg: '-c',
      shellType,
      spawnFn: () => child,
      writeDetailFn: () => { throw new Error('detail disk full'); },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /failed to persist/);
    assert.ok(child.killCalls >= 1);
    assert.ok(child.signalCode || child.exitCode != null);
  });
}

test('rollback consumes kill-time child errors', async () => {
  const child = fakeChild({ killMode: 'error-exit' });
  const result = await startBackgroundShellJob({
    command: 'echo rollback-error',
    timeoutMs: 1000,
    workDir: process.cwd(),
    mergeStderr: false,
    spawnEnv: process.env,
    shell: '/bin/sh',
    shellArg: '-c',
    shellType: 'posix',
    spawnFn: () => child,
    writeDetailFn: () => { throw new Error('persist failed'); },
  });
  assert.match(result.error, /failed to persist/);
  assert.equal(result.rollbackPending, undefined);
});

test('rollback timeout returns a tracked diagnosable failure within its bound', async () => {
  const child = fakeChild({ killMode: 'none' });
  const started = Date.now();
  const result = await startBackgroundShellJob({
    command: 'echo rollback-timeout',
    timeoutMs: 1000,
    workDir: process.cwd(),
    mergeStderr: false,
    spawnEnv: process.env,
    shell: '/bin/sh',
    shellArg: '-c',
    shellType: 'posix',
    spawnFn: () => child,
    writeDetailFn: () => { throw new Error('persist failed'); },
    rollbackTimeoutMs: 20,
  });
  assert.equal(result.rollbackPending, true);
  assert.match(result.error, /termination unconfirmed after 20ms .*remains tracked/);
  assert.ok(Date.now() - started < 1000);
  let releases = 0;
  assert.equal(attachShellJobResourceLease(
    result.jobId,
    { release() { releases += 1; } },
    { allowUnpersisted: true },
  ), true);
  child.signalCode = 'SIGKILL';
  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  await waitUntil(() => releases === 1);
});

test('explicit async cancellation after admission prevents spawn and releases once', async () => {
  const controller = new AbortController();
  let releases = 0;
  let spawns = 0;
  const output = await executeBashTool({
    command: 'echo must-not-spawn',
    mode: 'async',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
  }, process.cwd(), {
    abortSignal: controller.signal,
    resourceAdmission: {
      async acquire() {
        controller.abort(new Error('cancelled after admission'));
        return { release() { releases += 1; } };
      },
    },
    shellJobRuntime: {
      spawnFn() {
        spawns += 1;
        return fakeChild();
      },
    },
  });
  assert.match(String(output), /cancelled after admission/);
  assert.equal(spawns, 0);
  assert.equal(releases, 1);
});

test('persistent shell holds one lease across commands and releases on close', {
  skip: process.platform === 'win32' ? 'persistent shells are disabled on Windows' : false,
}, async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxShells: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const sessionId = `resource-test-${process.pid}`;
  const first = await executeBashTool({
    command: 'printf persistent',
    persistent: true,
    session_id: sessionId,
    create: true,
  }, process.cwd(), { resourceAdmission: admission });
  assert.match(String(first), /persistent/);
  assert.equal(admission.snapshot().active.shell, 1);
  await executeBashTool({ command: '', session_id: sessionId, close: true }, process.cwd(), {
    resourceAdmission: admission,
  });
  assert.equal(admission.snapshot().active.shell, 0);
});

test('hidden agent admission combines factory and call cancellation sources', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 1, maxHighLoad: 1 },
    metrics: healthy,
  });
  const occupied = await admission.acquire('agent');
  const factory = new AbortController();
  const call = new AbortController();
  const dispatch = makeAgentDispatch({
    agent: 'explorer',
    config: {},
    parentSignal: factory.signal,
    resourceAdmission: admission,
  });
  const pending = dispatch({ prompt: 'locate', parentSignal: call.signal });
  factory.abort(new Error('factory parent cancelled'));
  await assert.rejects(pending, /factory parent cancelled/);
  assert.equal(admission.snapshot().queued, 0);
  occupied.release();
});
