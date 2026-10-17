// The phone-side transfer controller (GitHub #40): destination order, the
// native sink's acked writes, the browser lane and Blob fallbacks, cleanup on
// cancel, and the message every refusal shows.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
  FILE_DOWNLOAD_ERROR_REASONS,
  FileDownloadError,
  fileDownloadErrorCode,
  folderTooLargeMessage,
} from '../shared/file-downloads.ts';
import {
  BLOB_FALLBACK_MAX_BYTES,
  LANE_BLOB_MAX_BYTES,
  LANE_WINDOW_BYTES,
  FileDownloadCancelledError,
  FileSaveError,
  fileDownloadFailureMessage,
  fileDownloadReasonMessage,
  fileDownloadSupport,
  fileSaveFailureMessage,
  remainingMs,
  runFileDownload,
  transferRate,
} from './file-download-transfer.ts';

const SOURCE = { kind: 'link', sessionId: 's1', itemId: 'row-7', href: 'C:/out/build.zip' };
const byteAt = (index) => (index * 7 + 3) % 251;

/** A host that serves `size` deterministic bytes; nothing is allocated up front. */
function fakeHost({ size = 10, rangeMaxBytes = 4, media, available = true, chunkVersion } = {}) {
  const calls = [];
  const transfer = {
    transferId: 't1',
    name: 'build.zip',
    size,
    mime: 'application/zip',
    version: 'v1',
    expiresAt: 0,
    rangeMaxBytes,
    ...(media ? { media } : {}),
  };
  const api = {
    available: () => available,
    authorize: async (request) => {
      calls.push(['authorize', request]);
      return { grantId: 'g1', name: 'build.zip', size, mime: 'application/zip', version: 'v1', expiresAt: 0 };
    },
    begin: async (grantId) => {
      calls.push(['begin', grantId]);
      return transfer;
    },
    readRange: async (transferId, offset, length, version) => {
      calls.push(['range', offset, length, version]);
      const bytes = Buffer.alloc(Math.min(length, size - offset));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = byteAt(offset + i);
      return {
        transferId,
        offset,
        length: bytes.length,
        data: bytes.toString('base64'),
        version: chunkVersion ?? version,
        eof: offset + bytes.length >= size,
      };
    },
    finish: async (transferId) => {
      calls.push(['finish', transferId]);
      return { transferId, size, version: 'v1' };
    },
    abort: async (id) => {
      calls.push(['abort', id]);
      return true;
    },
  };
  return { api, calls, transfer };
}

/** A native shell whose writes ack after a tick, one at a time. */
function fakeNative({
  share = { ok: true, shared: true },
  begin = { ok: true, handle: 'h1' },
  holdWrite,
  finish = async (args) => ({ ok: true, handle: args.handle, displayName: 'build.zip', size: args.size }),
} = {}) {
  const calls = [];
  const chunks = [];
  const written = { length: 0, bytes: () => [...Buffer.concat(chunks)] };
  let inflight = 0;
  let maxInflight = 0;
  const call = async (method, args) => {
    calls.push([method, args]);
    if (method === 'fileSaveBegin') return begin;
    if (method === 'fileSaveWrite') {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      assert.equal(args.offset, written.length, 'each write starts where the last ack ended');
      await (holdWrite?.(args) ?? new Promise((resolve) => setTimeout(resolve, 1)));
      const chunk = Buffer.from(args.data, 'base64');
      chunks.push(chunk);
      written.length += chunk.length;
      inflight -= 1;
      return { ok: true, handle: args.handle, written: written.length };
    }
    if (method === 'fileSaveFinish') return finish(args);
    if (method === 'fileSaveAbort') return { ok: true, handle: args.handle };
    if (method === 'fileSaveShare') return typeof share === 'function' ? share(args) : share;
    return null;
  };
  return { call, calls, written, maxInflight: () => maxInflight };
}

function environment(host, sink, lane = () => null, probe = 'ok') {
  const delivered = [];
  const probed = [];
  const laneReads = [];
  return {
    delivered,
    probed,
    laneReads,
    env: {
      readLane: async (url, offset, length) => {
        laneReads.push([url, offset, length]);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) bytes[i] = byteAt(offset + i);
        return bytes.buffer;
      },
      api: host.api,
      sink: async () => sink,
      laneUrl: lane,
      probeLane: async (url) => {
        probed.push(url);
        return probe;
      },
      deliver: async (target, transfer) => {
        delivered.push({ target, transfer });
        return 'saved';
      },
    },
  };
}

const run = (env, options = {}) =>
  runFileDownload(env, SOURCE, { signal: options.signal ?? new AbortController().signal, ...options });
const methods = (calls) => calls.map(([method]) => method);

test('the native sink gets every range in order, one acked write at a time, then finish and share', async () => {
  const host = fakeHost({ size: 10, rangeMaxBytes: 4 });
  const native = fakeNative();
  const { env, delivered } = environment(host, { kind: 'native', call: native.call });
  const phases = [];
  const outcome = await run(env, { onProgress: (progress) => phases.push(progress.phase) });

  const { shareAgain, ...plain } = outcome;
  // A shell that predates `persisted` kept the file: read as persisted.
  assert.deepEqual(plain, { name: 'build.zip', size: 10, destination: 'native', result: 'shared', persisted: true });
  assert.equal(typeof shareAgain, 'function');
  assert.deepEqual(host.calls[0], ['authorize', { source: SOURCE, purpose: 'share' }]);
  assert.deepEqual(
    host.calls.filter(([method]) => method === 'range'),
    [
      ['range', 0, 4, 'v1'],
      ['range', 4, 4, 'v1'],
      ['range', 8, 2, 'v1'],
    ]
  );
  assert.deepEqual(
    native.written.bytes(),
    Array.from({ length: 10 }, (_, i) => byteAt(i))
  );
  assert.equal(native.maxInflight(), 1);
  assert.deepEqual(methods(native.calls), [
    'fileSaveBegin',
    'fileSaveWrite',
    'fileSaveWrite',
    'fileSaveWrite',
    'fileSaveFinish',
    'fileSaveShare',
  ]);
  assert.deepEqual(native.calls[0][1], { name: 'build.zip', mime: 'application/zip', size: 10, purpose: 'share' });
  assert.deepEqual(native.calls.at(-2)[1], { handle: 'h1', size: 10 });
  assert.ok(host.calls.some(([method]) => method === 'finish'));
  assert.ok(!host.calls.some(([method]) => method === 'abort'));
  assert.equal(delivered.length, 0);
  assert.deepEqual([...new Set(phases)], ['preparing', 'downloading', 'saving', 'sharing']);
});

test('native chunks never exceed the native write limit even when the host allows bigger ranges', async () => {
  const host = fakeHost({ size: 1024 * 1024 + 5, rangeMaxBytes: 4 * 1024 * 1024 });
  const native = fakeNative();
  const { env } = environment(host, { kind: 'native', call: native.call });
  await run(env);
  assert.deepEqual(
    host.calls.filter(([method]) => method === 'range').map(([, offset, length]) => [offset, length]),
    [
      [0, 1024 * 1024],
      [1024 * 1024, 5],
    ]
  );
});

test('cancelling mid-transfer aborts the native file and the host lease, and never finishes', async () => {
  const host = fakeHost({ size: 12, rangeMaxBytes: 4 });
  const controller = new AbortController();
  const native = fakeNative({
    holdWrite: (args) => {
      if (args.offset === 4) controller.abort();
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
  });
  const { env } = environment(host, { kind: 'native', call: native.call });
  await assert.rejects(run(env, { signal: controller.signal }), FileDownloadCancelledError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    native.calls.find(([method]) => method === 'fileSaveAbort'),
    ['fileSaveAbort', { handle: 'h1' }]
  );
  assert.ok(host.calls.some(([method, id]) => method === 'abort' && id === 't1'));
  assert.ok(!host.calls.some(([method]) => method === 'finish'));
  assert.ok(!native.calls.some(([method]) => method === 'fileSaveFinish'));
});

test('a cancel that lands while authorize is in flight releases the grant that arrives later', async () => {
  const host = fakeHost();
  let grant;
  host.api.authorize = () =>
    new Promise((resolve) => {
      grant = () => resolve({ grantId: 'late', name: 'x', size: 1, mime: 'x', version: 'v1', expiresAt: 0 });
    });
  const controller = new AbortController();
  const { env } = environment(host, { kind: 'browser' });
  const pending = run(env, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, FileDownloadCancelledError);
  grant();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(host.calls, [['abort', 'late']]);
});

test('a share sheet the user dismissed is not a failure; a broken one still leaves the file saved', async () => {
  for (const [share, result] of [
    [{ ok: false, error: 'cancelled' }, 'dismissed'],
    [{ ok: true, shared: false }, 'dismissed'],
    [{ ok: false, error: 'storage' }, 'share-failed'],
  ]) {
    const host = fakeHost();
    const native = fakeNative({ share });
    const { env } = environment(host, { kind: 'native', call: native.call });
    const outcome = await run(env);
    assert.equal(outcome.result, result);
    assert.ok(!native.calls.some(([method]) => method === 'fileSaveAbort'));
  }
});

/** A native finish the test releases, answering `persisted`. */
function heldFinish(persisted) {
  let release;
  const started = new Promise((resolve) => {
    release = (args) => resolve(args);
  });
  let answer;
  const finish = (args) => {
    release(args);
    return new Promise((resolve) => {
      answer = () => resolve({ ok: true, handle: args.handle, displayName: 'build.zip', size: args.size, persisted });
    });
  };
  return { finish, started, answer: () => answer() };
}

test('a cancel while the native finish is pending never shares; a kept file is reported as kept', async () => {
  const held = heldFinish(true);
  const host = fakeHost();
  const native = fakeNative({ finish: held.finish });
  const { env } = environment(host, { kind: 'native', call: native.call });
  const controller = new AbortController();
  const pending = run(env, { signal: controller.signal });
  await held.started;
  controller.abort();
  held.answer();
  const outcome = await pending;
  assert.equal(outcome.result, 'saved-before-cancel');
  assert.equal(outcome.persisted, true);
  assert.equal(outcome.shareAgain, undefined);
  assert.ok(!native.calls.some(([method]) => method === 'fileSaveShare'), 'no share sheet after a cancel');
});

test('a cancel while the native finish is pending leaves an unkept file cancelled, unshared', async () => {
  const held = heldFinish(false);
  const host = fakeHost();
  const native = fakeNative({ finish: held.finish });
  const { env } = environment(host, { kind: 'native', call: native.call });
  const controller = new AbortController();
  const pending = run(env, { signal: controller.signal });
  await held.started;
  controller.abort();
  held.answer();
  await assert.rejects(pending, FileDownloadCancelledError);
  assert.ok(!native.calls.some(([method]) => method === 'fileSaveShare'));
});

test('a file only in staging reports persisted false and can be shared again until its handle expires', async () => {
  const shares = [
    { ok: true, shared: false },
    { ok: true, shared: true },
    { ok: false, error: 'unknown-handle' },
  ];
  const native = fakeNative({
    finish: async (args) => ({
      ok: true,
      handle: args.handle,
      displayName: 'build.zip',
      size: args.size,
      persisted: false,
    }),
    share: () => shares.shift(),
  });
  const { env } = environment(fakeHost(), { kind: 'native', call: native.call });
  const outcome = await run(env);
  assert.equal(outcome.result, 'dismissed');
  assert.equal(outcome.persisted, false);
  assert.equal(await outcome.shareAgain(), 'shared');
  assert.equal(await outcome.shareAgain(), 'expired');
  assert.deepEqual(
    native.calls.filter(([method]) => method === 'fileSaveShare'),
    [
      ['fileSaveShare', { handle: 'h1' }],
      ['fileSaveShare', { handle: 'h1' }],
      ['fileSaveShare', { handle: 'h1' }],
    ]
  );
});

test('dismissing the native save location cancels quietly and releases the lease', async () => {
  const host = fakeHost();
  const native = fakeNative({ begin: { ok: false, error: 'cancelled' } });
  const { env } = environment(host, { kind: 'native', call: native.call });
  await assert.rejects(run(env), FileDownloadCancelledError);
  assert.ok(host.calls.some(([method, id]) => method === 'abort' && id === 't1'));
});

test('native storage and permission failures keep their reasons', async () => {
  for (const error of ['storage', 'permission']) {
    const host = fakeHost();
    const native = fakeNative({ begin: { ok: false, error } });
    const { env } = environment(host, { kind: 'native', call: native.call });
    const failure = await run(env).catch((reason) => reason);
    assert.ok(failure instanceof FileSaveError);
    assert.equal(failure.reason, error);
  }
});

const MEDIA = { assetId: 'lease-asset', variant: 'download', expiresAt: 0 };
const LANE_URL = 'https://mixdog.test/__mixdog-download__/lease-asset?v=v1';

test('a browser with a confirmed media lane hands the lease URL to a download, reading nothing itself', async () => {
  const host = fakeHost({ size: 200 * 1024 * 1024, media: MEDIA });
  const seen = [];
  const { env, delivered, probed } = environment(host, { kind: 'browser' }, (transfer) => {
    seen.push(transfer.media);
    return LANE_URL;
  });
  const outcome = await run(env);
  assert.deepEqual(outcome, { name: 'build.zip', size: 200 * 1024 * 1024, destination: 'lane', result: 'started' });
  assert.deepEqual(host.calls[0], ['authorize', { source: SOURCE, purpose: 'save' }]);
  assert.deepEqual(seen, [MEDIA]);
  assert.deepEqual(probed, [LANE_URL], 'the worker answered before the browser went there');
  assert.deepEqual(delivered[0].target, { url: LANE_URL });
  assert.deepEqual(methods(host.calls), ['authorize', 'begin']);
});

test('a browser reads a confirmed lane itself in Range windows into one Blob, with progress and a later share', async () => {
  const size = LANE_WINDOW_BYTES * 2 + 5;
  const host = fakeHost({ size, media: MEDIA });
  const { env, delivered, laneReads } = environment(host, { kind: 'browser' }, () => LANE_URL);
  const shared = [];
  env.shareLater = (blob, transfer) => () => {
    shared.push([blob.size, transfer.name]);
    return Promise.resolve('shared');
  };
  const progress = [];
  const outcome = await run(env, { onProgress: (step) => progress.push([step.phase, step.received]) });
  assert.equal(outcome.destination, 'blob');
  assert.equal(outcome.result, 'saved');
  assert.deepEqual(laneReads, [
    [LANE_URL, 0, LANE_WINDOW_BYTES],
    [LANE_URL, LANE_WINDOW_BYTES, LANE_WINDOW_BYTES],
    [LANE_URL, LANE_WINDOW_BYTES * 2, 5],
  ]);
  assert.deepEqual(methods(host.calls), ['authorize', 'begin'], 'no RPC range read and no abort of the lane lease');
  assert.deepEqual(
    progress.filter(([phase]) => phase === 'downloading').map(([, received]) => received),
    [LANE_WINDOW_BYTES, LANE_WINDOW_BYTES * 2, size]
  );
  const blob = delivered[0].target.blob;
  assert.equal(blob.size, size);
  assert.equal(blob.type, 'application/zip');
  const tail = new Uint8Array(await blob.slice(size - 5).arrayBuffer());
  assert.deepEqual(
    [...tail],
    Array.from({ length: 5 }, (_, i) => byteAt(size - 5 + i))
  );
  assert.equal(await outcome.shareAgain(), 'shared');
  assert.deepEqual(shared, [[size, 'build.zip']]);
});

test('a lane read the worker refuses as changed fails the download without delivering', async () => {
  const host = fakeHost({ size: 10, media: MEDIA });
  const { env, delivered } = environment(host, { kind: 'browser' }, () => LANE_URL);
  env.readLane = async () => {
    throw new FileDownloadError('changed', 'The file changed on the host.');
  };
  const failure = await run(env).catch((reason) => reason);
  assert.equal(failure.reason, 'changed');
  assert.equal(delivered.length, 0);
  // The lease belongs to the lane once the worker answered; nothing to abort over RPC.
  assert.deepEqual(methods(host.calls), ['authorize', 'begin']);
});

test('a lane over the page read limit is still handed to the browser as its URL', async () => {
  const host = fakeHost({ size: LANE_BLOB_MAX_BYTES + 1, media: MEDIA });
  const { env, delivered, laneReads } = environment(host, { kind: 'browser' }, () => LANE_URL);
  assert.equal((await run(env)).result, 'started');
  assert.deepEqual(delivered[0].target, { url: LANE_URL });
  assert.deepEqual(laneReads, []);
});

test('a lane the worker cannot serve falls back to RPC ranges for a small file', async () => {
  const host = fakeHost({ size: 10, rangeMaxBytes: 4, media: MEDIA });
  const { env, delivered, probed } = environment(host, { kind: 'browser' }, () => LANE_URL, 'unavailable');
  const outcome = await run(env);
  assert.equal(outcome.destination, 'blob');
  assert.deepEqual(probed, [LANE_URL]);
  assert.deepEqual(methods(host.calls), ['authorize', 'begin', 'range', 'range', 'range', 'finish']);
  assert.ok('blob' in delivered[0].target, 'the lane URL was never navigated');
});

test('a lane failure leaves a large browser file refused, and 412 means the file changed', async () => {
  const large = fakeHost({ size: BLOB_FALLBACK_MAX_BYTES + 1, media: MEDIA });
  const refused = environment(large, { kind: 'browser' }, () => LANE_URL, 'unavailable');
  assert.equal((await run(refused.env).catch((reason) => reason)).reason, 'browser-too-large');
  assert.deepEqual(methods(large.calls), ['authorize', 'begin', 'abort']);
  assert.equal(refused.delivered.length, 0);

  const moved = fakeHost({ media: MEDIA });
  const changed = environment(moved, { kind: 'browser' }, () => LANE_URL, 'changed');
  const failure = await run(changed.env).catch((reason) => reason);
  assert.equal(failure.reason, 'changed');
  assert.equal(fileDownloadFailureMessage(failure), fileDownloadReasonMessage('changed'));
  assert.deepEqual(methods(moved.calls), ['authorize', 'begin', 'abort']);
  assert.equal(changed.delivered.length, 0);
});

test('the native sink stays on RPC ranges even when the transfer carries a lane lease', async () => {
  const host = fakeHost({ size: 6, rangeMaxBytes: 4, media: MEDIA });
  const native = fakeNative();
  const { env, probed } = environment(host, { kind: 'native', call: native.call }, () => LANE_URL);
  assert.equal((await run(env)).destination, 'native');
  assert.deepEqual(probed, []);
  assert.equal(host.calls.filter(([method]) => method === 'range').length, 2);
});

test('without the lane a small file arrives as one Blob after the host confirms it', async () => {
  const host = fakeHost({ size: 10, rangeMaxBytes: 4 });
  const { env, delivered } = environment(host, { kind: 'browser' });
  const outcome = await run(env);
  assert.equal(outcome.destination, 'blob');
  assert.deepEqual(methods(host.calls), ['authorize', 'begin', 'range', 'range', 'range', 'finish']);
  const blob = delivered[0].target.blob;
  assert.equal(blob.type, 'application/zip');
  assert.deepEqual(
    [...new Uint8Array(await blob.arrayBuffer())],
    Array.from({ length: 10 }, (_, i) => byteAt(i))
  );
});

test('without the lane a file over the Blob limit is refused before any byte moves', async () => {
  const host = fakeHost({ size: BLOB_FALLBACK_MAX_BYTES + 1 });
  const { env, delivered } = environment(host, { kind: 'browser' });
  const failure = await run(env).catch((reason) => reason);
  assert.ok(failure instanceof FileSaveError);
  assert.equal(failure.reason, 'browser-too-large');
  assert.match(fileDownloadFailureMessage(failure), /Update Mixdog on the PC and on this device/);
  assert.deepEqual(methods(host.calls), ['authorize', 'begin', 'abort']);
  assert.equal(delivered.length, 0);

  const exact = fakeHost({ size: BLOB_FALLBACK_MAX_BYTES, rangeMaxBytes: BLOB_FALLBACK_MAX_BYTES });
  const fits = environment(exact, { kind: 'browser' });
  assert.equal((await run(fits.env)).destination, 'blob', 'exactly the limit still fits');
});

test('a range of another version fails the transfer as changed and releases it', async () => {
  const host = fakeHost({ chunkVersion: 'v2' });
  const { env } = environment(host, { kind: 'browser' });
  const failure = await run(env).catch((reason) => reason);
  assert.equal(failure.reason, 'changed');
  assert.ok(host.calls.some(([method]) => method === 'abort'));
});

test('an old host and a device without a sink are refused before anything is asked', async () => {
  const old = fakeHost({ available: false });
  const oldEnv = environment(old, { kind: 'browser' }).env;
  assert.equal((await run(oldEnv).catch((reason) => reason)).reason, 'host-too-old');
  assert.deepEqual(await fileDownloadSupport(oldEnv), { state: 'blocked', reason: 'host-too-old' });
  assert.deepEqual(old.calls, []);

  const missing = environment({ api: undefined }, { kind: 'browser' }).env;
  assert.equal((await run(missing).catch((reason) => reason)).reason, 'host-too-old');

  const sinkless = fakeHost();
  const sinklessEnv = environment(sinkless, { kind: 'none' }).env;
  assert.equal((await run(sinklessEnv).catch((reason) => reason)).reason, 'no-sink');
  assert.deepEqual(await fileDownloadSupport(sinklessEnv), { state: 'blocked', reason: 'no-sink' });
  assert.deepEqual(sinkless.calls, []);

  assert.deepEqual(await fileDownloadSupport(environment(fakeHost(), { kind: 'browser' }).env), {
    state: 'ready',
    native: false,
  });
});

test('every refusal reason maps to its own catalogued message', () => {
  const locales = new URL('./locales/', import.meta.url);
  const catalogs = readdirSync(locales).map((file) => JSON.parse(readFileSync(new URL(file, locales), 'utf8')));
  const messages = FILE_DOWNLOAD_ERROR_REASONS.map((reason) => {
    const fromClass = fileDownloadFailureMessage(new FileDownloadError(reason, 'raw host text'));
    // The remote shim restores only `code` on a plain Error.
    const fromCode = fileDownloadFailureMessage(
      Object.assign(new Error('raw host text'), { code: fileDownloadErrorCode(reason) })
    );
    assert.equal(fromClass, fromCode);
    assert.equal(fromClass, fileDownloadReasonMessage(reason));
    return fromClass;
  });
  const saveMessages = ['no-sink', 'browser-too-large', 'storage', 'permission', 'device'].map(fileSaveFailureMessage);
  for (const message of [...messages, ...saveMessages]) {
    assert.ok(message && message !== 'raw host text');
    for (const catalog of catalogs) assert.equal(typeof catalog[message], 'string', `translated: ${message}`);
  }
  assert.equal(new Set(messages).size, messages.length);
  assert.equal(fileDownloadFailureMessage(new Error('socket closed')), 'socket closed');
});

test('a folder refusal states the host counts against the caps and asks for a subfolder', () => {
  const host = new FileDownloadError('folder-too-large', folderTooLargeMessage(14200, 90 * 1024 * 1024));
  const message = fileDownloadFailureMessage(host);
  assert.match(message, /14,200 files and 90\.0 MB/);
  assert.match(message, /2,000 files and 64 MB/);
  assert.match(message, /subfolder/);
  // The remote shim restores only `code` on a plain Error; the text survives.
  const restored = Object.assign(new Error(host.message), { code: fileDownloadErrorCode('folder-too-large') });
  assert.equal(fileDownloadFailureMessage(restored), message);
});

test('rate and time left come from the recent samples', () => {
  assert.equal(transferRate([{ at: 0, bytes: 0 }]), null);
  assert.equal(
    transferRate([
      { at: 1000, bytes: 0 },
      { at: 3000, bytes: 4000 },
    ]),
    2000
  );
  assert.equal(remainingMs(2000, 4000, 10_000), 3000);
  assert.equal(remainingMs(null, 0, 10), null);
  assert.equal(remainingMs(2000, 10, 10), null);
});
