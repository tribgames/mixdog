import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { bridgeDeadline, readCappedJson, requestBridgeWithin } from './client.mjs';

/** A bridge stand-in: `handler(request, response)` decides how it answers. */
async function bridge(t, handler) {
  const server = createServer((request, response) => {
    request.resume();
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { port: server.address().port, token: 'token' };
}

const body = JSON.stringify({ ok: true, value: { text: 'clicked' } });

test('the request clock restarts on every byte, so a command held for the person outlives it', async (t) => {
  const discovery = await bridge(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      response.write(' ');
      if (sent === 20) {
        clearInterval(timer);
        response.end(body);
      }
    }, 25);
    response.once('close', () => clearInterval(timer));
  });
  // 20 keep-alive periods = 500 ms, against a 150 ms request clock.
  const started = Date.now();
  const result = await requestBridgeWithin(discovery, '{}', undefined, { action: 'click' }, 150);
  assert.ok(Date.now() - started > 400, 'it really waited past the clock');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, value: { text: 'clicked' } });
});

test('a bridge that goes silent after committing the response still times the request out', async (t) => {
  const discovery = await bridge(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
  });
  await assert.rejects(requestBridgeWithin(discovery, '{}', undefined, { action: 'click' }, 150), {
    name: 'TimeoutError',
  });
});

test('a bridge that never answers times the request out, and an ordinary one-shot reply is unchanged', async (t) => {
  const silent = await bridge(t, () => {});
  await assert.rejects(requestBridgeWithin(silent, '{}', undefined, { action: 'click' }, 150), {
    name: 'TimeoutError',
  });
  const plain = await bridge(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  const result = await requestBridgeWithin(plain, '{}', undefined, { action: 'click' }, 150);
  assert.deepEqual(result.body, { ok: true, value: { text: 'clicked' } });
});

test("Stop ends a request that is being kept alive at once, with the caller's own reason", async (t) => {
  const discovery = await bridge(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => response.write(' '), 20);
    response.once('close', () => clearInterval(timer));
  });
  const controller = new AbortController();
  const stopped = new Error('turn stopped');
  const pending = requestBridgeWithin(discovery, '{}', controller.signal, { action: 'click' }, 10_000);
  setTimeout(() => controller.abort(stopped), 100);
  await assert.rejects(pending, (error) => error === stopped);
});

test('bridgeDeadline: silence times out, touch restarts the clock, stop and the caller signal end it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = bridgeDeadline(undefined, 45_000);
  t.mock.timers.tick(44_000);
  quiet.touch();
  t.mock.timers.tick(44_000);
  assert.equal(quiet.signal.aborted, false, 'a byte at 44 s restarted the 45 s clock');
  t.mock.timers.tick(1_001);
  assert.equal(quiet.signal.aborted, true);
  assert.equal(quiet.signal.reason.name, 'TimeoutError');

  const stopped = bridgeDeadline(undefined, 45_000);
  stopped.stop();
  t.mock.timers.tick(60_000);
  assert.equal(stopped.signal.aborted, false, 'a finished request leaves no timer behind');

  const caller = new AbortController();
  const linked = bridgeDeadline(caller.signal, 45_000);
  const reason = new Error('cancelled');
  caller.abort(reason);
  assert.equal(linked.signal.reason, reason);
  linked.stop();
});

test('readCappedJson reports each chunk it reads', async () => {
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(' '));
        controller.enqueue(encoder.encode(' {"ok":'));
        controller.enqueue(encoder.encode('true}'));
        controller.close();
      },
    })
  );
  let chunks = 0;
  assert.deepEqual(await readCappedJson(response, 1024, () => (chunks += 1)), { ok: true });
  assert.equal(chunks, 3);
});
