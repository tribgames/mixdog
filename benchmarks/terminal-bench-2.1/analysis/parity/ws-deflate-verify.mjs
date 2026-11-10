// Has `ws`'s own Receiver read the frames the Rust client wrote (`wsio.rs` test `what_we_send_is_what_ws_sends_in_every_negotiation`
// dumps them to MIXDOG_WS_OUT; its mask is fixed, so the frames are the same on every run): each must come back as the
// message the vectors name. It writes what ws read with the frames it read (`--out`, `fixtures/ws-read-rust.json`), and
// the Rust test checks that it still writes exactly those frames and that ws read them as the messages sent, so no test
// runs this script or cargo.
// Usage: node ws-deflate-verify.mjs <node-tree> <rust-frames.json> <ws-deflate-vectors.json> --out <ws-read-rust.json>
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(`${resolve(process.argv[2])}/package.json`);
const wsRoot = dirname(require.resolve('ws'));
const internal = (name) => require(join(wsRoot, 'lib', name));
const Receiver = internal('receiver');
const PerMessageDeflate = internal('permessage-deflate');
const extension = internal('extension');
const NAME = PerMessageDeflate.extensionName;
/** The longest one case may take to be read. */
const CASE_DEADLINE_MS = 10_000;
const MAX_PAYLOAD = 16 * 1024 * 1024;

const rust = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const vectors = JSON.parse(readFileSync(process.argv[4], 'utf8'));
let failures = 0;
let frames = 0;
const cases = [];
for (const entry of rust) {
  const recorded = vectors.cases.find((c) => c.name === entry.name);
  // The messages the Rust side sent: every one of the vectors' client messages that is not fragmented.
  const expected = recorded.client.messages.filter((m) => m.frames.length === 1).map((m) => (m.hex ?? Buffer.from(m.text).toString('hex')));
  const server = new PerMessageDeflate({ isServer: true, maxPayload: MAX_PAYLOAD });
  server.accept(extension.parse('permessage-deflate; client_max_window_bits')[NAME]);
  // The server answers with the parameters the case negotiated, as ws's own server would.
  const answer = extension.parse(entry.response)[NAME][0];
  const configured = new PerMessageDeflate({ isServer: true, maxPayload: MAX_PAYLOAD, serverNoContextTakeover: Boolean(answer.server_no_context_takeover), clientNoContextTakeover: Boolean(answer.client_no_context_takeover), serverMaxWindowBits: answer.server_max_window_bits, clientMaxWindowBits: answer.client_max_window_bits });
  configured.accept(extension.parse('permessage-deflate; client_max_window_bits')[NAME]);
  const receiver = new Receiver({ binaryType: 'nodebuffer', extensions: { [NAME]: configured }, isServer: true, maxPayload: MAX_PAYLOAD, skipUTF8Validation: false });
  const seen = [];
  const done = new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error(`${entry.name}: not read within ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS);
    receiver.on('message', (data) => seen.push(Buffer.from(data).toString('hex')));
    receiver.on('error', (error) => { clearTimeout(timer); reject(new Error(`${entry.name}: ws refused the frames: ${error.message}`)); });
    receiver.on('finish', () => { clearTimeout(timer); resolveDone(); });
  });
  for (const frame of entry.frames) { receiver.write(Buffer.from(frame, 'hex')); frames += 1; }
  receiver.end();
  await done;
  if (JSON.stringify(seen) !== JSON.stringify(expected)) { failures += 1; console.error(`${entry.name}: ws read ${seen.length} messages that differ from the ${expected.length} sent`); }
  cases.push({ name: entry.name, response: entry.response, frames: entry.frames, read: seen });
}
if (failures) process.exit(1);
const out = process.argv[process.argv.indexOf('--out') + 1];
const wsVersion = JSON.parse(readFileSync(join(wsRoot, 'package.json'), 'utf8')).version;
const vectorsSha256 = createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');
const manifest = { exact: true, ws: wsVersion, maxPayload: MAX_PAYLOAD, vectorsSha256, read: 'ws Receiver, server side, the case\'s negotiated permessage-deflate parameters' };
writeFileSync(resolve(out), `${JSON.stringify({ manifest, cases }, null, 1)}\n`);
console.log(`ws read ${frames} frames of ${rust.length} negotiations as the messages the Rust client sent`);
