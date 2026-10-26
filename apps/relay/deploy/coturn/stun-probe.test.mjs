import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import test from 'node:test';

import {
  STUN_RC,
  STUN_RM,
  STUN_RTO_MS,
  bindingRequest,
  parseBindingResponse,
  probeStun,
} from './stun-probe.mjs';

const COOKIE = Buffer.from('2112a442', 'hex');
const ID = Buffer.alloc(12, 9);

/** One attribute, padded to a multiple of 4 as RFC 8489 §14 requires. */
function attribute(type, value) {
  const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  padded.writeUInt16BE(type, 0);
  padded.writeUInt16BE(value.length, 2);
  value.copy(padded, 4);
  return padded;
}

/** XOR-MAPPED-ADDRESS value for an IPv4 `address:port`. */
function mappedIpv4(address, port) {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(port ^ 0x2112, 2);
  address.split('.').forEach((octet, index) => {
    value[4 + index] = Number(octet) ^ COOKIE[index];
  });
  return value;
}

/** A Binding success response around `body`; `length` overrides the header's length field. */
function response(body, { id = ID, length = body.length, type = 0x0101 } = {}) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(length, 2);
  COOKIE.copy(header, 4);
  id.copy(header, 8);
  return Buffer.concat([header, body]);
}

const mapped = (address, port) => attribute(0x0020, mappedIpv4(address, port));

test('a Binding request is a bare RFC 8489 header', () => {
  const id = Buffer.alloc(12, 7);
  const request = bindingRequest(id);
  assert.equal(request.length, 20);
  assert.equal(request.readUInt16BE(0), 0x0001);
  assert.equal(request.readUInt16BE(2), 0);
  assert.deepEqual(request.subarray(4, 8), COOKIE);
  assert.deepEqual(request.subarray(8), id);
});

test('the mapped address is un-XORed, skipping other attributes, and foreign replies are ignored', () => {
  assert.deepEqual(parseBindingResponse(response(mapped('203.0.113.9', 54321)), ID), {
    address: '203.0.113.9',
    port: 54321,
  });
  const software = attribute(0x8022, Buffer.from('coturn-x'));
  const odd = attribute(0x8028, Buffer.from('abc')); // 3 bytes of value + 1 of padding
  assert.deepEqual(parseBindingResponse(response(Buffer.concat([software, odd, mapped('198.51.100.7', 3478)])), ID), {
    address: '198.51.100.7',
    port: 3478,
  });
  assert.equal(parseBindingResponse(response(mapped('203.0.113.9', 1)), Buffer.alloc(12, 1)), null);
  assert.equal(parseBindingResponse(response(mapped('203.0.113.9', 1), { type: 0x0111 }), ID), null);
  assert.equal(parseBindingResponse(Buffer.alloc(20), ID), null);
});

test('truncated or inconsistent messages are refused, not read around', () => {
  const good = response(mapped('203.0.113.9', 54321));
  assert.notEqual(parseBindingResponse(good, ID), null);
  // Truncated header.
  for (const size of [0, 3, 19]) assert.equal(parseBindingResponse(good.subarray(0, size), ID), null, `header ${size}`);
  // Datagram cut inside the attribute: the length field promises more than arrived.
  for (const size of [21, 23, 24, 27, 31]) {
    assert.equal(parseBindingResponse(good.subarray(0, size), ID), null, `cut at ${size}`);
  }
  // Length field larger / smaller than what follows, or not a multiple of 4.
  assert.equal(parseBindingResponse(response(mapped('203.0.113.9', 1), { length: 16 }), ID), null);
  assert.equal(parseBindingResponse(response(mapped('203.0.113.9', 1), { length: 8 }), ID), null);
  assert.equal(parseBindingResponse(response(mapped('203.0.113.9', 1), { length: 10 }), ID), null);
  // Bytes after the message the header describes.
  assert.equal(parseBindingResponse(Buffer.concat([good, Buffer.alloc(4)]), ID), null);
  // An attribute that overruns the message, or whose padding is missing.
  const overrun = Buffer.from(attribute(0x8022, Buffer.from('coturn-x')));
  overrun.writeUInt16BE(40, 2);
  assert.equal(parseBindingResponse(response(overrun), ID), null);
  // A value of 5 bytes needs 3 bytes of padding that the message does not carry.
  const unpadded = Buffer.concat([Buffer.from([0x80, 0x28, 0x00, 0x05]), Buffer.from('abcd')]);
  assert.equal(parseBindingResponse(response(unpadded), ID), null);
  // A bare attribute header with no room for its value.
  assert.equal(parseBindingResponse(response(Buffer.from([0x80, 0x22, 0x00, 0x04])), ID), null);
  // A well-formed attribute list followed by a fragment of another.
  assert.equal(parseBindingResponse(response(Buffer.concat([mapped('203.0.113.9', 1), Buffer.from([0x80, 0x22])])), ID), null);
});

test('a XOR-MAPPED-ADDRESS must be the complete 8-byte IPv4 form', () => {
  const value = mappedIpv4('203.0.113.9', 5000);
  for (const bad of [value.subarray(0, 7), value.subarray(0, 4), Buffer.concat([value, Buffer.alloc(4)]), Buffer.alloc(0)]) {
    assert.equal(parseBindingResponse(response(attribute(0x0020, bad)), ID), null, `length ${bad.length}`);
  }
  const ipv6 = Buffer.alloc(20);
  ipv6[1] = 0x02;
  assert.equal(parseBindingResponse(response(attribute(0x0020, ipv6)), ID), null, 'IPv6 form');
  const unknownFamily = Buffer.from(value);
  unknownFamily[1] = 0x03;
  assert.equal(parseBindingResponse(response(attribute(0x0020, unknownFamily)), ID), null);
  // A bad mapped attribute poisons the message even after a good one.
  assert.equal(
    parseBindingResponse(response(Buffer.concat([mapped('203.0.113.9', 1), attribute(0x0020, value.subarray(0, 7))])), ID),
    null
  );
});

test('the retransmission schedule is the RFC 8489 §6.2.1 one', () => {
  assert.deepEqual([STUN_RTO_MS, STUN_RC, STUN_RM], [500, 7, 16]);
});

/** A UDP endpoint that records each datagram it gets; `reply(count, request, remote)` may answer. */
async function endpoint(t, reply = () => null) {
  const socket = createSocket('udp4');
  const received = [];
  t.after(() => socket.close());
  socket.on('message', (request, remote) => {
    received.push({ at: performance.now(), request });
    const answer = reply(received.length, request, remote);
    if (answer) socket.send(answer, remote.port, remote.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, received };
}

test('probeStun resends the same request on the doubling schedule and answers on a later copy', async (t) => {
  const rto = 20;
  const server = await endpoint(t, (count, request, remote) =>
    count === 3 ? response(mapped(remote.address, remote.port), { id: request.subarray(8, 20) }) : null
  );
  const result = await probeStun('127.0.0.1', server.port, { rtoMs: rto });
  assert.equal(result.address, '127.0.0.1');
  assert.equal(server.received.length, 3);
  assert.equal(server.received.every(({ request }) => request.equals(server.received[0].request)), true);
  // Sends at 0, rto, 3*rto (timers may fire a millisecond early).
  const [first, second, third] = server.received.map(({ at }) => at);
  assert.ok(second - first >= rto - 3, String(second - first));
  assert.ok(third - second >= 2 * rto - 3, String(third - second));
});

test('probeStun gives up after Rc requests and Rm times the RTO of silence', async (t) => {
  const rto = 10;
  const server = await endpoint(t);
  const started = performance.now();
  await assert.rejects(probeStun('127.0.0.1', server.port, { rtoMs: rto }), /no STUN reply/u);
  const elapsed = performance.now() - started;
  assert.equal(server.received.length, STUN_RC);
  // 0, 1, 3, 7, 15, 31 RTO are the sends; the transaction fails at 31 + Rm = 47 RTO.
  assert.ok(elapsed >= (31 + STUN_RM) * rto - 5, String(elapsed));
});

test('probeStun ignores a malformed reply and keeps waiting for a good one', async (t) => {
  const server = await endpoint(t, (count, request, remote) =>
    count === 1
      ? response(mapped(remote.address, remote.port), { id: request.subarray(8, 20), length: 4 })
      : response(mapped(remote.address, remote.port), { id: request.subarray(8, 20) })
  );
  const result = await probeStun('127.0.0.1', server.port, { rtoMs: 20 });
  assert.equal(result.address, '127.0.0.1');
  assert.equal(server.received.length, 2);
});
