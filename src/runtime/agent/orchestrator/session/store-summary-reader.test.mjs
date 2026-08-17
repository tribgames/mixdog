import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLeadWorkerIndex } from '../../../../standalone/agent-tool/lead-worker-index.mjs';
import { listStoredAgentWorkers } from './store-summary-reader.mjs';

test('agent pool lists living idle workers and drops dead ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-pool-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    writeFileSync(join(root, 'sessions', 'child-a.json'), JSON.stringify({
      id: 'child-a',
      title: 'Review dependency update',
      ownerSessionId: 'lead-a',
      agent: 'reviewer',
    }));
    writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({
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
    }));
    const rows = listStoredAgentWorkers();
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['child-a', 'child-b']);
    assert.equal(rows.find((row) => row.sessionId === 'child-a')?.status, 'idle');
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
    writeFileSync(join(root, 'sessions', 'leada.json'), JSON.stringify({
      id: 'leada',
      owner: 'user',
      agent: 'lead',
      sourceType: 'lead',
      status: 'idle',
      provider: 'xai',
      model: 'grok',
      messages: [{ role: 'user', content: 'hello' }],
    }));
    writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({
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
    }));
    writeFileSync(join(root, 'lead-workers.json'), JSON.stringify({
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
    }));
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

test('agent pool drops reaped Leads and does not revive historical Lead sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-reaped-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    writeFileSync(join(root, 'sessions', 'history.json'), JSON.stringify({
      id: 'history',
      owner: 'user',
      agent: 'lead',
      status: 'idle',
      messages: [{ role: 'user', content: 'old task' }],
    }));
    writeFileSync(join(root, 'lead-workers.json'), JSON.stringify({
      workers: {
        history: {
          sessionId: 'history',
          agent: 'lead',
          status: 'idle',
          stage: 'idle',
          updatedAt: new Date(Date.now() - 120_000).toISOString(),
          reapAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    }));
    assert.deepEqual(listStoredAgentWorkers(), []);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
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
    assert.equal(index.upsertLeadSession({
      ...lead,
      id: 'worker-runtime',
      owner: 'agent',
      agent: 'worker',
      ownerSessionId: lead.id,
    }, { status: 'running', stage: 'running' }), false);
    assert.equal(existsSync(join(root, 'agent-workers.json')), false);
    let stored = JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8'));
    assert.equal(stored.workers['lead-runtime'].status, 'running');
    assert.equal(stored.workers['worker-runtime'], undefined);

    assert.equal(index.upsertLeadSession(lead, { status: 'idle', stage: 'idle' }), true);
    stored = JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8'));
    assert.equal(stored.workers['lead-runtime'].status, 'idle');
    assert.ok(Date.parse(stored.workers['lead-runtime'].reapAt) > Date.now());

    assert.equal(index.removeLeadWorkerRow('lead-runtime'), true);
    stored = JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8'));
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
    writeFileSync(join(root, 'lead-workers.json'), JSON.stringify({
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
    }));
    createLeadWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      workerRowFromSession: (session, tag, extra) => ({ tag, sessionId: session.id, ...extra }),
    });
    const stored = JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8'));
    assert.equal(stored.workers.crashed.status, 'idle');
    assert.equal(stored.workers.crashed.stage, 'idle');
    assert.equal(stored.workers.crashed.turnStartedAt, null);
    assert.equal(stored.workers.live.status, 'running');

    const pool = listStoredAgentWorkers();
    assert.equal(pool.find((row) => row.sessionId === 'crashed')?.status, 'idle');
    assert.equal(pool.find((row) => row.sessionId === 'live')?.status, 'running');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
