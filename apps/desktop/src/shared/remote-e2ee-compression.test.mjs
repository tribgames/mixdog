import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_E2EE_PLAINTEXT_BYTES,
  packPlaintext,
  runBoundedByteTransform,
  unpackPlaintext,
} from './remote-e2ee-compression';
import { RelayE2EEChannel } from './remote-e2ee';

test('bounded transforms accept the exact output boundary', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const output = await runBoundedByteTransform(bytes, new TransformStream(), bytes.length);
  assert.deepEqual(output, bytes);
});

test('bounded transforms stop reading and cancel on cumulative overflow', async () => {
  let pulls = 0;
  let cancelled;
  const stream = {
    readable: new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(3));
      },
      cancel(reason) { cancelled = reason; },
    }, { highWaterMark: 0 }),
    writable: new WritableStream(),
  };
  await assert.rejects(runBoundedByteTransform(new Uint8Array(), stream, 5), /exceeds 5 bytes/);
  assert.equal(pulls, 2);
  assert.ok(cancelled instanceof RangeError);
});

test('plain messages obey the same limit on sending and receiving', async () => {
  const bytes = new Uint8Array(MAX_E2EE_PLAINTEXT_BYTES + 1);
  await assert.rejects(unpackPlaintext(bytes), /Relay plaintext exceeds/);
  for (const compress of [false, true]) {
    await assert.rejects(packPlaintext(bytes, compress), /Relay plaintext exceeds/);
  }
});

test('authenticated expansion overflow rejects without poisoning the channel queue', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const receiver = new RelayE2EEChannel(key, 'server');
  let sequence = 0;
  async function frame(plaintext) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const current = ++sequence;
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: new TextEncoder().encode(`mixdog-relay-e2ee-v1\0client-to-server\0${current}`),
    }, key, plaintext);
    return JSON.stringify({
      type: 'e2ee-box',
      version: 1,
      sequence: current,
      nonce: Buffer.from(nonce).toString('base64url'),
      ciphertext: Buffer.from(ciphertext).toString('base64url'),
    });
  }
  const compressed = deflateRawSync(Buffer.alloc(MAX_E2EE_PLAINTEXT_BYTES + 1, 0x20));
  const oversized = Buffer.concat([Buffer.from([1]), compressed]);
  await assert.rejects(receiver.decryptJson(await frame(oversized)), /Relay plaintext exceeds/);
  await assert.rejects(receiver.decryptJson(await frame(Buffer.from([1, 0xff]))));
  const valid = await frame(new TextEncoder().encode('{"ok":true}'));
  assert.deepEqual(await receiver.decryptJson(valid), { ok: true });
  await assert.rejects(receiver.decryptJson(valid), /replayed/);
});
