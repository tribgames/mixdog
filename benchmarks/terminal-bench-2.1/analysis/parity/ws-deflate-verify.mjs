// Has `ws`'s own Receiver read the frames the Rust client wrote (`wsio.rs` test `what_we_send_is_what_ws_sends_in_every_negotiation`
// dumps them to MIXDOG_WS_OUT): each must come back as the message the vectors name. The server side of that proof.
// Usage: node ws-deflate-verify.mjs <node-tree> <rust-frames.json> <ws-deflate-vectors.json>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
}
if (failures) process.exit(1);
console.log(`ws read ${frames} frames of ${rust.length} negotiations as the messages the Rust client sent`);
