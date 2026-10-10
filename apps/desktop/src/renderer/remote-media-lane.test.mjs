import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaLaneSupported, publishMediaKey, remoteMediaLaneUrl, revokeMediaKey } from './remote-media-lane.ts';

const base = { base: 'https://relay.test', token: 'tok en', sid: 'S'.repeat(43), supported: true };

test('lane URLs carry the public session label and never anything secret', () => {
  assert.equal(
    remoteMediaLaneUrl({ ...base, assetId: 'abc12345-def', variant: 'thumb' }),
    `https://relay.test/media/abc12345-def?variant=thumb&sid=${'S'.repeat(43)}&enc=e2ee1&token=tok%20en`
  );
  assert.match(remoteMediaLaneUrl({ ...base, assetId: 'abc12345-def' }), /variant=original/);
});

test('an unsupported lane, or an asset without a session, yields no URL so callers fall back', () => {
  assert.equal(remoteMediaLaneUrl({ ...base, supported: false, assetId: 'abc12345-def' }), '');
  assert.equal(remoteMediaLaneUrl({ ...base, supported: false, assetId: 'healthz' }), '');
  assert.equal(remoteMediaLaneUrl({ ...base, sid: null, assetId: 'abc12345-def' }), '');
  // The feature probe is the relay's own plain answer: no session label.
  assert.equal(
    remoteMediaLaneUrl({ ...base, sid: null, assetId: 'healthz' }),
    'https://relay.test/media/healthz?variant=original&token=tok%20en'
  );
});

test('the lane needs the host capability and a controlling worker', () => {
  const serviceWorker = { controller: null, addEventListener: () => undefined };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker }, configurable: true, writable: true });
  assert.equal(mediaLaneSupported(true), false);
  const posted = [];
  serviceWorker.controller = { postMessage: (message) => posted.push(message) };
  assert.equal(mediaLaneSupported(true), true);
  assert.equal(mediaLaneSupported(false), false);
  const key = { type: 'secret' };
  publishMediaKey('S'.repeat(43), key);
  revokeMediaKey('S'.repeat(43));
  assert.deepEqual(posted, [
    { type: 'mixdog:media-key', sid: 'S'.repeat(43), key },
    { type: 'mixdog:media-key-revoke', sid: 'S'.repeat(43) },
  ]);
  Reflect.deleteProperty(globalThis, 'navigator');
});
