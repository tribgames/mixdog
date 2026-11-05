#!/usr/bin/env node
// MXT transport golden twin (DS-REM-4, WP-REMOTE). Drives the Node product's carrier-agnostic
// stream core (shared/remote-transport.ts: framing, split/fragment, sender, receiver, path
// monitor) through deterministic scenarios and records every operation with its observed result.
// The Rust `mixdog-remote::transport` replays the same operations and must produce equal results,
// including the wire bytes (as lengths and SHA-256 of each carrier message).
//
// Boxes are synthetic (`MXE\x01 | u64 sequence | nonce | body | tag` with a deterministic body):
// the stream core never opens them, and a sequence in the header is all it reads.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-remote-transport.mjs --tree <dir with node_modules>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, sha256, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const T = await importFrom(tree, 'apps/desktop/src/shared/remote-transport.ts');

const ops = [];
const things = new Map();
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const digest = (bytes) => ({ len: bytes.byteLength, sha: sha256(Buffer.from(bytes)) });

function makeBox(seq, len, kind = 'MXE') {
  const box = new Uint8Array(len);
  box.set([0x4d, 0x58, kind === 'MXE' ? 0x45 : 0x43, 0x01], 0);
  new DataView(box.buffer).setBigUint64(4, BigInt(seq), false);
  for (let i = 12; i < len; i += 1) box[i] = (i * 7 + seq) % 251;
  return box;
}

/** Records one operation and what the product did with it. */
function rec(op, args, run) {
  let result;
  try {
    result = run() ?? null;
  } catch (error) {
    result = { error: error.message };
  }
  ops.push({ op, ...args, result });
  return result;
}

const control = (cseq, value) => T.readRemoteTransportControl({ stale: false, value, sequence: cseq }, 'client');
const outSeqs = (list) => list.map((entry) => entry.sequence);

// ---- constants ------------------------------------------------------------------------------
rec('consts', {}, () => ({
  maxMessage: T.REMOTE_TRANSPORT_MAX_MESSAGE_BYTES,
  chunk: T.REMOTE_TRANSPORT_CHUNK_BYTES,
  chunkHeader: T.REMOTE_TRANSPORT_CHUNK_HEADER_BYTES,
  maxRecord: T.REMOTE_TRANSPORT_MAX_RECORD_BYTES,
  inFlight: T.REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT,
  headReserve: T.REMOTE_TRANSPORT_HEAD_RESERVE_BYTES,
  futureBudget: T.REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES,
  receiveBudget: T.REMOTE_TRANSPORT_RECEIVE_BUDGET_BYTES,
  bulk: T.REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES,
  mediaRecord: T.REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES,
  mediaChunkChars: T.REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS,
  controlPlaintext: T.REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES,
  ackRanges: T.REMOTE_TRANSPORT_MAX_ACK_RANGES,
  fragment: T.REMOTE_TRANSPORT_FRAGMENT_BYTES,
  maxFragments: T.REMOTE_TRANSPORT_MAX_FRAGMENTS,
  assemblyPool: T.REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES,
  charge: [0, 10, 70000, 2000000].map((n) => T.remoteTransportRecordCharge(n)),
  fits: [undefined, null, 1000, 65466, 70000, Infinity].map((n) => T.remoteTransportCarrierFits(n)),
}));

// ---- framing --------------------------------------------------------------------------------
const encoded = (seq, len) => T.encodeRemoteTransportRecord(makeBox(seq, len));
for (const [seq, len] of [[1, 1000], [2, T.REMOTE_TRANSPORT_CHUNK_BYTES], [3, T.REMOTE_TRANSPORT_CHUNK_BYTES + 1], [4, 200000], [5, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES], [6, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES + 1], [7, 39]]) {
  rec('encode_record', { seq, len }, () => encoded(seq, len).map(digest));
}
const message = (seq, len, index) => encoded(seq, len)[index];
const described = (m) => {
  const d = T.decodeRemoteTransportMessage(m);
  return d.kind === 'app'
    ? { kind: 'app', sequence: d.sequence, len: d.box.byteLength }
    : d.kind === 'chunk'
      ? { kind: 'chunk', sequence: d.sequence, index: d.index, count: d.count, total: d.total, len: d.data.byteLength }
      : { kind: 'control', len: d.box.byteLength };
};
for (const [seq, len, index] of [[1, 1000, 0], [4, 200000, 0], [4, 200000, 3], [5, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES, 15]]) {
  rec('decode_record', { seq, len, index }, () => described(message(seq, len, index)));
}
const rawCases = [
  '00', '4d585401', '4d58540109', '4d5854ff01' + '00'.repeat(60), '4d58540101' + '00'.repeat(60),
  '4d58540103' + '4d584301' + '00'.repeat(60), '4d58540103' + '4d584301' + '00'.repeat(20),
  '4d58540102' + '00'.repeat(30),
];
for (const raw of rawCases) rec('decode_raw', { hex: raw }, () => described(Buffer.from(raw, 'hex')));
// A chunk whose header lies about its geometry, in each way a forger can.
const forgedChunk = (seq, index, count, total, dataLen) => {
  const out = new Uint8Array(T.REMOTE_TRANSPORT_CHUNK_HEADER_BYTES + dataLen);
  out.set([0x4d, 0x58, 0x54, 0x01, 2], 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(5, BigInt(seq), false);
  view.setUint32(13, index, false);
  view.setUint32(17, count, false);
  view.setUint32(21, total, false);
  return out;
};
for (const [seq, index, count, total, dataLen] of [[1, 0, 2, 100, 100], [1, 0, 3, 100000, 65441], [1, 2, 2, 100000, 100], [1, 1, 2, 100000, 5], [0, 0, 2, 100000, 65441], [1, 1, 2, 100000, 100000 - 65441]]) {
  rec('decode_forged', { seq, index, count, total, dataLen }, () => described(forgedChunk(seq, index, count, total, dataLen)));
}
for (const len of [39, 40, 100, 65441, 65442]) {
  rec('encode_control', { len }, () => digest(T.encodeRemoteTransportControl(makeBox(1, len, 'MXC'))));
}
rec('encode_control_app_box', {}, () => digest(T.encodeRemoteTransportControl(makeBox(1, 100, 'MXE'))));

// ---- control messages -----------------------------------------------------------------------
const controlCases = [
  { v: 1, t: 'ack', through: 5 }, { v: 1, t: 'ack', through: 5, ranges: [[7, 9], [11, 11]] },
  { v: 1, t: 'ack', through: 5, ranges: [[6, 9]] }, { v: 1, t: 'ack', through: 5, ranges: [[7, 9], [10, 12]] },
  { v: 1, t: 'ack', through: 5, ranges: [[7, 6]] }, { v: 1, t: 'ack', through: 5, ranges: [[7, 5 + 128]] },
  { v: 1, t: 'ack', through: 5, ranges: [[7, 5 + 129]] }, { v: 2, t: 'ack', through: 5 }, { v: 1, t: 'ack', through: -1 },
  { v: 1, t: 'repair', sequences: [3, 5, 9] }, { v: 1, t: 'repair', sequences: [] }, { v: 1, t: 'repair', sequences: [5, 5] },
  { v: 1, t: 'repair', sequences: [0] }, { v: 1, t: 'ping', id: 3 }, { v: 1, t: 'ping', id: 3, sent: 12 },
  { v: 1, t: 'pong', id: 3, sent: 12 }, { v: 1, t: 'ping', id: 0 }, { v: 1, t: 'ping', id: 3, sent: -1 },
];
for (const value of controlCases) {
  rec('read_control', { cseq: 4, value }, () => {
    const c = control(4, value);
    return c === null ? null : { t: c.t, ...(c.through !== undefined ? { through: c.through, ranges: c.ranges ?? [] } : {}), ...(c.sequences ? { sequences: c.sequences } : {}), ...(c.id !== undefined ? { id: c.id, sent: c.sent ?? null } : {}) };
  });
}
rec('read_control_stale', {}, () => T.readRemoteTransportControl({ stale: true, value: { v: 1, t: 'ack', through: 1 }, sequence: 1 }, 'client'));
rec('control_json', {}, () => [
  JSON.stringify(T.remoteTransportAck(7)), JSON.stringify(T.remoteTransportAck(7, [[9, 10], [12, 12]])),
  JSON.stringify(T.remoteTransportRepair([3, 4])), JSON.stringify(T.remoteTransportPing(5)),
  JSON.stringify(T.remoteTransportPing(5, 9)), JSON.stringify({ v: 1, t: 'pong', id: 5 }),
]);

// ---- receiver: reorder, dedup, chunk reassembly --------------------------------------------
const receiver = (n) => rec('new_receiver', { n }, () => { things.set(n, new T.RemoteTransportReceiver()); });
const accept = (n, m, now = 0) => T.decodeRemoteTransportMessage(m) && things.get(n).accept(T.decodeRemoteTransportMessage(m), now);
const rAccept = (n, seq, len, index, now = 0) => rec('r_accept', { n, seq, len, index, now }, () => accept(n, message(seq, len, index), now));
const rForge = (n, f, now = 0) =>
  rec('r_accept_forged', { n, ...f, now }, () => {
    const m = forgedChunk(f.seq, f.index, f.count, f.total, f.dataLen);
    const data = m.subarray(T.REMOTE_TRANSPORT_CHUNK_HEADER_BYTES);
    data.fill(f.fill ?? 0xaa);
    if (f.headerSeq !== undefined) {
      data.set([0x4d, 0x58, 0x45, 0x01], 0);
      new DataView(data.buffer, data.byteOffset).setBigUint64(4, BigInt(f.headerSeq), false);
    }
    return accept(n, m, now);
  });
const rNext = (n) =>
  rec('r_next', { n }, () => {
    const next = things.get(n).next();
    return next ? { sequence: next.sequence, ...digest(next.box) } : null;
  });
const rCommit = (n, seq, now = 0) => rec('r_commit', { n, seq, now }, () => things.get(n).commit(seq, now));
const rDiscard = (n, seq) => rec('r_discard', { n, seq }, () => things.get(n).discard(seq));
const rDrain = (n, now = 0) => {
  for (let next = things.get(n).next(); next; next = things.get(n).next()) {
    rNext(n);
    rCommit(n, next.sequence, now);
  }
  rNext(n);
};
const rStats = (n) => rec('r_stats', { n }, () => things.get(n).stats());
const rAckDue = (n, now) => rec('r_ack_due', { n, now }, () => things.get(n).ackDue(now));
const rAckSent = (n, through) => rec('r_ack_sent', { n, through }, () => things.get(n).ackSent(through));
const rRepairDue = (n, now, rtt = null) => rec('r_repair_due', { n, now, rtt }, () => things.get(n).repairDue(now, rtt ? things.get(rtt) : undefined));
const rProbe = (n, sent, now) => rec('r_probe', { n, sent, now }, () => things.get(n).probe(sent, now));
const rSweep = (n, now, idle) => rec('r_sweep', { n, now, idle: idle ?? null }, () => (idle == null ? things.get(n).sweep(now) : things.get(n).sweep(now, idle)));
const rCarrier = (n, now) => rec('r_carrier_changed', { n, now }, () => things.get(n).carrierChanged(now));

receiver('r1');
rAccept('r1', 3, 1000, 0, 1);
for (const index of [2, 0, 1]) rAccept('r1', 2, 150000, index, 2);
rAccept('r1', 2, 150000, 1, 3);
rAccept('r1', 200, 1000, 0, 3);
rStats('r1');
rAckDue('r1', 4);
rAccept('r1', 1, 70000, 1, 4);
rAccept('r1', 1, 70000, 0, 4);
rDrain('r1', 5);
rAckDue('r1', 5);
rAckSent('r1', 3);
rAckDue('r1', 6);
rAccept('r1', 2, 150000, 0, 7);
rAckDue('r1', 7);
rStats('r1');
receiver('r2');
rForge('r2', { seq: 1, index: 0, count: 2, total: 100000, dataLen: 65441, headerSeq: 9 }, 1);
rForge('r2', { seq: 1, index: 0, count: 2, total: 100000, dataLen: 65441, headerSeq: 1 }, 1);
rForge('r2', { seq: 1, index: 0, count: 2, total: 90000, dataLen: 65441, headerSeq: 1 }, 2);
rForge('r2', { seq: 1, index: 0, count: 2, total: 80000, dataLen: 65441, headerSeq: 1 }, 3);
rStats('r2');
rForge('r2', { seq: 1, index: 1, count: 2, total: 100000, dataLen: 100000 - 65441, fill: 1 }, 4);
rNext('r2');
rDiscard('r2', 1);
rStats('r2');
rAccept('r2', 1, 100000, 0, 5);
rAccept('r2', 1, 100000, 1, 5);
rNext('r2');
rRepairDue('r2', 6);
rCommit('r2', 1, 7);
rCommit('r2', 2, 7);
// Many future records and the byte-only window: each record is charged one carrier message.
receiver('r3');
for (let seq = 2; seq <= 140; seq += 1) rAccept('r3', seq, 100, 0, seq);
rStats('r3');
rAccept('r3', 1, 100, 0, 200);
rDrain('r3', 201);
rStats('r3');
rAckDue('r3', 202);

// ---- sender: retain, ack, carrier switch ----------------------------------------------------
const sender = (n) => rec('new_sender', { n }, () => { things.set(n, new T.RemoteTransportSender()); });
const sPush = (n, seq, len, stream) => rec('s_push', { n, seq, len, stream: stream ?? null }, () => things.get(n).push(makeBox(seq, len), stream === undefined ? {} : { stream }));
const sDue = (n, now, budget) => rec('s_due', { n, now, budget: budget ?? null }, () => outSeqs(budget === undefined ? things.get(n).due(now) : things.get(n).due(now, budget)));
const sSent = (n, seq, carrier, now) => rec('s_mark_sent', { n, seq, carrier, now }, () => things.get(n).markSent(seq, carrier, now));
const sAck = (n, cseq, through, ranges, now) => rec('s_ack', { n, cseq, through, ranges, now }, () => things.get(n).acknowledge(control(cseq, T.remoteTransportAck(through, ranges)), now));
const sRepair = (n, cseq, sequences) => rec('s_repair', { n, cseq, sequences }, () => things.get(n).repair(control(cseq, T.remoteTransportRepair(sequences))));
const sFailed = (n, carrier, now, hold) => rec('s_carrier_failed', { n, carrier, now, hold }, () => things.get(n).carrierFailed(carrier, now, hold));
const sStats = (n) => rec('s_stats', { n }, () => things.get(n).stats());
const sAdmit = (n, stream, buffered) => rec('s_can_admit', { n, stream: stream ?? null, buffered }, () => things.get(n).canAdmit(stream === undefined ? { bufferedAmount: buffered } : { stream, bufferedAmount: buffered }));
const sProbeDue = (n, now, pto) => rec('s_probe_due', { n, now, pto }, () => things.get(n).probeDue(now, pto));
const sProbeThrough = (n, carrier, buffered) => rec('s_probe_through', { n, carrier, buffered }, () => things.get(n).probeThrough(carrier, buffered));
const sExpired = (n, now) => rec('s_expired', { n, now }, () => things.get(n).expired(now));

sender('s1');
sPush('s1', 2, 1000);
sPush('s1', 1, 1000);
for (const [seq, len] of [[1, 1000], [2, 5000], [3, 70000], [4, 2000], [5, 3000]]) sPush('s1', seq, len);
sDue('s1', 10);
sDue('s1', 10, 6000);
sDue('s1', 10, 0);
for (let seq = 1; seq <= 5; seq += 1) sSent('s1', seq, 'relay', 10 + seq);
sDue('s1', 20);
sAck('s1', 1, 9, [], 21);
sAck('s1', 2, 2, [[4, 4]], 22);
sStats('s1');
sAck('s1', 3, 1, [], 23);
sProbeThrough('s1', 'relay', 0);
sProbeThrough('s1', 'relay', 60000);
// The relay carrier fails: what it carried is re-sent after one PTO hold, minus held records.
sFailed('s1', 'relay', 100, 300);
sDue('s1', 150);
sDue('s1', 450);
sAck('s1', 4, 2, [[4, 4]], 460);
sDue('s1', 460);
sRepair('s1', 5, [4, 5, 99]);
sDue('s1', 461);
sSent('s1', 3, 'direct:a', 462);
sSent('s1', 4, 'direct:a', 462);
sSent('s1', 5, 'direct:a', 462);
sAck('s1', 6, 5, [], 470);
sStats('s1');
sExpired('s1', 100000);
// An ack sealed before a later repair never undoes it; an ack after the failure ends the hold.
sender('s2');
for (let seq = 1; seq <= 4; seq += 1) { sPush('s2', seq, 1000); sSent('s2', seq, 'relay', 1); }
sRepair('s2', 10, [2]);
sAck('s2', 9, 0, [[2, 3]], 2);
sDue('s2', 3);
sSent('s2', 2, 'relay', 3);
sAck('s2', 11, 0, [[2, 3]], 4);
sFailed('s2', 'relay', 5, 1000);
sDue('s2', 6);
sAck('s2', 12, 0, [[3, 3]], 7);
sDue('s2', 7);
sAck('s2', 13, 0, [[3, 3]], 8);
sDue('s2', 8);
sProbeDue('s2', 100, 50);
// PTO at the sender: probes double.
sender('s3');
sPush('s3', 1, 1000);
sSent('s3', 1, 'relay', 1000);
for (const now of [1100, 1200, 1300, 1400, 1600, 1700, 2000, 2100]) sProbeDue('s3', now, 100);
sAck('s3', 1, 1, [], 2200);
sProbeDue('s3', 9000, 100);
// Expiry counts from the last ack advance and a healthy slow link never expires.
sender('s4');
for (let seq = 1; seq <= 3; seq += 1) { sPush('s4', seq, 1000); sSent('s4', seq, 'relay', 100); }
sExpired('s4', 60099);
sExpired('s4', 60100);
sAck('s4', 1, 1, [], 50000);
sExpired('s4', 60100);
sExpired('s4', 110000);
sExpired('s4', 110001 - 1);
sAck('s4', 2, 3, [], 110000);
sExpired('s4', 999999);
// Window and bulk credit: a maximal record needs room; media streams have their own credit.
sender('s5');
sAdmit('s5', undefined, 0);
sAdmit('s5', 'm1', 0);
sAdmit('s5', 'm1', 1048577);
let seqNo = 1;
for (; seqNo <= 40; seqNo += 1) {
  const ok = rec('s_can_admit', { n: 's5', stream: 'm1', buffered: 0 }, () => things.get('s5').canAdmit({ stream: 'm1', bufferedAmount: 0 }));
  if (!ok) break;
  sPush('s5', seqNo, 80000, 'm1');
}
sAdmit('s5', 'm2', 0);
sAdmit('s5', undefined, 0);
sPush('s5', seqNo, 80000, 'm1');
sPush('s5', seqNo, 90000, 'm2');
sPush('s5', seqNo, 2000000);
sStats('s5');
sender('s6');
for (let seq = 1; seq <= 8; seq += 1) { sAdmit('s6', undefined, 0); sPush('s6', seq, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES); }
sAdmit('s6', undefined, 0);
sPush('s6', 9, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES);
sPush('s6', 9, T.REMOTE_TRANSPORT_MAX_RECORD_BYTES);
sStats('s6');

// ---- path monitor ---------------------------------------------------------------------------
const monitor = (n, now) => rec('new_monitor', { n, now }, () => { things.set(n, new T.RemoteTransportPathMonitor(now)); });
const mValues = (n) => rec('m_values', { n }, () => { const m = things.get(n); return { pto: m.ptoMs(), lossDelay: m.lossDelayMs(), idle: m.idleTimeoutMs(), smoothed: m.smoothedRttMs() }; });
const mCall = (name, key, n, args) => rec(name, { n, args }, () => things.get(n)[key](...args));
monitor('m1', 0);
mValues('m1');
for (const rtt of [100, 120, 80, 400, 90]) { mCall('m_rtt_sample', 'rttSample', 'm1', [rtt]); mValues('m1'); }
mCall('m_stalled', 'stalled', 'm1', [5000, 0]);
mCall('m_stalled', 'stalled', 'm1', [5999, 0]);
mCall('m_stalled', 'stalled', 'm1', [6000, 0]);
mCall('m_inbound', 'inbound', 'm1', [6000]);
// An empty queue is not progress; outstanding work with no ack or drain for 6 s is a stall.
mCall('m_stalled', 'stalled', 'm1', [8000, 5000]);
mCall('m_inbound', 'inbound', 'm1', [9000]);
mCall('m_stalled', 'stalled', 'm1', [13999, 5000]);
mCall('m_inbound', 'inbound', 'm1', [13999]);
mCall('m_stalled', 'stalled', 'm1', [14000, 5000]);
mCall('m_ack_advanced', 'ackAdvanced', 'm1', [14000]);
mCall('m_stalled', 'stalled', 'm1', [19999, 5000]);
mCall('m_stalled', 'stalled', 'm1', [20000, 5000]);
mCall('m_buffered', 'buffered', 'm1', [900000, 20000]);
mCall('m_buffered', 'buffered', 'm1', [800000, 25000]);
mCall('m_inbound', 'inbound', 'm1', [25000]);
mCall('m_stalled', 'stalled', 'm1', [30999, 5000]);
mCall('m_inbound', 'inbound', 'm1', [31000]);
mCall('m_stalled', 'stalled', 'm1', [31000, 5000]);
mCall('m_reset', 'reset', 'm1', [40000]);
mValues('m1');
mCall('m_stalled', 'stalled', 'm1', [45999, 1]);
// A very slow link: idle timeout is at least 3 PTO.
monitor('m2', 0);
mCall('m_rtt_sample', 'rttSample', 'm2', [5000]);
mValues('m2');
mCall('m_stalled', 'stalled', 'm2', [6000, 0]);
mCall('m_stalled', 'stalled', 'm2', [50000, 0]);

// ---- loss recovery (receiver + path estimator) ---------------------------------------------
monitor('mr', 0);
mCall('m_rtt_sample', 'rttSample', 'mr', [100]);
receiver('l1');
rAccept('l1', 1, 1000, 0, 100);
rDrain('l1', 100);
rAccept('l1', 3, 1000, 0, 110);
rRepairDue('l1', 110, 'mr');
rRepairDue('l1', 221, 'mr');
rRepairDue('l1', 222, 'mr');
rAccept('l1', 6, 1000, 0, 230);
rRepairDue('l1', 230, 'mr');
rRepairDue('l1', 400, 'mr');
rRepairDue('l1', 530, 'mr');
rRepairDue('l1', 540, 'mr');
rRepairDue('l1', 1000, 'mr');
rRepairDue('l1', 2000, 'mr');
rAccept('l1', 2, 1000, 0, 2001);
rDrain('l1', 2001);
rRepairDue('l1', 2002, 'mr');
rStats('l1');
// A lost FINAL record: no later record reveals the gap; the ping's `sent` does.
receiver('l2');
rAccept('l2', 1, 1000, 0, 0);
rDrain('l2', 0);
rRepairDue('l2', 50, 'mr');
rProbe('l2', 3, 60);
rRepairDue('l2', 100, 'mr');
rRepairDue('l2', 170, 'mr');
rRepairDue('l2', 171, 'mr');
rRepairDue('l2', 380, 'mr');
rRepairDue('l2', 1000);
// An eviction or a failed authentication is an explicit loss, declared once.
receiver('l3');
rAccept('l3', 1, 150000, 0, 0);
rSweep('l3', 5999, null);
rSweep('l3', 6000, null);
rRepairDue('l3', 6000);
rAccept('l3', 1, 150000, 0, 6001);
rSweep('l3', 12001, 10000);
rSweep('l3', 16001, 10000);
rRepairDue('l3', 16001);
rRepairDue('l3', 16002);
receiver('l4');
rAccept('l4', 1, 1000, 0, 0);
rNext('l4');
rDiscard('l4', 1);
rDiscard('l4', 1);
rRepairDue('l4', 1);
rAccept('l4', 1, 1000, 0, 2);
rDrain('l4', 2);
rCarrier('l4', 3);
rAckDue('l4', 3);
rAckSent('l4', 1);
rAckDue('l4', 4);

// ---- demotion end to end: path stall -> carrier failed -> resume on the relay ---------------
sender('d1');
monitor('dm', 0);
receiver('d2');
for (let seq = 1; seq <= 4; seq += 1) sPush('d1', seq, 20000);
for (let seq = 1; seq <= 4; seq += 1) sSent('d1', seq, 'direct:a', 100);
mCall('m_outstanding', 'outstanding', 'dm', [things.get('d1').stats().outstandingBytes, 100]);
mCall('m_inbound', 'inbound', 'dm', [100]);
rec('d_ack', { n: 'd1', cseq: 1, through: 1, ranges: [], now: 500 }, () => things.get('d1').acknowledge(control(1, T.remoteTransportAck(1)), 500));
mCall('m_ack_advanced', 'ackAdvanced', 'dm', [500]);
mCall('m_inbound', 'inbound', 'dm', [500]);
mCall('m_stalled', 'stalled', 'dm', [6499, 3 * 65466]);
mCall('m_stalled', 'stalled', 'dm', [6500, 3 * 65466]);
sFailed('d1', 'direct:a', 6500, 0);
sDue('d1', 6500);
for (const seq of [2, 3, 4]) sSent('d1', seq, 'relay', 6501);
sAck('d1', 2, 4, [], 6600);
sStats('d1');

// ---- messages above the record layer --------------------------------------------------------
const textOf = (len) => `{"k":"${'a'.repeat(len - 8)}"}`;
const splits = [];
for (const [name, len, id] of [['small', 100, 1], ['edge', 1048576, 2], ['over', 1048577, 3], ['big', 2500000, 4], ['bad', 2500000, 0]]) {
  rec('split', { name, len, id }, () => {
    const payloads = T.splitRemoteTransportPayload(JSON.parse(textOf(len)), id);
    things.set(`split:${name}`, payloads);
    return payloads.map((p) => digest(Buffer.from(JSON.stringify(p))));
  });
  splits.push(name);
}
rec('split_limit', {}, () => {
  try {
    T.splitRemoteTransportPayload(JSON.parse(textOf(10)), 1);
    return T.REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES;
  } catch (error) {
    return error.message;
  }
});
const aNew = (n, pool) => rec('a_new', { n, pool: pool ?? null }, () => { things.set(n, pool ? new T.RemoteTransportMessageAssembler(things.get(pool)) : new T.RemoteTransportMessageAssembler(new T.RemoteTransportAssemblyPool())); });
const aAccept = (n, split, index, now) =>
  rec('a_accept', { n, split, index, now }, () => {
    const out = things.get(n).accept(things.get(`split:${split}`)[index], now);
    return out.state === 'complete' ? { state: 'complete', ...digest(Buffer.from(JSON.stringify(out.payload))) } : { state: out.state };
  });
aNew('a1');
for (let index = 0; index < 3; index += 1) aAccept('a1', 'big', index, 10 + index);
rec('a_state', { n: 'a1' }, () => ({ pending: things.get('a1').pendingBytes(), reserved: things.get('a1').reservedBytes(), stalled: things.get('a1').stalled(10 + 60000), idle: things.get('a1').stalled(12 + 59999) }));
aAccept('a1', 'big', 2, 20);
rec('a_state', { n: 'a1' }, () => ({ pending: things.get('a1').pendingBytes(), reserved: things.get('a1').reservedBytes() }));
aNew('a2');
for (let index = 0; index < 3; index += 1) aAccept('a2', 'big', index, 10);
rec('a_close', { n: 'a2' }, () => things.get('a2').close());
rec('a_state', { n: 'a2' }, () => ({ pending: things.get('a2').pendingBytes(), reserved: things.get('a2').reservedBytes() }));
aNew('a3');
aAccept('a3', 'big', 1, 1);
aAccept('a3', 'small', 0, 1);
aNew('a4');
aAccept('a4', 'small', 0, 1);
aAccept('a4', 'big', 0, 1);
aAccept('a4', 'small', 0, 2);
rec('new_pool', { p: 'pool', capacity: 4000000 }, () => { things.set('pool', new T.RemoteTransportAssemblyPool(4000000)); });
aNew('a5', 'pool');
aNew('a6', 'pool');
aAccept('a5', 'big', 0, 1);
aAccept('a6', 'big', 0, 1);
rec('pool_used', { p: 'pool' }, () => things.get('pool').usedBytes());
rec('a_close', { n: 'a5' }, () => things.get('a5').close());
aAccept('a6', 'big', 0, 2);
rec('pool_used', { p: 'pool' }, () => things.get('pool').usedBytes());
// A complete large message: every fragment in order.
aNew('a7');
rec('a_all', { n: 'a7', split: 'big', now: 5 }, () => {
  const parts = things.get('split:big');
  let last;
  parts.forEach((p, i) => { last = things.get('a7').accept(p, 5 + i); });
  return last.state === 'complete' ? { state: 'complete', ...digest(Buffer.from(JSON.stringify(last.payload))) } : { state: last.state };
});

const outDir = join(FIXTURES_ROOT, 'remote-transport');
writeJson(join(outDir, 'vectors.json'), {
  recorder: 'record-remote-transport.mjs',
  note: 'Operations on the MXT stream core with the results the Node product produced; replayed by mixdog-remote.',
  ops,
});
writeSetManifest(outDir, { set: 'remote-transport', recorder: 'benchmarks/rust-core/recorders/record-remote-transport.mjs', command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-remote-transport.mjs --tree <tree>', identityTree: tree });
console.log(`remote-transport: ${ops.length} operations`);
process.exit(0);
