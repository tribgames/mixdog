import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { runHttpHandler } from './handlers.mjs';

for (const phase of ['headers', 'body']) {
  test(`HTTP hook cancellation closes a real request awaiting ${phase}`, {
    timeout: 3_000,
  }, async (t) => {
    const received = Promise.withResolvers();
    const bodyReady = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const server = createServer((request, response) => {
      request.resume();
      response.once('close', () => closed.resolve());
      if (phase === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
      }
      received.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const controller = new AbortController();
    const reason = new Error('explicit policy cancellation');
    const pending = runHttpHandler({
      type: 'http', allowPrivateHosts: true, timeout: 2,
      url: `http://127.0.0.1:${server.address().port}/hook`,
    }, {}, 'PreToolUse', {
      signal: controller.signal,
      privateFetch: async (...args) => {
        const response = await fetch(...args);
        bodyReady.resolve();
        return response;
      },
    });
    await received.promise;
    if (phase === 'body') {
      await bodyReady.promise;
      await new Promise(setImmediate);
    }
    controller.abort(reason);
    const result = await pending;
    await closed.promise;
    assert.equal(result.exitCode, -1);
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, reason);
  });
}
