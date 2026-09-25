import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { remoteAccessInfoFromDescriptor } from './remote-access-window.ts';

const descriptor = (clientUrl) => ({ relay: { clientUrl, token: 'token', clients: [] } });

test('a pairing card is built from a relay descriptor', async () => {
  const info = await remoteAccessInfoFromDescriptor(descriptor('https://relay.example/d/device/'));
  assert.equal(info?.relayBrowserUrl, 'https://relay.example/d/device/');
  assert.match(String(info?.relayBrowserQrSvg), /<svg/);
  assert.equal(await remoteAccessInfoFromDescriptor(null), null);
});

test('a QR build failure answers null and is logged instead of rejecting', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  // Past QR capacity: the renderer itself throws.
  const info = await remoteAccessInfoFromDescriptor(descriptor(`https://relay.example/${'x'.repeat(8_000)}`));
  assert.equal(info, null);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[0]), /pairing QR build failed/);
});

test('every remote-access action in the main process builds its card through the guarded path', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  for (const name of ['remoteAccessInfo', 'rotateRemoteAccess', 'revokeRemoteAccessClient']) {
    const start = main.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} is defined`);
    const body = main.slice(start, main.indexOf('\n}\n', start));
    assert.match(body, /remoteAccessInfoFromDescriptor\(/, `${name} uses the guarded card builder`);
    assert.doesNotMatch(body, /buildRemoteAccessInfo\(/, `${name} does not build the card unguarded`);
  }
});
