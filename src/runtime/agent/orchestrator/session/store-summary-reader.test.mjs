import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { flushAllIndexWritesSync } from '../../../../session-runtime/services/agent-tool/index-write-queue.mjs';
import { createLeadWorkerIndex } from '../../../../session-runtime/services/agent-tool/lead-worker-index.mjs';
import { createTagRegistry } from '../../../../session-runtime/services/agent-tool/tag-registry.mjs';
import { listStoredAgentWorkers } from './store-summary-reader.mjs';

// Cache retention past any fixed bound is asserted in
// store-agent-worker-churn.test.mjs (settled records, read counter).
test('a pool larger than any fixed cache bound sees every same-size, same-mtime rewrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-header-many-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const stamp = new Date().toISOString();
    // A fixed mtime lets a same-size rewrite keep the file fingerprint.
    const mtime = new Date(Date.parse(stamp) - 60_000);
    const ids = Array.from({ length: 300 }, (_, index) => `many-child-${String(index).padStart(3, '0')}`);
    const writeSession = (id, letter) => {
      const path = join(root, 'sessions', `${id}.json`);
      writeFileSync(path, JSON.stringify({ id, owner: 'agent', title: `Title ${letter} ${id}`, updatedAt: stamp }));
      utimesSync(path, mtime, mtime);
    };
    for (const id of ids) writeSession(id, 'A');
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: ids.map((sessionId) => ({
          sessionId,
          tag: sessionId,
          agent: 'worker',
          status: 'idle',
          updatedAt: stamp,
        })),
      })
    );
    const titles = () => listStoredAgentWorkers().map((row) => row.title);
    const first = titles();
    assert.equal(first.length, ids.length);
    assert.ok(first.every((title) => title.startsWith('Title A ')));
    // Same size, same mtime: the full file stamp (change time) still differs.
    for (const id of ids) writeSession(id, 'B');
    assert.deepEqual(
      titles(),
      first.map((title) => title.replace('Title A ', 'Title B '))
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// The worker/Lead indexes persist through an async writer queue; a test that
// inspects the file itself first waits for the queue to land.
function readPersistedIndex(root, name) {
  flushAllIndexWritesSync();
  return JSON.parse(readFileSync(join(root, name), 'utf8'));
}

test('cached pool metadata preserves routing and display fields without depending on tool catalogs', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-header-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const id = 'header-child';
    const stamp = new Date().toISOString();
    const session = {
      id,
      owner: 'agent',
      ownerSessionId: 'header-root',
      parentSessionId: 'header-parent',
      agent: 'reviewer',
      title: 'Preserve pool metadata',
      provider: 'test-provider',
      model: 'test-model',
      effort: 'high',
      fast: true,
      autoEffort: false,
      createdAt: stamp,
      updatedAt: stamp,
      cwd: root,
      clientHostPid: process.pid,
      messages: [{ role: 'user', content: 'not pool metadata' }],
      tools: [{ name: 'tool', description: 'not pool metadata'.repeat(1000) }],
      deferredToolCatalog: [{ name: 'deferred', inputSchema: { type: 'object' } }],
    };
    writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify(session));
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({ workers: [{ sessionId: id, tag: 'review', agent: 'reviewer', status: 'idle' }] })
    );
    const first = listStoredAgentWorkers();
    assert.equal(first.length, 1);
    for (const field of [
      'ownerSessionId',
      'parentSessionId',
      'agent',
      'title',
      'provider',
      'model',
      'effort',
      'fast',
      'autoEffort',
      'createdAt',
      'updatedAt',
      'cwd',
      'clientHostPid',
    ]) {
      assert.equal(first[0][field], session[field], field);
    }
    assert.deepEqual(listStoredAgentWorkers(), first);
    delete session.tools;
    delete session.deferredToolCatalog;
    writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify(session));
    assert.deepEqual(listStoredAgentWorkers(), first);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent pool lists living idle workers and drops dead ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-pool-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    writeFileSync(
      join(root, 'sessions', 'child-a.json'),
      JSON.stringify({
        id: 'child-a',
        title: 'Review dependency update',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
      })
    );
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: {
          a: {
            tag: 'review',
            sessionId: 'child-a',
            ownerSessionId: 'lead-a',
            agent: 'reviewer',
            status: 'idle',
            stage: 'idle',
          },
          b: {
            tag: 'work',
            sessionId: 'child-b',
            ownerSessionId: 'lead-b',
            agent: 'worker',
            status: 'running',
            stage: 'running',
          },
          c: {
            tag: 'done',
            sessionId: 'child-c',
            ownerSessionId: 'lead-c',
            agent: 'worker',
            status: 'closed',
            stage: 'closed',
          },
        },
      })
    );
    const rows = listStoredAgentWorkers();
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['child-a', 'child-b']);
    assert.equal(rows.find((row) => row.sessionId === 'child-a')?.status, 'completed');
    assert.equal(rows.find((row) => row.sessionId === 'child-a')?.title, 'Review dependency update');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent pool joins a resident Lead lease without projecting session history', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-pool-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    writeFileSync(
      join(root, 'sessions', 'leada.json'),
      JSON.stringify({
        id: 'leada',
        owner: 'user',
        agent: 'lead',
        sourceType: 'lead',
        status: 'idle',
        provider: 'xai',
        model: 'grok',
        messages: [{ role: 'user', content: 'hello' }],
      })
    );
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: {
          child: {
            tag: 'review',
            sessionId: 'childa',
            ownerSessionId: 'leada',
            agent: 'reviewer',
            status: 'idle',
            stage: 'idle',
          },
        },
      })
    );
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          leada: {
            tag: 'lead:leada',
            sessionId: 'leada',
            ownerSessionId: 'leada',
            agent: 'lead',
            status: 'idle',
            stage: 'idle',
            provider: 'xai',
            model: 'grok',
            updatedAt: new Date().toISOString(),
            reapAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })
    );
    const rows = listStoredAgentWorkers();
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['childa', 'leada']);
    const lead = rows.find((row) => row.sessionId === 'leada');
    assert.equal(lead?.agent, 'lead');
    assert.equal(lead?.status, 'idle');
    assert.equal(lead?.ownerSessionId, 'leada');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent pool drops Leads past the pane window and does not revive historical Lead sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-reaped-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    writeFileSync(
      join(root, 'sessions', 'history.json'),
      JSON.stringify({
        id: 'history',
        owner: 'user',
        agent: 'lead',
        status: 'idle',
        messages: [{ role: 'user', content: 'old task' }],
      })
    );
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          history: {
            sessionId: 'history',
            agent: 'lead',
            status: 'idle',
            stage: 'idle',
            updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            reapAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })
    );
    assert.deepEqual(listStoredAgentWorkers(), []);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an expired Lead takes its idle children out of the pool, and a live lease brings them back', () => {
  withAgentPoolRoot('mixdog-lead-orphan-', (root) => {
    // The Lead conversation is still open, but its pool row was reaped: the
    // Agent window has no Lead row left to hang these children under.
    writeFileSync(
      join(root, 'sessions', 'lead-open.json'),
      JSON.stringify({
        id: 'lead-open',
        owner: 'cli',
        agent: 'lead',
        sourceType: 'lead',
        status: 'idle',
      })
    );
    writeAgentChild(root, 'child-idle', { ownerSessionId: 'lead-open' });
    writeAgentWorkerIndex(root, {
      idle: {
        tag: 'review',
        sessionId: 'child-idle',
        ownerSessionId: 'lead-open',
        agent: 'reviewer',
        status: 'idle',
        stage: 'idle',
      },
    });
    assert.deepEqual(
      listStoredAgentWorkers().map((row) => row.sessionId),
      []
    );

    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          'lead-open': {
            tag: 'lead:lead-open',
            sessionId: 'lead-open',
            ownerSessionId: 'lead-open',
            agent: 'lead',
            status: 'idle',
            stage: 'idle',
            updatedAt: new Date().toISOString(),
            reapAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })
    );
    assert.deepEqual(
      listStoredAgentWorkers()
        .map((row) => row.sessionId)
        .sort(),
      ['child-idle', 'lead-open']
    );
  });
});

test('a working child outlives its Lead row so live work stays visible', () => {
  withAgentPoolRoot('mixdog-lead-orphan-working-', (root) => {
    writeFileSync(
      join(root, 'sessions', 'lead-open.json'),
      JSON.stringify({
        id: 'lead-open',
        owner: 'cli',
        agent: 'lead',
        status: 'idle',
      })
    );
    writeAgentChild(root, 'child-working', {
      ownerSessionId: 'lead-open',
      status: 'running',
      stage: 'running',
    });
    writeAgentWorkerIndex(root, {
      working: {
        tag: 'review',
        sessionId: 'child-working',
        ownerSessionId: 'lead-open',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
      },
    });
    const row = listStoredAgentWorkers({ runningSessionIds: new Set(['child-working']) }).find(
      (entry) => entry.sessionId === 'child-working'
    );
    assert.equal(row?.status, 'running');
  });
});

test('completed child sessions remain available across registry recreation without expiration', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-child-reap-persist-'));
  const sessions = new Map([
    [
      'openai-child',
      {
        id: 'openai-child',
        agentTag: 'openai-review',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        provider: 'openai-oauth',
      },
    ],
    [
      'anthropic-child',
      {
        id: 'anthropic-child',
        agentTag: 'anthropic-review',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        provider: 'anthropic-oauth',
      },
    ],
  ]);
  const manager = {
    getSession: (sessionId) => sessions.get(sessionId) || null,
    listSessions: () => [...sessions.values()],
  };
  try {
    const registry = createTagRegistry({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: manager,
      emitSubagentEvent: () => {},
    });
    const startedAt = Date.now();
    for (const session of sessions.values()) {
      registry.upsertWorkerSession(session, session.agentTag, {
        status: 'idle',
        stage: 'idle',
        finishedAt: new Date(startedAt).toISOString(),
      });
    }
    let stored = readPersistedIndex(root, 'agent-workers.json');
    const rows = Object.values(stored.workers);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.reapAt === null));

    const restarted = createTagRegistry({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: manager,
      emitSubagentEvent: () => {},
    });
    stored = readPersistedIndex(root, 'agent-workers.json');
    const restartedRows = Object.values(stored.workers);
    assert.deepEqual(restartedRows, rows);
    assert.equal(restarted.agentSessionEntries().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('boot preserves old and recent child rows instead of expiring them', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-child-reap-recover-'));
  const now = Date.now();
  try {
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        version: 2,
        workers: {
          expired: {
            tag: 'old-review',
            sessionId: 'expired-child',
            ownerSessionId: 'lead-a',
            agent: 'reviewer',
            provider: 'anthropic-oauth',
            status: 'idle',
            stage: 'idle',
            updatedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          },
          remaining: {
            tag: 'recent-review',
            sessionId: 'remaining-child',
            ownerSessionId: 'lead-a',
            agent: 'reviewer',
            provider: 'openai-oauth',
            status: 'idle',
            stage: 'idle',
            updatedAt: new Date(now - 10 * 60_000).toISOString(),
          },
        },
      })
    );
    const registry = createTagRegistry({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: { getSession: () => null, listSessions: () => [] },
      emitSubagentEvent: () => {},
    });
    const stored = readPersistedIndex(root, 'agent-workers.json');
    const rows = Object.values(stored.workers);
    assert.equal(
      rows.some((row) => row.sessionId === 'expired-child'),
      true
    );
    const remaining = rows.find((row) => row.sessionId === 'remaining-child');
    assert.ok(remaining);
    assert.equal(rows.length, 2);
    assert.equal(registry.agentSessionEntries().length, 2);
    assert.equal(Object.values(stored.tombstones || {}).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lead lifecycle uses only lead-workers.json and removes the idle lease on reap', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-lifecycle-'));
  try {
    const index = createLeadWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      workerRowFromSession(session, tag, extra) {
        return {
          tag,
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          createdAt: session.createdAt,
          ...extra,
        };
      },
    });
    const lead = {
      id: 'lead-runtime',
      provider: 'openai-oauth',
      model: 'gpt-test',
      createdAt: new Date().toISOString(),
    };
    assert.equal(index.upsertLeadSession(lead, { status: 'running', stage: 'running' }), true);
    assert.equal(
      index.upsertLeadSession(
        {
          ...lead,
          id: 'worker-runtime',
          owner: 'agent',
          agent: 'worker',
          ownerSessionId: lead.id,
        },
        { status: 'running', stage: 'running' }
      ),
      false
    );
    assert.equal(existsSync(join(root, 'agent-workers.json')), false);
    let stored = readPersistedIndex(root, 'lead-workers.json');
    assert.equal(stored.workers['lead-runtime'].status, 'running');
    assert.equal(stored.workers['worker-runtime'], undefined);

    assert.equal(index.upsertLeadSession(lead, { status: 'idle', stage: 'idle' }), true);
    stored = readPersistedIndex(root, 'lead-workers.json');
    assert.equal(stored.workers['lead-runtime'].status, 'idle');
    assert.ok(Date.parse(stored.workers['lead-runtime'].reapAt) > Date.now());

    // A workspace transition moves the row's cwd and nothing else; no row, no write.
    const idleRow = stored.workers['lead-runtime'];
    assert.equal(index.updateLeadWorkerCwd('lead-runtime', '/repo/worktree'), true);
    assert.equal(index.updateLeadWorkerCwd('unknown-lead', '/repo/worktree'), true);
    stored = readPersistedIndex(root, 'lead-workers.json');
    assert.deepEqual(stored.workers['lead-runtime'], { ...idleRow, cwd: '/repo/worktree' });
    assert.equal(stored.workers['unknown-lead'], undefined);

    assert.equal(index.removeLeadWorkerRow('lead-runtime'), true);
    stored = readPersistedIndex(root, 'lead-workers.json');
    assert.deepEqual(stored.workers, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lead boot recovery settles a running row whose runtime died, and keeps a live one', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-recover-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = Date.now();
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          crashed: {
            sessionId: 'crashed',
            agent: 'lead',
            status: 'running',
            stage: 'running',
            // Inside the freshness window: only the dead runtime proves it stopped.
            runtimePid: 0x7fffffff,
            turnStartedAt: new Date(now - 5_000).toISOString(),
            updatedAt: new Date(now - 5_000).toISOString(),
            reapAt: new Date(now + 600_000).toISOString(),
          },
          live: {
            sessionId: 'live',
            agent: 'lead',
            status: 'running',
            stage: 'running',
            runtimePid: process.pid,
            turnStartedAt: new Date(now - 5_000).toISOString(),
            updatedAt: new Date(now - 5_000).toISOString(),
            reapAt: new Date(now + 600_000).toISOString(),
          },
        },
      })
    );
    createLeadWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      workerRowFromSession: (session, tag, extra) => ({ tag, sessionId: session.id, ...extra }),
    });
    const stored = readPersistedIndex(root, 'lead-workers.json');
    assert.equal(stored.workers.crashed.status, 'idle');
    assert.equal(stored.workers.crashed.stage, 'idle');
    assert.equal(stored.workers.crashed.turnStartedAt, null);
    assert.equal(stored.workers.live.status, 'running');

    const pool = listStoredAgentWorkers({ runningSessionIds: new Set(['live']) });
    assert.equal(pool.find((row) => row.sessionId === 'crashed')?.status, 'idle');
    assert.equal(pool.find((row) => row.sessionId === 'live')?.status, 'running');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a settled Lead upsert stamps the finish the pane window counts from; a running one does not', () => {
  withAgentPoolRoot('mixdog-lead-finish-stamp-', (root) => {
    const index = createLeadWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      workerRowFromSession: (session, tag, extra) => ({ tag, sessionId: session.id, ...extra }),
    });
    try {
      const session = { id: 'lead-stamp', owner: 'user', agent: 'lead', messages: [] };
      index.upsertLeadSession(session, { status: 'running', stage: 'running' });
      assert.equal(index.readLeadWorkerRows()[0].finishedAt ?? null, null);
      index.upsertLeadSession(session, { status: 'idle', stage: 'idle' });
      const settled = index.readLeadWorkerRows()[0];
      assert.ok(Date.parse(settled.finishedAt) > 0);
      assert.equal(listStoredAgentWorkers().find((row) => row.sessionId === 'lead-stamp')?.status, 'idle');
    } finally {
      index.dispose();
    }
  });
});

test('Lead recovery keeps a long turn still in flight in this daemon and settles a stalled one', () => {
  withAgentPoolRoot('mixdog-lead-recover-inflight-', (root) => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const running = (sessionId) => ({
      sessionId,
      agent: 'lead',
      status: 'running',
      stage: 'running',
      runtimePid: process.pid,
      turnStartedAt: old,
      updatedAt: old,
    });
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({ workers: { long: running('long'), stalled: running('stalled') } })
    );
    createLeadWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      workerRowFromSession: (session, tag, extra) => ({ tag, sessionId: session.id, ...extra }),
      isSessionRunning: (sessionId) => sessionId === 'long',
    }).dispose();
    const stored = readPersistedIndex(root, 'lead-workers.json');
    assert.equal(stored.workers.long.status, 'running');
    assert.equal(stored.workers.stalled.status, 'idle');
  });
});

function withAgentPoolRoot(prefix, body) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    return body(root);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function writeAgentChild(root, sessionId, extra = {}) {
  const {
    ownerSessionId = 'lead-a',
    agent = 'reviewer',
    tag = 'review',
    title = 'Review',
    status,
    stage,
    ...rest
  } = extra;
  writeFileSync(
    join(root, 'sessions', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      owner: 'agent',
      ownerSessionId,
      agent,
      agentTag: tag,
      title,
      status: status || stage || 'idle',
      stage: stage || status || 'idle',
      ...rest,
    })
  );
}

function writeAgentWorkerIndex(root, workers) {
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ workers }));
}

test('a cancelled or cancel-unconfirmed Lead the daemon still runs is not shown running', () => {
  withAgentPoolRoot('mixdog-lead-cancel-running-', (root) => {
    const lead = (sessionId, status) => ({ sessionId, agent: 'lead', status, stage: status });
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          'lead-cancelled': lead('lead-cancelled', 'cancelled'),
          'lead-unconfirmed': lead('lead-unconfirmed', 'cancel-unconfirmed'),
          'lead-idle': lead('lead-idle', 'idle'),
        },
      })
    );
    const rows = listStoredAgentWorkers({
      runningSessionIds: new Set(['lead-cancelled', 'lead-unconfirmed', 'lead-idle']),
    });
    const status = (id) => rows.find((entry) => entry.sessionId === id)?.status;
    assert.equal(status('lead-cancelled'), 'cancelled');
    assert.equal(status('lead-unconfirmed'), 'cancel-unconfirmed');
    assert.equal(status('lead-idle'), 'running', 'an uncancelled running Lead is still working');
  });
});

test('a child the daemon runs stays listed whatever stale terminal status its row carries', () => {
  withAgentPoolRoot('mixdog-running-stale-terminal-', (root) => {
    const workers = {};
    for (const status of ['done', 'error']) {
      const sessionId = `child-${status}`;
      writeAgentChild(root, sessionId, { status, stage: status, tag: status });
      workers[status] = {
        tag: status,
        sessionId,
        agent: 'worker',
        ownerSessionId: 'lead-a',
        status,
        stage: status,
        updatedAt: new Date().toISOString(),
      };
    }
    writeAgentWorkerIndex(root, workers);
    const running = listStoredAgentWorkers({ runningSessionIds: new Set(['child-done', 'child-error']) });
    for (const status of ['done', 'error']) {
      const row = running.find((entry) => entry.sessionId === `child-${status}`);
      assert.equal(row?.status, 'running', status);
      assert.equal(row?.stage, 'running', status);
    }
    // Not running in the daemon: a completed row is listed as completed and a
    // failed one as the failure it is, each for the pane window.
    assert.deepEqual(
      listStoredAgentWorkers({ runningSessionIds: new Set() })
        .filter((entry) => entry.sessionId.startsWith('child-'))
        .map((entry) => [entry.sessionId, entry.status]),
      [
        ['child-done', 'completed'],
        ['child-error', 'error'],
      ]
    );
  });
});

test('reaped rows stay hidden after recovery saves', () => {
  withAgentPoolRoot('mixdog-reaped-pool-', (root) => {
    const now = Date.now();
    const row = {
      tag: 'old',
      sessionId: 'reaped-child',
      ownerSessionId: 'lead-a',
      agent: 'worker',
      clientHostPid: process.pid,
      runtimePid: process.pid,
      status: 'idle',
      stage: 'idle',
      createdAt: now - 60_000,
      updatedAt: new Date(now).toISOString(),
      lastUsedAt: now,
      finishedAt: new Date(now).toISOString(),
    };
    writeAgentChild(root, row.sessionId, { ...row, agentTag: row.tag });
    const tombstone = { tag: row.tag, clientHostPid: process.pid, reapedAt: new Date(now - 30_000).toISOString() };
    const writeIndex = (workers) =>
      writeFileSync(
        join(root, 'agent-workers.json'),
        JSON.stringify({
          workers,
          tombstones: [tombstone],
        })
      );
    writeIndex({ old: row });
    assert.equal(
      listStoredAgentWorkers().some((r) => r.sessionId === row.sessionId),
      false
    );
    writeIndex({});
    assert.equal(
      listStoredAgentWorkers().some((r) => r.sessionId === row.sessionId),
      false
    );
    writeIndex({ old: { ...row, status: 'running', stage: 'running', turnStartedAt: new Date(now).toISOString() } });
    assert.equal(
      listStoredAgentWorkers().some((r) => r.sessionId === row.sessionId),
      true
    );
    assert.equal(existsSync(join(root, 'sessions', `${row.sessionId}.json`)), true, 'the transcript is retained');
  });
});

test('a declared-working row the daemon does not report in flight is unknown, never guessed running', () => {
  withAgentPoolRoot('mixdog-unknown-worker-', (root) => {
    writeAgentChild(root, 'child-stale', { status: 'running', tag: 'stale' });
    writeAgentWorkerIndex(root, {
      stale: {
        tag: 'stale',
        sessionId: 'child-stale',
        agent: 'worker',
        ownerSessionId: 'lead-a',
        status: 'running',
        stage: 'running',
        updatedAt: new Date().toISOString(),
      },
    });
    // No daemon answer, or a daemon whose runtime does not have this turn in
    // flight: the row's own claim is not evidence.
    for (const options of [undefined, { runningSessionIds: new Set(['other']) }]) {
      const row = listStoredAgentWorkers(options).find((entry) => entry.sessionId === 'child-stale');
      assert.equal(row?.status, 'unknown');
      assert.equal(row?.stage, 'unknown');
      assert.equal(row?.turnStartedAt, null);
    }
    const live = listStoredAgentWorkers({ runningSessionIds: new Set(['child-stale']) });
    assert.equal(live.find((entry) => entry.sessionId === 'child-stale')?.status, 'running');
  });
});

test('a long turn the daemon reports in flight stays running whatever its row stamp says', () => {
  withAgentPoolRoot('mixdog-long-turn-', (root) => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    writeAgentChild(root, 'child-long', { status: 'running', tag: 'long' });
    writeAgentWorkerIndex(root, {
      long: {
        tag: 'long',
        sessionId: 'child-long',
        agent: 'worker',
        ownerSessionId: 'lead-a',
        status: 'running',
        stage: 'running',
        turnStartedAt: old,
        updatedAt: old,
      },
    });
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          'lead-a': {
            sessionId: 'lead-a',
            agent: 'lead',
            status: 'running',
            stage: 'running',
            turnStartedAt: old,
            updatedAt: old,
            reapAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      })
    );
    const rows = listStoredAgentWorkers({ runningSessionIds: new Set(['child-long', 'lead-a']) });
    const child = rows.find((entry) => entry.sessionId === 'child-long');
    assert.equal(child?.status, 'running');
    assert.equal(child?.turnStartedAt, old);
    const lead = rows.find((entry) => entry.sessionId === 'lead-a');
    assert.equal(lead?.status, 'running', 'a working Lead outlasts the reap deadline stamped at its turn start');
    assert.equal(lead?.turnStartedAt, old);
  });
});

test('a running worker stays in the pool whatever runtime phase its stage carries; the status decides', () => {
  withAgentPoolRoot('mixdog-status-decides-', (root) => {
    const now = Date.now();
    const workers = {};
    for (const stage of ['idle', 'done', 'error']) {
      const sessionId = `child-${stage}`;
      writeAgentChild(root, sessionId, { status: 'running', stage: 'running', tag: stage });
      workers[stage] = {
        tag: stage,
        sessionId,
        agent: 'worker',
        ownerSessionId: 'lead-a',
        status: 'running',
        stage,
        updatedAt: new Date(now).toISOString(),
        turnStartedAt: new Date(now - 5_000).toISOString(),
      };
    }
    // The opposite mix is a settled worker: its stale active stage does not revive it.
    writeAgentChild(root, 'child-settled', { status: 'idle', stage: 'idle', tag: 'settled' });
    workers.settled = {
      tag: 'settled',
      sessionId: 'child-settled',
      agent: 'worker',
      ownerSessionId: 'lead-a',
      status: 'idle',
      stage: 'streaming',
      updatedAt: new Date(now).toISOString(),
      turnStartedAt: new Date(now - 5_000).toISOString(),
    };
    writeAgentWorkerIndex(root, workers);
    const running = new Set(
      Object.values(workers)
        .map((row) => row.sessionId)
        .filter((sessionId) => sessionId !== 'child-settled')
    );
    const rows = listStoredAgentWorkers({ runningSessionIds: running });
    for (const stage of ['idle', 'done', 'error']) {
      const row = rows.find((entry) => entry.sessionId === `child-${stage}`);
      assert.equal(row?.status, 'running', `stage ${stage}`);
      assert.equal(row?.turnStartedAt, workers[stage].turnStartedAt, `stage ${stage} keeps its turn stamp`);
    }
    const settled = rows.find((entry) => entry.sessionId === 'child-settled');
    assert.equal(settled?.status, 'completed');
    assert.equal(settled?.turnStartedAt, null, 'a completed status is not live work');
  });
});

test('a finished agent stays listed for one hour from its finish stamp, then drops out; new work revives it', () => {
  withAgentPoolRoot('mixdog-pane-window-', (root) => {
    const HOUR = 3_600_000;
    const at = (ageMs) => new Date(Date.now() - ageMs).toISOString();
    const outcomes = { completed: 'idle', failed: 'failed', cancelled: 'cancelled' };
    const workers = {};
    for (const [name, status] of Object.entries(outcomes)) {
      for (const [phase, age] of [
        ['fresh', HOUR - 60_000],
        ['stale', HOUR + 60_000],
      ]) {
        const sessionId = `child-${name}-${phase}`;
        writeAgentChild(root, sessionId, { status, stage: status, tag: sessionId });
        workers[sessionId] = {
          tag: sessionId,
          sessionId,
          agent: 'worker',
          ownerSessionId: 'lead-a',
          status,
          stage: status,
          // Updated long ago: only the finish stamp decides.
          updatedAt: at(age),
          finishedAt: at(age),
          // A provider cache window shorter than the pane window changes nothing.
          reapAt: at(age + 1),
        };
      }
    }
    writeAgentWorkerIndex(root, workers);
    const lead = (sessionId, age) => ({
      sessionId,
      agent: 'lead',
      status: 'idle',
      stage: 'idle',
      updatedAt: at(age),
      finishedAt: at(age),
      // A 24h provider reap window does not extend the pane window.
      reapAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    });
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: { 'lead-fresh': lead('lead-fresh', HOUR - 60_000), 'lead-stale': lead('lead-stale', HOUR + 60_000) },
      })
    );
    const status = (rows, id) => rows.find((entry) => entry.sessionId === id)?.status;
    const rows = listStoredAgentWorkers({ runningSessionIds: new Set() });
    assert.equal(status(rows, 'child-completed-fresh'), 'completed');
    assert.equal(status(rows, 'child-failed-fresh'), 'failed');
    assert.equal(status(rows, 'child-cancelled-fresh'), 'cancelled');
    assert.equal(status(rows, 'lead-fresh'), 'idle');
    for (const id of ['child-completed-stale', 'child-failed-stale', 'child-cancelled-stale', 'lead-stale']) {
      assert.equal(status(rows, id), undefined, `${id} is past the window`);
    }

    // New work on a finished agent shows it working again, however old its stamp.
    const revived = listStoredAgentWorkers({
      runningSessionIds: new Set(['child-completed-stale', 'child-failed-stale', 'lead-stale']),
    });
    for (const id of ['child-completed-stale', 'child-failed-stale', 'lead-stale']) {
      assert.equal(status(revived, id), 'running', id);
    }
    // A cancel still outranks the daemon's running report, and stays inside its window.
    const cancelRunning = listStoredAgentWorkers({ runningSessionIds: new Set(['child-cancelled-fresh']) });
    assert.equal(status(cancelRunning, 'child-cancelled-fresh'), 'cancelled');
  });
});

test('a cancelled worker row is reported cancelled, not running', () => {
  withAgentPoolRoot('mixdog-cancel-row-', (root) => {
    writeAgentChild(root, 'child-cancel', { status: 'cancelled', stage: 'running' });
    writeAgentWorkerIndex(root, {
      review: {
        tag: 'review',
        sessionId: 'child-cancel',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        status: 'cancelled',
        stage: 'running',
      },
    });
    const row = listStoredAgentWorkers().find((entry) => entry.sessionId === 'child-cancel');
    assert.ok(row, 'cancelled worker stays in the pool so consumers see the cancel');
    assert.equal(row.status, 'cancelled');
    assert.notEqual(row.status, 'running');
  });
});

test('a session the daemon runs is working even when its durable row says idle; an explicit cancel outranks it', () => {
  withAgentPoolRoot('mixdog-running-idle-row-', (root) => {
    writeAgentChild(root, 'child-idle-row', { status: 'idle', stage: 'idle', tag: 'idle-row' });
    writeAgentChild(root, 'child-cancel-row', { status: 'cancelled', stage: 'running', tag: 'cancel-row' });
    writeAgentChild(root, 'child-unconfirmed-row', {
      status: 'cancel-unconfirmed',
      stage: 'running',
      tag: 'unconfirmed',
    });
    const worker = (tag, sessionId, status, stage) => ({
      tag,
      sessionId,
      agent: 'worker',
      ownerSessionId: 'lead-a',
      status,
      stage,
      turnStartedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    });
    writeAgentWorkerIndex(root, {
      'idle-row': worker('idle-row', 'child-idle-row', 'idle', 'idle'),
      'cancel-row': worker('cancel-row', 'child-cancel-row', 'cancelled', 'running'),
      unconfirmed: worker('unconfirmed', 'child-unconfirmed-row', 'cancel-unconfirmed', 'running'),
    });
    const rows = listStoredAgentWorkers({
      runningSessionIds: new Set(['child-idle-row', 'child-cancel-row', 'child-unconfirmed-row']),
    });
    const idle = rows.find((entry) => entry.sessionId === 'child-idle-row');
    assert.equal(idle?.status, 'running');
    assert.equal(idle?.stage, 'running');
    assert.equal(idle?.turnStartedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(idle?.idleSince, null, 'working rows carry no idle stamp');
    const cancelled = rows.find((entry) => entry.sessionId === 'child-cancel-row');
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.turnStartedAt, null);
    const unconfirmed = rows.find((entry) => entry.sessionId === 'child-unconfirmed-row');
    assert.equal(unconfirmed?.status, 'cancel-unconfirmed');
    assert.equal(unconfirmed?.turnStartedAt, null);
    // The same idle row without the daemon's running report reads completed.
    const quiet = listStoredAgentWorkers({ runningSessionIds: new Set() }).find(
      (entry) => entry.sessionId === 'child-idle-row'
    );
    assert.equal(quiet?.status, 'completed');
  });
});

test('cancel that removes the worker row does not publish the session as running', () => {
  withAgentPoolRoot('mixdog-cancel-forget-row-', (root) => {
    writeAgentChild(root, 'child-forget', { status: 'running', stage: 'running' });
    writeAgentWorkerIndex(root, {
      review: {
        tag: 'review',
        sessionId: 'child-forget',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
      },
    });
    const running = { runningSessionIds: new Set(['child-forget']) };
    assert.equal(
      listStoredAgentWorkers(running).find((entry) => entry.sessionId === 'child-forget')?.status,
      'running'
    );

    createTagRegistry({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: { getSession: () => null, listSessions: () => [] },
      emitSubagentEvent: () => {},
    }).forgetTerminalSession('review', 'child-forget');

    // closeSession('cli-agent-close') tombstones status=closed and stamps
    // cancelStatus.
    writeAgentChild(root, 'child-forget', {
      status: 'closed',
      stage: 'closed',
      closed: true,
      closedReason: 'cli-agent-close',
      cancelStatus: 'cancelled',
      cancelledAt: 1_000,
    });

    const stored = readPersistedIndex(root, 'agent-workers.json');
    const remaining = Array.isArray(stored.workers) ? stored.workers : Object.values(stored.workers || {});
    assert.equal(remaining.filter((row) => row?.sessionId === 'child-forget').length, 0);

    const row = listStoredAgentWorkers(running).find((entry) => entry.sessionId === 'child-forget');
    assert.notEqual(row?.status, 'running');
  });
});

test('cancel-unconfirmed stays distinguishable from a confirmed cancel', () => {
  withAgentPoolRoot('mixdog-cancel-unconfirmed-', (root) => {
    writeAgentChild(root, 'child-unconfirmed', { status: 'cancel-unconfirmed', stage: 'cancelling' });
    writeAgentWorkerIndex(root, {
      review: {
        tag: 'review',
        sessionId: 'child-unconfirmed',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        status: 'cancel-unconfirmed',
        stage: 'cancelling',
      },
    });
    const row = listStoredAgentWorkers().find((entry) => entry.sessionId === 'child-unconfirmed');
    assert.equal(row?.status, 'cancel-unconfirmed');
    assert.equal(row?.stage, 'cancelling');
    assert.notEqual(row?.status, 'running');
    assert.notEqual(row?.status, 'cancelled');
  });
});

test('a cancel in the session header or the row stage holds over a stale running row until newer work', () => {
  withAgentPoolRoot('mixdog-cancel-sources-', (root) => {
    const cancelledAt = Date.now() - 60_000;
    const worker = (tag, sessionId, extra = {}) => ({
      tag,
      sessionId,
      agent: 'worker',
      ownerSessionId: 'lead-a',
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date(cancelledAt - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    // Durable close stamped cancel-unconfirmed; the index row still says running.
    writeAgentChild(root, 'child-header', {
      tag: 'header',
      status: 'closed',
      stage: 'closed',
      cancelStatus: 'cancel-unconfirmed',
      cancelledAt,
    });
    // A confirmed cancel on the row never masks the header's unconfirmed one.
    writeAgentChild(root, 'child-mixed', {
      tag: 'mixed',
      status: 'closed',
      cancelStatus: 'cancel-unconfirmed',
      cancelledAt,
    });
    // The cancel recorded only in the row's stage.
    writeAgentChild(root, 'child-stage', { tag: 'stage', status: 'running' });
    // A turn started after the header's cancel is newer work.
    writeAgentChild(root, 'child-newer', {
      tag: 'newer',
      status: 'idle',
      cancelStatus: 'cancelled',
      cancelledAt,
    });
    writeAgentWorkerIndex(root, {
      header: worker('header', 'child-header'),
      mixed: worker('mixed', 'child-mixed', { stage: 'cancelled' }),
      stage: worker('stage', 'child-stage', { stage: 'cancelled' }),
      newer: worker('newer', 'child-newer', { turnStartedAt: new Date(cancelledAt + 30_000).toISOString() }),
    });
    for (const runningSessionIds of [
      new Set(),
      new Set(['child-header', 'child-mixed', 'child-stage', 'child-newer']),
    ]) {
      const rows = listStoredAgentWorkers({ runningSessionIds });
      const row = (id) => rows.find((entry) => entry.sessionId === id);
      assert.equal(row('child-header')?.status, 'cancel-unconfirmed');
      assert.equal(row('child-header')?.stage, 'cancel-unconfirmed');
      assert.equal(row('child-header')?.turnStartedAt, null);
      assert.equal(row('child-mixed')?.status, 'cancel-unconfirmed');
      assert.equal(row('child-stage')?.status, 'cancelled');
      assert.equal(row('child-stage')?.stage, 'cancelled');
      assert.equal(row('child-newer')?.status, runningSessionIds.size ? 'running' : 'unknown');
    }
  });
});

test('an expired confirmed-cancel row still shows its header cancel-unconfirmed', () => {
  withAgentPoolRoot('mixdog-expired-cancel-header-', (root) => {
    const longAgo = Date.now() - 48 * 60 * 60_000;
    const stamp = new Date(longAgo).toISOString();
    const worker = (tag, sessionId) => ({
      tag,
      sessionId,
      agent: 'worker',
      ownerSessionId: 'lead-a',
      status: 'cancelled',
      stage: 'cancelled',
      updatedAt: stamp,
      finishedAt: stamp,
    });
    writeAgentChild(root, 'child-expired-unconfirmed', {
      tag: 'expired-unconfirmed',
      status: 'closed',
      stage: 'closed',
      cancelStatus: 'cancel-unconfirmed',
      cancelledAt: longAgo,
    });
    writeAgentChild(root, 'child-expired-confirmed', { tag: 'expired-confirmed', status: 'idle' });
    writeAgentWorkerIndex(root, {
      'expired-unconfirmed': worker('expired-unconfirmed', 'child-expired-unconfirmed'),
      'expired-confirmed': worker('expired-confirmed', 'child-expired-confirmed'),
    });
    const rows = listStoredAgentWorkers();
    const row = (id) => rows.find((entry) => entry.sessionId === id);
    assert.equal(row('child-expired-unconfirmed')?.status, 'cancel-unconfirmed');
    assert.equal(row('child-expired-confirmed'), undefined, 'a confirmed cancel past its window is dropped');
  });
});

test('stored Agent pool preserves root ownership and immediate nested parent links', () => {
  withAgentPoolRoot('mixdog-agent-pool-nested-', (root) => {
    writeAgentChild(root, 'child-direct', {
      ownerSessionId: 'root-lead',
      parentSessionId: 'root-lead',
      tag: 'direct',
    });
    writeAgentChild(root, 'grandchild', {
      ownerSessionId: 'root-lead',
      parentSessionId: 'child-direct',
      tag: 'nested',
      closed: true,
      status: 'closed',
      stage: 'closed',
    });
    writeFileSync(
      join(root, 'sessions', 'root-lead.json'),
      JSON.stringify({
        id: 'root-lead',
        owner: 'user',
        ownerSessionId: 'root-lead',
        agent: 'lead',
        status: 'idle',
        messages: [{ role: 'user', content: 'root task' }],
      })
    );
    writeAgentWorkerIndex(root, {
      direct: {
        tag: 'direct',
        sessionId: 'child-direct',
        ownerSessionId: 'root-lead',
        parentSessionId: 'root-lead',
        agent: 'reviewer',
        status: 'idle',
        stage: 'idle',
      },
      // No ancestry on the row: the session header must carry the same
      // production ancestry shape for a nested descendant.
      nested: {
        tag: 'nested',
        sessionId: 'grandchild',
        agent: 'reviewer',
        status: 'idle',
        stage: 'idle',
      },
    });
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({
        workers: {
          root: {
            sessionId: 'root-lead',
            ownerSessionId: 'root-lead',
            agent: 'lead',
            status: 'idle',
            stage: 'idle',
            updatedAt: new Date().toISOString(),
            reapAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })
    );
    const rows = listStoredAgentWorkers();
    const rootLead = rows.find((row) => row.sessionId === 'root-lead');
    const direct = rows.find((row) => row.sessionId === 'child-direct');
    const nested = rows.find((row) => row.sessionId === 'grandchild');
    assert.equal(rootLead?.ownerSessionId, 'root-lead');
    assert.equal(rootLead?.parentSessionId, null);
    assert.equal(direct?.ownerSessionId, 'root-lead');
    assert.equal(direct?.parentSessionId, 'root-lead');
    assert.equal(nested?.ownerSessionId, 'root-lead');
    assert.equal(nested?.parentSessionId, 'child-direct');
  });
});
