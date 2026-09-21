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
