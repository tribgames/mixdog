import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteWebrtcSourceCaptures } from './source-capture.ts';

const KEY = 'screen:1';
const PLAN = { sourceId: 'screen:1:0', width: 1920, height: 1080, maxFrameRate: 30 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { kind: 'video', contentHint: '', stopped: false, stop: () => (track.stopped = true) };
  return { track, getVideoTracks: () => [track], getTracks: () => [track] };
}

/** A sender whose next replaceTrack waits for `gate` when one is set. */
function fakeSender() {
  const sender = {
    track: null,
    gate: null,
    replaceTrack(track) {
      const gate = sender.gate;
      sender.gate = null;
      return Promise.resolve(gate).then(() => {
        sender.track = track;
      });
    },
  };
  return sender;
}

function fixture(senderCount = 1) {
  const acquisitions = [];
  const sources = new Map();
  const events = [];
  const senders = Array.from({ length: senderCount }, fakeSender);
  const captures = createRemoteWebrtcSourceCaptures({
    acquire: () => {
      const acquisition = deferred();
      acquisitions.push(acquisition);
      return acquisition.promise;
    },
    sources,
    senders: (sourceKey) => (sourceKey === KEY ? senders : []),
    emit: (event) => events.push(event),
  });
  return { captures, acquisitions, sources, events, senders };
}

test('a source closed while its capture opens never gets a live track', async () => {
  const h = fixture();
  const capture = h.captures.capture(KEY, PLAN);
  h.captures.close(KEY);
  const stream = fakeStream();
  h.acquisitions[0].resolve(stream);
  await capture;
  assert.equal(stream.track.stopped, true, 'the late track is stopped');
  assert.equal(h.sources.has(KEY), false);
  assert.equal(h.senders[0].track, null);
  assert.deepEqual(h.events, [], 'nothing to report for a closed source');

  const failed = fixture();
  const failing = failed.captures.capture(KEY, PLAN);
  failed.captures.close(KEY);
  failed.acquisitions[0].reject(new Error('denied'));
  await failing;
  assert.deepEqual(failed.events, [], 'a closed source fails no connection');
});

test('a source closed while its capture swaps tracks keeps no live track', async () => {
  const h = fixture(2);
  const hold = deferred();
  h.senders[0].gate = hold.promise;
  const capture = h.captures.capture(KEY, PLAN);
  const stream = fakeStream();
  h.acquisitions[0].resolve(stream);
  await flush();
  h.captures.close(KEY);
  hold.resolve();
  await capture;
  assert.equal(stream.track.stopped, true);
  assert.equal(h.senders[1].track, null, 'no sender is swapped after the close');
  assert.equal(h.sources.has(KEY), false);
  assert.deepEqual(h.events, []);
});

test('overlapping captures: only the newest is installed, the late older one is stopped', async () => {
  const h = fixture();
  const older = h.captures.capture(KEY, PLAN);
  const newer = h.captures.capture(KEY, { ...PLAN, width: 2560, height: 1440 });
  const newest = fakeStream();
  h.acquisitions[1].resolve(newest);
  await newer;
  const late = fakeStream();
  h.acquisitions[0].resolve(late);
  await older;
  assert.equal(late.track.stopped, true);
  assert.equal(newest.track.stopped, false);
  assert.equal(h.sources.get(KEY).track, newest.track);
  assert.equal(h.senders[0].track, newest.track);
  assert.deepEqual(
    h.events.map((event) => event.ok),
    [true],
    'only the owning capture reports'
  );
});

test('a newer capture that starts while the older one swaps tracks ends with every sender on it', async () => {
  const h = fixture(2);
  const hold = deferred();
  h.senders[0].gate = hold.promise;
  const older = h.captures.capture(KEY, PLAN);
  const first = fakeStream();
  h.acquisitions[0].resolve(first);
  await flush();
  const newer = h.captures.capture(KEY, PLAN);
  hold.resolve();
  await older;
  assert.equal(h.senders[1].track, null, 'a superseded capture stops swapping');
  const second = fakeStream();
  h.acquisitions[1].resolve(second);
  await newer;
  assert.ok(h.senders.every((sender) => sender.track === second.track));
  assert.equal(first.track.stopped, true, 'the superseded track is stopped');
  assert.equal(second.track.stopped, false);
  assert.equal(h.sources.get(KEY).track, second.track);
  assert.deepEqual(
    h.events.map((event) => event.ok),
    [true]
  );
});
