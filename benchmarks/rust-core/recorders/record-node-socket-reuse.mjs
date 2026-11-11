#!/usr/bin/env node
// Which keep-alive socket undici (the product tree's, b6f10295a) gives requests sent by two timers due in the same
// millisecond, while the socket of an earlier response is busy until Node's check phase: undici frees a socket one
// `setImmediate` after its response ends (`client-h1.js:846`), so a request dispatched before that immediate runs finds
// it busy and dials. Recorded from real Node timers and sockets, for the core's replay clock: its check phase
// (native/core/crates/mixdog-rt/src/virtual_clock.rs `check_phase`) is what the core's counterpart of that immediate waits
// on (mixdog-ai `transport/node_http.rs`, `Pool::claim_hold`). The replay is
// native/core/crates/mixdog-core/tests/check_phase_socket_reuse.rs.
//
// A case: a server (a process of its own) answers `r0` with a 400 and `body` bytes and every other request with `ok`. The
// client sends `r0`, waits until the whole answer has arrived, then arms `t1` and `t2` for the same 100 ms and blocks the
// thread past it, so both fire in one turn. `t1` reads r0's body and sends `r1` (the product's resend of a rejected
// request, request-compression.mjs `resendIfEncodingRejected`); `t2` sends `r2`; once both are answered `r3` is sent. A
// body larger than undici's body stream buffers ends while `t1` reads it, so its socket is freed in that turn's check
// phase; a small one ended when it arrived. Each case is run RUNS times in fresh processes and must give the same result.
//
//   node benchmarks/rust-core/recorders/record-node-socket-reuse.mjs --tree <export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/node-socket-reuse/golden.json: per case the order of `t1`, `r0-read`, `t2`, and per request
// whether it went on r0's socket (`reused`) or a new one (`new`), and how many sockets the server accepted.
import { spawnSync, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMIT } from './lib/case-set.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RUNS = 3;
const CASES = [
  { name: 'a-body-ended-before-the-timers', body: 2 },
  { name: 'a-body-ended-inside-the-first-timer', body: 70_000 },
];

const recorder = fileURLToPath(import.meta.url);
const args = parseArgs();

async function serve(body) {
  const http = await import('node:http');
  let accepted = 0;
  const server = http.createServer((req, res) => {
    const tag = req.headers['x-req'];
    process.send({ tag, conn: req.socket.conn });
    req.resume();
    req.on('end', () => {
      if (tag === 'r0') {
        res.writeHead(400, { 'content-length': body });
        res.end(Buffer.alloc(body, 97), () => process.send({ written: tag }));
      } else {
        res.writeHead(200, { 'content-length': 2 });
        res.end('ok');
      }
    });
  });
  server.on('connection', (socket) => {
    socket.conn = ++accepted;
  });
  server.keepAliveTimeout = 60_000;
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
}

async function runCase(spec) {
  const { fetch, Agent } = createRequire(join(resolveTree(args), 'package.json'))('undici');
  const server = fork(recorder, ['--serve', String(spec.body)]);
  const seen = [];
  let written = null;
  const port = await new Promise((resolve) =>
    server.on('message', (m) => {
      if (m.port) resolve(m.port);
      else if (m.written) written?.();
      else seen.push(m);
    }),
  );
  const agent = new Agent();
  const send = (tag) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}', headers: { 'x-req': tag }, dispatcher: agent });
  const whole = new Promise((resolve) => {
    written = resolve;
  });
  const r0 = await send('r0');
  await whole;
  // The written answer reaches this process's socket within this real-time margin on a loopback.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const order = [];
  const answered = [];
  setTimeout(async () => {
    order.push('t1');
    await r0.arrayBuffer();
    order.push('r0-read');
    answered.push(send('r1').then((r) => r.text()));
  }, 100);
  setTimeout(() => {
    order.push('t2');
    answered.push(send('r2').then((r) => r.text()));
  }, 100);
  setImmediate(() => {
    const end = Date.now() + 150;
    while (Date.now() < end);
  });
  while (answered.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all(answered);
  await (await send('r3')).text();
  await new Promise((resolve) => setTimeout(resolve, 100));
  server.kill();
  await agent.close();
  const first = seen.find((m) => m.tag === 'r0').conn;
  const sockets = Object.fromEntries(['r1', 'r2', 'r3'].map((tag) => [tag, seen.find((m) => m.tag === tag).conn === first ? 'reused' : 'new']));
  return { order, sockets, accepted: new Set(seen.map((m) => m.conn)).size };
}

if (args.has('serve')) {
  await serve(Number(args.get('serve')));
} else if (args.has('case')) {
  console.log(JSON.stringify(await runCase(CASES.find((spec) => spec.name === args.get('case')))));
} else {
  const cases = [];
  for (const spec of CASES) {
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) {
      const child = spawnSync(process.execPath, [recorder, '--tree', resolveTree(args), '--case', spec.name], { encoding: 'utf8', timeout: 60_000, windowsHide: true, killSignal: 'SIGKILL' });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`case ${spec.name}: exit ${child.status}: ${child.stdout}${child.stderr}`);
      runs.push(child.stdout.trim().split('\n').at(-1));
    }
    if (new Set(runs).size !== 1) throw new Error(`case ${spec.name}: the runs differ: ${runs.join(' | ')}`);
    const result = JSON.parse(runs[0]);
    cases.push({ name: spec.name, body: spec.body, ...result });
    console.log(`${spec.name}: ${runs[0]}`);
  }
  const finalDir = join(FIXTURES_ROOT, 'node-socket-reuse');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { node: process.version, cases });
  writeSetManifest(stage, {
    set: 'node-socket-reuse',
    recorder: 'benchmarks/rust-core/recorders/record-node-socket-reuse.mjs',
    command: `node benchmarks/rust-core/recorders/record-node-socket-reuse.mjs --tree <export of ${COMMIT} with node_modules>`,
    identity: exactProductIdentity(resolveTree(args), COMMIT),
    extra: { ...recorderProvenance(import.meta.url), runs: RUNS },
  });
  commitStage(stage, finalDir);
}
