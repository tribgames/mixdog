// The HTTP/2 side of the provider recorders' world (the twin of the `fetch` endpoint of lib/provider-case-recorder.mjs): a product that
// sends over `node:http2` (Cursor, cursor-wire-transport.mjs:4) reaches an h2c hub on loopback instead of the network. The hub records every
// stream into the same list the `fetch` endpoint records into (`rec.net.records`, one arrival order) and answers it from `rec.net.reply`.
//
// A request as it arrived: `method`, `origin` (the origin the product addressed), `path`, `headers` (the pseudo-headers first, then every
// header in arrival order) and `body`. `:authority` is written as the host and `:scheme` as the scheme of that origin (the loopback
// address and clear text are the world's); the pseudo-headers are written in the order :method, :scheme, :authority, :path, which
// HTTP/2 leaves to the client library. The body of a Connect stream (`application/connect+proto`) is its first frame, taken as soon as
// it is whole: later frames (heartbeats, tool results) are not part of the arrival. Any other body is the whole request body.
//
// A reply is `rec.net.reply`'s object: `status`, `contentType`, `headers`, and `body` or `chunks` (each chunk its own DATA frame);
// `destroy` resets the stream.
import { register } from 'node:module';
import http2 from 'node:http2';
import { ORIGIN_HEADER } from './world-http2.mjs';

const STAND_IN = new URL('./world-http2.mjs', import.meta.url).href;
const PSEUDO_ORDER = [':method', ':scheme', ':authority', ':path'];

export async function startH2World(rec) {
  const hooks = `export async function resolve(specifier, context, next) {
  if ((specifier === 'node:http2' || specifier === 'http2') && context.parentURL !== ${JSON.stringify(STAND_IN)}) return { url: ${JSON.stringify(STAND_IN)}, shortCircuit: true };
  return next(specifier, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  const hub = rec.net;
  const server = http2.createServer();
  server.on('session', (session) => session.on('error', () => {}));
  server.on('stream', (stream, _headers, _flags, rawHeaders) => {
    stream.on('error', () => {});
    serve(rec, hub, stream, rawHeaders).catch((error) => die(`the h2 hub's stream: ${error?.stack ?? error}`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  globalThis.__worldH2 = { port: server.address().port };
  return { close: () => { server.close(); delete globalThis.__worldH2; } };
}

// A failure of the hub's own machinery is the recorder's: it ends the run, never a recorded answer.
const die = (message) => {
  console.error(`recorder: ${message}`);
  process.exit(1);
};

const firstFrame =(stream, connect) => new Promise((resolve) => {
  const chunks = [];
  let held = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    resolve(Buffer.concat(chunks));
  };
  stream.on('data', (chunk) => {
    if (done) return;
    chunks.push(chunk);
    held += chunk.length;
    if (!connect || held < 5) return;
    const all = Buffer.concat(chunks);
    if (held >= 5 + all.readUInt32BE(1)) {
      chunks.length = 0;
      chunks.push(all.subarray(0, 5 + all.readUInt32BE(1)));
      finish();
    }
  });
  stream.on('end', finish);
  stream.on('close', finish);
});

async function serve(rec, hub, stream, rawHeaders) {
  const pairs = [];
  for (let i = 0; i < rawHeaders.length; i += 2) pairs.push([rawHeaders[i], rawHeaders[i + 1]]);
  const origin = pairs.find(([name]) => name === ORIGIN_HEADER)[1];
  const addressed = new URL(origin);
  const pseudo = PSEUDO_ORDER.map((name) => [name, pairs.find(([n]) => n === name)[1]]).map(([name, value]) => [name, name === ':authority' ? addressed.host : name === ':scheme' ? addressed.protocol.slice(0, -1) : value]);
  const rest = pairs.filter(([name]) => !name.startsWith(':') && name !== ORIGIN_HEADER);
  const headers = [...pseudo, ...rest];
  const byName = Object.fromEntries(rest.map(([name, value]) => [name.toLowerCase(), value]));
  const raw = await firstFrame(stream, /application\/connect\+proto/.test(byName['content-type'] ?? ''));
  const text = raw.toString('utf8');
  const record = { method: pairs.find(([n]) => n === ':method')[1], origin, path: pairs.find(([n]) => n === ':path')[1], headers, body: Buffer.from(text, 'utf8').equals(raw) ? text : raw };
  Object.defineProperty(record, 'h', { value: byName, enumerable: false });
  Object.defineProperty(record, 'whenClientClosed', { value: new Promise((resolve) => stream.on('close', resolve)) });
  Object.defineProperty(record, 'connectionPort', { value: stream.session.socket.remotePort });
  hub.records.push(record);
  rec.clock.notify();
  let reply;
  try {
    reply = hub.reply?.(record, hub.records.length) ?? { status: 404, contentType: 'application/json', body: '{"error":{"message":"not scripted"}}' };
  } catch (error) {
    die(`the scripted endpoint's reply: ${error?.stack ?? error}`);
  }
  record.reply = reply;
  if (reply.destroy) {
    stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    return;
  }
  // `date` is the one wall-clock header; fixed as the `fetch` endpoint fixes it, so the response heads the product records are stable.
  stream.respond({ ':status': reply.status ?? 200, date: 'Thu, 01 Jan 2026 00:00:00 GMT', 'content-type': reply.contentType ?? 'application/connect+proto', ...(reply.headers ?? {}) });
  for (const chunk of reply.chunks ?? []) await new Promise((resolve, reject) => stream.write(chunk, (error) => (error ? reject(error) : resolve())));
  stream.end(reply.chunks ? undefined : reply.body);
}
