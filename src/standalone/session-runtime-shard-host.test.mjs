import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSessionRuntimeHost } from './session-runtime-host.mjs';
import { shardIndexForKey } from './session-runtime-shard-router.mjs';

const SHARDS = 2;

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch { /* retry until the deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function keyForShard(index, prefix, shards = SHARDS) {
  for (let n = 0; n < 2_000; n += 1) {
    const key = `${prefix}-${n}`;
    if (shardIndexForKey(key, shards) === index) return key;
  }
  throw new Error(`no ${prefix} key maps to shard ${index}`);
}

function dispatchIdForShard(index, shards = SHARDS) {
  for (let n = 0; n < 2_000; n += 1) {
    const id = `dispatch-${n}`;
    if (shardIndexForKey(`dispatch:${id}`, shards) === index) return id;
  }
  throw new Error(`no dispatch id maps to shard ${index}`);
}

// Stub shard child: answers the runtime protocol and exposes the shard-level
// signals (lag samples, unhealthy, provider cooldown) on demand.
const SHARD_STUB = `
const SHARD = Number(process.env.MIXDOG_SESSION_RUNTIME_SHARD || 0);
const revisions = new Map();
const syncs = [];
const cancels = [];
const agentJobs = [];
const agentNotifications = [];
let prewarms = 0;
function send(message) { if (process.connected) process.send(message); }
function respond(requestId, value) { if (requestId) send({ type: 'response', requestId, ok: true, value }); }
process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'provider-cooldown-sync') { syncs.push(message); return; }
  if (message.type === 'agent-control-notification') {
    agentNotifications.push(message);
    return;
  }
  const requestId = String(message.requestId || '');
  if (message.type === 'agent-control-status') {
    respond(requestId, {
      workers: agentJobs.map((job) => ({
        tag: job.tag,
        sessionId: job.sessionId,
        agent: 'worker',
        status: 'running',
        provider: 'test',
        model: 'test',
      })),
      jobs: agentJobs,
      scope: { sessionId: message.context?.callerSessionId || null },
    });
    return;
  }
  if (message.type === 'agent-control-local-cancel') {
    respond(requestId, { cancelled: true });
    return;
  }
  if (message.type === 'agent-control-local') {
    const args = message.args || {};
    const type = String(args.type || 'spawn');
    const ownerSessionId = String(message.context?.callerSessionId || '');
    if (type === 'spawn' || type === 'send') {
      const tag = String(args.tag || ('auto-' + SHARD + '-' + (agentJobs.length + 1)));
      const existing = agentJobs.find((job) => job.tag === tag);
      const sessionId = existing?.sessionId || ('sess_agent_' + SHARD + '_' + tag.replace(/[^A-Za-z0-9_-]/g, '_'));
      const task_id = 'task_agent_' + SHARD + '_' + (agentJobs.length + 1);
      const job = { task_id, type, status: 'running', tag, sessionId };
      agentJobs.push(job);
      respond(requestId, [
        'agent task: ' + task_id,
        'status: running',
        'type: ' + type,
        'target: ' + tag + ' ' + sessionId,
      ].join('\\n'));
      setImmediate(() => send({
        type: 'agent-control-notification',
        ownerSessionId,
        text: 'Async agent task ' + task_id + ' (completed) finished.\\n\\nresult from shard ' + SHARD,
        meta: {
          type: 'agent_task_result',
          execution_surface: 'agent',
          execution_id: task_id,
          status: 'completed',
        },
      }));
      return;
    }
    const found = agentJobs.find((job) => (
      (args.tag && job.tag === args.tag)
      || (args.task_id && job.task_id === args.task_id)
      || (args.sessionId && job.sessionId === args.sessionId)
    ));
    respond(requestId, found
      ? 'agent task: ' + found.task_id + '\\nstatus: ' + found.status + '\\ntarget: ' + found.tag + ' ' + found.sessionId
      : 'Error: agent target not found');
    return;
  }
  if (message.type === 'create') {
    if (message.options?.failCreate === true) {
      send({ type: 'response', requestId, ok: false, error: { message: 'create rejected by stub' } });
      return;
    }
    revisions.set(message.runtimeId, 1);
    send({ type: 'state', runtimeId: message.runtimeId, revision: 1, full: { sessionId: message.options?.sessionId || '' } });
    respond(requestId, { created: true });
    return;
  }
  if (message.type === 'snapshot') {
    const revision = (revisions.get(message.runtimeId) || 1) + 1;
    revisions.set(message.runtimeId, revision);
    send({ type: 'state', runtimeId: message.runtimeId, revision, full: { sessionId: 'shard-session' } });
    respond(requestId, { published: true });
    return;
  }
  if (message.type === 'workload') {
    respond(requestId, {
      shard: SHARD,
      runtimes: revisions.size,
      memory: { rssBytes: 1000 },
      childSpawns: {
        mode: SHARD === 0 ? 'remote-lease' : 'local',
        maxInflight: 4,
        lanes: [{ name: 'search', inflight: SHARD + 1, queued: SHARD, limit: 4, waitTimeoutMs: 30000 }],
      },
      toolIo: { readIo: { active: SHARD + 1, queued: 2, activeMax: 16, maxWaitMs: (SHARD + 1) * 10 } },
      resources: {
        active: { agent: SHARD + 1, shell: 1 },
        queued: SHARD,
        limits: { maxAgents: 8, maxShells: 8 },
        activeLeases: [{ kind: 'agent', label: 'shard-' + SHARD, ageMs: 5 }],
      },
    });
    return;
  }
  if (message.type === 'prewarm') { prewarms += 1; respond(requestId, { ready: true, shard: SHARD }); return; }
  if (message.type === 'agent-dispatch') {
    const reply = () => respond(requestId, { value: { pid: process.pid, shard: SHARD, dispatchId: message.dispatchId } });
    const delay = Number(message.delayMs) || 0;
    if (delay > 0) setTimeout(reply, delay); else reply();
    return;
  }
  if (message.type === 'agent-dispatch-cancel') {
    cancels.push(String(message.dispatchId || ''));
    respond(requestId, { cancelled: true });
    return;
  }
  if (message.type === 'call') {
    const args = Array.isArray(message.args) ? message.args : [];
    const command = args[0];
    if (command === 'lag') {
      const value = Number(args[1]) || 0;
      send({ type: 'event-loop-lag', shard: SHARD, sample: {
        p50Ms: value, p95Ms: value, p99Ms: value, maxMs: value, meanMs: value, intervalMs: 5000, at: Date.now(),
      } });
      respond(requestId, { pid: process.pid, shard: SHARD });
      return;
    }
    if (command === 'cooldown') {
      const ms = Number(args[1]) || 60000;
      send({ type: 'provider-cooldown', shard: SHARD, cooldown: {
        untilMs: Date.now() + ms, disabledReason: null, observedAt: Date.now(),
      } });
      respond(requestId, { pid: process.pid, shard: SHARD });
      return;
    }
    if (command === 'admission-cooldown') {
      // Event-driven admission cooldown: no fast-mode change at all.
      send({ type: 'provider-cooldown', shard: SHARD, cooldown: {
        untilMs: 0, disabledReason: null, observedAt: Date.now(),
      }, admission: { type: 'cooldown', key: 'anthropic-oauth:test', cooldownUntil: Date.now() + 30000 } });
      respond(requestId, { pid: process.pid, shard: SHARD });
      return;
    }
    if (command === 'syncs') { respond(requestId, { pid: process.pid, shard: SHARD, syncs, cancels, prewarms }); return; }
    if (command === 'agent-notifications') {
      respond(requestId, { pid: process.pid, shard: SHARD, agentNotifications });
      return;
    }
    if (command === 'unhealthy') {
      respond(requestId, { pid: process.pid, shard: SHARD });
      setImmediate(() => send({ type: 'unhealthy', detail: { reason: 'test shard unhealthy' } }));
      return;
    }
    if (command === 'slow') {
      setTimeout(() => respond(requestId, { pid: process.pid, shard: SHARD }), Number(args[1]) || 500);
      return;
    }
    if (message.method === 'resume') { respond(requestId, true); return; }
    respond(requestId, { pid: process.pid, shard: SHARD, method: message.method, args: message.args });
    return;
  }
  if (message.type === 'shutdown') { respond(requestId, { stopped: true }); setImmediate(() => process.exit(0)); return; }
  respond(requestId, { ready: true, shard: SHARD });
});
`;

async function withShardHost(run, { shardCount = SHARDS, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-runtime-shard-'));
  const workerEntry = join(dir, 'shard-stub.mjs');
  const logs = [];
  await writeFile(workerEntry, SHARD_STUB, 'utf8');
  const host = createSessionRuntimeHost({
    workerEntry,
    cwd: dir,
    env: { ...process.env, ...env },
    shardCount,
    log: (line) => logs.push(line),
  });
  try {
    await run({ host, logs });
  } finally {
    await host.close('test complete');
    await rm(dir, { recursive: true, force: true });
  }
}

test('independent sessions run on distinct shard processes', async () => {
  await withShardHost(async ({ host }) => {
    const first = await host.create({ sessionId: keyForShard(0, 'sess') });
    const second = await host.create({ sessionId: keyForShard(1, 'sess') });
    const a = await first.submitAsync('ping');
    const b = await second.submitAsync('ping');
    assert.equal(a.shard, 0);
    assert.equal(b.shard, 1);
    assert.notEqual(a.pid, b.pid);

    // Same session identity always resolves to the same shard/process.
    const sameSession = await host.create({ sessionId: keyForShard(0, 'sess') });
    assert.equal((await sameSession.submitAsync('ping')).pid, a.pid);

    const status = host.status;
    assert.equal(status.shardCount, SHARDS);
    assert.equal(status.shards.length, SHARDS);
    assert.equal(status.active, true);
    // Aggregate view stays compatible with single-worker status consumers.
    assert.equal(status.worker.runtimes, 3);
    assert.equal(status.worker.pids.length, 2);
    assert.ok(status.worker.pid);
  });
});

test('agent dispatch fans out across shards and cancel follows its shard', async () => {
  await withShardHost(async ({ host }) => {
    const firstId = dispatchIdForShard(0);
    const secondId = dispatchIdForShard(1);
    const first = await host.agentDispatch({ dispatchId: firstId, agent: 'memory' });
    const second = await host.agentDispatch({ dispatchId: secondId, agent: 'memory' });
    assert.equal(first.shard, 0);
    assert.equal(second.shard, 1);
    assert.notEqual(first.pid, second.pid);

    // An aborted dispatch cancels on the shard that owns it, not on shard 0.
    const controller = new AbortController();
    const cancelId = dispatchIdForShard(1);
    const pending = host.agentDispatch(
      { dispatchId: cancelId, agent: 'memory', delayMs: 400 },
      { signal: controller.signal },
    );
    controller.abort(new Error('test abort'));
    await pending.catch(() => {});
    const owner = await host.create({ sessionId: keyForShard(1, 'sess') });
    const observed = await waitFor(async () => {
      const row = await owner.submitAsync('syncs');
      return row.cancels.includes(cancelId) ? row : null;
    }, `shard 1 cancel for ${cancelId}`);
    assert.equal(observed.shard, 1);
  });
});

test('one Lead distributes persistent Agent tags across shards and receives their completions', async () => {
  await withShardHost(async ({ host }) => {
    const ownerSessionId = keyForShard(0, 'lead-agent-owner');
    const owner = await host.create({ sessionId: ownerSessionId });
    const tagFor = (index) => {
      for (let n = 0; n < 2_000; n += 1) {
        const tag = `fanout-${index}-${n}`;
        if (shardIndexForKey(`agent:${ownerSessionId}:${tag}`, SHARDS) === index) return tag;
      }
      throw new Error(`no agent tag maps to shard ${index}`);
    };
    const tag0 = tagFor(0);
    const tag1 = tagFor(1);

    const first = await host.agentControl(
      { type: 'spawn', tag: tag0, agent: 'worker', prompt: 'first' },
      { callerSessionId: ownerSessionId, callerCwd: process.cwd() },
    );
    const second = await host.agentControl(
      { type: 'spawn', tag: tag1, agent: 'worker', prompt: 'second' },
      { callerSessionId: ownerSessionId, callerCwd: process.cwd() },
    );
    assert.match(first, /sess_agent_0_/);
    assert.match(second, /sess_agent_1_/);

    // Same-tag follow-ups preserve the shard-local persistent session.
    const follow0 = await host.agentControl(
      { type: 'send', tag: tag0, message: 'follow zero' },
      { callerSessionId: ownerSessionId, callerCwd: process.cwd() },
    );
    const follow1 = await host.agentControl(
      { type: 'send', tag: tag1, message: 'follow one' },
      { callerSessionId: ownerSessionId, callerCwd: process.cwd() },
    );
    assert.match(follow0, /sess_agent_0_/);
    assert.match(follow1, /sess_agent_1_/);

    const notifications = await waitFor(async () => {
      const row = await owner.submitAsync('agent-notifications');
      return row.agentNotifications.length >= 4 ? row.agentNotifications : null;
    }, 'cross-shard Agent completion delivery');
    assert.equal(notifications.every((row) => row.ownerSessionId === ownerSessionId), true);
    assert.equal(notifications.some((row) => /shard 0/.test(row.text)), true);
    assert.equal(notifications.some((row) => /shard 1/.test(row.text)), true);

    const listed = await host.agentControl(
      { type: 'list' },
      { callerSessionId: ownerSessionId, callerCwd: process.cwd() },
    );
    assert.match(listed, /agents:\s*2/);
    assert.match(listed, /tasks:\s*4/);
  });
});

test('an unhealthy shard recycles alone while sibling shards keep serving', async () => {
  await withShardHost(async ({ host, logs }) => {
    const failing = await host.create({ sessionId: keyForShard(0, 'sess') });
    const healthy = await host.create({ sessionId: keyForShard(1, 'sess') });
    const failingPid = (await failing.submitAsync('ping')).pid;
    const healthyPid = (await healthy.submitAsync('ping')).pid;

    await failing.submitAsync('unhealthy');
    await waitFor(
      () => logs.some((line) => /shard 0 recycling.*unhealthy/.test(line))
        && logs.some((line) => /shard 0 recovered 1 runtime/.test(line)),
      'shard 0 recycle + recovery',
    );

    // The sibling shard is untouched: same process, still answering control.
    const stillHealthy = await healthy.submitAsync('ping');
    assert.equal(stillHealthy.pid, healthyPid);
    assert.equal(stillHealthy.shard, 1);

    // The failed shard is replaced in place: same shard index, new process.
    const recovered = await failing.submitAsync('ping');
    assert.equal(recovered.shard, 0);
    assert.notEqual(recovered.pid, failingPid);
    assert.equal(host.status.shards[1].pid, healthyPid);
  });
});

test('a lagging shard is quarantined from new placement without losing its work', async () => {
  await withShardHost(async ({ host, logs }) => {
    const lagging = await host.create({ sessionId: keyForShard(0, 'sess') });
    const sibling = await host.create({ sessionId: keyForShard(1, 'sess') });
    const laggingPid = (await lagging.submitAsync('ping')).pid;
    const siblingPid = (await sibling.submitAsync('ping')).pid;

    // One spike is not a quarantine; sustained saturation is.
    await lagging.submitAsync('lag', 3_000);
    await lagging.submitAsync('lag', 3_000);
    assert.equal(host.status.shards[0].degraded, false);
    await lagging.submitAsync('lag', 3_000);
    await waitFor(() => host.status.shards[0].degraded === true, 'shard 0 quarantine');
    assert.ok(logs.some((line) => /shard 0 event-loop saturated/.test(line)));

    // New work whose home is the saturated shard is placed on a healthy one…
    const placed = await host.create({ sessionId: keyForShard(0, 'sess-late') });
    const placedRow = await placed.submitAsync('ping');
    assert.equal(placedRow.shard, 1);
    assert.equal(placedRow.pid, siblingPid);

    // …while the saturated shard keeps its own accepted work in the SAME
    // process (never killed, never migrated).
    const stillOwned = await lagging.submitAsync('ping');
    assert.equal(stillOwned.pid, laggingPid);
    assert.equal(host.status.shards[0].lag.p99Ms, 3_000);

    await lagging.submitAsync('lag', 10);
    await waitFor(() => host.status.shards[0].degraded === false, 'shard 0 lag recovery');
  });
});

test('a provider cooldown discovered in one shard is replayed into the others', async () => {
  await withShardHost(async ({ host }) => {
    const first = await host.create({ sessionId: keyForShard(0, 'sess') });
    const second = await host.create({ sessionId: keyForShard(1, 'sess') });
    await second.submitAsync('ping');

    await first.submitAsync('cooldown', 120_000);
    const state = await waitFor(async () => {
      const row = await second.submitAsync('syncs');
      return row.syncs.length > 0 ? row : null;
    }, 'cooldown replay into shard 1');
    assert.ok(state.syncs[0].cooldown.untilMs > Date.now());
    assert.ok(host.status.providerCooldown.untilMs > Date.now());

    // The discovering shard is not echoed its own cooldown back.
    const origin = await first.submitAsync('syncs');
    assert.equal(origin.syncs.length, 0);
  });
});

test('workload telemetry aggregates every live shard', async () => {
  await withShardHost(async ({ host }) => {
    const first = await host.create({ sessionId: keyForShard(0, 'sess') });
    const second = await host.create({ sessionId: keyForShard(1, 'sess') });
    await first.submitAsync('ping');
    await second.submitAsync('ping');
    await host.refreshRuntimeWorkload();
    const workloads = host.workloads;
    assert.equal(workloads.shardCount, SHARDS);
    assert.equal(workloads.shards.length, SHARDS);
    assert.equal(workloads.worker.shards, SHARDS);
    assert.equal(workloads.worker.runtimes, 2);
    assert.equal(workloads.worker.memory.rssBytes, 2000);
    assert.ok(workloads.machineSpawnBudget);

    // Backward-compatible fields must describe the MACHINE, not shard 0:
    // live load sums across shards while configured caps stay caps.
    const worker = workloads.worker;
    assert.equal(worker.childSpawns.lanes.length, 1);
    assert.equal(worker.childSpawns.lanes[0].inflight, 3);
    assert.equal(worker.childSpawns.lanes[0].queued, 1);
    assert.equal(worker.childSpawns.lanes[0].limit, 4);
    assert.equal(worker.childSpawns.lanes[0].waitTimeoutMs, 30000);
    assert.equal(worker.childSpawns.maxInflight, 4);
    // One shard off the machine budget must be visible, not hidden by shard 0.
    assert.equal(worker.childSpawns.mode, 'mixed');
    assert.equal(worker.toolIo.readIo.active, 3);
    assert.equal(worker.toolIo.readIo.queued, 4);
    assert.equal(worker.toolIo.readIo.activeMax, 16);
    assert.equal(worker.toolIo.readIo.maxWaitMs, 20);
    assert.equal(worker.resources.active.agent, 3);
    assert.equal(worker.resources.active.shell, 2);
    assert.equal(worker.resources.queued, 1);
    assert.equal(worker.resources.limits.maxAgents, 8);
    assert.equal(worker.resources.activeLeases.length, 2);
  });
});

test('an admission cooldown event reaches sibling shards without waiting for a telemetry tick', async () => {
  await withShardHost(async ({ host }) => {
    const origin = await host.create({ sessionId: keyForShard(0, 'sess') });
    const sibling = await host.create({ sessionId: keyForShard(1, 'sess') });
    await sibling.submitAsync('ping');

    const startedAt = Date.now();
    await origin.submitAsync('admission-cooldown');
    // No fast-mode change at all: only the admission event carries the news,
    // and it must still be forwarded (and far faster than the 5s lag tick).
    const state = await waitFor(async () => {
      const row = await sibling.submitAsync('syncs');
      return row.syncs.length > 0 ? row : null;
    }, 'admission cooldown replay into shard 1', 2_000);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(state.syncs[0].admission.type, 'cooldown');
    assert.equal(state.syncs[0].admission.key, 'anthropic-oauth:test');
    assert.ok(state.syncs[0].admission.cooldownUntil > Date.now());
    // The origin shard is never handed its own event back.
    assert.equal((await origin.submitAsync('syncs')).syncs.length, 0);
  });
});

test('a failed create releases sticky shard ownership exactly once', async () => {
  await withShardHost(async ({ host }) => {
    const sessionId = keyForShard(0, 'sess-owner');
    const holder = await host.create({ sessionId });
    const homePid = (await holder.submitAsync('ping')).pid;
    assert.equal(host.status.shards[0].pid, homePid);

    // A rejected create must not decrement the claim the live view still holds.
    await assert.rejects(host.create({ sessionId, failCreate: true }), /create rejected/);

    // Quarantine the home shard: placement of NEW keys moves away, but this
    // session is already owned and must never be split across two shards.
    for (let sample = 0; sample < 3; sample += 1) await holder.submitAsync('lag', 3_000);
    await waitFor(() => host.status.shards[0].degraded === true, 'shard 0 quarantine');

    const rejoined = await host.create({ sessionId });
    assert.equal((await rejoined.submitAsync('ping')).pid, homePid);
    assert.equal(host.status.shards[1].pid, null);

    // Both live views release the single claim; the next claim may re-place.
    await holder.dispose('test');
    await rejoined.dispose('test');
    const relocated = await host.create({ sessionId });
    assert.equal((await relocated.submitAsync('ping')).shard, 1);
  });
});

test('an explicit shard count is clamped to the hard maximum', async () => {
  await withShardHost(async ({ host }) => {
    assert.equal(host.status.shardCount, 16);
    assert.equal(host.status.shards.length, 16);
    // Shards stay lazy: clamping must not fork 16 children either.
    assert.equal(host.status.shards.every((shard) => shard.pid === null), true);
    assert.equal(host.status.active, false);
  }, { shardCount: 999 });
});

test('prewarm warms shard 0 once and every later shard on spawn', async () => {
  await withShardHost(async ({ host }) => {
    const ready = await host.prewarm();
    assert.equal(ready.shard, 0);
    const first = await host.create({ sessionId: keyForShard(0, 'sess') });
    // The spawn path and the explicit prewarm share one pass, never two.
    assert.equal((await first.submitAsync('syncs')).prewarms, 1);

    // A shard that forks later warms itself, so a fan-out burst never starts
    // on a cold shard.
    const second = await host.create({ sessionId: keyForShard(1, 'sess') });
    const row = await waitFor(async () => {
      const value = await second.submitAsync('syncs');
      return value.prewarms > 0 ? value : null;
    }, 'lazily spawned shard prewarm');
    assert.equal(row.shard, 1);
    assert.equal(row.prewarms, 1);
  });
});

test('a single-shard host keeps the historical single-worker behaviour', async () => {
  await withShardHost(async ({ host }) => {
    const runtime = await host.create({ sessionId: 'solo-session' });
    const row = await runtime.submitAsync('ping');
    assert.equal(row.shard, 0);
    assert.equal(host.status.shardCount, 1);
    assert.equal(host.status.worker.pid, row.pid);
    assert.equal(host.status.shards.length, 1);
  }, { shardCount: 1 });
});
