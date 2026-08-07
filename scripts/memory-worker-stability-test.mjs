#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeIpcSend } from '../src/runtime/shared/safe-ipc-send.mjs';
import { createParentBridge } from '../src/runtime/channels/lib/parent-bridge.mjs';
import { presentErrorText } from '../src/runtime/shared/err-text.mjs';
import { compactFailureNotice } from '../src/tui/app/slash-dispatch.mjs';
import {
  applyShardStateFrame,
  createSessionRuntimePool,
  sessionShardIndex,
} from '../src/standalone/session-runtime-pool.mjs';
import { disposeSessionRuntimeRecord } from '../src/standalone/session-runtime-record.mjs';

function waitFor(predicate, message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      try {
        const value = predicate();
        if (value) { resolve(value); return; }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timeout: ${message}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function requestJson({ port, path, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    const abort = () => req.destroy(signal.reason || new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', abort));
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

test('safe IPC send absorbs disconnected, synchronous, and callback failures', () => {
  const completions = [];
  assert.equal(safeIpcSend({ connected: false, send() { throw new Error('must not send'); } }, { ok: true }), false);

  const failures = [];
  assert.equal(safeIpcSend({
    connected: true,
    send() { throw Object.assign(new Error('closed sync'), { code: 'ERR_IPC_CHANNEL_CLOSED' }); },
  }, { ok: true }, {
    onError: (error) => failures.push(error),
    onComplete: (error) => completions.push(error?.message),
  }), false);

  assert.equal(safeIpcSend({
    connected: true,
    send(_message, _handle, _options, callback) {
      callback(Object.assign(new Error('closed async'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
    },
  }, { ok: true }, {
    onError: (error) => failures.push(error),
    onComplete: (error) => completions.push(error?.message),
  }), true);

  assert.deepEqual(failures.map((error) => error.message), ['closed sync', 'closed async']);
  assert.deepEqual(completions, ['closed sync', 'closed async']);
});

test('channel memory bridge rejects immediately on async send failure and parent disconnect', async () => {
  const asyncFailureProc = new EventEmitter();
  asyncFailureProc.connected = true;
  asyncFailureProc.send = (_message, _handle, _options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('channel closed'), {
      code: 'ERR_IPC_CHANNEL_CLOSED',
    })));
  };
  const asyncBridge = createParentBridge({
    getInstanceId: () => 'async-failure',
    ipcProcess: asyncFailureProc,
  });
  await assert.rejects(
    asyncBridge.callMemoryAction('cycle1', {}, 5000),
    /channel closed/,
  );

  const disconnectProc = new EventEmitter();
  disconnectProc.connected = true;
  disconnectProc.send = () => true;
  const disconnectBridge = createParentBridge({
    getInstanceId: () => 'disconnect',
    ipcProcess: disconnectProc,
  });
  const pending = disconnectBridge.callMemoryAction('cycle1', {}, 5000);
  disconnectProc.connected = false;
  disconnectProc.emit('disconnect');
  await assert.rejects(pending, /parent IPC disconnected/);
});

test('worker IPC modules contain no raw process or child send calls', () => {
  const files = [
    '../src/runtime/channels/lib/parent-bridge.mjs',
    '../src/runtime/channels/lib/worker-ipc.mjs',
    '../src/runtime/channels/lib/owned-runtime.mjs',
    '../src/runtime/memory/lib/agent-ipc.mjs',
    '../src/standalone/daemon.mjs',
    '../src/standalone/channel-worker.mjs',
    '../src/runtime/memory/index.mjs',
    '../scripts/daemon-stub.mjs',
  ];
  for (const relative of files) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\b(?:process|child|target)\.send\s*\(/, relative);
  }
});

test('daemon, sessions, channels, and trace sinks keep memory out of the control event loop', () => {
  const daemon = readFileSync(fileURLToPath(new URL('../src/standalone/daemon.mjs', import.meta.url)), 'utf8');
  const runtime = readFileSync(fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url)), 'utf8');
  const channels = readFileSync(fileURLToPath(new URL('../src/runtime/channels/lib/memory-client.mjs', import.meta.url)), 'utf8');
  const trace = readFileSync(fileURLToPath(new URL('../src/runtime/agent/orchestrator/agent-trace-io.mjs', import.meta.url)), 'utf8');
  assert.match(daemon, /getStandaloneMemoryRuntime/);
  assert.doesNotMatch(daemon, /import\(['"]\.\.\/runtime\/memory\/index\.mjs['"]\)/);
  assert.match(runtime, /getStandaloneMemoryRuntime/);
  assert.doesNotMatch(runtime, /profiledImport\(['"]memory-runtime['"],\s*MEMORY_RUNTIME\)/);
  assert.match(channels, /getStandaloneMemoryRuntime/);
  assert.doesNotMatch(channels, /import\(['"]\.\.\/\.\.\/memory\/index\.mjs['"]\)/);
  assert.doesNotMatch(trace, /import\(['"]\.\.\/\.\.\/\.\.\/memory\/index\.mjs['"]\)/);
});

test('session shards are stable by session id and preserve delta identities', () => {
  const shard = sessionShardIndex('sess-stable', 8);
  assert.equal(sessionShardIndex('sess-stable', 8), shard);
  assert.ok(shard >= 0 && shard < 8);
  const firstItem = { id: 'one', text: 'stable' };
  const initial = { sessionId: 'sess-stable', busy: true, items: [firstItem] };
  const next = applyShardStateFrame(initial, {
    patch: {
      set: { spinner: { active: true } },
      remove: [],
      itemsAppend: { from: 1, values: [{ id: 'two', text: 'new' }] },
    },
  });
  assert.equal(next.items[0], firstItem);
  assert.equal(next.items.length, 2);
  assert.equal(next.spinner.active, true);
});

test('a failing shard dispose still releases its record and transcript projections', async () => {
  let unsubscribed = 0;
  const record = {
    id: 'dispose-failure',
    disposed: false,
    unsubscribe: () => { unsubscribed += 1; },
    source: { items: ['source'] },
    projected: { items: ['projected'] },
    published: { items: ['published'] },
    fields: new Map([['large', { source: 'x'.repeat(1024), value: 'x'.repeat(1024) }]]),
    items: new Map([[{ id: 1 }, { text: 'retained transcript' }]]),
    runtime: {
      async dispose() { throw new Error('dispose hook failed'); },
    },
  };
  const records = new Map([[record.id, record]]);

  await assert.rejects(
    disposeSessionRuntimeRecord(records, record, ['test']),
    /dispose hook failed/,
  );
  assert.equal(records.size, 0);
  assert.equal(record.disposed, true);
  assert.equal(unsubscribed, 1);
  assert.equal(record.source, null);
  assert.equal(record.projected, null);
  assert.equal(record.published, null);
  assert.equal(record.fields.size, 0);
  assert.equal(record.items.size, 0);
});

test('daemon routes session creation through process shards instead of importing session-local', () => {
  const daemon = readFileSync(fileURLToPath(new URL('../src/standalone/daemon.mjs', import.meta.url)), 'utf8');
  assert.match(daemon, /createSessionRuntimePool/);
  assert.doesNotMatch(daemon, /import\(['"]\.\.\/tui\/session-local\.mjs['"]\)/);
});

test('a crashed session shard recreates and resumes only its own live runtimes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-shard-recovery-'));
  const sessionId = 'shard_recovery_session';
  const shardIndex = sessionShardIndex(sessionId, 2);
  const pool = createSessionRuntimePool({
    shardCount: 2,
    cwd: root,
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
      MIXDOG_BOOT_CORE_MEMORY: '0',
      MIXDOG_DAEMON_SKIP_MEMORY: '1',
      MIXDOG_AGENT_TRACE_DISABLE: '1',
    },
  });
  try {
    const runtime = await pool.create({ sessionId, cwd: root });
    await runtime.reserveSession(sessionId);
    const originalPid = pool.status.shards[shardIndex].pid;
    assert.ok(originalPid);
    process.kill(originalPid);
    const replacementPid = await waitFor(() => {
      const pid = pool.status.shards[shardIndex].pid;
      return pid && pid !== originalPid ? pid : 0;
    }, 'replacement shard process');
    await waitFor(
      () => runtime.getState().sessionId === sessionId,
      'session runtime resume after shard replacement',
    );
    assert.notEqual(replacementPid, originalPid);
    assert.equal(pool.status.shards[1 - shardIndex].pid, null,
      'an unused peer shard must not be spawned or disturbed');
  } finally {
    await pool.close('shard recovery test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('aborting memory HTTP request closes the in-flight socket promptly', async (t) => {
  let resolveClientClose;
  const clientClosed = new Promise((resolve) => { resolveClientClose = resolve; });
  const server = http.createServer((_req, res) => {
    res.on('close', () => {
      if (!res.writableFinished) resolveClientClose();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const controller = new AbortController();
  const pending = requestJson({
    port: server.address().port,
    path: '/slow',
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('compact memory timeout')), 25);

  await assert.rejects(pending, /compact memory timeout/);
  await Promise.race([
    clientClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('client socket did not close after abort')), 1000)),
  ]);
});

test('compact UI preserves the original memory failure reason', () => {
  const error = 'recall-fasttrack compact failed: memory ingest_session timed out after 4000ms';
  assert.equal(presentErrorText(error), 'Compact failed.');
  assert.equal(presentErrorText(error, { surface: 'compact' }), error);
  assert.equal(compactFailureNotice(error), `Compact failed: ${error}`);
});

test('memory internal-tool dispatch forwards the caller cancellation signal', () => {
  const runtimeCorePath = fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url));
  const source = readFileSync(runtimeCorePath, 'utf8');
  assert.match(
    source,
    /memoryMod\.handleToolCall\(\s*name,\s*memoryToolArgsForCaller\(args,\s*callerCwd\),\s*callerCtx\?\.signal\s*\|\|/,
  );
});
