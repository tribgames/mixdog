import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-http-sse-framing-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { sendViaHttpSse } = await import('../openai-oauth-http-sse.mjs');

for (const [lineEnding, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  for (const bytewise of [false, true]) {
    test(`HTTP/SSE preserves frame and callback order with ${lineEnding}, ${bytewise ? 'bytewise' : 'coalesced'} reads`, async () => {
      const call = {
        type: 'function_call',
        id: 'item-framing',
        call_id: 'call-framing',
        name: 'read',
        arguments: '{"path":"fixture.txt"}',
      };
      const frame = (event) => `data: ${JSON.stringify(event)}`;
      // The terminal frame intentionally has no trailing separator. Bytewise
      // reads also split UTF-8 code points and the CRLF delimiter itself.
      const wire = [
        ': keepalive',
        '',
        frame({ type: 'response.created', response: { id: 'resp-framing', model: 'gpt-fixture' } }),
        `event: response.output_text.delta${newline}data: {"type":"response.output_text.delta",${newline}data: "delta":"안녕🌊"}`,
        frame({ type: 'response.output_item.added', item: call }),
        frame({
          type: 'response.function_call_arguments.done',
          item_id: call.id,
          arguments: call.arguments,
        }),
        frame({ type: 'response.output_item.done', item: call }),
        'data: [DONE]',
        frame({ type: 'response.output_text.delta', delta: ' done' }),
        frame({
          type: 'response.completed',
          response: {
            id: 'resp-framing',
            model: 'gpt-fixture',
            output: [call],
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        }),
      ].join(newline + newline);
      const bytes = new TextEncoder().encode(wire);
      const delivered = [];
      const result = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'fixture-key' },
        body: { model: 'gpt-fixture', tools: [{ name: 'read' }] },
        useModel: 'gpt-fixture',
        onTextDelta: (text) => delivered.push(`text:${text}`),
        onToolCall: (toolCall) => delivered.push(`call:${toolCall.id}`),
        fetchFn: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const step = bytewise ? 1 : bytes.length;
                for (let offset = 0; offset < bytes.length; offset += step) {
                  controller.enqueue(bytes.subarray(offset, offset + step));
                }
                controller.close();
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } }
          ),
      });

      assert.equal(result.content, '안녕🌊 done');
      assert.equal(result.responseId, 'resp-framing');
      assert.equal(result.model, 'gpt-fixture');
      assert.deepEqual(delivered, ['text:안녕🌊', 'call:call-framing', 'text: done']);
      assert.deepEqual(result.toolCalls, [{ id: 'call-framing', name: 'read', arguments: { path: 'fixture.txt' } }]);
      assert.equal(result.usage.inputTokens, 3);
      assert.equal(result.usage.outputTokens, 1);
    });
  }
}

test('an HTTP/SSE request retry waits the server-advised time', async () => {
  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
  const bytes = new TextEncoder().encode(
    [
      frame({ type: 'response.created', response: { id: 'resp-ok', model: 'gpt-fixture' } }),
      frame({ type: 'response.output_text.delta', delta: 'ok' }),
      frame({
        type: 'response.completed',
        response: { id: 'resp-ok', model: 'gpt-fixture', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ].join('')
  );
  const waits = [];
  let requests = 0;
  const result = await sendViaHttpSse({
    auth: { type: 'openai-direct', apiKey: 'fixture-key' },
    body: { model: 'gpt-fixture' },
    useModel: 'gpt-fixture',
    _sleepFn: (ms) => {
      waits.push(ms);
    },
    fetchFn: async () => {
      requests += 1;
      if (requests === 1) return new Response('busy', { status: 503, headers: { 'retry-after-ms': '7000' } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  assert.equal(result.content, 'ok');
  assert.equal(requests, 2);
  // The advice is a deadline: time spent before the sleep is deducted, never added.
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 6_500 && waits[0] <= 7_000, `waited ${waits[0]}ms`);
});

test('an HTTP/SSE body cut mid-stream carries the finished tool call for the loop', async () => {
  const call = {
    type: 'function_call',
    id: 'item-cut',
    call_id: 'call-cut',
    name: 'read',
    arguments: '{"path":"a.txt"}',
  };
  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
  const bytes = new TextEncoder().encode(
    [
      frame({ type: 'response.created', response: { id: 'resp-cut', model: 'gpt-fixture' } }),
      frame({ type: 'response.output_item.added', item: call }),
      frame({ type: 'response.function_call_arguments.done', item_id: call.id, arguments: call.arguments }),
      frame({ type: 'response.output_item.done', item: call }),
    ].join('')
  );
  const cut = new TypeError('terminated');
  let pulls = 0;
  const delivered = [];
  await assert.rejects(
    sendViaHttpSse({
      auth: { type: 'openai-direct', apiKey: 'fixture-key' },
      body: { model: 'gpt-fixture', tools: [{ name: 'read' }] },
      useModel: 'gpt-fixture',
      onToolCall: (toolCall) => delivered.push(toolCall.id),
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(bytes);
              else controller.error(cut);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    }),
    (error) => {
      assert.equal(error.message, 'terminated');
      assert.deepEqual(
        error.partialToolCalls.map((toolCall) => toolCall.id),
        ['call-cut']
      );
      assert.equal(error.pendingToolUse, false);
      return true;
    }
  );
  assert.deepEqual(delivered, ['call-cut']);
});

test('HTTP/SSE response.incomplete content_filter throws a typed policy error', async () => {
  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
  const bytes = new TextEncoder().encode(
    [
      frame({ type: 'response.created', response: { id: 'resp-cf', model: 'gpt-fixture' } }),
      frame({
        type: 'response.incomplete',
        response: { id: 'resp-cf', model: 'gpt-fixture', incomplete_details: { reason: 'content_filter' } },
      }),
    ].join('')
  );
  await assert.rejects(
    sendViaHttpSse({
      auth: { type: 'openai-direct', apiKey: 'fixture-key' },
      body: { model: 'gpt-fixture' },
      useModel: 'gpt-fixture',
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    }),
    (error) => {
      assert.equal(error.code, 'content_filter');
      assert.equal(error.providerErrorCode, 'content_filter');
      return true;
    }
  );
});

test('HTTP/SSE response.failed carries the typed code, nested headers and reset time', async () => {
  const error = {
    type: 'usage_limit_reached',
    message: 'limit',
    resets_at: 1893456000,
    headers: { 'retry-after': '9' },
  };
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: 'response.failed', response: { id: 'r', error } })}\n\n`
  );
  await assert.rejects(
    sendViaHttpSse({
      auth: { type: 'openai-direct', apiKey: 'fixture-key' },
      body: { model: 'gpt-fixture' },
      useModel: 'gpt-fixture',
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    }),
    (err) => {
      assert.equal(err.code, 'usage_limit_reached');
      assert.deepEqual(err.headers, error.headers);
      assert.equal(err.retryAfterMs, 9000);
      assert.equal(err.resetAt, 1893456000 * 1000);
      return true;
    }
  );
});
