import './computer-bridge/test-linux-display.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBridgeDiscovery } from './bridge-discovery.mjs';
import { executeBrowserTool } from './browser-bridge/client.mjs';
import { executeComputerTool, releaseAllComputerSessions } from './computer-bridge/client.mjs';
import { _resetWatchedFileCachesForTest } from './shared/watched-file-cache.mjs';
import { executeTerminalTool } from './terminal-bridge/client.mjs';

const CLIENTS = [
  {
    name: 'terminal',
    execute: executeTerminalTool,
    read: { action: 'read' },
    mutation: { action: 'run', command: 'echo hi' },
  },
  {
    name: 'browser',
    execute: executeBrowserTool,
    read: { action: 'snapshot', input: { tab: 'p1' } },
    mutation: { action: 'click', input: { ref: 'p1-s1-e1' } },
  },
  {
    name: 'computer',
    execute: executeComputerTool,
    read: { action: 'list', input: { kind: 'windows' } },
    mutation: { action: 'act', input: { window_id: 'hwnd:0x123', actions: [{ type: 'click', ref: 'ref:1' }] } },
  },
];

for (const client of CLIENTS) {
  test(`${client.name} recovery reads current discovery before watch delivery`, { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mixdog-bridge-recovery-'));
    const previous = process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
    process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = directory;
    const file = `${client.name}-bridge.json`;
    // Hold watch delivery, as during the debounce: recovery must read the real
    // advertisement rather than depend on the watcher winning a timing race.
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
    const seen = [];
    let mode;
    let controller;
    let old;
    let replacement;
    const publish = (server, token = 'replacement') =>
      fs.writeFileSync(
        join(directory, file),
        JSON.stringify({ version: 1, port: server.address().port, token, pid: process.pid })
      );
    const serve = (endpoint) => createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (command.action === 'session_abort' || command.action === 'session_release') {
          response.end(JSON.stringify({ ok: true, value: { text: 'released' } }));
          return;
        }
        seen.push({ endpoint, token: request.headers.authorization, command });
        if (endpoint === 'old' && mode !== 'warm') {
          if (mode !== 'unchanged') publish(replacement);
          if (mode.startsWith('body-')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{"ok":');
            return;
          }
          if (mode.startsWith('invalid-json')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{');
            return;
          }
          if (mode === 'cancel') controller.abort();
          if (mode === 'unauthorized') {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          } else request.socket.destroy();
          return;
        }
        if (endpoint === 'replacement' && mode === 'twice') {
          publish(old, 'third');
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: true, value: { text: 'observed', raw: 'observed', tab: 1, shell: 'sh', cursor: 8 } })
        );
      });
    });
    old = serve('old');
    replacement = serve('replacement');
    try {
      for (const server of [old, replacement]) {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
      }
      const modes = ['warm', 'changed', 'unchanged', 'twice', 'mutation', 'cancel'];
      if (client.name === 'computer') modes.push('unauthorized');
      if (client.name === 'terminal') {
        modes.push('body-timeout', 'body-timeout-mutation', 'body-cancel', 'invalid-json', 'invalid-json-mutation');
      }
      for (mode of modes) {
        await t.test(mode, async (t) => {
          _resetWatchedFileCachesForTest();
          publish(old, 'old');
          assert.equal(readBridgeDiscovery(file).port, old.address().port);
          seen.length = 0;
          controller = new AbortController();
          let bodyReads = 0;
          if (mode.startsWith('body-')) {
            let deadline;
            t.mock.method(AbortSignal, 'timeout', () => {
              deadline = new AbortController();
              return deadline.signal;
            });
            const readText = Response.prototype.text;
            t.mock.method(Response.prototype, 'text', function () {
              const reading = readText.call(this);
              if (new URL(this.url).port === String(old.address().port)) {
                // Real headers have arrived and native body consumption has
                // started. Only the abort timing is controlled.
                bodyReads += 1;
                if (mode === 'body-cancel') controller.abort(new Error('user stopped'));
                else deadline.abort(new DOMException('budget expired', 'TimeoutError'));
              }
              return reading;
            });
          }
          const args = mode.endsWith('mutation') ? client.mutation : client.read;
          const result = await client.execute(args, {
            sessionId: `${client.name}-${mode}`,
            signal: controller.signal,
          });
          const recovered = mode === 'changed' || mode === 'unauthorized' || mode === 'invalid-json';
          if (mode.startsWith('body-')) assert.equal(bodyReads, 1);
          assert.deepEqual(
            seen.map(({ endpoint }) => endpoint),
            recovered || mode === 'twice' ? ['old', 'replacement'] : ['old']
          );
          assert.equal(result.isError, mode === 'warm' || recovered ? undefined : true);
          assert.equal(seen[0].token, 'Bearer old');
          if (seen.length === 2) {
            assert.equal(seen[1].token, 'Bearer replacement');
            assert.deepEqual(seen[1].command, seen[0].command, 'only the same observation is retried');
          }
          if (recovered) assert.match(result.content[0].text, /observed/);
          if (mode.startsWith('body-timeout')) assert.equal(result.content[0].text, 'Error: terminal bridge timed out');
          if (mode === 'body-cancel') assert.equal(result.content[0].text, 'Error: terminal command cancelled');
          if (mode === 'invalid-json-mutation') {
            assert.equal(result.content[0].text, 'Error: terminal bridge returned an invalid response (HTTP 200)');
          }
        });
      }
      await t.test('timeout is not retried even with a replacement', async (t) => {
        _resetWatchedFileCachesForTest();
        publish(old, 'old');
        assert.equal(readBridgeDiscovery(file).port, old.address().port);
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
          calls += 1;
          publish(replacement);
          throw new DOMException('budget expired', 'TimeoutError');
        });
        const result = await client.execute(client.read, { sessionId: `${client.name}-timeout` });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /timed out/);
        assert.equal(calls, 1);
      });
    } finally {
      await releaseAllComputerSessions(1_000);
      for (const server of [old, replacement]) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
      _resetWatchedFileCachesForTest();
      if (previous === undefined) delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
      else process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
