import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SESSION_SUMMARY_INDEX_VERSION,
  _normalizeSummaryIndex,
  _sessionSummary,
} from '../src/runtime/agent/orchestrator/session/store-summary-index.mjs';
import {
  listStoredSessionSummaries as listLightweightSessionSummaries,
  readStoredSessionTranscript,
} from '../src/runtime/agent/orchestrator/session/store-summary-reader.mjs';
import { createLifecycleApi, resolveResumeCwd } from '../src/session-runtime/lifecycle-api.mjs';
import { createSessionTurnApi } from '../src/session-runtime/session-turn-api.mjs';
import { createMcpGlue } from '../src/session-runtime/mcp-glue.mjs';
import { createRoutePreparationGate } from '../src/session-runtime/route-preparation.mjs';
import { createCwdPlugins } from '../src/session-runtime/cwd-plugins.mjs';
import {
  normalizeDesktopSessionMetadata,
  resumeSession as resumeStoredSession,
} from '../src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs';
import {
  drainSessionStore,
  deleteSession,
  listOwnedAgentSessionIds,
  loadSession,
  listStoredSessionSummaries,
  markSessionClosed,
  saveSession,
  saveSessionAsync,
  saveSessionAsyncDeferred,
  setLiveSession,
} from '../src/runtime/agent/orchestrator/session/store.mjs';
import {
  _sessionPayloadForSaveWorker,
} from '../src/runtime/agent/orchestrator/session/store/save-worker.mjs';
import { createEngineApiB } from '../src/tui/engine/session-api-ext.mjs';

test('worker save payload removes disk-ineligible media before structured clone', () => {
  const imageData = 'a'.repeat(4 * 1024 * 1024);
  const toolOutput = 'tool output must remain durable';
  const session = {
    id: 'worker_payload_projection',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect this image' },
          { type: 'image', data: imageData, mimeType: 'image/png' },
        ],
      },
      { role: 'tool', content: toolOutput },
    ],
    liveTurnMessages: [{ role: 'assistant', content: 'duplicate live transcript' }],
    toolApprovalHook: () => {},
  };

  const payload = _sessionPayloadForSaveWorker(session);
  assert.equal(session.messages[0].content[1].data, imageData,
    'the live session must retain media for subsequent model turns');
  assert.equal(Object.hasOwn(payload, 'liveTurnMessages'), false);
  assert.equal(Object.hasOwn(payload, 'toolApprovalHook'), false);
  assert.match(payload.messages[0].content[1].text, /Image omitted from stored history/);
  assert.equal(payload.messages[1].content, toolOutput,
    'canonical tool history must not be truncated by clone optimization');
  assert.doesNotThrow(() => structuredClone(payload));
});

test('heavy runtime prewarm is armed after the first stream delta, never idle startup', () => {
  const core = readFileSync(
    fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url)),
    'utf8',
  );
  const startup = core.slice(
    core.indexOf("bootProfile('session-runtime:ready'"),
    core.indexOf('if (rt.remoteEnabled)'),
  );
  const turn = readFileSync(
    fileURLToPath(new URL('../src/session-runtime/session-turn-api.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(startup, /scheduleLeadSessionPrewarm|scheduleToolRuntimeWarmup\(\)|scheduleCodeGraphPrewarm\(/);
  assert.match(turn, /scheduleToolRuntimeWarmup\?\.\(0\)/);
  assert.match(turn, /scheduleCodeGraphPrewarm\?\.\(0, reason\)/);
  assert.match(turn, /armHeavyRuntimeWarmup\('first-stream'\)/);
});

test('first stream delta wins the TTFT path before heavy runtime prewarm', async () => {
  const events = [];
  let current = {
    id: 'ttft_session',
    provider: 'test',
    model: 'model',
    messages: [],
    tools: [],
    deferredToolCatalog: [],
    deferredInitialRefreshPending: false,
  };
  let activeTurns = 0;
  let firstTurnCompleted = false;
  let prewarmDone = false;
  let timing = null;
  const timingListener = (row) => { timing = row; };
  process.once('mixdog:turn-timing', timingListener);
  try {
    const runtime = createSessionTurnApi({
      getSession: () => current,
      setSession: (value) => { current = value; },
      getCurrentCwd: () => '/project',
      getActiveTurnCount: () => activeTurns,
      setActiveTurnCount: (value) => { activeTurns = value; },
      isFirstTurnCompleted: () => firstTurnCompleted,
      setFirstTurnCompleted: (value) => { firstTurnCompleted = value; },
      getCodeGraphFirstTurnPrewarmDone: () => prewarmDone,
      setCodeGraphFirstTurnPrewarmDone: (value) => { prewarmDone = value; },
      getRemoteEnabled: () => false,
      refreshSessionForCwdIfNeeded: async () => {},
      createCurrentSession: async () => current,
      scheduleToolRuntimeWarmup: () => events.push('tool-prewarm'),
      scheduleCodeGraphPrewarm: (_delay, reason) => events.push(`graph-prewarm:${reason}`),
      hooks: {
        emit: () => {},
        dispatch: async () => ({}),
      },
      hookCommonPayload: (value) => value,
      mgr: {
        askSession: async (...args) => {
          events.push('provider-dispatch');
          assert.deepEqual(events, ['mcp:150', 'provider-dispatch']);
          args[6].onStreamDelta('text');
          events.push('provider-streaming');
          return { content: 'done' };
        },
        getSession: () => current,
        enqueuePendingMessage: () => 0,
      },
      notifyFnForSession: () => () => {},
      awaitInitialMcpConnect: async (graceMs) => { events.push(`mcp:${graceMs}`); },
      mcpTurnGraceMs: 150,
      awaitRoutePreparation: async () => {},
      sessionTitles: {},
      scheduleProviderWarmup: () => {},
      scheduleProviderModelWarmup: () => {},
    });

    const submittedAt = Date.now() - 20;
    const response = await runtime.ask('hello', { id: 'ttft-request', submittedAt });
    assert.equal(response.result.content, 'done');
    assert.deepEqual(events, [
      'mcp:150',
      'provider-dispatch',
      'tool-prewarm',
      'graph-prewarm:first-stream',
      'provider-streaming',
    ]);
    assert.equal(activeTurns, 0);
    assert.equal(prewarmDone, true);
    assert.equal(timing?.status, 'first-delta');
    assert.equal(timing?.sessionId, current.id);
    assert.equal(timing?.requestId, 'ttft-request');
    assert.ok(timing?.endToEndTtftMs >= 20);
    assert.ok(timing?.queueMs >= 20);
    assert.ok(timing?.ttftMs >= timing?.providerMs);
  } finally {
    process.off('mixdog:turn-timing', timingListener);
  }
});

test('MCP connect wait is capped by the turn TTFT grace', async () => {
  const state = {
    mcpFailures: [],
    mcpConnectGeneration: 0,
    mcpConnectInFlight: new Promise(() => {}),
  };
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpStartupTimeoutMs: () => 10_000,
    },
    getConfig: () => ({}),
    getCurrentCwd: () => '/project',
    state,
  });
  let settled = false;
  const startedAt = performance.now();
  const waiting = glue.awaitInitialMcpConnect(25).then(() => { settled = true; });
  await delay(5);
  assert.equal(settled, false);
  await waiting;
  assert.ok(performance.now() - startedAt < 300);
});

test('generated titles persist through the shared session file and summary catalog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shared-session-title-'));
  try {
    const storeUrl = new URL('../src/runtime/agent/orchestrator/session/store.mjs', import.meta.url).href;
    const crudUrl = new URL('../src/runtime/agent/orchestrator/session/manager/session-crud.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.MIXDOG_DATA_DIR = ${JSON.stringify(root)};
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { saveSession, drainSessionStore, listStoredSessionSummaries } = await import(${JSON.stringify(storeUrl)});
      const { updateSessionGeneratedTitle, updateSessionManualTitle } = await import(${JSON.stringify(crudUrl)});
      const session = {
        id: 'shared_generated_title',
        owner: 'cli',
        agent: 'lead',
        sourceType: 'lead',
        generation: 0,
        createdAt: 10,
        updatedAt: 20,
        lastUsedAt: 20,
        messages: [
          { role: 'user', content: 'Original preview' },
          { role: 'assistant', content: 'Original answer' },
        ],
      };
      saveSession(session, { sync: true });
      const promoted = await updateSessionGeneratedTitle(session.id, 'Durable shared title', 'first');
      const renamed = await updateSessionManualTitle(session.id, 'Manual shared title');
      const overwritten = await updateSessionGeneratedTitle(session.id, 'Late generated title', 'third');
      drainSessionStore();
      const stored = JSON.parse(readFileSync(join(
        ${JSON.stringify(root)}, 'sessions', session.id + '.json',
      ), 'utf8'));
      const row = listStoredSessionSummaries({ refreshFromStorage: true })
        .find((entry) => entry.id === session.id);
      process.stdout.write(JSON.stringify({ promoted, renamed, overwritten, stored, row }));
    `], { encoding: 'utf8' });
    const { promoted, renamed, overwritten, stored, row } = JSON.parse(output);
    assert.equal(promoted, true);
    assert.equal(renamed, true);
    assert.equal(overwritten, false);
    assert.equal(stored.title, 'Manual shared title');
    assert.equal(stored.titleLocked, true);
    assert.equal(stored.generatedTitleStage, 'first');
    assert.equal(stored.updatedAt, 20, 'metadata-only title updates must not reorder Recent');
    assert.equal(row.title, 'Manual shared title');
    assert.equal(row.preview, 'Original preview');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deferred terminal save is registered for immediate exit drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-deferred-terminal-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const session = {
      id: 'deferred_terminal_exit',
      owner: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ role: 'assistant', content: 'terminal state' }],
    };
    const pending = saveSessionAsyncDeferred(session);
    drainSessionStore();
    await pending;
    assert.equal(loadSession(session.id)?.messages?.[0]?.content, 'terminal state');
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('exit drain writes deferred terminal state after an older worker-pending save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-deferred-order-'));
  try {
    const storeUrl = new URL('../src/runtime/agent/orchestrator/session/store.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.MIXDOG_DATA_DIR = ${JSON.stringify(root)};
      const { saveSessionAsync, saveSessionAsyncDeferred, drainSessionStore, loadSession } = await import(${JSON.stringify(storeUrl)});
      const base = { id: 'deferred_order_exit', owner: 'user', createdAt: Date.now(), updatedAt: Date.now() };
      saveSessionAsync({ ...base, messages: [{ role: 'assistant', content: 'older worker snapshot' }], padding: 'x'.repeat(2_000_000) }).catch(() => {});
      const terminal = saveSessionAsyncDeferred({ ...base, updatedAt: Date.now() + 1, messages: [{ role: 'assistant', content: 'newest terminal snapshot' }] });
      drainSessionStore();
      await Promise.allSettled([terminal]);
      process.stdout.write(loadSession(base.id)?.messages?.[0]?.content || '');
      process.exit(0);
    `], { encoding: 'utf8' });
    assert.equal(output, 'newest terminal snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop classification is optional and round-trips through the existing summary index', () => {
  const task = _sessionSummary({
    id: 'lead_task',
    owner: 'cli',
    agent: 'lead',
    cwd: '/app/workspace',
    updatedAt: 20,
    lastUsedAt: 12,
      title: 'Shared task title',
    desktopSession: { classification: 'task', projectPath: null },
  });
  const project = _normalizeSummaryIndex({
    rows: [{
      id: 'lead_project',
      cwd: '/project',
      updatedAt: 30,
      lastUsedAt: 15,
      title: 'Shared project title',
      desktopSession: { classification: 'project', projectPath: '/project' },
    }],
  }).rows[0];
  const legacy = _normalizeSummaryIndex({ rows: [{ id: 'legacy', cwd: '/old' }] }).rows[0];
  const malformed = _normalizeSummaryIndex({
    rows: [{ id: 'malformed', desktopSession: { classification: 'worker' } }],
  }).rows[0];

  assert.deepEqual(task.desktopSession, { classification: 'task', projectPath: null });
  assert.deepEqual(project.desktopSession, { classification: 'project', projectPath: '/project' });
  assert.equal(task.lastUsedAt, 12);
  assert.equal(project.lastUsedAt, 15);
  assert.equal(task.title, 'Shared task title');
  assert.equal(project.title, 'Shared project title');
  assert.equal(legacy.desktopSession, null);
  assert.equal(malformed.desktopSession, null);
});

test('cold summary reader loads the sidecar without importing the full store', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cold-summary-reader-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: SESSION_SUMMARY_INDEX_VERSION,
      rows: [{
        id: 'cold_reader',
        updatedAt: 10,
        cwd: '/workspace',
        title: 'Cold durable title',
        preview: 'Cold reader session',
        desktopSession: { classification: 'task', projectPath: null },
      }],
    }));
    const [row] = listLightweightSessionSummaries();
    assert.equal(row.id, 'cold_reader');
    assert.equal(row.title, 'Cold durable title');
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold summary reader falls back to session files when a non-empty sidecar is stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cold-summary-stale-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const indexPath = join(root, 'session-summaries.json');
    writeFileSync(indexPath, JSON.stringify({
      version: SESSION_SUMMARY_INDEX_VERSION,
      rows: [{
        id: 'stale_reader',
        updatedAt: 10,
        cwd: '/workspace',
        preview: 'Stale sidecar title',
        messageCount: 1,
      }],
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(indexPath, old, old);
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'stale_reader.json'), JSON.stringify({
      id: 'stale_reader',
      owner: 'user',
      agent: 'lead',
      updatedAt: Date.now(),
      cwd: '/workspace',
      messages: [{ role: 'user', content: 'Recovered current title' }],
    }));

    const rows = listLightweightSessionSummaries();
    assert.equal(rows.find((row) => row.id === 'stale_reader')?.preview, 'Recovered current title');
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSession reuses a parsed session until the atomic file identity changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-load-cache-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const target = join(sessions, 'cached_parse.json');
    writeFileSync(target, JSON.stringify({
      id: 'cached_parse',
      messages: [{ role: 'user', content: 'first version' }],
    }));
    const first = loadSession('cached_parse');
    const second = loadSession('cached_parse');
    assert.equal(second, first);
    writeFileSync(target, JSON.stringify({
      id: 'cached_parse',
      messages: [{ role: 'user', content: 'changed version with a different size' }],
    }));
    const changed = loadSession('cached_parse');
    assert.notEqual(changed, first);
    assert.equal(changed.messages[0].content, 'changed version with a different size');
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('session summaries use the first real user request and remove injected display blocks', () => {
  const summary = _sessionSummary({
    id: 'clean_title_source',
    owner: 'user',
    messages: [
      { role: 'user', content: '<system-reminder>runtime bootstrap</system-reminder>' },
      {
        role: 'user',
        content: 'A previous model worked on this task and produced the compacted handoff summary below. Build on it.',
      },
      {
        role: 'user',
        content: 'Reference files: [Image #1] <mcp-instructions>internal tools</mcp-instructions> Align the project dropdown',
      },
      { role: 'user', content: 'The async agent task task_agent completed with internal output.' },
      { role: 'user', content: 'A later follow-up must not replace the stable title source' },
    ],
  });

  assert.equal(summary.preview, 'Align the project dropdown');
});

test('session summary message projection updates append, mutation, and replacement paths', () => {
  const session = {
    id: 'summary_projection_cache',
    messages: [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first response' },
    ],
  };
  const first = _sessionSummary(session);
  assert.equal(first.messageCount, 2);
  assert.equal(first.preview, 'first request');

  session.messages.push({ role: 'assistant', content: 'second response' });
  const appended = _sessionSummary(session);
  assert.equal(appended.messageCount, 3);

  session.messages[0].content = 'updated first request';
  assert.equal(_sessionSummary(session).preview, 'updated first request');

  session.messages = [{ role: 'user', content: 'replacement request' }];
  const replaced = _sessionSummary(session);
  assert.equal(replaced.messageCount, 1);
  assert.equal(replaced.preview, 'replacement request');
});

test('authoritative summary refresh repairs a stale index and skips malformed session files', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-summary-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: 1,
      rows: [{
        id: 'desktop_old',
        updatedAt: 1,
        cwd: '/old',
        desktopSession: { classification: 'task', projectPath: null },
      }],
    }));
    writeFileSync(join(sessions, 'desktop_new.json'), JSON.stringify({
      id: 'desktop_new',
      owner: 'user',
      agent: 'lead',
      updatedAt: 20,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Newly persisted desktop task' }],
    }));
    writeFileSync(join(sessions, 'cli_only.json'), JSON.stringify({
      id: 'cli_only',
      owner: 'user',
      updatedAt: 10,
      cwd: '/cli',
      messages: [{ role: 'user', content: 'CLI only' }],
    }));
    writeFileSync(join(sessions, 'broken.json'), '{"id":');

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.deepEqual(rows.map((row) => row.id), ['desktop_new', 'cli_only']);
    assert.deepEqual(
      rows.find((row) => row.id === 'desktop_new').desktopSession,
      { classification: 'task', projectPath: null },
    );
    assert.equal(rows.find((row) => row.id === 'cli_only').desktopSession, null);
    const repaired = JSON.parse(readFileSync(join(root, 'session-summaries.json'), 'utf8'));
    assert.deepEqual(repaired.rows.map((row) => row.id), ['desktop_new', 'cli_only']);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('cached summaries reflect local lifecycle mutations and forced refresh reconciles disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-cache-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'indexed.json'), JSON.stringify({
      id: 'indexed', owner: 'user', updatedAt: 10, messages: [],
    }));
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: 1, rows: [{ id: 'indexed', owner: 'user', updatedAt: 10 }],
    }));

    assert.deepEqual(listStoredSessionSummaries().map((row) => row.id), [],
      'a missing or stale index must return without scanning transcripts on the caller thread');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (listStoredSessionSummaries().some((row) => row.id === 'indexed')) break;
      await delay(10);
    }
    assert.deepEqual(listStoredSessionSummaries().map((row) => row.id), ['indexed']);
    assert.equal(
      JSON.parse(readFileSync(join(root, 'session-summaries.json'), 'utf8')).version,
      SESSION_SUMMARY_INDEX_VERSION,
    );

    saveSession({
      id: 'cached_new', owner: 'user', updatedAt: 20,
      messages: [{ role: 'user', content: 'Cached local session' }],
    }, { sync: true });
    assert.deepEqual(
      listStoredSessionSummaries().map((row) => row.id),
      ['cached_new', 'indexed'],
    );

    await saveSessionAsync({
      id: 'cached_async', owner: 'user', updatedAt: 25,
      messages: [{ role: 'user', content: 'Cached async session' }],
    });
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'cached_async'), true);
    assert.equal(deleteSession('cached_async'), true);

    assert.notEqual(markSessionClosed('cached_new', 'test'), null);
    assert.equal(
      listStoredSessionSummaries().find((row) => row.id === 'cached_new').closed,
      true,
    );
    assert.equal(deleteSession('cached_new'), true);
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'cached_new'), false);

    writeFileSync(join(sessions, 'external.json'), JSON.stringify({
      id: 'external', owner: 'user', updatedAt: 30, messages: [],
    }));
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'external'), false);
    assert.deepEqual(
      listStoredSessionSummaries({ refreshFromStorage: true }).map((row) => row.id),
      ['external', 'indexed'],
    );
    unlinkSync(join(sessions, 'external.json'));
    assert.deepEqual(
      listStoredSessionSummaries({ refreshFromStorage: true }).map((row) => row.id),
      ['indexed'],
    );
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('authoritative refresh trusts disk over stale live state while preserving unsettled local writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-races-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'authoritative.json'), JSON.stringify({
      id: 'authoritative',
      owner: 'user',
      closed: true,
      status: 'closed',
      updatedAt: 40,
      desktopSession: { classification: 'project', projectPath: '/disk-project' },
      messages: [],
    }));
    setLiveSession({
      id: 'authoritative',
      owner: 'agent:stale',
      closed: false,
      updatedAt: 99,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [],
    });
    let rows = listStoredSessionSummaries({ refreshFromStorage: true });
    const authoritative = rows.find((row) => row.id === 'authoritative');
    assert.equal(authoritative.closed, true);
    assert.equal(authoritative.owner, 'user');
    assert.deepEqual(authoritative.desktopSession, { classification: 'project', projectPath: '/disk-project' });

    unlinkSync(join(sessions, 'authoritative.json'));
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'authoritative'),
      false,
    );

    saveSession({
      id: 'pending_desktop',
      owner: 'user',
      updatedAt: 50,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Visible before debounce flush' }],
    });
    assert.equal(existsSync(join(sessions, 'pending_desktop.json')), false);
    rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_desktop'), true);
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'pending_desktop'), true);
    // Delete contract: an ABSENT canonical record is an idempotent SUCCESS —
    // the debounced save is purged with the id, so the session no longer
    // exists once the call returns. `false` means "nothing deleted AND nothing
    // mutated" (veto, unreadable probe, foreign bytes, failed unlink).
    assert.equal(deleteSession('pending_desktop'), true);
    await new Promise((resolve) => setTimeout(resolve, 225));
    assert.equal(existsSync(join(sessions, 'pending_desktop.json')), false);
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'pending_desktop'),
      false,
    );

    const first = saveSessionAsync({
      id: 'worker_deleted',
      owner: 'user',
      updatedAt: 60,
      messages: [{ role: 'user', content: 'First queued worker write' }],
    });
    const second = saveSessionAsync({
      id: 'worker_deleted',
      owner: 'user',
      updatedAt: 61,
      messages: [{ role: 'user', content: 'Latest queued worker write' }],
    });
    deleteSession('worker_deleted');
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(join(sessions, 'worker_deleted.json')), false);
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'worker_deleted'),
      false,
    );
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('authoritative refresh rejects filename and embedded session id mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-identity-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'cli_transcript.json'), JSON.stringify({
      id: 'cli_transcript',
      owner: 'user',
      updatedAt: 10,
      messages: [{ role: 'user', content: 'Legitimate CLI transcript' }],
    }));
    // Without filename/id validation this duplicate row could lend desktop
    // metadata to cli_transcript, then resume the legitimate CLI-owned file.
    writeFileSync(join(sessions, 'desktop_spoof.json'), JSON.stringify({
      id: 'cli_transcript',
      owner: 'user',
      updatedAt: 30,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Spoofed desktop authorization' }],
    }));
    writeFileSync(join(sessions, 'desktop_good.json'), JSON.stringify({
      id: 'desktop_good',
      owner: 'user',
      updatedAt: 20,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Legitimate desktop task' }],
    }));
    writeFileSync(join(sessions, 'duplicate_copy.json'), JSON.stringify({
      id: 'desktop_good',
      owner: 'user',
      updatedAt: 40,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Mismatched duplicate' }],
    }));

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.deepEqual(rows.map((row) => row.id), ['desktop_good', 'cli_transcript']);
    assert.equal(rows.find((row) => row.id === 'desktop_good').preview, 'Legitimate desktop task');
    assert.equal(rows.find((row) => row.id === 'cli_transcript').desktopSession, null);
    assert.equal(loadSession('cli_transcript').messages[0].content, 'Legitimate CLI transcript');
    assert.equal(loadSession('desktop_spoof'), null);
    assert.equal(loadSession('duplicate_copy'), null);
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative refresh fails closed when the session directory is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-unreadable-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: SESSION_SUMMARY_INDEX_VERSION,
      rows: [{
        id: 'stale_desktop',
        updatedAt: 1,
        desktopSession: { classification: 'task', projectPath: null },
      }],
    }));
    // A non-directory at the authoritative storage path deterministically
    // exercises readdir failure on Windows and POSIX.
    writeFileSync(join(root, 'sessions'), 'not a directory');

    assert.deepEqual(listStoredSessionSummaries({ refreshFromStorage: true }), []);
    assert.deepEqual(
      listStoredSessionSummaries({ rebuildIfMissing: false }).map((row) => row.id),
      ['stale_desktop'],
    );
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative refresh includes a desktop session still in the debounce window', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-pending-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    saveSession({
      id: 'desktop_pending',
      owner: 'user',
      agent: 'lead',
      updatedAt: 50,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Immediate desktop task' }],
    });

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'desktop_pending'), true);
    assert.equal(rows.find((row) => row.id === 'desktop_pending').preview, 'Immediate desktop task');
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid existing disk identities block same-id pending and live state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-live-blocked-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'pending_mismatch.json'), JSON.stringify({
      id: 'different_transcript',
      owner: 'user',
      messages: [{ role: 'user', content: 'Mismatched disk transcript' }],
    }));
    writeFileSync(join(sessions, 'pending_malformed.json'), '{"id":');

    for (const id of ['pending_mismatch', 'pending_malformed']) {
      saveSession({
        id,
        owner: 'user',
        agent: 'lead',
        updatedAt: 60,
        cwd: '/app/workspace',
        desktopSession: { classification: 'task', projectPath: null },
        messages: [{ role: 'user', content: `Pending replacement ${id}` }],
      });
    }

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_mismatch'), false);
    assert.equal(rows.some((row) => row.id === 'pending_malformed'), false);
    assert.equal(loadSession('pending_mismatch'), null);
    assert.equal(loadSession('pending_malformed'), null);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFileSync failure blocks same-id pending and live state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-read-error-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const readErrorPath = join(root, 'sessions', 'pending_read_error.json');
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    // A directory with a .json storage name is visible to readdirSync and
    // existsSync, but readFileSync itself fails on supported desktop platforms.
    // This deterministically exercises the I/O catch before JSON.parse.
    mkdirSync(readErrorPath);
    saveSession({
      id: 'pending_read_error',
      owner: 'user',
      agent: 'lead',
      updatedAt: 70,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Pending replacement after read error' }],
    });

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_read_error'), false);
    assert.equal(loadSession('pending_read_error'), null);
  } finally {
    // Remove the deliberate directory collision so draining the pending test
    // save can complete without changing production failure behavior.
    rmSync(readErrorPath, { recursive: true, force: true });
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('session creation accepts only explicit desktop classification metadata', () => {
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'task', projectPath: '/ignored' }, '/cwd'),
    { classification: 'task', projectPath: null },
  );
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'project' }, '/project'),
    { classification: 'project', projectPath: '/project' },
  );
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'project', projectPath: '  /project/trimmed  ' }, '/fallback'),
    { classification: 'project', projectPath: '/project/trimmed' },
  );
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project', projectPath: {} }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project', projectPath: '\0bad' }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project' }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'worker' }, '/cwd'), null);
  assert.equal(normalizeDesktopSessionMetadata({}, '/cwd'), null);
  assert.equal(normalizeDesktopSessionMetadata(null, '/cwd'), null);
});

test('desktop resume pins projects and unclassified tasks to their host-managed scope', () => {
  assert.equal(resolveResumeCwd({
    cwd: '/stale',
    desktopSession: { classification: 'project', projectPath: '/project' },
  }, '/app/workspace'), '/project');
  assert.equal(resolveResumeCwd({
    cwd: '/transient',
    desktopSession: { classification: 'task', projectPath: null },
  }, '/app/workspace'), '/app/workspace');
  assert.equal(resolveResumeCwd({ cwd: '/cli' }, '/current'), '/cli');
});

test('new desktop sessions immediately repoint remote transcript forwarding', async () => {
  let current = null;
  const events = [];
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    mgr: { closeSession: () => true },
    invalidateContextStatusCache: () => events.push('invalidate'),
    createCurrentSession: async () => {
      events.push('create');
      current = { id: 'desktop_new', messages: [] };
    },
    pushTranscriptRebind: () => events.push('rebind'),
  });

  assert.equal(await runtime.newSession(), 'desktop_new');
  assert.deepEqual(events, ['invalidate', 'create', 'rebind']);
});

test('session deletion hard-deletes inactive rows and safely replaces the active row', async () => {
  let current = {
    id: 'desktop_active',
    owner: 'user',
    sourceType: 'cli',
    messages: [{ role: 'user', content: 'Active session' }],
  };
  const rows = [
    current,
    {
      id: 'desktop_inactive',
      owner: 'user',
      sourceType: 'cli',
      messages: [{ role: 'user', content: 'Inactive session' }],
    },
  ];
  const events = [];
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    mgr: {
      listSessions: () => rows,
      listOwnedAgentSessionIds: (id) => [`agent_for_${id}`],
      deleteSession: (id) => { events.push(['delete', id]); return true; },
      closeSession: (...args) => { events.push(['close', ...args]); return true; },
    },
    cancelBackgroundTasks: (options) => events.push(['background', options]),
    agentTool: { closeAll: (reason) => events.push(['agents', reason]) },
    statusRoutes: { clearGatewaySessionRoute: (id) => events.push(['route', id]) },
    invalidateContextStatusCache: () => events.push(['context']),
    invalidatePreSessionToolSurface: () => events.push(['surface']),
    createCurrentSession: async () => {
      current = { id: 'desktop_replacement', messages: [] };
      events.push(['create', current.id]);
    },
    pushTranscriptRebind: () => events.push(['rebind']),
  });

  assert.equal(await runtime.deleteSession('desktop_inactive'), true);
  assert.deepEqual(events.shift(), ['delete', 'desktop_inactive']);
  assert.deepEqual(events.shift(), ['delete', 'agent_for_desktop_inactive']);
  assert.equal(await runtime.deleteSession('desktop_active'), true);
  assert.equal(current.id, 'desktop_replacement');
  assert.deepEqual(events, [
    ['background', {
      reason: 'desktop-session-delete',
      notify: false,
      callerSessionId: 'desktop_active',
    }],
    ['agents', 'desktop-session-delete'],
    ['route', 'desktop_active'],
    ['close', 'desktop_active', 'desktop-session-delete', { tombstone: true }],
    ['close', 'agent_for_desktop_active', 'desktop-session-delete', { tombstone: true }],
    ['context'],
    ['surface'],
    ['create', 'desktop_replacement'],
    ['rebind'],
  ]);
});

test('missing child transcript projects the final archived result from its parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-archived-agent-result-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const childId = 'sess_missing_archived_agent';
    const parentId = 'sess_archived_agent_parent';
    writeFileSync(join(sessions, `${parentId}.json`), JSON.stringify({
      id: parentId,
      owner: 'user',
      cwd: '/project',
      updatedAt: 500,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{
        role: 'user',
        content: `The async agent task task_agent_1 has finished (completed) - review this result in your next step.\n\nResult:\n> background task\n> task_id: task_agent_1\n> surface: agent\n> operation: spawn\n> label: fix-dom-2\n> status: completed\n> finished: 2026-08-01T13:06:26.828Z\n> tag: fix-dom-2\n> sessionId: ${childId}\n> agent: worker\n> provider: anthropic-oauth\n> model: claude-opus-5\n> effort: low\n> fast: false\n> \n> agent result tag=fix-dom-2 agent=worker anthropic-oauth/claude-opus-5\n> Recovered final result body.`,
        meta: { transcript: { at: 700 } },
      }],
    }));

    const restored = await readStoredSessionTranscript(childId);
    assert.equal(restored.archivedAgentResult, true);
    assert.equal(restored.sessionId, childId);
    assert.equal(restored.provider, 'anthropic-oauth');
    assert.equal(restored.model, 'claude-opus-5');
    assert.match(restored.items[0].text, /^# Archived agent result/);
    assert.match(restored.items[0].text, /Recovered final result body/);
    assert.equal(await readStoredSessionTranscript('sess_fully_missing_agent'), null);
    assert.deepEqual(listOwnedAgentSessionIds(parentId), [],
      'notification references never masquerade as owned child session files');
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime resume returns the persisted transcript and restores desktop task scope', async () => {
  let current = null;
  let cwd = '/app/workspace';
  let route = { provider: 'test', model: 'model' };
  let transcriptRebinds = 0;
  const messages = [
    { role: 'user', content: 'Persisted question' },
    { role: 'assistant', content: 'Persisted answer' },
  ];
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getRoute: () => route,
    setRoute: (value) => { route = value; },
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => cwd,
    desktopSession: { classification: 'task', projectPath: null },
    setSessionNeedsCwdRefresh: () => {},
    mgr: {
      resumeSession: async (id, _preset, options) => {
        assert.deepEqual(options, {
          desktopSession: { classification: 'task', projectPath: null },
        });
        return {
          id,
          provider: 'test',
          model: 'model',
          cwd: '/stale-task-cwd',
          desktopSession: { classification: 'task', projectPath: null },
          messages,
        };
      },
    },
    statusRoutes: {},
    createCurrentSession: async () => {},
    refreshRouteEffort: async () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    applyResolvedCwd: (value) => { cwd = value; },
    resolveRoute: (_config, value) => value,
    applyDeferredToolSurface: () => {},
    getStandaloneTools: () => [],
    pushTranscriptRebind: () => { transcriptRebinds += 1; },
  });

  const resumed = await runtime.resume('desktop_task');
  assert.deepEqual(resumed.messages, messages);
  assert.equal(resumed.cwd, '/app/workspace');
  assert.equal(current.cwd, '/app/workspace');
  assert.equal(transcriptRebinds, 1);
});

test('runtime session prefetch warms the manager without changing the active session', () => {
  const calls = [];
  const current = { id: 'active', messages: [] };
  const runtime = createLifecycleApi({
    getSession: () => current,
    getMode: () => 'full',
    mgr: {
      prefetchSession: (...args) => {
        calls.push(args);
        return true;
      },
    },
  });

  assert.equal(runtime.prefetchSession('next'), true);
  assert.deepEqual(calls, [['next', 'full']]);
  assert.equal(current.id, 'active');
});

test('runtime read-only peek returns a durably closed historical session', () => {
  const current = { id: 'active', messages: [] };
  const historical = {
    id: 'closed_history',
    closed: true,
    provider: 'test',
    model: 'historical-model',
    messages: [
      { role: 'user', content: 'Persisted question' },
      { role: 'assistant', content: 'Persisted answer' },
    ],
  };
  const recovered = [];
  const runtime = createLifecycleApi({
    getSession: () => current,
    mgr: {
      recoverSessionAfterProcessRestart: (id) => {
        recovered.push(id);
        return id === historical.id ? historical : null;
      },
    },
  });

  assert.equal(runtime.peekSession(current.id), current);
  assert.deepEqual(recovered, [], "the live local session must not be crash-reconciled by a peek");
  assert.equal(runtime.peekSession(historical.id), historical);
  assert.deepEqual(recovered, [historical.id]);
  assert.equal(current.id, 'active', "peek must not resume or replace the active session");
  assert.equal(runtime.peekSession('missing_history'), null);
  assert.deepEqual(recovered, [historical.id, 'missing_history']);
});

test('runtime read-only peek applies the prepared tool projection without switching sessions', () => {
  const current = { id: 'active', messages: [] };
  const historical = {
    id: 'prepared_history',
    provider: 'test',
    model: 'historical-model',
    messages: [{ role: 'user', content: 'Meter current tools' }],
    tools: [{ name: 'stale' }],
  };
  const preparedCalls = [];
  const runtime = createLifecycleApi({
    getSession: () => current,
    getMode: () => 'full',
    mgr: {
      recoverSessionAfterProcessRestart: () => historical,
      prepareSessionProjection: (session, preset) => {
        preparedCalls.push([session, preset]);
        return { ...session, tools: [{ name: 'current' }] };
      },
    },
  });

  const projected = runtime.peekSession(historical.id);
  assert.notEqual(projected, historical);
  assert.deepEqual(projected.tools, [{ name: 'current' }]);
  assert.deepEqual(preparedCalls, [[historical, 'full']]);
  assert.equal(current.id, 'active');
});

test('engine read-only peek publishes live-calculated context fields for a cold pane', () => {
  const session = {
    id: 'cold_context',
    provider: 'openai',
    model: 'gpt-5.4',
    cwd: '/workspace',
    contextWindow: 272_000,
    rawContextWindow: 272_000,
    effectiveContextWindowPercent: 100,
    messages: [{ role: 'user', content: 'Cold context projection' }],
  };
  const api = createEngineApiB({
    runtime: {
      peekSession: () => session,
      contextStatusForSession: (received) => {
        assert.equal(received, session);
        return {
          usedTokens: 87_000,
          usedSource: 'estimated',
          currentEstimatedTokens: 87_000,
          contextWindow: 244_800,
          effectiveContextWindow: 272_000,
          rawContextWindow: 272_000,
          effectiveContextWindowPercent: 100,
          compaction: {
            boundaryTokens: 272_000,
            triggerTokens: 244_800,
          },
          usage: { lastContextTokens: 80_000 },
        };
      },
    },
  });

  const projected = api.peekSessionTranscript(session.id);
  assert.equal(projected.stats.currentEstimatedContextTokens, 87_000);
  assert.equal(projected.stats.currentContextSource, 'estimated');
  assert.equal(projected.contextWindow, 272_000);
  assert.equal(projected.rawContextWindow, 272_000);
  assert.equal(projected.displayContextWindow, 244_800);
  assert.equal(projected.compactBoundaryTokens, 272_000);
  assert.equal(projected.autoCompactTokenLimit, 244_800);
  assert.equal(projected.effectiveContextWindowPercent, 100);
});

test('desktop context switches retain runtime resources while durably closing the old session', async () => {
  let current = {
    id: 'old',
    messages: [{ role: 'user', content: 'keep me' }],
    liveTurnMessages: [],
  };
  let cwd = '/old';
  let desktopSession = { classification: 'task', projectPath: null };
  let route = { provider: 'resumed-provider', model: 'resumed-model' };
  const closed = [];
  const cleanup = [];
  let releaseMcp;
  const mcpReset = new Promise((resolve) => { releaseMcp = resolve; });
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getDesktopSession: () => desktopSession,
    setDesktopSession: (value) => { desktopSession = value; },
    getRoute: () => route,
    setRoute: (value) => { route = value; },
    getConfig: () => ({ default: 'workflow-lead' }),
    getCurrentCwd: () => cwd,
    mgr: { closeSession: (...args) => { closed.push(args); return true; } },
    cancelBackgroundTasks: (options) => cleanup.push(['background', options]),
    agentTool: { closeAll: (reason) => cleanup.push(['agents', reason]) },
    statusRoutes: { clearGatewaySessionRoute: (id) => cleanup.push(['route', id]) },
    applyResolvedCwd: (value, options) => {
      // Mirror the real contract: the cwd applies in place immediately while
      // the project MCP reset continues in the background; the switch must not
      // block on it.
      cleanup.push(['cwd:start', value, options]);
      cwd = value;
      void mcpReset.then(() => cleanup.push(['mcp:ready', value]));
      return value;
    },
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    refreshRouteEffort: async () => {},
    resolveRoute: (_config, value) => Object.keys(value).length > 0
      ? value
      : { provider: 'configured-provider', model: 'configured-model' },
  });

  let settled = false;
  const switching = runtime.switchContext({
    cwd: '/project',
    desktopSession: { classification: 'project', projectPath: '/project' },
  });
  switching.then(() => { settled = true; });
  // Non-blocking switch: it settles WITHOUT the MCP reset resolving. The
  // reconnect gate moved to the ask path (bounded awaitInitialMcpConnect).
  await switching;
  assert.equal(settled, true);
  assert.deepEqual(cleanup.slice(0, 4), [
    ['background', {
      reason: 'desktop-context-switch',
      notify: false,
      callerSessionId: 'old',
    }],
    ['agents', 'desktop-context-switch'],
    ['route', 'old'],
    ['cwd:start', '/project', { markRefresh: false }],
  ]);
  releaseMcp();
  await mcpReset;

  assert.deepEqual(closed, [['old', 'desktop-context-switch', { tombstone: false }]]);
  assert.equal(current, null);
  assert.equal(cwd, '/project');
  assert.deepEqual(route, { provider: 'configured-provider', model: 'configured-model' });
  assert.deepEqual(desktopSession, { classification: 'project', projectPath: '/project' });
});

test('resume context switches skip default route initialization', async () => {
  let route = { provider: 'historical-provider', model: 'historical-model' };
  let refreshCalls = 0;
  let cleared = 0;
  const runtime = createLifecycleApi({
    getSession: () => null,
    setSession: () => {},
    getDesktopSession: () => null,
    setDesktopSession: () => {},
    getRoute: () => route,
    setRoute: (value) => { route = value; },
    getConfig: () => ({ default: 'configured' }),
    getCurrentCwd: () => '/old',
    applyResolvedCwd: () => {},
    resolveRoute: () => ({ provider: 'configured-provider', model: 'configured-model' }),
    refreshRouteEffort: async () => { refreshCalls += 1; },
    clearRoutePreparation: () => { cleared += 1; },
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
  });

  assert.equal(await runtime.switchContext({
    cwd: '/resume',
    desktopSession: null,
    forResume: true,
  }), true);
  assert.deepEqual(route, { provider: 'historical-provider', model: 'historical-model' });
  assert.equal(refreshCalls, 0);
  assert.equal(cleared, 1);
});

test('resume returns before route preparation and the next turn waits on the same gate', async () => {
  const routeError = new Error('route preparation failed');
  let releaseRoute;
  const routeBlocked = new Promise((resolve) => { releaseRoute = resolve; });
  let refreshStarted = false;
  let current = null;
  let route = {};
  const resumed = {
    id: 'deferred_route',
    provider: 'provider',
    model: 'model',
    cwd: '/resume',
    messages: [{ role: 'user', content: 'history' }],
  };
  const gate = createRoutePreparationGate();
  const lifecycle = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getDesktopSession: () => null,
    getRoute: () => route,
    setRoute: (value) => { route = value; },
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => '/resume',
    mgr: { resumeSession: async () => resumed },
    statusRoutes: {},
    applyResolvedCwd: () => {},
    resolveRoute: (_config, value) => ({ ...value }),
    refreshRouteEffort: async () => {
      refreshStarted = true;
      await routeBlocked;
      throw routeError;
    },
    beginRoutePreparation: (task) => gate.start(task),
    clearRoutePreparation: () => gate.clear(),
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    setSessionNeedsCwdRefresh: () => {},
    applyDeferredToolSurface: () => {},
    getStandaloneTools: () => [],
    pushTranscriptRebind: () => {},
  });

  const result = await lifecycle.resume(resumed.id);
  assert.equal(result.id, resumed.id);
  await Promise.resolve();
  assert.equal(refreshStarted, true);

  let activeTurns = 0;
  const turns = createSessionTurnApi({
    getSession: () => current,
    awaitRoutePreparation: () => gate.wait(),
    getActiveTurnCount: () => activeTurns,
    setActiveTurnCount: (value) => { activeTurns = value; },
  });
  let turnSettled = false;
  const pendingTurn = turns.ask('next prompt').finally(() => { turnSettled = true; });
  await Promise.resolve();
  assert.equal(turnSettled, false);
  assert.equal(activeTurns, 0);

  releaseRoute();
  await assert.rejects(pendingTurn, routeError);
  assert.equal(activeTurns, 0);
});

test('attached viewers leave locally without closing the live owner session', async () => {
  const closed = [];
  const attachedSession = () => ({
    id: 'live_owner_session',
    remoteAttached: true,
    provider: 'test',
    model: 'model',
    cwd: '/viewer',
    messages: [{ role: 'user', content: 'owned elsewhere' }],
    liveTurnMessages: [],
  });
  const baseDeps = (getSession, setSession) => ({
    getSession,
    setSession,
    getRoute: () => ({ provider: 'test', model: 'model' }),
    setRoute: () => {},
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => '/viewer',
    getDesktopSession: () => null,
    setDesktopSession: () => {},
    setSessionNeedsCwdRefresh: () => {},
    mgr: { closeSession: (...args) => { closed.push(args); return true; } },
    statusRoutes: {},
    cancelBackgroundTasks: () => {},
    agentTool: { closeAll: () => {} },
    createCurrentSession: async () => {},
    refreshRouteEffort: async () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    applyResolvedCwd: () => {},
    resolveRoute: (_config, value) => value,
    applyDeferredToolSurface: () => {},
    getStandaloneTools: () => [],
    pushTranscriptRebind: () => {},
  });

  let current = attachedSession();
  const switchRuntime = createLifecycleApi(baseDeps(
    () => current,
    (value) => { current = value; },
  ));
  await switchRuntime.switchContext({ cwd: '/next', desktopSession: null });
  assert.equal(current, null);

  current = attachedSession();
  const newRuntime = createLifecycleApi({
    ...baseDeps(() => current, (value) => { current = value; }),
    createCurrentSession: async () => { current = { id: 'new_session', messages: [] }; },
  });
  assert.equal(await newRuntime.newSession(), 'new_session');

  current = attachedSession();
  const resumed = {
    id: 'next_session',
    provider: 'test',
    model: 'model',
    cwd: '/next',
    messages: [],
  };
  const resumeRuntime = createLifecycleApi({
    ...baseDeps(() => current, (value) => { current = value; }),
    mgr: {
      closeSession: (...args) => { closed.push(args); return true; },
      resumeSession: async () => resumed,
    },
  });
  assert.equal((await resumeRuntime.resume('next_session')).id, 'next_session');
  assert.equal(current, resumed);
  assert.deepEqual(closed, []);
});

test('remote-attached fallback queues without manufacturing an assistant reply', async () => {
  const queued = [];
  const attached = { id: 'live_owner_session', remoteAttached: true };
  const runtime = createSessionTurnApi({
    getSession: () => attached,
    mgr: {
      enqueueRemotePendingMessage: (id, prompt) => {
        queued.push([id, prompt]);
        return 1;
      },
    },
  });

  assert.equal(runtime.enqueueRemoteAttachedPrompt('direct fallback'), true);
  const response = await runtime.ask('ask race fallback');
  assert.equal(response.result.content, '');
  assert.equal(response.result.remoteAttached, true);
  assert.equal(response.result.delivered, true);
  assert.deepEqual(queued, [
    ['live_owner_session', 'direct fallback'],
    ['live_owner_session', 'ask race fallback'],
  ]);
});

test('cleared desktop context resumes legacy rows without reviving the creation marker', async () => {
  const taskDesktopSession = { classification: 'task', projectPath: null };
  let current = null;
  let cwd = '/task';
  let desktopSession = taskDesktopSession;
  const resumeOptions = [];
  const stored = {
    legacy: {
      id: 'legacy',
      provider: 'test',
      model: 'model',
      cwd: '/legacy',
      desktopSession: null,
      messages: [],
    },
    project: {
      id: 'project',
      provider: 'test',
      model: 'model',
      cwd: '/project',
      desktopSession: { classification: 'project', projectPath: '/project' },
      messages: [],
    },
  };
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getDesktopSession: () => desktopSession,
    setDesktopSession: (value) => { desktopSession = value; },
    getRoute: () => ({ provider: 'test', model: 'model' }),
    setRoute: () => {},
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => cwd,
    setSessionNeedsCwdRefresh: () => {},
    desktopSession: taskDesktopSession,
    mgr: {
      closeSession: () => true,
      resumeSession: async (id, _preset, options) => {
        resumeOptions.push(options);
        const session = stored[id];
        const expected = options?.desktopSession;
        if (expected && (!session.desktopSession
          || expected.classification !== session.desktopSession.classification)) return null;
        return session;
      },
    },
    statusRoutes: {},
    createCurrentSession: async () => {},
    refreshRouteEffort: async () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    applyResolvedCwd: async (value) => { cwd = value; },
    resolveRoute: (_config, value) => value,
    applyDeferredToolSurface: () => {},
    getStandaloneTools: () => [],
  });

  await runtime.switchContext({ cwd: '/legacy', desktopSession: null });
  assert.equal(desktopSession, null);
  assert.equal((await runtime.resume('legacy')).id, 'legacy');
  assert.equal(resumeOptions[0], undefined);

  await runtime.switchContext({ cwd: '/task', desktopSession: taskDesktopSession });
  assert.equal(await runtime.resume('project'), null);
  assert.deepEqual(resumeOptions[1], { desktopSession: taskDesktopSession });
});

test('desktop cwd application awaits project MCP reset before becoming ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-mcp-order-'));
  const oldCwd = join(root, 'old');
  const nextCwd = join(root, 'next');
  mkdirSync(oldCwd);
  mkdirSync(nextCwd);
  let currentCwd = oldCwd;
  let projectKey = '';
  let releaseReset;
  const resetGate = new Promise((resolve) => { releaseReset = resolve; });
  const events = [];
  const cwdPlugins = createCwdPlugins({
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (value) => { currentCwd = value; },
    getSession: () => null,
    getLastProjectMcpKey: () => projectKey,
    setLastProjectMcpKey: (value) => { projectKey = value; },
    isCodeGraphPrewarmLazy: () => true,
    isCodeGraphFirstTurnPrewarmDone: () => false,
    getCodeGraphPrewarmDelayMs: () => 0,
    connectConfiguredMcp: async (options) => {
      events.push(['reset:start', options]);
      await resetGate;
      events.push(['reset:done']);
    },
    invalidatePreSessionToolSurface: () => events.push(['surface:invalidated']),
    scheduleCodeGraphPrewarm: () => {},
    hooks: { dispatch: () => {} },
    hookCommonPayload: (value) => value,
    bootProfile: () => {},
    readProjectMcpServers: () => ({}),
    writeLastSessionCwd: () => {},
    clean: (value) => String(value || '').trim(),
    resolve,
    statSync,
  });
  try {
    let ready = false;
    const applying = cwdPlugins.applyResolvedCwd(nextCwd, { waitForMcpReset: true });
    applying.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    assert.deepEqual(events, [['reset:start', { reset: true }]]);
    releaseReset();
    assert.equal(await applying, resolve(nextCwd));
    assert.deepEqual(events, [
      ['reset:start', { reset: true }],
      ['reset:done'],
      ['surface:invalidated'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production runtime composition supplies mutable desktop session bindings', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url)),
    'utf8',
  );
  const composition = source.slice(
    source.indexOf('const lifecycleApi = createLifecycleApi({'),
    source.indexOf('const resourceApi = createResourceApi({'),
  );
  assert.match(composition, /getDesktopSession:\s*\(\)\s*=>\s*rt\.desktopSession/);
  assert.match(composition, /setDesktopSession:\s*\(v\)\s*=>\s*\{\s*rt\.desktopSession = v;\s*\}/);
});

test('summary metadata rejects non-string project paths instead of leaking objects', () => {
  const withoutFallback = _sessionSummary({
    id: 'bad_project_path',
    desktopSession: { classification: 'project', projectPath: { untrusted: true } },
  });
  const withFallback = _normalizeSummaryIndex({
    rows: [{
      id: 'legacy_project_path',
      cwd: '  /legacy/project  ',
      desktopSession: { classification: 'project', projectPath: null },
    }],
  }).rows[0];

  assert.equal(withoutFallback.desktopSession, null);
  assert.deepEqual(withFallback.desktopSession, {
    classification: 'project',
    projectPath: '/legacy/project',
  });
});

test('desktop-guarded resume refuses legacy/cross-class rows while the historical path still accepts legacy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-resume-guard-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const project = {
      id: 'desktop_project_guard',
      cwd: '/project',
      desktopSession: { classification: 'project', projectPath: '/project' },
      messages: [{ role: 'user', content: 'Project transcript' }],
      tools: [],
    };
    const legacy = {
      id: 'legacy_cli_guard',
      cwd: '/cli',
      messages: [{ role: 'user', content: 'CLI transcript' }],
      tools: [],
    };
    writeFileSync(join(sessions, `${project.id}.json`), JSON.stringify(project));
    writeFileSync(join(sessions, `${legacy.id}.json`), JSON.stringify(legacy));

    const expectedTask = { desktopSession: { classification: 'task', projectPath: null } };
    assert.equal(await resumeStoredSession(project.id, 'full', expectedTask), null);
    assert.equal(await resumeStoredSession(legacy.id, 'full', expectedTask), null);
    assert.deepEqual(JSON.parse(readFileSync(join(sessions, `${project.id}.json`), 'utf8')), project);
    assert.deepEqual(JSON.parse(readFileSync(join(sessions, `${legacy.id}.json`), 'utf8')), legacy);
    const resumedLegacy = await resumeStoredSession(legacy.id, 'full');
    assert.equal(resumedLegacy.id, legacy.id);
    assert.equal(resumedLegacy.desktopSession, undefined);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    } catch {
      // The save worker acknowledges the session write before its best-effort
      // summary-index flush has fully released Windows filesystem handles.
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }
});
