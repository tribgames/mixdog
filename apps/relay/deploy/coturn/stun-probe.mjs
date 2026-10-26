#!/usr/bin/env node
// Sends one STUN Binding request (RFC 8489) over UDP and prints the address
// the server saw. Run it from OUTSIDE the VPS to prove the UDP path through the
// provider firewall:
//   node stun-probe.mjs <host> [port=3478]
// Exit 0 with "<address>:<port>" on stdout, 1 on timeout or a malformed reply.
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { pathToFileURL } from 'node:url';

const MAGIC_COOKIE = 0x2112a442;
const HEADER_BYTES = 20;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;
/** RFC 8489 §14.2: reserved byte, family byte, X-Port (2), X-Address (4 for IPv4). */
const XOR_MAPPED_IPV4_BYTES = 8;

/** RFC 8489 §6.2.1 retransmission: the first RTO is 500 ms ("RECOMMENDED" on
 *  fixed-line access), doubling after each of Rc = 7 requests; after the last,
 *  Rm = 16 times the RTO is waited. With these defaults requests go out at 0,
 *  500, 1500, 3500, 7500, 15500 and 31500 ms and the transaction fails at
 *  39500 ms. */
export const STUN_RTO_MS = 500;
export const STUN_RC = 7;
export const STUN_RM = 16;

export function bindingRequest(transactionId = randomBytes(12)) {
  const message = Buffer.alloc(HEADER_BYTES);
  message.writeUInt16BE(0x0001, 0);
  message.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(message, 8);
  return message;
}

/** The IPv4 XOR-MAPPED-ADDRESS of a Binding success response to `transactionId`,
 *  or null. The whole message must be well formed (RFC 8489 §5, §14): a header
 *  of 20 bytes, a length field that is a multiple of 4 and equals the rest of
 *  the datagram, every attribute (padded to 4 bytes) inside it, and a
 *  XOR-MAPPED-ADDRESS that is exactly the 8-byte IPv4 form. Anything else —
 *  truncated, over-long, inconsistent — is refused rather than read around. */
export function parseBindingResponse(message, transactionId) {
  if (message.length < HEADER_BYTES) return null;
  if (message.readUInt16BE(0) !== BINDING_SUCCESS || message.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if (!message.subarray(8, HEADER_BYTES).equals(transactionId)) return null;
  const bodyBytes = message.readUInt16BE(2);
  if (bodyBytes % 4 !== 0 || HEADER_BYTES + bodyBytes !== message.length) return null;
  let mapped = null;
  for (let offset = HEADER_BYTES; offset < message.length; ) {
    if (offset + 4 > message.length) return null;
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const next = offset + 4 + length + ((4 - (length % 4)) % 4);
    if (next > message.length) return null;
    if (type === XOR_MAPPED_ADDRESS) {
      const value = message.subarray(offset + 4, offset + 4 + length);
      if (length !== XOR_MAPPED_IPV4_BYTES || value[1] !== FAMILY_IPV4) return null;
      const cookie = message.subarray(4, 8);
      mapped ??= {
        address: [0, 1, 2, 3].map((index) => value[4 + index] ^ cookie[index]).join('.'),
        port: value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16),
      };
    }
    offset = next;
  }
  return mapped;
}

/** One Binding transaction with the RFC 8489 §6.2.1 schedule. `rtoMs` exists so
 *  a test can run the same schedule at a smaller scale. */
export function probeStun(host, port = 3478, { rtoMs = STUN_RTO_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const request = bindingRequest();
    const transactionId = request.subarray(8, HEADER_BYTES);
    let timer;
    let sent = 0;
    const finish = (settle, value) => {
      clearTimeout(timer);
      socket.close();
      settle(value);
    };
    const send = () => {
      sent += 1;
      socket.send(request, port, host);
      timer = setTimeout(
        sent < STUN_RC ? send : () => finish(reject, new Error(`no STUN reply from ${host}:${port}`)),
        sent < STUN_RC ? rtoMs * 2 ** (sent - 1) : rtoMs * STUN_RM
      );
    };
    socket.once('error', (error) => finish(reject, error));
    socket.on('message', (message) => {
      const mapped = parseBindingResponse(message, transactionId);
      if (mapped) finish(resolve, mapped);
    });
    send();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, port] = process.argv.slice(2);
  if (!host) {
    console.error('usage: node stun-probe.mjs <host> [port=3478]');
    process.exit(2);
  }
  probeStun(host, port ? Number(port) : undefined).then(
    ({ address, port: mappedPort }) => console.log(`${address}:${mappedPort}`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
