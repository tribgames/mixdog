#!/usr/bin/env node
// Records what `source-capture.test.mjs` (apps/desktop/src/renderer/remote-webrtc-sender, Node `b6f10295a`) shows of a
// source's capture: the scenarios in which a capture arrives as its source closes or while another capture is installing, each run
// through Node's real `createRemoteWebrtcSourceCaptures` with the test's own fakes, recording the outcome the user sees —
// which captures' tracks were stopped (released), which capture's track is the source's, which the senders carry, and what
// was reported. The module is TypeScript: run it with the tree's tsx loader.
//
//   node --import <tree>/apps/desktop/node_modules/tsx/dist/esm/index.mjs benchmarks/rust-core/recorders/record-source-capture-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/source-capture-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-source-capture-cases.mjs';
const TEST = 'apps/desktop/src/renderer/remote-webrtc-sender/source-capture.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { createRemoteWebrtcSourceCaptures } = await importFrom(tree, 'apps/desktop/src/renderer/remote-webrtc-sender/source-capture.ts');

const KEY = 'screen:1';
const PLAN = { sourceId: 'screen:1:0', width: 1920, height: 1080, maxFrameRate: 30 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  const out = {};
  out.promise = new Promise((resolve, reject) => Object.assign(out, { resolve, reject }));
  return out;
};
const fakeStream = (name) => {
  const track = { name, kind: 'video', contentHint: '', stopped: false, stop: () => (track.stopped = true) };
  return { name, track, getVideoTracks: () => [track], getTracks: () => [track] };
};
const fakeSender = () => {
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
};
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
    createDrawn: () => {
      const stream = fakeStream('drawn');
      return { canvas: {}, context: {}, stream, track: stream.track };
    },
    sources,
    senders: (sourceKey) => (sourceKey === KEY ? senders : []),
    emit: (event) => events.push(event),
  });
  return { captures, acquisitions, sources, events, senders };
}
/** What a user sees at the end: each named capture's stop, the source's track, each sender's track, the reports. */
const outcome = (h, streams) => ({
  stopped: Object.fromEntries(streams.map((stream) => [stream.name, stream.track.stopped])),
  source: h.sources.get(KEY)?.track.name ?? null,
  senders: h.senders.map((sender) => sender.track?.name ?? null),
  reports: h.events.map((event) => event.ok),
});

const cases = [];
const record = async (name, steps, run) => {
  const streams = [];
  const stream = (n) => {
    const made = fakeStream(n);
    streams.push(made);
    return made;
  };
  cases.push({ name, steps, recorded: await run(stream, streams) });
};

await record('a source closed while its capture opens', 'capture, close, then the capture resolves', async (stream, streams) => {
  const h = fixture();
  const capture = h.captures.capture(KEY, PLAN);
  h.captures.close(KEY);
  h.acquisitions[0].resolve(stream('late'));
  await capture;
  return outcome(h, streams);
});
await record('a source closed while its capture swaps tracks', 'capture resolves, a sender swap is held, close, release', async (stream, streams) => {
  const h = fixture(2);
  const hold = deferred();
  h.senders[0].gate = hold.promise;
  const capture = h.captures.capture(KEY, PLAN);
  h.acquisitions[0].resolve(stream('late'));
  await flush();
  h.captures.close(KEY);
  hold.resolve();
  await capture;
  return outcome(h, streams);
});
await record('overlapping captures', 'two captures, the newer resolves first, then the older', async (stream, streams) => {
  const h = fixture();
  const older = h.captures.capture(KEY, PLAN);
  const newer = h.captures.capture(KEY, { ...PLAN, width: 2560, height: 1440 });
  h.acquisitions[1].resolve(stream('newest'));
  await newer;
  h.acquisitions[0].resolve(stream('late'));
  await older;
  return outcome(h, streams);
});
await record('a draw abandons a capture still opening', 'capture, draw, the capture resolves', async (stream, streams) => {
  const h = fixture();
  const capturing = h.captures.capture(KEY, PLAN);
  h.captures.draw(KEY);
  await h.sources.get(KEY).installed;
  h.acquisitions[0].resolve(stream('late'));
  await capturing;
  return { ...outcome(h, streams), drawnIsSource: h.sources.get(KEY).track.name === 'drawn' };
});
await record('a newer capture that starts while the older one swaps tracks', 'older swap held, newer starts, release, newer resolves', async (stream, streams) => {
  const h = fixture(2);
  const hold = deferred();
  h.senders[0].gate = hold.promise;
  const older = h.captures.capture(KEY, PLAN);
  h.acquisitions[0].resolve(stream('first'));
  await flush();
  const newer = h.captures.capture(KEY, PLAN);
  hold.resolve();
  await older;
  const afterOlder = h.senders.map((sender) => sender.track?.name ?? null);
  h.acquisitions[1].resolve(stream('second'));
  await newer;
  return { ...outcome(h, streams), sendersWhenTheOlderEnded: afterOlder };
});

const finalDir = join(FIXTURES_ROOT, 'source-capture-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's source captures at ${NODE_COMMIT}, per scenario of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'source-capture-cases',
  recorder: RECORDER,
  command: `node --import <tree>/apps/desktop/node_modules/tsx/dist/esm/index.mjs ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'per scenario the whole outcome: each capture\'s stop, the source\'s track, each sender\'s track, the reports',
    excluded: {
      'draw switches every sender in place onto a drawn track; a capture switches them back':
        "replaceTrack on RTCRtpSenders of a connection (source-capture.ts:96-112) has no core counterpart: the core's viewers read one shared frame source (webrtc/capture.rs), so there is no per-sender swap to compare",
    },
    declared:
      "The core's source is a frame source: a capture's `stopped` is its release (drop) and the source's track is the capture whose pictures are shown; both are compared whole. " +
      "Not compared, each with its reason: `senders` and `sendersWhenTheOlderEnded` (the tracks RTCRtpSenders carry, source-capture.ts:77-86: the core's viewers read the one shared source, so there is no per-sender track); " +
      "`reports` (the renderer's `source-captured` events, source-capture.ts:88-97, which the core's remote does not emit); `drawnIsSource` (restates `source` for the drawn track). " +
      "The core's source always has a first capture, which Node's scenarios lack: it is not in the comparison. A scenario is played by role, as capture_tests.rs says: the renderer settles ownership by the order captures started, the core's source by the order they arrive",
  },
});
commitStage(stage, finalDir);
console.log(`source-capture-cases: ${cases.length} case(s)`);
process.exit(0);
