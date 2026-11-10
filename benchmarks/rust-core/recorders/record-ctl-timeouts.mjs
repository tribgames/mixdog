#!/usr/bin/env node
// Golden for the bounds of the control calls (`standalone/session-client.mjs`). The real exported functions that make each
// call run against a stub HTTP server on loopback that answers late, trickles, or never answers:
//   probeSessionHealth       GET  /health                       (status)
//   holdInTreeDaemon         POST /install-hold {close|release} (hold, cancelDrain)
//   stopInTreeDaemon         POST /stop                         (stop, release)
//   shutdownDaemon           POST /shutdown                     (terminate)
// `request` is wrapped in memory by a module-load hook (the product tree on disk is untouched) so that each case records
// the options the call site really passed (`timeoutMs`, `deadlineMs`), the error `request` threw (`code`, `message`) and
// how long it ran. The stop and hold calls need a daemon of this process's tree; the hook exposes that registry so a
// stand-in can be entered (nothing is spawned).
//
//   node benchmarks/rust-core/recorders/record-ctl-timeouts.mjs --tree <git checkout of the ref> [--ref <commit>]
//
// Output: native/core/fixtures/ctl-timeouts/golden.json.
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
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

// Appended to session-client.mjs as it loads: `request` is rebound to a recorder around the real one.
const APPENDED = `
export const __inTreeDaemons = inTreeDaemons;
{
  const real = request;
  request = (options) => {
    const entry = {
      method: options.method ?? 'GET',
      path: options.path,
      timeoutMs: options.timeoutMs ?? 120000,
      deadlineMs: options.deadlineMs ?? 0,
      error: null,
      elapsedMs: null,
    };
    (globalThis.__ctlRequests ??= []).push(entry);
    const startedAt = performance.now();
    const settle = () => {
      entry.elapsedMs = Math.round(performance.now() - startedAt);
    };
    return real(options).then(
      (value) => {
        settle();
        return value;
      },
      (error) => {
        settle();
        entry.error = { code: error.code ?? null, message: error.message };
        throw error;
      }
    );
  };
}
`;
const hooks = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/src/standalone/session-client.mjs')) return loaded;
  return { ...loaded, source: String(loaded.source) + ${JSON.stringify(APPENDED)}, shortCircuit: true };
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const client = await import(pathToFileURL(join(tree, 'src', 'standalone', 'session-client.mjs')).href);

const TOKEN = 'ctl-timeouts-stub';
const STAND_IN_PID = 424242;

// A reply script is data: `silent`, `{after: ms}`, or `{trickle: {everyMs, chunks}}` (headers and the opening of the body
// at once, then one more piece every `everyMs`, the closing brace last).
function serve(reply, body) {
  const text = JSON.stringify(body);
  return (res) => {
    if (reply.kind === 'silent') return;
    if (reply.kind === 'after') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(text);
      }, reply.ms);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(text.slice(0, -1));
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (sent < reply.chunks) res.write(' ');
      else {
        clearInterval(timer);
        res.end('}');
      }
    }, reply.everyMs);
  };
}

async function withStub(script, run) {
  const server = http.createServer((req, res) => {
    req.resume();
    script(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Per Node call: the exported function that makes it, what it returns that shows the request's outcome, the stub's answer.
const CALLS = {
  'GET /health': {
    answer: { status: 'ok' },
    run: (d) => client.probeSessionHealth({ port: d.port, token: d.token }),
    seen: (v) => ({ health: v?.status ?? null }),
  },
  'POST /install-hold close': {
    answer: { held: true },
    standIn: true,
    run: (d) => client.holdInTreeDaemon({ release: false, ttlMs: 1000, discovery: d }),
    seen: (v) => ({ status: v.status, error: v.error }),
  },
  'POST /install-hold release': {
    answer: {},
    standIn: true,
    run: (d) => client.holdInTreeDaemon({ release: true, discovery: d }),
    seen: (v) => ({ status: v.status, error: v.error }),
  },
  'POST /stop': {
    answer: {},
    standIn: true,
    run: (d) => client.stopInTreeDaemon({ timeoutMs: 1, discovery: d }),
    seen: (v) => ({ request: v.request, error: v.error }),
  },
  // shutdownDaemon swallows the error: a refused or timed-out request shows as "the daemon (this process) is still alive".
  'POST /shutdown': {
    answer: {},
    pid: process.pid,
    run: (d) => client.shutdownDaemon(d),
    seen: (v) => ({ shutDown: v }),
  },
};

const LIFECYCLE = [{ kind: 'silent' }, { kind: 'after', ms: 2900 }, { kind: 'trickle', everyMs: 1000, chunks: 5 }];
const PROBE = [{ kind: 'silent' }, { kind: 'after', ms: 600 }, { kind: 'after', ms: 1000 }, { kind: 'trickle', everyMs: 300, chunks: 4 }];

const cases = [];
for (const [nodeCall, spec] of Object.entries(CALLS)) {
  for (const reply of nodeCall === 'GET /health' ? PROBE : LIFECYCLE) {
    globalThis.__ctlRequests = [];
    if (spec.standIn) client.__inTreeDaemons.set({ exitCode: null, signalCode: null }, STAND_IN_PID);
    const seen = await withStub(serve(reply, spec.answer), async (port) =>
      spec.seen(await spec.run({ port, token: TOKEN, pid: spec.pid ?? STAND_IN_PID }))
    );
    client.__inTreeDaemons.clear();
    if (globalThis.__ctlRequests.length !== 1) throw new Error(`${nodeCall}: ${globalThis.__ctlRequests.length} requests`);
    const { method, path, timeoutMs, deadlineMs, error, elapsedMs } = globalThis.__ctlRequests[0];
    cases.push({
      nodeCall,
      reply,
      request: { method, path, timeoutMs, deadlineMs },
      settled: error ? 'rejected' : 'resolved',
      error,
      elapsedMs,
      seen,
    });
  }
}

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, {
  set: 'ctl-timeouts',
  recorder,
  command: `node ${recorder} --tree <tree> --ref <commit>`,
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases, null, 2));
