#!/usr/bin/env node
// When a keep-alive socket of the product's HTTP client is free again, recorded from real Node timers and sockets. The
// client is the product's: Node's global `fetch` over an Agent of the tree's undici installed as the global dispatcher
// (http-agent.mjs `getLlmDispatcher`). The rules these cases pin, read from the source:
// - undici frees a socket when the response's message has been parsed to its end (`client-h1.js:785`
//   `onMessageComplete`), whether or not the caller has read the body, and lends it again one `setImmediate` later
//   (`:846`; until then the client has not emitted `drain`, `client-h1.js` `_resume`, and the pool passes it over).
// - The body goes into a Node Readable (Node's bundled fetch, `this.body.push(bytes)`); once it holds the stream's
//   high-water mark (64 KiB on Node 22) the push returns false, the parser pauses (`onBody` -> `ERROR.PAUSED`) and the
//   socket is not read further, so a larger body that nobody reads never ends and its socket stays busy.
// - `Connection: close` (`!shouldKeepAlive`) and an error mid-body destroy the socket; `body.cancel()` before the end
//   destroys it (fetch `onAborted` -> `connection.destroy()`), after the end it changes nothing.
// The replay is native/core/crates/mixdog-core/tests/check_phase_socket_reuse.rs, on the core's replay clock.
//
// A case: a server (a process of its own) answers `r0` with a 400 and `body` bytes (`close`: with `connection: close`;
// `error`: the head of `body` bytes, 10 of them, then the socket destroyed) and every other request with `ok`. The client
// sends `r0`, waits until the answer has arrived, then arms `t1` and `t2` for the same 100 ms and blocks the thread past
// it, so both fire in one turn. `t1` does `action` to r0's body (`read` it whole, `cancel` it, or nothing: `none`) and
// sends `r1` (the product's resend of a rejected request, request-compression.mjs `resendIfEncodingRejected`); `t2` sends
// `r2`; 20 ms after both are answered `r3` is sent, and an unread r0 is cancelled. Each case runs RUNS times in fresh processes and
// must give the same result.
//
//   node benchmarks/rust-core/recorders/record-node-socket-reuse.mjs --tree <export of b6f10295a with node_modules> [--only <case>]
//
// Output: native/core/fixtures/node-socket-reuse/golden.json: per case the order of `t1`, what came of r0's body
// (`r0-read`, `r0-error`, `r0-cancelled`), `t2`; per request whether it went on r0's socket (`reused`) or another
// (`new`); and how many sockets the server accepted.
import { spawnSync, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMIT } from './lib/case-set.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RUNS = 3;
const CASES = [
  { name: 'a-body-ended-before-the-timers', body: 2, action: 'read', server: 'keep' },
  { name: 'a-body-ended-inside-the-first-timer', body: 70_000, action: 'read', server: 'keep' },
  { name: 'a-body-ended-and-never-read', body: 2, action: 'none', server: 'keep' },
  { name: 'a-body-larger-than-the-buffer-never-read', body: 200_000, action: 'none', server: 'keep' },
  { name: 'a-small-body-cancelled', body: 2, action: 'cancel', server: 'keep' },
  { name: 'a-large-body-cancelled', body: 200_000, action: 'cancel', server: 'keep' },
  { name: 'connection-close', body: 2, action: 'read', server: 'close' },
  { name: 'an-error-mid-body', body: 1_000, action: 'read', server: 'error' },
];

const recorder = fileURLToPath(import.meta.url);
const args = parseArgs();

async function serve(spec) {
  const http = await import('node:http');
  let accepted = 0;
  const server = http.createServer((req, res) => {
    const tag = req.headers['x-req'];
    process.send({ tag, conn: req.socket.conn });
    req.resume();
    req.on('end', () => {
      if (tag !== 'r0') {
        res.writeHead(200, { 'content-length': 2 });
        res.end('ok');
      } else if (spec.server === 'error') {
        res.writeHead(400, { 'content-length': spec.body });
        res.write(Buffer.alloc(10, 97), () => req.socket.destroy());
      } else {
        res.writeHead(400, { 'content-length': spec.body, ...(spec.server === 'close' ? { connection: 'close' } : {}) });
        res.end(Buffer.alloc(spec.body, 97));
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
  const { Agent, setGlobalDispatcher } = createRequire(join(resolveTree(args), 'package.json'))('undici');
  const server = fork(recorder, ['--serve', spec.name], { windowsHide: true });
  const seen = [];
  const port = await new Promise((resolve) =>
    server.on('message', (m) => {
      if (m.port) resolve(m.port);
      else seen.push(m);
    }),
  );
  // As http-agent.mjs `installPolicyRouter`: the tree's undici dispatcher installed globally, under Node's own `fetch`.
  const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 90_000 });
  setGlobalDispatcher(agent);
  const send = (tag) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}', headers: { 'x-req': tag } });
  const r0 = await send('r0');
  // The answer, written at once, reaches this process's socket within this real-time margin on a loopback.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const order = [];
  const answered = [];
  setTimeout(async () => {
    order.push('t1');
    if (spec.action === 'read') {
      try {
        await r0.arrayBuffer();
        order.push('r0-read');
      } catch {
        order.push('r0-error');
      }
    } else if (spec.action === 'cancel') {
      await r0.body.cancel();
      order.push('r0-cancelled');
    }
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
  // A later timer: whichever of r1 and r2 was answered last is free by then (a real-time race otherwise), so r3 takes
  // the oldest free socket.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await (await send('r3')).text();
  if (spec.action === 'none') await r0.body.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  server.kill();
  await agent.destroy();
  const first = seen.find((m) => m.tag === 'r0').conn;
  const sockets = Object.fromEntries(['r1', 'r2', 'r3'].map((tag) => [tag, seen.find((m) => m.tag === tag).conn === first ? 'reused' : 'new']));
  return { order, sockets, accepted: new Set(seen.map((m) => m.conn)).size };
}

if (args.has('serve')) {
  await serve(CASES.find((spec) => spec.name === args.get('serve')));
} else if (args.has('case')) {
  console.log(JSON.stringify(await runCase(CASES.find((spec) => spec.name === args.get('case')))));
  process.exit(0);
} else {
  const only = args.get('only');
  const cases = [];
  for (const spec of CASES.filter((spec) => !only || spec.name === only)) {
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) {
      const child = spawnSync(process.execPath, [recorder, '--tree', resolveTree(args), '--case', spec.name], { encoding: 'utf8', timeout: 60_000, windowsHide: true, killSignal: 'SIGKILL' });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`case ${spec.name}: exit ${child.status}: ${child.stdout}${child.stderr}`);
      runs.push(child.stdout.trim().split('\n').at(-1));
    }
    if (new Set(runs).size !== 1) throw new Error(`case ${spec.name}: the runs differ: ${runs.join(' | ')}`);
    cases.push({ ...spec, ...JSON.parse(runs[0]) });
    console.log(`${spec.name}: ${runs[0]}`);
  }
  if (only) process.exit(0);
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
