#!/usr/bin/env node
// Node's webhook request parsing (src/runtime/channels/lib/webhook/request-handler.test.mjs and the paths around it) from
// the real request-handler.mjs: `parseEndpointName` for every shape of an endpoint path (query strip, percent decoding,
// undecodable escapes, the overlong and signed forms a JavaScript `decodeURIComponent` refuses), `handlePost` for the
// names its strict gate refuses (the gate runs before any body read or table lookup, so no store is touched; the cases that
// pass the gate need PostgreSQL and are not recorded here), and `collectRawBody` for chunked bodies (a chunk split inside a
// multi-byte character, exactly the cap, one byte past it with later chunks, a body of no chunk). The request is an
// EventEmitter fed synchronously, the response records `writeHead`/`end`; per chunk the recorder notes whether the
// response had been written yet, and bodies cut short (abort, reset, socket error) mid-body. Nothing waits on time.
//
//   node benchmarks/rust-core/recorders/record-webhook-endpoint-name.mjs --tree <b6f10295a with node_modules> [--out <file>]
//
// Output: native/core/fixtures/webhook-endpoint-name/golden.json (+ MANIFEST.json), or only the result at --out.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { IncomingMessage } from 'node:http';
import * as net from 'node:net';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-webhook-endpoint-name.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'C:/mixdog-build/tmp/w12/rec';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

const dataDir = mkdtempSync(join(SCRATCH, 'data-')).replaceAll('\\', '/');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: dataDir,
  MIXDOG_RUNTIME_ROOT: mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
});
const { collectRawBody, createWebhookRequestHandler, MAX_BODY_BYTES, parseEndpointName } = await import(
  pathToFileURL(join(tree, 'src/runtime/channels/lib/webhook/request-handler.mjs')).href
);

const response = () => ({
  status: 0,
  headers: null,
  body: '',
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  },
});

// Endpoint paths; `gate` marks the ones the strict name gate refuses (answered by handlePost without a store).
const paths = [
  { url: '/webhook/demo?source=test' },
  { url: '/webhook/demo' },
  { url: '/webhook/%E2%9C%93', gate: true },
  { url: '/webhook/' , gate: true },
  { url: '/webhook/?x=1', gate: true },
  { url: '/webhook/a%2Fb', gate: true },
  { url: '/webhook/..%2Fx', gate: true },
  { url: '/webhook/%2e%2e', gate: true },
  { url: '/webhook/%41%62', gate: false },
  { url: '/webhook/%61bc_D-1?x=%', gate: false },
  { url: '/webhook/%', gate: true },
  { url: '/webhook/%4', gate: true },
  { url: '/webhook/%zz', gate: true },
  { url: '/webhook/%+1', gate: true },
  { url: '/webhook/%+f', gate: true },
  { url: '/webhook/%-1', gate: true },
  { url: '/webhook/% 1', gate: true },
  { url: '/webhook/%00', gate: true },
  { url: '/webhook/%C0%80', gate: true },
  { url: '/webhook/%ff', gate: true },
  { url: '/webhook/%e2%9c', gate: true },
  { url: '/webhook/%ED%A0%80', gate: true },
  { url: '/webhook/%F0%9F%98%80', gate: true },
  { url: '/webhook/caf\u00e9', gate: true },
  { url: `/webhook/${'a'.repeat(64)}`, gate: false },
  { url: `/webhook/${'a'.repeat(65)}`, gate: true },
  { url: '/webhook/a b', gate: true },
  { url: '/webhook/a?b?c', gate: false },
  { url: '/webhook/a%3Fb', gate: true },
  { url: '/webhook/a#b', gate: true },
];
const handler = createWebhookRequestHandler({
  getConfig: () => ({ endpoints: {} }),
  verifyRequest: () => {
    throw new Error('verify is not reached');
  },
  handleWebhook: () => {
    throw new Error('dispatch is not reached');
  },
});
const pathResults = [];
for (const { url, gate } of paths) {
  const entry = { url, parsed: parseEndpointName(url) };
  if (gate === true) {
    const req = new EventEmitter();
    req.url = url;
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };
    const res = response();
    await handler.handlePost(req, res);
    entry.gate = { status: res.status, headers: res.headers, body: res.body, destroyed };
  }
  pathResults.push(entry);
}

// Bodies: a chunk is {hex} or {fill: byte, length}.
const chunk = (c) => (c.hex !== undefined ? Buffer.from(c.hex, 'hex') : Buffer.alloc(c.length, c.fill));
const body = Buffer.from([0xe2, 0x82, 0xac, 0x00, 0xff]);
const MIB = 1024 * 1024;
const bodyCases = [
  { name: 'no chunk', chunks: [] },
  { name: 'one chunk', chunks: [{ hex: 'e282ac00ff' }] },
  { name: 'a chunk split inside a multi-byte character', chunks: [{ hex: body.subarray(0, 2).toString('hex') }, { hex: body.subarray(2).toString('hex') }] },
  { name: 'an empty chunk between two', chunks: [{ hex: '6162' }, { hex: '' }, { hex: '6364' }] },
  { name: 'exactly the cap', chunks: [{ fill: 97, length: MAX_BODY_BYTES }] },
  { name: 'the cap in five chunks and an empty one', chunks: [...Array(5).fill({ fill: 97, length: MIB }), { fill: 98, length: 0 }] },
  { name: 'one byte past the cap in one chunk', chunks: [{ fill: 97, length: MAX_BODY_BYTES + 1 }] },
  { name: 'one byte past the cap over six chunks, then one more', chunks: [...Array(5).fill({ fill: 97, length: MIB }), { fill: 98, length: 1 }, { fill: 99, length: MIB }] },
];
const caseResults = [];
for (const c of bodyCases) {
  const req = new EventEmitter();
  let destroyed = false;
  req.destroy = () => {
    destroyed = true;
  };
  const res = response();
  const received = collectRawBody(req, res);
  const answeredAfter = [];
  for (const spec of c.chunks) {
    req.emit('data', chunk(spec));
    answeredAfter.push(res.status !== 0);
  }
  req.emit('end');
  const bytes = await received;
  caseResults.push({
    name: c.name,
    chunks: c.chunks,
    answeredAfter,
    received: bytes === null ? null : { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    status: res.status,
    headers: res.headers,
    body: res.body,
    destroyed,
  });
}

// Bodies cut short: Node's collector listens to 'data' and 'end' only, so a request that is aborted or errors mid-body
// leaves its promise pending for good. Each case runs through the real collector on a real IncomingMessage (or, for the
// old 'aborted' event, an emitter); the cut is one event, then the event loop is turned (setImmediate, no timer) to let
// anything that was going to happen happen. `destroyed` counts only the handler's own `req.destroy()`.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cutCases = [
  { name: 'aborted event before any chunk', chunks: [], cut: 'aborted-event' },
  { name: 'aborted event after one chunk', chunks: [{ hex: '6162' }], cut: 'aborted-event' },
  { name: 'connection reset before any chunk', chunks: [], cut: 'reset' },
  { name: 'connection reset after two chunks', chunks: [{ hex: '6162' }, { hex: 'e282' }], cut: 'reset' },
  { name: 'socket error after one chunk', chunks: [{ hex: '6162' }], cut: 'socket-error' },
  { name: 'socket error after the cap and one byte more is answered first', chunks: [{ fill: 97, length: MAX_BODY_BYTES + 1 }], cut: 'socket-error' },
];
const cutResults = [];
for (const c of cutCases) {
  const real = c.cut !== 'aborted-event';
  const req = real ? new IncomingMessage(new Socket()) : new EventEmitter();
  let destroyed = false;
  req.destroy = (...a) => {
    destroyed = true;
    return real ? IncomingMessage.prototype.destroy.apply(req, a) : undefined;
  };
  const res = response();
  let settled = false;
  const received = collectRawBody(req, res).then((bytes) => {
    settled = true;
    return bytes;
  });
  const answeredAfter = [];
  for (const spec of c.chunks) {
    if (real) req.push(chunk(spec));
    else req.emit('data', chunk(spec));
    await flush();
    answeredAfter.push(res.status !== 0);
  }
  if (c.cut === 'aborted-event') {
    req.emit('aborted');
    req.emit('close');
  } else {
    const err = c.cut === 'reset' ? Object.assign(new Error('aborted'), { code: 'ECONNRESET' }) : new Error('read EPIPE');
    IncomingMessage.prototype.destroy.call(req, err);
  }
  await flush();
  await flush();
  const bytes = settled ? await received : undefined;
  cutResults.push({
    name: c.name,
    chunks: c.chunks,
    cut: c.cut,
    answeredAfter,
    settled,
    received: bytes === undefined || bytes === null ? null : { length: bytes.length },
    status: res.status,
    headers: res.headers,
    body: res.body,
    destroyed,
  });
}

// What a peer sees on the wire: real `http.createServer` servers, raw bytes over a socket. The gate server answers like the
// listener (`handlePost` for `POST /webhook/*`, `GET /` 200 `OK`); the collect server runs `collectRawBody` alone (the cases
// that pass the gate need PostgreSQL) and counts how many collections settled. A case records the responses the peer parsed
// (status, raw head and bytes with the `date` value tokenised, body), whether the server closed the connection, and the settled count. `sequential`
// writes the second part only once the first response has arrived. One deadline guards a connection that stays open.
const wireHandler = createWebhookRequestHandler({
  getConfig: () => ({ endpoints: {} }),
  verifyRequest: () => {
    throw new Error('verify is not reached');
  },
  handleWebhook: () => {
    throw new Error('dispatch is not reached');
  },
});
let settledCollections = 0;
const wireServers = {
  gate: http.createServer((req, res) => {
    // webhook.mjs routing: GET / is the liveness answer, POST /webhook/* the endpoint, everything else a text 404.
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else if (req.method === 'POST' && req.url?.startsWith('/webhook/')) {
      void wireHandler.handlePost(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }),
  collect: http.createServer((req, res) => {
    void collectRawBody(req, res).then(() => {
      settledCollections += 1;
    });
  }),
};
for (const server of Object.values(wireServers)) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

// The Date value is a clock reading of the recording run: the head keeps its name as sent and its value becomes this token.
const DATE_TOKEN = '<date>';

// Every response is recorded as the bytes the server sent (`raw`: status line, header lines in order, name case and repeats
// as sent, the body with its framing), with only the Date value replaced; `head` is the same without the body and `body` is
// the decoded body. The lower-cased map below is only how this parser finds the framing; it is not recorded.
// `methods` are the request methods in order: the reply to a HEAD carries no body whatever its framing headers say.
function parseResponses(buffer, methods = []) {
  const responses = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return { responses, partial: rest.length > 0 };
    const lines = rest.subarray(0, end).toString('latin1').split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
    const head = lines.map((line, i) => (i > 0 && /^date:/i.test(line) ? `${line.slice(0, line.indexOf(':') + 1)} ${DATE_TOKEN}` : line)).join('\r\n');
    let at = end + 4;
    let body = '';
    if (methods[responses.length] === 'HEAD') {
      // no body
    } else if (headers['transfer-encoding'] === 'chunked') {
      for (;;) {
        const line = rest.indexOf('\r\n', at);
        if (line < 0) return { responses, partial: true };
        const size = parseInt(rest.subarray(at, line).toString('latin1'), 16);
        if (rest.length < line + 2 + size + 2) return { responses, partial: true };
        body += rest.subarray(line + 2, line + 2 + size).toString('latin1');
        at = line + 2 + size + 2;
        if (size === 0) break;
      }
    } else {
      const length = headers['content-length'] === undefined ? rest.length - at : Number(headers['content-length']);
      if (rest.length < at + length) return { responses, partial: true };
      body = rest.subarray(at, at + length).toString('latin1');
      at += length;
    }
    responses.push({ status: Number(lines[0].split(' ')[1]), head, body, raw: `${head}\r\n\r\n${rest.subarray(end + 4, at).toString('latin1')}` });
    rest = rest.subarray(at);
  }
}

function runWire(server, c) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let data = Buffer.alloc(0);
    let closed = false;
    let next = 1;
    const methods = [...c.parts.join('').matchAll(/^([A-Z]+) \S+ HTTP\/1\.[01]\r?$/gm)].map((m) => m[1]);
    const deadline = setTimeout(() => reject(new Error(`wire case "${c.name}": the connection stayed open`)), 10000);
    socket.on('error', () => {});
    socket.on('data', (d) => {
      data = Buffer.concat([data, d]);
      if (c.sequential && next < c.parts.length && parseResponses(data, methods).responses.length > 0) socket.write(c.parts[next++], 'latin1');
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(deadline);
      resolve({ responses: parseResponses(data, methods).responses, closed });
    });
    socket.write(c.parts[0], 'latin1');
    if (!c.sequential) for (const part of c.parts.slice(1)) socket.write(part, 'latin1');
    if (c.halfClose) socket.end();
  });
}

const gateRequest = 'POST /webhook/%zz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
const secondRequest = 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
const chunkedHead = 'POST /webhook/hook HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n';
const wireCases = [
  { name: 'a gate answer with a second request pipelined behind it', server: 'gate', parts: [gateRequest + secondRequest] },
  { name: 'a gate answer, then a second request on the same connection', server: 'gate', sequential: true, parts: [gateRequest, secondRequest] },
  { name: 'a truncated chunked body, the peer half-closed', server: 'collect', halfClose: true, parts: [chunkedHead + '2\r\n{}\r\n0\r\n'] },
  { name: 'junk where a chunk ends', server: 'collect', parts: [chunkedHead + '2\r\n{}XX0\r\n\r\n'] },
  // The replies the listener writes through its HTTP stack: a kept connection, then a closing one.
  { name: 'GET / asking to close', server: 'gate', parts: ['GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'] },
  { name: 'GET / kept alive, then GET / asking to close', server: 'gate', sequential: true, parts: ['GET / HTTP/1.1\r\nHost: x\r\n\r\n', secondRequest] },  // A sender on HTTP/1.0 gets no chunked framing; the reply of a request that asks to keep the connection is recorded too.
  { name: 'GET on HTTP/1.0', server: 'gate', parts: ['GET / HTTP/1.0\r\n\r\n'] },
  { name: 'GET on HTTP/1.0 with Connection: keep-alive', server: 'gate', parts: ['GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'] },
  { name: 'a gate answer on HTTP/1.0', server: 'gate', parts: ['POST /webhook/%zz HTTP/1.0\r\nContent-Length: 0\r\n\r\n'] },
  { name: 'a gate answer on HTTP/1.0 with Connection: keep-alive', server: 'gate', parts: ['POST /webhook/%zz HTTP/1.0\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n'] },
  // HEAD: the headers of the reply the request would get, and no body.
  { name: 'HEAD on HTTP/1.1 asking to close', server: 'gate', parts: ['HEAD /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'] },
  { name: 'HEAD on HTTP/1.1 kept alive, then GET / asking to close', server: 'gate', sequential: true, parts: ['HEAD /nope HTTP/1.1\r\nHost: x\r\n\r\n', secondRequest] },
  { name: 'HEAD on HTTP/1.0', server: 'gate', parts: ['HEAD /nope HTTP/1.0\r\n\r\n'] },
  { name: 'HEAD on HTTP/1.0 with Connection: keep-alive', server: 'gate', halfClose: true, parts: ['HEAD /nope HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'] },
];
const wireResults = [];
for (const c of wireCases) {
  const before = settledCollections;
  const seen = await runWire(wireServers[c.server], c);
  wireResults.push({ ...c, ...seen, settled: settledCollections - before });
}

// Time: the server's own settings (read, not assumed), and what they do on the wire. Node's timers are real here, so the
// request and headers timeouts are shortened (with the check interval) on the server that records the 408s: the bytes sent
// do not depend on the length, and the replay waits the recorded defaults on its own clock. The keep-alive probe runs the
// default server (the gate server) for real: one connection is asked again just before the timeout and answers, an idle
// one is closed just after it.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultServer = http.createServer();
const defaults = { keepAliveTimeoutMs: defaultServer.keepAliveTimeout, keepAliveTimeoutBufferMs: defaultServer.keepAliveTimeoutBuffer, headersTimeoutMs: defaultServer.headersTimeout, requestTimeoutMs: defaultServer.requestTimeout, connectionsCheckingIntervalMs: defaultServer.connectionsCheckingInterval };
defaultServer.close();
const keepAliveRequest = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';
const keepAlive = await (async () => {
  const port = wireServers.gate.address().port;
  const open = (resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.state = { closed: false };
    socket.on('error', () => {});
    socket.on('close', () => {
      socket.state.closed = true;
    });
    socket.once('data', () => resolve(socket));
    socket.write(keepAliveRequest);
  };
  const [again, idle] = await Promise.all([new Promise(open), new Promise(open)]);
  // The server closes an idle connection after keepAliveTimeout plus keepAliveTimeoutBuffer, while it announces only the first.
  const closesAfterMs = defaults.keepAliveTimeoutMs + defaults.keepAliveTimeoutBufferMs;
  const justBeforeMs = closesAfterMs - 500;
  await sleep(justBeforeMs);
  const idleOpenBefore = !idle.state.closed;
  const answeredBefore = await new Promise((resolve) => {
    again.once('data', () => resolve(true));
    again.write(keepAliveRequest);
    setTimeout(() => resolve(false), 1000);
  });
  await sleep(1000);
  return {
    closesAfterMs,
    justBeforeMs,
    idleOpenJustBefore: idleOpenBefore,
    answeredJustBefore: answeredBefore,
    closedJustAfterMs: justBeforeMs + 1000,
    idleClosedJustAfter: idle.state.closed,
  };
})();
if (!(keepAlive.idleOpenJustBefore && keepAlive.answeredJustBefore && keepAlive.idleClosedJustAfter)) throw new Error(`keep-alive probe: ${JSON.stringify(keepAlive)}`);

const shortServer = http.createServer({ requestTimeout: 1000, headersTimeout: 500, connectionsCheckingInterval: 100 }, (req, res) => {
  void collectRawBody(req, res);
});
await new Promise((resolve) => shortServer.listen(0, '127.0.0.1', resolve));
const timeoutCases = [
  { name: 'a body that does not arrive in time', after: 'requestTimeoutMs', parts: ['POST /webhook/hook HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc'] },
  { name: 'a head that does not complete in time', after: 'headersTimeoutMs', parts: ['POST /webhook/hook HTTP/1.1\r\nHost: x\r\nX-Slow: '] },
];
const timeoutResults = [];
for (const c of timeoutCases) timeoutResults.push({ ...c, ...(await runWire(shortServer, c)) });
// A connection that never sends a byte: Node's parser is initialised at accept, so the connection check expires it through
// headersTimeout like any other head. It is still open just before headersTimeout, and closed with the bare 408 by
// headersTimeout plus one check interval (the check runs on the interval, so the close falls inside that window).
const silent = await new Promise((resolve, reject) => {
  const server = shortServer;
  const socket = net.connect(server.address().port, '127.0.0.1');
  const started = Date.now();
  let data = Buffer.alloc(0);
  let closedAtMs = null;
  const shortHeadersMs = server.headersTimeout;
  const shortIntervalMs = server.connectionsCheckingInterval;
  let openJustBefore = null;
  const deadline = setTimeout(() => reject(new Error('silent connection: the connection stayed open')), 10000);
  socket.on('error', () => {});
  socket.on('data', (d) => {
    data = Buffer.concat([data, d]);
  });
  socket.on('close', () => {
    closedAtMs = Date.now() - started;
    clearTimeout(deadline);
    const { responses } = parseResponses(data);
    resolve({
      name: 'a connection that sends no byte',
      parts: [],
      after: 'headersTimeoutPlusCheckMs',
      openJustBeforeHeadersTimeout: openJustBefore,
      closedNotBeforeHeadersTimeout: closedAtMs >= shortHeadersMs,
      closedByHeadersTimeoutPlusCheck: closedAtMs <= shortHeadersMs + shortIntervalMs + 250,
      responses,
      closed: true,
    });
  });
  setTimeout(() => {
    openJustBefore = closedAtMs === null && data.length === 0;
  }, shortHeadersMs - 100);
});
if (!(silent.openJustBeforeHeadersTimeout && silent.closedNotBeforeHeadersTimeout && silent.closedByHeadersTimeoutPlusCheck)) throw new Error(`silent connection probe: ${JSON.stringify(silent)}`);
timeoutResults.push(silent);
shortServer.close();
for (const server of Object.values(wireServers)) server.close();

const result = { maxBodyBytes: MAX_BODY_BYTES, paths: pathResults, bodies: caseResults, cutBodies: cutResults, wire: wireResults, timing: { defaults, keepAlive, timeouts: timeoutResults } };
const out = args.get('out');
if (out) {
  writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'webhook-endpoint-name');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'webhook-endpoint-name',
    recorder,
    command: `node ${recorder} --tree <b6f10295a>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      // Every reply is compared as the raw bytes sent (status line, header lines in order with their name case and repeats, body framing).
      exclusions: [
        { what: 'the value of the Date header in wire[].responses[].{raw,head} and timing.timeouts[].responses[].{raw,head}', reason: 'a clock reading of the recording run: the recorder replaces it by the token <date> and the replay replaces the listener\'s Date value by the same token; the header name, its place and its case are compared' },
        { what: 'timing.timeouts[]: the 1000 ms request timeout, 500 ms headers timeout and 100 ms check interval of the recording server', reason: 'Node\'s own timers are real in the recording, so they are shortened to keep it to seconds; the bytes sent do not depend on them, and the replay waits timing.defaults (the server\'s own settings, read from a default server) on its virtual clock' },
        { what: 'timing.timeouts[] "a connection that sends no byte": the instant of the close (not recorded) and the 1000/500/100 ms timers', reason: 'Node closes it somewhere in [headersTimeout, headersTimeout + connectionsCheckingInterval] by where the check tick falls; the recorder records only that it was open just before headersTimeout and closed inside that window, and the replay closes at the end of the window (headersTimeoutMs + connectionsCheckingIntervalMs of timing.defaults, read from a default server)' },
      ],
    },
  });
  commitStage(stage, finalDir);
}
process.exit(0);
