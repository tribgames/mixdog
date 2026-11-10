import assert from 'node:assert/strict';
import test from 'node:test';
import { readCappedJson } from './client.mjs';

test('a chunked response without Content-Length is still capped', async () => {
  const chunked = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"large":"'));
        controller.enqueue(new Uint8Array(32));
        controller.close();
      },
    })
  );
  await assert.rejects(readCappedJson(chunked, 16), /exceeds 16 bytes/);
  assert.deepEqual(await readCappedJson(new Response('{"ok":true}'), 16), { ok: true });
});
