#!/usr/bin/env node
// Golden twin of the session client's request bounds (`standalone/session-client.mjs` `request`): the real exported
// calls (`forceDaemonUpgrade`, a lifecycle call: timeoutMs 3000, no deadline; `probeSessionHealth`: timeoutMs 800 and
// deadlineMs 800) pointed at a stub HTTP server on loopback that answers late, trickles, or never answers. The
// recording holds, per case, whether the call resolved, the error code and message, and the answer. Rust
// `mixdogd ctl` (`ctl.rs`) must bound its calls the same way: lifecycle commands by 3000 ms of silence, `status` by 800 ms in
// all, and a call past its bound fails with `session timeout: <method> <path>`.
//
//   node benchmarks/rust-core/recorders/record-ctl-timeouts.mjs --tree <git checkout of the ref> [--ref <commit>]
//
// Output: native/core/fixtures/ctl-timeouts/golden.json.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'ctl-timeouts');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-ctl-timeouts.mjs';

const root = mkdtempSync(join(tmpdir(), 'ctl-timeouts-'));
const dirs = Object.fromEntries(['data', 'home', 'runtime', 'appdata', 'localappdata'].map((n) => [n, join(root, n)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
for (const name of Object.keys(process.env)) {
  if (/^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: join(dirs.home, '.mixdog'),
  MIXDOG_RUNTIME_ROOT: dirs.runtime,
  MIXDOG_CONFIG_DIR: join(dirs.home, 'config'),
  MIXDOG_DESKTOP_USER_DATA: join(dirs.home, 'desktop'),
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});

const client = await import(pathToFileURL(join(tree, 'src', 'standalone', 'session-client.mjs')).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A stub that never replies in time. `script(res)` decides when and how it answers.
async function withStub(script, run) {
  const server = http.createServer((req, res) => {
    req.resume();
    script(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  writeFileSync(
    join(dirs.runtime, 'daemon.json'),
    JSON.stringify({ pid: process.pid, endpoints: { session: { port, token: 'tok' } } })
  );
  try {
    return await run(port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const silent = () => {};
const after = (ms, body) => (res) => setTimeout(() => json(res, body), ms);
// Headers at once, then one body chunk every `everyMs` until `chunks` are out, then the closing `}`.
const trickle = (everyMs, chunks, body) => (res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const text = JSON.stringify(body);
  res.write(text.slice(0, -1));
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    if (sent < chunks) res.write(' ');
    else {
      clearInterval(timer);
      res.end('}');
    }
  }, everyMs);
};

const lifecycle = () => client.forceDaemonUpgrade();
const probe = (port) => client.probeSessionHealth({ port, token: 'tok' });

async function outcome(call) {
  try {
    const value = await call();
    return { settled: 'resolved', value };
  } catch (error) {
    return { settled: 'rejected', code: error.code ?? null, message: error.message };
  }
}

const HEALTH = { status: 'ok' };
const ACCEPTED = { accepted: true };
const CASES = [
  { name: 'lifecycle: silent core', call: 'forceDaemonUpgrade', script: silent, expect: 'rejected' },
  { name: 'lifecycle: answer after 2900 ms', call: 'forceDaemonUpgrade', script: after(2900, ACCEPTED), expect: 'resolved' },
  { name: 'lifecycle: answer after 3300 ms', call: 'forceDaemonUpgrade', script: after(3300, ACCEPTED), expect: 'rejected' },
  { name: 'lifecycle: a trickle that outlasts 3000 ms but never goes silent for 3000 ms', call: 'forceDaemonUpgrade', script: trickle(1000, 5, ACCEPTED), expect: 'resolved' },
  { name: 'probe: silent core', call: 'probeSessionHealth', script: silent, expect: 'null' },
  { name: 'probe: answer after 600 ms', call: 'probeSessionHealth', script: after(600, HEALTH), expect: 'health' },
  { name: 'probe: answer after 1000 ms', call: 'probeSessionHealth', script: after(1000, HEALTH), expect: 'null' },
  { name: 'probe: a trickle that never goes silent for 800 ms but outlasts it', call: 'probeSessionHealth', script: trickle(300, 4, HEALTH), expect: 'null' },
];

const cases = [];
for (const spec of CASES) {
  const result = await withStub(spec.script, (port) => outcome(spec.call === 'forceDaemonUpgrade' ? lifecycle : () => probe(port)));
  cases.push({ name: spec.name, call: spec.call, ...result });
  await sleep(50);
}

writeJson(join(stage, 'golden.json'), {
  cases,
});
writeSetManifest(stage, {
  set: 'ctl-timeouts',
  recorder,
  command: `node ${recorder} --tree <tree> --ref <commit>`,
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases, null, 2));
