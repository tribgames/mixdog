#!/usr/bin/env node
// Golden twin of the daemon's self-shutdown deferral: a `POST /shutdown` (`session-transport/routes.mjs:189-196`) calls
// `onClientsEmpty()`, which is `maybeSelfShutdown('no live session clients')` (`standalone/daemon.mjs:506-576`). With a
// client still registered the call only logs `shutdown deferred (..)` and the daemon stays up; with none it shuts down, unless
// work is running: a busy session defers it and a recheck 1 s later reads 'busy service work settled' (a service call in flight
// would read 'service calls settled' after 250 ms, daemon.mjs:543; no call that stays in flight could be driven from outside).
//
// Recorded from the real daemon of the tree (`ensureDaemon`, `attachSession`, `shutdownDaemon` of
// `standalone/session-client.mjs`) in an isolated data dir, one daemon per case: how many session clients were attached,
// whether the daemon was alive after the request, and the daemon-log lines of the deferral and of the shutdown (timestamps
// removed). The busy case runs a real turn against a provider that stalls until released.
//
//   node benchmarks/rust-core/recorders/record-self-shutdown-deferral.mjs --tree <dir with node_modules>
import { execFileSync } from 'node:child_process';
import { link, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const CASES = ['a session client is attached', 'no client is attached', 'a turn is running and no client is attached'];
const cli = parseArgs();
const tree = resolveTree(cli);
const caseName = cli.get('case');

if (!caseName) {
  const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'self-shutdown-deferral');
  const stage = stageSet(outDir);
  // One process per case: the daemon and the client read their paths from the environment once.
  const cases = CASES.map((name) =>
    JSON.parse(
      execFileSync(process.execPath, [process.argv[1], '--tree', tree, '--case', name], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop()
    )
  );
  writeJson(join(stage, 'twin.json'), { cases });
  writeSetManifest(stage, {
    set: 'self-shutdown-deferral',
    recorder: 'benchmarks/rust-core/recorders/record-self-shutdown-deferral.mjs',
    command: 'node benchmarks/rust-core/recorders/record-self-shutdown-deferral.mjs --tree <tree>',
    identityTree: cli.get('identity-tree') ?? tree,
  });
  commitStage(stage, outDir);
  console.log(`self-shutdown-deferral: ${cases.length} cases -> ${outDir}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'self-shutdown-deferral-'));
const home = join(work, 'home');
const dirs = { data: join(home, '.mixdog', 'data'), runtime: join(work, 'runtime'), workspace: join(work, 'ws'), tmp: join(work, 'tmp') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
// Nothing of the parent that could route the daemon to a user daemon, a service or a key.
for (const name of Object.keys(process.env)) {
  if (/^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: join(home, '.mixdog'),
  MIXDOG_RUNTIME_ROOT: dirs.runtime,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_DAEMON_SKIP_MEMORY: '1',
  MIXDOG_DISABLE_MCP: '1',
  HOME: home,
  USERPROFILE: home,
  TEMP: dirs.tmp,
  TMP: dirs.tmp,
});

const client = await import(pathToFileURL(join(tree, 'src', 'standalone', 'session-client.mjs')).href);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = (ms) => new Promise((done) => setTimeout(done, ms));
const logLines = () =>
  readFileSync(join(dirs.data, 'daemon.log'), 'utf8')
    .split('\n')
    .filter((line) => /\[daemon\] (shutdown deferred|shutting down|client dropped)/.test(line))
    .map((line) => line.replace(/^\[[^\]]*\] \[daemon\] /, ''));

const PROVIDER = 'custom-harness';
const MODEL = 'harness-model';
const waitUntil = async (what, test, ms = 30_000) => {
  const until = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
};
// A chat endpoint whose streamed answer stays open until `release()`: a turn that is running, with no timing in the recording.
const stallingProvider = async () => {
  const open = [];
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: 'ok' }));
      open.push(res);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    streams: () => open.length,
    release() {
      for (const res of open) {
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    },
  };
};

const provider = caseName.includes('turn') ? await stallingProvider() : null;
if (provider) {
  writeFileSync(
    join(dirs.data, 'mixdog-config.json'),
    JSON.stringify({
      agent: {
        providers: {
          [PROVIDER]: { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { [MODEL]: { manual: true } } },
        },
      },
    })
  );
}

const discovery = await client.ensureDaemon({ cwd: dirs.workspace, attempts: 2, readyTimeoutMs: 180_000 });
const attached = await client.attachSession({ discovery, cwd: dirs.workspace, onFrame() {} });
const record = { name: caseName, request: 'POST /shutdown' };

if (caseName === CASES[0]) {
  await client.shutdownDaemon(discovery);
  await settle(2000);
  record.aliveAfter = alive(discovery.pid);
  await attached.close();
  await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 });
  // The daemon's log is written behind: it is read once the daemon is gone, and cut at the client's departure.
  const lines = logLines();
  Object.assign(record, { clients: 1, log: lines.slice(0, lines.findIndex((line) => line.startsWith('client dropped'))) });
} else if (caseName === CASES[1]) {
  await attached.close();
  record.aliveAfter = !(await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }));
  Object.assign(record, { clients: 0, log: logLines().filter((line) => !line.startsWith('client dropped')) });
} else {
  const created = await attached.call('session.create', { cwd: dirs.workspace, desktopSession: null });
  const sessionId = String(created.sessionId);
  await attached.call('session.configure', { sessionId, action: 'setRoute', args: [{ provider: PROVIDER, model: MODEL, applyToCurrentSession: true, keepMainModel: false }] });
  await attached.call('session.subscribe', { sessionId });
  await attached.call('session.submit', { sessionId, prompt: 'hold' });
  await waitUntil('the provider to hold the turn', () => provider.streams() > 0);
  const release = () => provider.release();
  record.running = 'a turn';  await settle(500);
  await attached.close();
  await client.shutdownDaemon(discovery);
  await settle(1500);
  record.aliveWhileRunning = alive(discovery.pid);
  await release();
  record.aliveAfter = !(await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }));
  Object.assign(record, { clients: 0, log: logLines().filter((line) => !line.startsWith('client dropped')) });
}
console.log(JSON.stringify(record));
process.exit(0);