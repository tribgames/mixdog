#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the transport media adapter
// (apps/desktop/src/main/remote-transport/media.ts) driven by scripted inputs: the REAL adapter and the REAL window
// logic (remote-relay-media.ts serveMediaWindow, the real media encryption), over a stand-in for the coordinator's
// link and for the download leases. Every message the adapter seals is logged in order; a media frame is logged as what
// it decrypts to (the meta, or a segment's offset, length and digest), because its nonce is random.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-transport-media.mjs --tree <exact git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-transport-media.mjs';
const finalDir = join(FIXTURES_ROOT, 'remote-transport-media');
const stage = stageSet(finalDir);

// The adapter has no completion of its own to await (receive() answers a boolean; every pump is `void`ed), so the recorder reads
// the adapter's pumps at their resting points. A load hook adds one probe call at each place a pump starts, parks for room
// (`stream.wake = resolve`), is woken, or ends (the `streams.delete` / `refusing = false` lines); it changes nothing else, and every
// edit must match exactly once or the recording stops. A step is over when every pump has ended, is parked for room, or waits on a
// send or read this script keeps pending: the pumps that are none of those are the ones still moving, and each leaves motion only
// through one of those events, so no clock, no event-loop turn and no count of yields decides anything.
const PROBE_EDITS = [
  [/stream\.wake = resolve;/g, 'stream.wake = resolve; globalThis.__mediaProbe.parked(stream);'],
  [/resolve\?\.\(\);/g, 'if (resolve) globalThis.__mediaProbe.woke(stream); resolve?.();'],
  [/streams\.set\(stream\.id, stream\);/g, 'streams.set(stream.id, stream); globalThis.__mediaProbe.started(stream);'],
  [/if \(streams\.get\(stream\.id\) === stream\) streams\.delete\(stream\.id\);/g, 'if (streams.get(stream.id) === stream) { streams.delete(stream.id); globalThis.__mediaProbe.ended(stream); }'],
  [/\n(\s+)refusing = true;/g, '\n$1refusing = true; globalThis.__mediaProbe.started(refuser);'],
  [/\n(\s+)refusing = false;/g, '\n$1refusing = false; globalThis.__mediaProbe.ended(refuser);'],
];
const probeHooks = `
const EDITS = ${JSON.stringify(PROBE_EDITS.map(([re, to]) => [re.source, to]))};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/apps/desktop/src/main/remote-transport/media.ts')) return loaded;
  let source = String(loaded.source);
  for (const [pattern, to] of EDITS) {
    const re = new RegExp(pattern, 'g');
    if ((source.match(re) ?? []).length !== 1) throw new Error('probe edit does not match exactly once: ' + pattern);
    source = source.replace(re, to);
  }
  return { ...loaded, source, shortCircuit: true };
}
`;
register(`data:text/javascript,${encodeURIComponent(probeHooks)}`);
const probe = (globalThis.__mediaProbe = {
  live: new Set(),
  parkedSet: new Set(),
  held: () => 0,
  notify: null,
  poke() {
    const notify = probe.notify;
    probe.notify = null;
    notify?.();
  },
  started(pump) {
    probe.live.add(pump);
    probe.poke();
  },
  parked(pump) {
    probe.parkedSet.add(pump);
    probe.poke();
  },
  woke(pump) {
    probe.parkedSet.delete(pump);
  },
  ended(pump) {
    probe.live.delete(pump);
    probe.parkedSet.delete(pump);
    probe.poke();
  },
});
async function quiesce() {
  while (probe.live.size - probe.parkedSet.size !== probe.held()) await new Promise((resolve) => (probe.notify = resolve));
}
const subtle = globalThis.crypto.subtle;const { createRemoteTransportMediaAdapter } = await importFrom(tree, 'apps/desktop/src/main/remote-transport/media.ts');
const mediaCrypto = await importFrom(tree, 'apps/desktop/src/shared/remote-media-crypto.ts');
const { parseRange } = await importFrom(tree, 'apps/relay/lib/media-http.mjs');

const KEY_BYTES = Buffer.alloc(32, 7);
const key = await subtle.importKey('raw', KEY_BYTES, 'AES-GCM', false, ['encrypt', 'decrypt']);
const SEGMENT = mediaCrypto.MEDIA_SEGMENT_BYTES;
const DEVICE = 'dev-1';
const ENC = 'e2ee1';

// ---- the leases ------------------------------------------------------------------------------------------------
const pattern = (offset, length) => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (offset + i) % 251;
  return out;
};
const ASSETS = {
  'aaaaaaaa-0001': { size: 200_000, mime: 'video/mp4', version: 'v1' },
  'aaaaaaaa-0002': { size: 70_000, mime: 'image/png' },
  'aaaaaaaa-0003': { size: 0, mime: 'text/plain' },
  'bbbbbbbb-0001': { size: 1000, mime: 'x/y', fail: 'file-download:changed' },
  'bbbbbbbb-0002': { size: 1000, mime: 'x/y', fail: 'file-download:expired' },
  'bbbbbbbb-0003': { size: 1000, mime: 'x/y', fail: 'plain' },
  'bbbbbbbb-0004': { size: 200_000, mime: 'x/y', failAfter: 1 },
  'dddddddd-0001': { size: 200_000, mime: 'video/mp4', hold: true },
};

async function scenario(name, options, script) {
  const state = { room: { default: options.room ?? true }, sends: [], reads: [], sendQueue: [], listener: null, requests: new Map(), chunkCount: new Map(), metas: new Map() };
  let effects = [];
  let results = [];
  probe.live.clear();
  probe.parkedSet.clear();
  probe.held = () => state.sends.length + state.reads.length;
  const log = (entry) => effects.push(entry);
  const readCounts = new Map();
  const downloads = {
    resolveMedia(assetId, variant, deviceId) {
      const asset = ASSETS[assetId];
      if (!asset || variant !== 'download' || deviceId !== DEVICE) return null;
      return {
        size: asset.size,
        mime: asset.mime,
        version: asset.version,
        read: async (offset, length) => {
          const count = (readCounts.get(assetId) ?? 0) + 1;
          readCounts.set(assetId, count);
          if (asset.hold) {
            await new Promise((resolve) => {
              state.reads.push(resolve);
              probe.poke();
            });
          }
          if (asset.fail === 'plain') throw new Error('disk gone');
          if (asset.fail) throw Object.assign(new Error('refused'), { code: asset.fail });
          if (asset.failAfter !== undefined && count > asset.failAfter) throw Object.assign(new Error('refused'), { code: 'file-download:changed' });
          return pattern(offset, length);
        },
      };
    },
  };
  const link = {
    canAdmit: (stream) => state.room[stream] ?? state.room.default,
    send(message, admission) {
      const entry = { e: 'send', stream: admission?.stream ?? null, message: JSON.parse(JSON.stringify(message)) };
      log(entry);
      const next = state.sendQueue.length ? state.sendQueue.shift() : options.send === 'held' ? 'held' : true;
      if (next === 'held') {
        return new Promise((resolve, reject) => {
          state.sends.push({ resolve, reject });
          probe.poke();
        });
      }
      if (next === 'reject') return Promise.reject(new Error('session ended'));
      return Promise.resolve(next);
    },
    onWritable(listener) {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    },
    protocolError: (detail) => log({ e: 'protocol-error', detail }),
  };
  const adapter = createRemoteTransportMediaAdapter({
    link,
    mediaKey: options.mediaKey === false ? null : key,
    device: options.device === undefined ? DEVICE : options.device,
    host: { invokeCapability: async () => null },
    downloads,
  });

  const steps = [];
  /** Replaces each sealed media frame by what it decrypts to. */
  async function describe(list) {
    const out = [];
    for (const entry of list) {
      const message = entry.message;
      if (entry.e === 'send' && message?.op === 'chunk') {
        const request = state.requests.get(message.id);
        const bytes = Buffer.from(message.frame, 'base64url');
        const body = bytes.subarray(4);
        const index = state.chunkCount.get(message.id) ?? 0;
        state.chunkCount.set(message.id, index + 1);
        const asset = { assetId: request.assetId, variant: request.variant };
        if (index === 0) {
          const range = parseRange(request.range, ASSETS[request.assetId].size);
          const rangeStart = range && !range.unsatisfiable ? range.start : 0;
          const expectedStart = Math.floor(rangeStart / SEGMENT) * SEGMENT;
          const meta = await mediaCrypto.decryptMediaMeta(key, asset, expectedStart, body);
          state.metas.set(message.id, meta);
          out.push({ ...entry, message: { type: message.type, op: 'chunk', id: message.id, frame: { kind: 'meta', expectedStart, meta } } });
        } else {
          const meta = state.metas.get(message.id);
          const offset = meta.start + (index - 1) * SEGMENT;
          const plain = await mediaCrypto.decryptMediaSegment(key, asset, offset, meta.size, body);
          out.push({ ...entry, message: { type: message.type, op: 'chunk', id: message.id, frame: { kind: 'segment', offset, size: meta.size, length: plain.length, sha256: createHash('sha256').update(plain).digest('hex') } } });
        }
      } else out.push(entry);
    }
    return out;
  }
  const h = {
    async step(op, act) {
      effects = [];
      results = [];
      act();
      await quiesce();
      steps.push({ ...op, effects: await describe(effects), results });
    },
    request(id, assetId, extra = {}) {
      const message = { type: 'transport-media', op: 'request', id, assetId, variant: 'download', range: '', enc: ENC, ...extra };
      state.requests.set(id, message);
      return h.receive(message);
    },
    receive(payload) {
      return h.step({ op: 'receive', payload }, () => results.push({ receive: adapter.receive(payload) }));
    },
    cancel: (id) => h.receive({ type: 'transport-media', op: 'cancel', id }),
    writable: () => h.step({ op: 'writable' }, () => state.listener?.()),
    room: (stream, value) => h.step({ op: 'room', stream, value }, () => (state.room[stream ?? 'default'] = value)),
    queueSend: (...values) => h.step({ op: 'queue-send', values }, () => state.sendQueue.push(...values)),
    releaseSend: (result = true, count = 1) =>
      h.step({ op: 'release-send', result, count }, () => {
        for (let i = 0; i < count; i += 1) {
          const pending = state.sends.shift();
          if (result === 'reject') pending?.reject(new Error('session ended'));
          else pending?.resolve(result);
        }
      }),
    releaseRead: (count = 1) =>
      h.step({ op: 'release-read', count }, () => {
        for (let i = 0; i < count; i += 1) state.reads.shift()?.();
      }),
    close: () => h.step({ op: 'close' }, () => adapter.close()),
    steps,
  };
  await script(h);
  scenarios.push({ name, options, steps });
}
const scenarios = [];

await scenario('a download streams its meta frame, every segment and the end', {}, async (h) => {
  await h.request('r1', 'aaaaaaaa-0001');
  await h.request('r2', 'aaaaaaaa-0002', { range: 'bytes=70000-' });
  await h.request('r3', 'aaaaaaaa-0002', { range: 'bytes=-100' });
  await h.request('r4', 'aaaaaaaa-0003');
  await h.request('r5', 'aaaaaaaa-0001', { range: 'bytes=100000-100010' });
});

await scenario('requests the lane answers with a status', {}, async (h) => {
  await h.request('s1', 'aaaaaaaa-0099');
  await h.request('s2', 'aaaaaaaa-0001', { enc: '' });
  await h.request('s3', 'aaaaaaaa-0001', { range: 'bytes=999999-' });
  await h.request('s4', 'aaaaaaaa-0001', { variant: 'weird' });
  await h.request('s5', 'bbbbbbbb-0001');
  await h.request('s6', 'bbbbbbbb-0002');
  await h.request('s7', 'bbbbbbbb-0003');
  await h.request('s8', 'aaaaaaaa-0001', { variant: 'original' });
  await h.request('s9', 'aaaaaaaa-0001', { range: 'bytes=5-1' });
});

await scenario('a file that fails after the head ends with an error', {}, async (h) => {
  await h.request('f1', 'bbbbbbbb-0004');
});

await scenario('a session with no media key is refused', { mediaKey: false }, async (h) => {
  await h.request('k1', 'aaaaaaaa-0001');
});

await scenario('a lease is answered only to the device it was minted for', { device: 'dev-2' }, async (h) => {
  await h.request('d1', 'aaaaaaaa-0001');
});

await scenario('a session with no device refuses a download', { device: null }, async (h) => {
  await h.request('d1', 'aaaaaaaa-0001');
});

await scenario('the pump waits for room and for each send to be taken', { room: false, send: 'held' }, async (h) => {
  await h.request('w1', 'aaaaaaaa-0002');
  await h.room(null, true);
  await h.writable();
  await h.releaseSend(true, 1);
  await h.releaseSend(true, 1);
  await h.room('w1', false);
  await h.releaseSend(true, 1);
  await h.writable();
  await h.room('w1', true);
  await h.writable();
  await h.releaseSend(true, 3);
});

await scenario('a send refused before sealing is retried when room returns', {}, async (h) => {
  await h.queueSend(false);
  await h.request('t1', 'aaaaaaaa-0003');
  await h.writable();
  await h.queueSend(false, false);
  await h.request('t2', 'aaaaaaaa-0003');
  await h.writable();
  await h.writable();
});

await scenario('a session that ended aborts the stream', {}, async (h) => {
  await h.queueSend(true, 'reject');
  await h.request('e1', 'aaaaaaaa-0002');
  await h.request('e2', 'aaaaaaaa-0003');
});

await scenario('a cancel stops a stream; a repeated id is ignored', { send: 'held' }, async (h) => {
  await h.request('c1', 'aaaaaaaa-0001');
  await h.request('c1', 'aaaaaaaa-0001');
  await h.cancel('c1');
  await h.releaseSend(true, 1);
  await h.releaseSend(true, 1);
  await h.request('c1', 'aaaaaaaa-0003');
  await h.cancel('nobody');
});

await scenario('the 33rd stream is refused, a cancel takes a queued refusal back, the 65th ends the session', { send: 'held' }, async (h) => {
  for (let i = 1; i <= 32; i += 1) await h.request(`m${i}`, 'dddddddd-0001');
  await h.request('m33', 'dddddddd-0001');
  await h.request('m34', 'dddddddd-0001');
  await h.cancel('m34');
  await h.request('m35', 'dddddddd-0001');
  await h.releaseSend(true, 1);
  for (let i = 36; i <= 66; i += 1) await h.request(`m${i}`, 'dddddddd-0001');
  await h.request('m67', 'dddddddd-0001');
  await h.request('m68', 'dddddddd-0001');
  await h.request('m69', 'dddddddd-0001');
});

await scenario('messages that are not for the adapter, and malformed ones', {}, async (h) => {
  await h.receive({ id: 1, method: 'x' });
  await h.receive(null);
  await h.receive({ type: 'transport-media', op: 'head', id: 'x1', status: 200 });
  await h.receive({ type: 'transport-media', op: 'request', id: 'x2' });
  await h.receive({ type: 'transport-media', op: 'nope', id: 'x3' });
  await h.receive({ type: 'transport-media', op: 'cancel' });
  await h.receive({ type: 'transport-media', op: 'cancel', id: 'x4' });
});

await scenario('closing the session stops every pump and unsubscribes', { send: 'held' }, async (h) => {
  await h.request('z1', 'aaaaaaaa-0001');
  await h.close();
  await h.releaseSend(true, 2);
  await h.request('z2', 'aaaaaaaa-0002');
  await h.close();
  await h.writable();
});

writeJson(join(stage, 'scenarios.json'), {
  domain: 'remote-transport-media',
  recorder,
  convention: 'media key = 32 bytes of 0x07; download leases by asset id (see the recorder); a media frame is logged as what it decrypts to',
  scenarios,
});
writeSetManifest(stage, {
  set: 'remote-transport-media',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps`);
