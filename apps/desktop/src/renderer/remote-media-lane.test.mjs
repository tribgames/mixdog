import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fileDownloadLaneUrl,
  mediaLaneSupported,
  publishMediaKey,
  remoteMediaLaneUrl,
  revokeMediaKey,
} from './remote-media-lane.ts';

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

test('download lane URLs exist only with a media lease, a controlling worker and a routed session key', () => {
  const SID = 'D'.repeat(43);
  const LEASE = '11111111-2222-4333-8444-555555555555';
  const transfer = {
    transferId: '99999999-8888-4777-8666-555555555555',
    name: 'a b&c.txt',
    size: 42,
    mime: 'text/plain',
    version: 'v'.repeat(43),
    expiresAt: Date.now() + 60_000,
    rangeMaxBytes: 4 * 1024 * 1024,
    media: { assetId: LEASE, variant: 'download', expiresAt: Date.now() + 60_000 },
  };
  const serviceWorker = { controller: null, addEventListener: () => undefined };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://relay.test' },
    configurable: true,
    writable: true,
  });
  try {
    const key = { type: 'secret' };
    const route = { base: 'https://relay.test', token: () => 'tok' };
    publishMediaKey(SID, key, route);
    assert.equal(fileDownloadLaneUrl(transfer), null, 'no controlling worker');
    serviceWorker.controller = { postMessage: () => undefined };
    assert.equal(
      fileDownloadLaneUrl(transfer),
      `https://relay.test/__mixdog-download__/${LEASE}?sid=${SID}&enc=e2ee1&v=${'v'.repeat(43)}&size=42&name=a+b%26c.txt&token=tok`
    );
    // An older host: the transfer has no media lease.
    assert.equal(fileDownloadLaneUrl({ ...transfer, media: undefined }), null);
    assert.equal(fileDownloadLaneUrl({ ...transfer, media: { ...transfer.media, assetId: '../x' } }), null);
    // A relay on another origin than the page cannot be reached by the worker.
    publishMediaKey(SID, key, { ...route, base: 'https://elsewhere.test' });
    assert.equal(fileDownloadLaneUrl(transfer), null);
    // A key published without a route (or revoked) gives no download URL.
    publishMediaKey(SID, key);
    assert.equal(fileDownloadLaneUrl(transfer), null);
    publishMediaKey(SID, key, route);
    revokeMediaKey(SID);
    assert.equal(fileDownloadLaneUrl(transfer), null);
  } finally {
    Reflect.deleteProperty(globalThis, 'navigator');
    Reflect.deleteProperty(globalThis, 'location');
  }
});
