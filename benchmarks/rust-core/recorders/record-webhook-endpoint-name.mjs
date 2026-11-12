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
import { IncomingMessage } from 'node:http';
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

const result = { maxBodyBytes: MAX_BODY_BYTES, paths: pathResults, bodies: caseResults, cutBodies: cutResults };
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
    extra: { ...recorderProvenance(import.meta.url) },
  });
  commitStage(stage, finalDir);
}
process.exit(0);
