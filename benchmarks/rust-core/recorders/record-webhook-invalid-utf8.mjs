#!/usr/bin/env node
// Webhook bodies that are not valid UTF-8, answered by Node's real receiver: `WebhookServer` (webhook.mjs) with its own
// listener, request handler (webhook/request-handler.mjs: the signature over the raw bytes, `rawBody.toString('utf8')`
// for the parse and the stored preview), verifier and the real PostgreSQL delivery store. The endpoint is a config
// endpoint with the global secret. The one seam is `WebhookServer.prototype.handleWebhook`, the boundary the Rust core
// calls `WebhookDispatch::handle`: it keeps the parsed payload and answers `200 {status:"accepted",id}`.
// Each case is sent as raw bytes on its own connection; recorded per case: the request, the reply, what reached the
// dispatch; then the whole delivery table, its timestamps on the virtual clock (below). Nothing sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-webhook-invalid-utf8.mjs --tree <b6f10295a with node_modules> [--out <file>]
//
// Output: native/core/fixtures/webhook-invalid-utf8/golden.json (+ MANIFEST.json), or only the result at --out.
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-webhook-invalid-utf8.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

const dataDir = mkdtempSync(join(SCRATCH, 'data-')).replaceAll('\\', '/');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: dataDir,
  MIXDOG_RUNTIME_ROOT: mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
  MIXDOG_RELAY_URL: 'ws://127.0.0.1:9',
});
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);

const log = [];
const waiters = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  for (const line of String(chunk).split('\n').filter(Boolean)) {
    log.push(line);
    for (const waiter of [...waiters]) if (waiter.pattern.test(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
  }
  return realWrite(chunk, ...rest);
};
const logLine = (pattern) => (log.some((line) => pattern.test(line)) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pattern, resolve })));

const { WebhookServer } = await imp('src/runtime/channels/lib/webhook.mjs');
const { openWebhooksDb } = await imp('src/runtime/channels/lib/webhooks-db.mjs');
const pgAdapter = await imp('src/runtime/memory/lib/pg/adapter.mjs');

const PORT = 47412;
const SECRET = 'utf8-secret';
const config = { port: PORT, secret: SECRET, endpoints: { hook: { enabled: true } } };
const dispatched = [];
WebhookServer.prototype.handleWebhook = async function (name, body, headers, res, deliveryId, endpoint) {
  dispatched.push({ name, payload: body, endpointInTable: Boolean(endpoint) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'accepted', id: deliveryId }));
};
const server = new WebhookServer(config);
server.start();
await logLine(/webhook: listening on/);

const sign = (bytes) => `sha256=${createHmac('sha256', SECRET).update(bytes).digest('hex')}`;
const hex = (bytes) => Buffer.from(bytes).toString('hex');
// One request, the raw bytes as the body, on its own connection.
const send = (headers, body) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/webhook/hook', headers: { ...headers, 'Content-Length': body.length }, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  req.on('error', reject);
  req.end(body);
});

const latin1 = Buffer.from('{"name":"caf\xe9"}', 'latin1');
const probe = Buffer.concat([Buffer.from('{"mixdogWebhookTest":true,"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
const truncated = Buffer.concat([Buffer.from('{"name":"caf'), Buffer.from([0xc3]), Buffer.from('"}')]);
const JSON_CT = { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issues' };
const cases = [
  { name: 'a Latin-1 byte inside a JSON string, signed over the raw bytes', headers: { ...JSON_CT, 'X-Hub-Signature-256': sign(latin1), 'X-GitHub-Delivery': 'd-latin1' }, body: latin1 },
  { name: 'a truncated multi-byte sequence before the closing quote', headers: { ...JSON_CT, 'X-Hub-Signature-256': sign(truncated), 'X-GitHub-Delivery': 'd-truncated' }, body: truncated },
  { name: 'a Send-test probe whose body carries an invalid byte', headers: { ...JSON_CT, 'X-Hub-Signature-256': sign(probe), 'X-Mixdog-Webhook-Test': '1' }, body: probe },
  { name: 'signed over the decoded text instead of the raw bytes', headers: { ...JSON_CT, 'X-Hub-Signature-256': sign(Buffer.from(latin1.toString('utf8'), 'utf8')), 'X-GitHub-Delivery': 'd-decoded' }, body: latin1 },
  { name: 'a non-JSON content type over invalid UTF-8', headers: { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': sign(latin1), 'X-GitHub-Delivery': 'd-text' }, body: latin1 },
];

// The virtual clock: case i runs at VIRTUAL_START + i * VIRTUAL_STEP. The store stamps rows with PostgreSQL's now(), which
// no process clock reaches, so each case's real window [before send, after reply] is kept and every stamp is mapped to
// the virtual instant of the one window that holds it (a stamp outside every window fails the recording).
const VIRTUAL_START = 1_700_000_000_000;
const VIRTUAL_STEP = 1_000;
const windows = [];
const result = { port: PORT, config, virtualClock: { start: VIRTUAL_START, step: VIRTUAL_STEP }, cases: [] };
for (const c of cases) {
  const before = dispatched.length;
  const opened = Date.now();
  const reply = await send(c.headers, c.body);
  windows.push([opened, Date.now()]);
  result.cases.push({ name: c.name, request: { headers: c.headers, bodyHex: hex(c.body) }, reply, dispatched: dispatched.slice(before) });
}
const virtual = (stamp) => {
  const at = new Date(stamp).getTime();
  const index = windows.findIndex(([from, to]) => at >= from && at <= to);
  if (index < 0) throw new Error(`delivery stamp ${new Date(stamp).toISOString()} lies outside every case window`);
  return new Date(VIRTUAL_START + index * VIRTUAL_STEP).toISOString();
};
// The whole delivery table the cases left, every column webhooks-db.mjs reads (DELIVERY_COLS).
const db = await openWebhooksDb();
const { rows } = await db.query(
  'SELECT endpoint, delivery_id, status, event, error, headers_summary, payload_preview, created_at, updated_at FROM webhooks.deliveries ORDER BY delivery_id',
);
result.deliveries = rows.map((row) => ({ ...row, created_at: virtual(row.created_at), updated_at: virtual(row.updated_at) }));

const out = args.get('out');
if (out) {
  writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'webhook-invalid-utf8');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'webhook-invalid-utf8',
    recorder,
    command: `node ${recorder} --tree <b6f10295a>`,
    identity,
    extra: { ...recorderProvenance(import.meta.url) },
  });
  commitStage(stage, finalDir);
}
await server.stop();
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
