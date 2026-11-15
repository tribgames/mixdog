// The Node side of the HTTP/1.1 byte comparison (tests/http1.rs). `createEchoServer` is a node:http server with a fixed
// handler; `node node-http-echo.mjs --record` sends every scenario below to it as raw bytes and writes what came back
// into node-http-echo.recording.json, which tests/http1.rs replays against the Rust layer serving the same handler
// (tests/http1.rs `EchoHandler` mirrors the routes of `route` here one by one). Run it by hand, never from a test:
//   node tests/fixtures/node-http-echo.mjs --record
// Strings that stand for bytes are latin1. The Date header value is masked by the comparison, not here.
import http from 'node:http';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHORT = { headersTimeout: 600, requestTimeout: 1200, connectionsCheckingInterval: 100 };

export function createEchoServer(options = {}) {
  const events = [];
  const server = http.createServer(options, (request, response) => route(events, request, response));
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    socket.write(
      `UPGRADE ${request.method} ${request.url} ${JSON.stringify(request.headers)} head=${head.toString('hex')}`
    );
    socket.destroy();
  });
  return server;
}

function route(events, request, response) {
  const target = request.url || '';
  const pathname = target.split('?')[0];
  switch (pathname) {
    case '/hello':
      response.setHeader('X-Second', '2');
      response.setHeader('x-first', '1');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('x-second', '3');
      response.end('hello');
      return;
    case '/json':
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"ok":true}');
      return;
    case '/json-cl':
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 11 });
      response.end('{"ok":true}');
      return;
    case '/stream':
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('one');
      setTimeout(() => response.write('two'), 30);
      setTimeout(() => response.end('three'), 60);
      return;
    case '/cookies':
      response.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2']);
      response.setHeader('Content-Type', 'text/plain');
      response.end('c');
      return;
    case '/close':
      response.setHeader('Connection', 'close');
      response.end('bye');
      return;
    case '/keepalive-own':
      response.setHeader('Keep-Alive', 'timeout=9');
      response.end('k');
      return;
    case '/nocontent':
      response.writeHead(204);
      response.end();
      return;
    case '/notmod':
      response.writeHead(304, { ETag: '"x"' });
      response.end();
      return;
    case '/echo':
      response.end(
        JSON.stringify({ method: request.method, url: request.url, httpVersion: request.httpVersion, headers: request.headers })
      );
      return;
    case '/body': {
      const parts = [];
      request.on('data', (chunk) => parts.push(chunk));
      request.on('end', () => response.end(`len=${Buffer.concat(parts).length} body=${Buffer.concat(parts).toString('utf8')}`));
      request.on('error', () => events.push('body-error'));
      request.on('close', () => {
        if (!request.complete) events.push('body-aborted');
      });
      return;
    }
    case '/big-destroy': {
      let size = 0;
      let refused = false;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 10 && !refused) {
          refused = true;
          response.once('finish', () => request.destroy());
          response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Payload too large.');
        }
      });
      return;
    }
    case '/drain-400': {
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
      });
      request.on('end', () => {
        response.writeHead(size > 10 ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(size > 10 ? 'Bad request.' : 'ok');
      });
      return;
    }
    case '/slow':
      setTimeout(() => response.end('slow'), 200);
      return;
    case '/events':
      response.end(JSON.stringify(events));
      return;
    default:
      response.statusCode = 404;
      response.end('nf');
  }
}

const HOST = 'Host: relay.test\r\n';
const get = (target, extra = '') => `GET ${target} HTTP/1.1\r\n${HOST}${extra}\r\n`;
const BIG = 'a'.repeat(20000);

// A scenario is a list of connections; a connection is steps ({send}, {wait}, {close}) and how its reading ends:
// 'eof' (until the server closes, at most maxMs) or 'quiet' (until nothing arrived for quietMs).
export const SCENARIOS = [
  { name: 'keep-alive reuse then close', conns: [{ steps: [{ send: get('/hello') }, { wait: 150 }, { send: get('/json') }, { wait: 150 }, { send: get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'idle close after 5 s', conns: [{ steps: [{ send: get('/hello') }], end: 'eof', maxMs: 9000, minMs: 4800, atMostMs: 6500 }] },
  { name: 'implicit header, content-length, chunked and stream', conns: [{ steps: [{ send: get('/hello') + get('/json') + get('/json-cl') + get('/stream') + get('/keepalive-own') + get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'set-cookie array, 204, 304', conns: [{ steps: [{ send: get('/cookies') + get('/nocontent') + get('/notmod') + get('/missing') + get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'head requests', conns: [{ steps: [{ send: `HEAD /hello HTTP/1.1\r\n${HOST}\r\n` + `HEAD /json HTTP/1.1\r\n${HOST}\r\n` + `HEAD /json-cl HTTP/1.1\r\n${HOST}\r\n` + get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'http 1.0', conns: [
    { steps: [{ send: 'GET /hello HTTP/1.0\r\n\r\n' }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: 'GET /stream HTTP/1.0\r\n\r\n' }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: 'GET /hello HTTP/1.0\r\nConnection: keep-alive\r\n\r\n' }, { wait: 150 }, { send: 'GET /json-cl HTTP/1.0\r\nConnection: keep-alive\r\n\r\n' }], end: 'quiet', quietMs: 400 },
    { steps: [{ send: 'GET /stream HTTP/1.0\r\nTE: chunked\r\n\r\n' }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'chunked and length bodies', conns: [{ steps: [
    { send: `POST /body HTTP/1.1\r\n${HOST}Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n` },
    { wait: 80 },
    { send: '6;ext=1\r\n world\r\n0\r\n\r\n' },
    { send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 3\r\n\r\nabc` },
    { send: get('/close') },
  ], end: 'eof', maxMs: 3000 }] },
  { name: 'oversize head 431', conns: [
    { steps: [{ send: get('/hello', `X-Big: ${BIG}\r\n`) }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: get('/hello') }, { wait: 150 }, { send: get('/hello', `X-Big: ${BIG}\r\n`) }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'malformed heads 400', conns: [
    { steps: [{ send: 'GARBAGE\r\n\r\n' }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `GET / HTTP/1.1\r\n${HOST}Bad Header\r\n\r\n` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `FOO / HTTP/1.1\r\n${HOST}\r\n` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\nabc` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: x\r\n\r\n` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: get('/hello') }, { wait: 150 }, { send: 'GARBAGE\r\n\r\n' }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'pipelining', conns: [{ steps: [{ send: get('/slow') + get('/hello') + get('/json') + get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'request headers as node reports them', conns: [{ steps: [{ send:
    'GET /echo?x=1 HTTP/1.1\r\nHost: relay.test\r\nX-A: 1\r\nUser-Agent: one\r\nx-a: 2\r\nUser-Agent: two\r\nCookie: a=1\r\nCookie: b=2\r\nSet-Cookie: s=1\r\nSet-Cookie: t=2\r\nContent-Type: a\r\nContent-Type: b\r\nOrigin: https://relay.test\r\nAccept: x,  y\r\nX-Pad:   padded value \t\r\n\r\n' +
    'GET http://other.test/echo HTTP/1.1\r\nHost: relay.test\r\n\r\n' + get('/close') }], end: 'eof', maxMs: 3000 }] },
  { name: 'missing host, expect, connect', conns: [
    { steps: [{ send: 'GET /hello HTTP/1.1\r\n\r\n' }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: 'GET /hello HTTP/1.0\r\n\r\n' }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 5\r\nExpect: 100-continue\r\n\r\n` }, { wait: 150 }, { send: 'hello' }], end: 'eof', maxMs: 1500 },
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 5\r\nExpect: 200-ok\r\n\r\nhello` }, { send: get('/close') }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `CONNECT relay.test:443 HTTP/1.1\r\n${HOST}\r\n` }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'upgrade hand-off', conns: [
    { steps: [{ send: `GET /ws HTTP/1.1\r\n${HOST}Connection: Upgrade\r\nUpgrade: websocket\r\nOrigin: https://relay.test\r\n\r\n\u0081\u0080abcd` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `GET / HTTP/1.1\r\n${HOST}Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `POST /ws HTTP/1.1\r\n${HOST}Connection: upgrade\r\nUpgrade: x\r\nContent-Length: 4\r\n\r\nbody` }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `GET /hello HTTP/1.1\r\n${HOST}Connection: upgrade\r\n\r\n` }], end: 'quiet', quietMs: 400 },
    { steps: [{ send: `GET /hello HTTP/1.1\r\n${HOST}Upgrade: websocket\r\n\r\n` + get('/close') }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'handler destroys the request', conns: [
    { steps: [{ send: `POST /big-destroy HTTP/1.1\r\n${HOST}Content-Length: 100\r\n\r\n` + 'x'.repeat(20) }], end: 'eof', maxMs: 3000 },
    { steps: [{ send: `POST /drain-400 HTTP/1.1\r\n${HOST}Content-Length: 30\r\n\r\n` + 'x'.repeat(30) + get('/close') }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'client abort mid body', conns: [
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 100\r\n\r\n0123456789` }, { wait: 100 }, { close: true }], end: 'quiet', quietMs: 200 },
    { steps: [{ wait: 200 }, { send: get('/events') + get('/close') }], end: 'eof', maxMs: 3000 },
  ] },
  { name: 'short timeouts', server: 'short', conns: [
    { steps: [{ send: 'GET /hello HTTP/1.1\r\nHost: rel' }], end: 'eof', maxMs: 6000 },
    { steps: [{ send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 50\r\n\r\npart` }], end: 'eof', maxMs: 6000 },
    { steps: [{ send: get('/hello') }, { wait: 150 }, { send: `POST /body HTTP/1.1\r\n${HOST}Content-Length: 50\r\n\r\npart` }], end: 'eof', maxMs: 6000 },
    { steps: [{ send: get('/hello') }, { wait: 150 }, { send: 'GET /hello HTTP/1.1\r\nHost: rel' }], end: 'eof', maxMs: 8000 },
  ] },
];

const latin1 = (text) => Buffer.from(text, 'latin1');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runConnection(port, conn) {
  const socket = net.connect(port, '127.0.0.1');
  const chunks = [];
  let closed = false;
  let lastData = Date.now();
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    lastData = Date.now();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    closed = true;
  });
  await new Promise((resolve) => socket.once('connect', resolve));
  const started = Date.now();
  let dropped = false;
  for (const step of conn.steps) {
    if (step.send !== undefined) socket.write(latin1(step.send));
    else if (step.wait !== undefined) await sleep(step.wait);
    else if (step.close) {
      socket.destroy();
      dropped = true;
    }
  }
  if (conn.end === 'eof') {
    while (!closed && !dropped && Date.now() - started < conn.maxMs) await sleep(20);
  } else {
    lastData = Date.now();
    while (!closed && !dropped && Date.now() - lastData < conn.quietMs) await sleep(20);
  }
  const result = { received: Buffer.concat(chunks).toString('latin1'), closedByServer: closed && !dropped, elapsedMs: Date.now() - started };
  socket.destroy();
  return result;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function record() {
  const out = [];
  const servers = { default: createEchoServer({}), short: createEchoServer(SHORT) };
  const ports = { default: await listen(servers.default), short: await listen(servers.short) };
  for (const scenario of SCENARIOS) {
    const which = scenario.server || 'default';
    const conns = [];
    for (const conn of scenario.conns) {
      const result = await runConnection(ports[which], conn);
      conns.push({ ...conn, ...result });
    }
    out.push({ name: scenario.name, server: which, conns });
  }
  for (const server of Object.values(servers)) server.close();
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-http-echo.recording.json');
  writeFileSync(file, `${JSON.stringify({ node: process.version, scenarios: out }, null, 1)}\n`);
  process.stdout.write(`recorded ${out.length} scenarios with node ${process.version}\n`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--record')) {
  await record();
}
