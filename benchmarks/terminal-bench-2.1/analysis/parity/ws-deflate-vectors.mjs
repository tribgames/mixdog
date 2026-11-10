// Frames as `ws` (the WebSocket library the Node client uses) writes and reads them with permessage-deflate, recorded
// from ws's own Sender, Receiver and PerMessageDeflate: the vectors the Rust codec (`mixdog-ai` `transport/wsio.rs`) is
// tested against. Nothing is written by hand; masks are fixed so the recording repeats.
// Usage: node ws-deflate-vectors.mjs <node-tree> --node-commit <sha> --out <file>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const commit = arg('--node-commit');
const out = resolve(arg('--out'));
const require = createRequire(`${tree}/package.json`);
// ws's `exports` hides its internals; they are required by path from the package's own directory.
const wsRoot = dirname(require.resolve('ws'));
const internal = (name) => require(join(wsRoot, 'lib', name));
const Sender = internal('sender');
const Receiver = internal('receiver');
const PerMessageDeflate = internal('permessage-deflate');
const extension = internal('extension');
const { kStatusCode } = internal('constants');
const wsVersion = require(join(wsRoot, 'package.json')).version;

/** The longest any step of the recording may take. */
const STEP_DEADLINE_MS = 10_000;
const MAX_PAYLOAD = 16 * 1024 * 1024; // WS_MAX_INCOMING_FRAME_BYTES, openai-ws-pool.mjs:58
const NAME = PerMessageDeflate.extensionName;
const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no result within ${STEP_DEADLINE_MS} ms`)), STEP_DEADLINE_MS).unref())]);
const hex = (buffer) => Buffer.from(buffer).toString('hex');

// Deterministic content: text that compresses, text that repeats an earlier message (shared window), bytes that do not.
let seed = 12345;
const noise = (n) => Buffer.from(Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff));
const medium = JSON.stringify({ type: 'response.create', input: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `message number ${i} with some repeated words` })) });
const messages = [
  { name: 'small text', data: 'hello' },
  { name: 'medium text', data: medium },
  { name: 'medium text again', data: medium },
  { name: 'binary noise', data: noise(3000), binary: true },
  { name: 'empty text', data: '' },
  { name: 'fragmented', parts: [medium.slice(0, 700), medium.slice(700)] },
  { name: 'after fragmented', data: medium.slice(0, 1500) },
];

/** What a Sender writes to its socket, one entry per call of `send`. */
function senderOver(perMessageDeflate, mask) {
  const chunks = [];
  const socket = { cork() {}, uncork() {}, write(data, cb) { chunks.push(Buffer.from(data)); if (cb) cb(); } };
  const sender = new Sender(socket, { [NAME]: perMessageDeflate }, (buffer) => { buffer.fill(0); buffer[0] = 1; buffer[1] = 2; buffer[2] = 3; buffer[3] = 4; });
  const send = (data, binary, fin) => within(new Promise((resolveSend) => {
    chunks.length = 0;
    sender.send(data, { binary: Boolean(binary), compress: true, fin, mask, readOnly: false }, () => resolveSend(hex(Buffer.concat(chunks))));
  }), 'a send');
  return { send };
}

async function framesOf(side, perMessageDeflate, mask) {
  const { send } = senderOver(perMessageDeflate, mask);
  const result = [];
  for (const message of messages) {
    if (message.parts) {
      const frames = [];
      for (let i = 0; i < message.parts.length; i += 1) {
        // The first fragment carries the data opcode, later ones continue it (ws: `sender.js` `send`, `_firstFragment`).
        frames.push(await send(message.parts[i], false, i === message.parts.length - 1));
      }
      result.push({ name: message.name, text: message.parts.join(''), frames });
    } else {
      const frame = await send(message.data, message.binary, true);
      result.push({ name: message.name, ...(message.binary ? { hex: hex(message.data) } : { text: message.data }), frames: [frame] });
    }
  }
  return { side, messages: result };
}

// Server options decide what the server answers (ws `websocket-server.js`); the client accepts that answer as
// `websocket.js` does.
const cases = [
  { name: 'default', server: {} },
  { name: 'client_no_context_takeover', server: { clientNoContextTakeover: true } },
  { name: 'server_no_context_takeover', server: { serverNoContextTakeover: true } },
  { name: 'both no_context_takeover', server: { clientNoContextTakeover: true, serverNoContextTakeover: true } },
  { name: 'client_max_window_bits=10', server: { clientMaxWindowBits: 10 } },
  { name: 'server_max_window_bits=10', server: { serverMaxWindowBits: 10 } },
  { name: 'client_max_window_bits=9, server_max_window_bits=9', server: { clientMaxWindowBits: 9, serverMaxWindowBits: 9 } },
  { name: 'client_max_window_bits=8', server: { clientMaxWindowBits: 8 } },
];
const OFFER = 'permessage-deflate; client_max_window_bits';

const recorded = [];
for (const c of cases) {
  const serverSide = new PerMessageDeflate({ ...c.server, isServer: true, maxPayload: MAX_PAYLOAD });
  serverSide.accept(extension.parse(OFFER)[NAME]);
  const response = extension.format({ [NAME]: [serverSide.params] });
  const clientSide = new PerMessageDeflate({ isServer: false, maxPayload: MAX_PAYLOAD });
  clientSide.accept(extension.parse(response)[NAME]);
  recorded.push({
    name: c.name,
    offer: OFFER,
    response,
    params: clientSide.params,
    // What the client wrote (masked) and what the server wrote (unmasked), for the same messages.
    client: await framesOf('client', clientSide, true),
    server: await framesOf('server', serverSide, false),
  });
}

/** A frame as bytes: first byte (fin, rsv, opcode), payload; client frames unmasked unless `masked`. */
function frame(first, payload, masked = false) {
  const body = Buffer.from(payload);
  const head = [first];
  const flag = masked ? 0x80 : 0;
  if (body.length < 126) head.push(flag | body.length);
  else if (body.length <= 0xffff) head.push(flag | 126, body.length >> 8, body.length & 0xff);
  else { head.push(flag | 127); const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(body.length)); head.push(...len); }
  return Buffer.concat([Buffer.from(head), body]);
}

/** Feeds `chunks` to a client-side Receiver and reports what ws did: messages, or the error and the close code it uses. */
async function receive(withExtension, chunks) {
  const extensions = {};
  if (withExtension) {
    const p = new PerMessageDeflate({ isServer: false, maxPayload: MAX_PAYLOAD });
    p.accept(extension.parse('permessage-deflate')[NAME]);
    extensions[NAME] = p;
  }
  const receiver = new Receiver({ binaryType: 'nodebuffer', extensions, isServer: false, maxPayload: MAX_PAYLOAD, skipUTF8Validation: false });
  const seen = [];
  const finished = new Promise((resolveDone) => {
    receiver.on('message', (data, isBinary) => seen.push({ binary: isBinary, hex: hex(data) }));
    receiver.on('ping', () => seen.push({ ping: true }));
    receiver.on('error', (error) => resolveDone({ messages: seen, error: { message: error.message, code: error.code, closeCode: error[kStatusCode] } }));
    receiver.on('finish', () => resolveDone({ messages: seen }));
  });
  for (const chunk of chunks) receiver.write(chunk);
  receiver.end();
  return within(finished, 'a receive');
}

const packed = (text) => {
  const p = new PerMessageDeflate({ isServer: true, maxPayload: MAX_PAYLOAD });
  p.accept(extension.parse(OFFER)[NAME]);
  return p;
};
const compressedFrame = async (text, first) => {
  const { send } = senderOver(packed(), false);
  const hexed = await send(text, false, true);
  const bytes = Buffer.from(hexed, 'hex');
  return first === undefined ? bytes : Buffer.concat([Buffer.from([first]), bytes.subarray(1)]);
};

const good = await compressedFrame('compressed and fine ' + 'x'.repeat(200));
// `negatives` are the frame sequences ws refuses (an error and a close code); `accepted` are ones that look wrong but ws
const negatives = [];
const accepted = [];
const negative = async (name, withExtension, frames) => {
  const result = await receive(withExtension, frames);
  (result.error ? negatives : accepted).push({ name, extension: withExtension, frames: frames.map(hex), result });
};
await negative('RSV1 without the extension', false, [Buffer.concat([Buffer.from([0xc1]), good.subarray(1)])]);
await negative('RSV2 set', true, [frame(0xa1, 'x')]);
await negative('RSV3 set', true, [frame(0x91, 'x')]);
await negative('RSV1 on a continuation', true, [frame(0x01, 'ab'), frame(0xc0, 'cd')]);
await negative('a continuation with nothing to continue', true, [frame(0x80, 'ab')]);
await negative('a new data frame inside an unfinished message', true, [frame(0x01, 'ab'), frame(0x81, 'cd')]);
await negative('a new compressed frame inside an unfinished compressed message', true, [good.subarray(0, 0) && Buffer.concat([Buffer.from([0x41]), good.subarray(1)]), good]);
await negative('RSV1 on a ping', true, [frame(0xc9, '')]);
await negative('a fragmented ping', true, [frame(0x09, '')]);
await negative('a masked server frame', true, [frame(0x81, 'ab', true)]);
await negative('invalid deflate data', true, [frame(0xc1, Buffer.from([0xff, 0xff, 0xff, 0xff]))]);
await negative('a reserved opcode', true, [frame(0x83, 'ab')]);
await negative('a message beyond the limit', true, [frame(0xc1, (await compressedFrame('a'.repeat(MAX_PAYLOAD + 1024))).subarray(4))]);
// Lengths a 64-bit header declares past what ws reads (`getPayloadLength64`: above 2^53 - 1), alone and as the
// continuation of a fragment already received.
await negative('a text frame declaring 2^53', true, [Buffer.from('817f0020000000000000', 'hex')]);
await negative('a continuation declaring 2^64 - 1 after a fragment', true, [frame(0x01, 'ab'), Buffer.from('807fffffffffffffffff', 'hex')]);
await negative('plain text and a compressed message after it', true, [frame(0x81, 'plain'), good]);
await negative('a ping inside a compressed message', true, [Buffer.concat([Buffer.from([0x41]), good.subarray(1)]), frame(0x89, 'p'), frame(0x80, '')]);

// A case listed as a negative that ws accepted, or the reverse, would be a mislabelled vector.
if (negatives.some((n) => !n.result.error) || accepted.some((a) => a.result.error)) throw new Error('vectors are filed under the wrong outcome');
writeFileSync(out, JSON.stringify({ nodeCommit: commit, node: process.version, ws: wsVersion, zlib: process.versions.zlib, maxPayload: MAX_PAYLOAD, cases: recorded, negatives, accepted }, null, 1));
console.log(`wrote ${out}: ${recorded.length} negotiations, ${negatives.length} negatives, ${accepted.length} accepted (node ${process.version}, ws ${wsVersion})`);
