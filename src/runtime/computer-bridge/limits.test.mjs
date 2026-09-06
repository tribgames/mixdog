import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerLineDecoder, readComputerBridgeJson, validateComputerReply, MAX_COMPUTER_IMAGE_CHARS } from './limits.mjs';

test('worker output budget counts UTF-8 across chunks and keeps independent response lines', () => {
  const lines = [];
  const receive = createComputerLineDecoder((line) => lines.push(line), 6);
  receive('한'); receive('글\nok\r\n');
  assert.deepEqual(lines, ['한글', 'ok']);
  assert.throws(() => receive('한글x'), /too_large/);
});

test('response byte limit is enforced even without Content-Length', async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"large":"'));
      controller.enqueue(new Uint8Array(32));
      controller.close();
    },
  }));
  await assert.rejects(readComputerBridgeJson(response, 16), /byte limit/);
  assert.deepEqual(await readComputerBridgeJson(new Response('{"ok":true}'), 16), { ok: true });
});

test('reply validation rejects unexpected image types and oversized images', () => {
  assert.throws(() => validateComputerReply({ text: 'ok', image: { mimeType: 'image/svg+xml', data: 'a' } }), /invalid/);
  assert.throws(() => validateComputerReply({ text: 'ok', image: { mimeType: 'image/png', data: 'a'.repeat(MAX_COMPUTER_IMAGE_CHARS + 1) } }), /oversized/);
  validateComputerReply({ text: 'ok', image: { mimeType: 'image/png', data: 'aA==' } });
});
