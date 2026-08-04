#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { safeIpcSend } from '../src/runtime/shared/safe-ipc-send.mjs';
import { createParentBridge } from '../src/runtime/channels/lib/parent-bridge.mjs';
import { presentErrorText } from '../src/runtime/shared/err-text.mjs';
import { compactFailureNotice } from '../src/tui/app/slash-dispatch.mjs';
import { requestJson } from '../src/standalone/memory-runtime-proxy.mjs';

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
    '../src/standalone/channel-daemon.mjs',
    '../src/standalone/channel-worker.mjs',
    '../src/runtime/memory/index.mjs',
    '../scripts/channel-daemon-stub.mjs',
  ];
  for (const relative of files) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\b(?:process|child|target)\.send\s*\(/, relative);
  }
});

test('aborting proxy HTTP request closes the in-flight socket promptly', async (t) => {
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
