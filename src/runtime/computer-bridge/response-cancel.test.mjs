import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeComputerTool } from './client.mjs';

test('cancellation after response headers still releases the same host session', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-response-cancel-'));
  const previousNamespace = process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = directory;
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  const received = [];
  let abortedAtHeaders = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(command);
      const payload = JSON.stringify({
        ok: true,
        value: {
          text:
            command.action === 'session_abort'
              ? 'released'
              : JSON.stringify({ action: 'capture', ok: true, padding: 'x'.repeat(900_000) }),
        },
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await writeFile(
      join(directory, 'computer-bridge.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: server.address().port,
        token: 'response-fixture',
      })
    );
    globalThis.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!abortedAtHeaders) {
        abortedAtHeaders = true;
        controller.abort();
      }
      return response;
    };
    const result = await executeComputerTool(
      { action: 'capture', input: { window_id: 'hwnd:0x1' } },
      { sessionId: 'response-fixture', signal: controller.signal }
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /command aborted; input state and session resources were released/);
    assert.deepEqual(
      received.map((command) => [command.action, command.session_id]),
      [
        ['capture', 'response-fixture'],
        ['session_abort', 'response-fixture'],
      ]
    );
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousNamespace === undefined) delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
    else process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = previousNamespace;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
