#!/usr/bin/env node
// Golden twin of the daemon's self-shutdown deferral: a `POST /shutdown` (`session-transport/routes.mjs:189-196`) calls
// `onClientsEmpty()`, which is `maybeSelfShutdown('no live session clients')` (`standalone/daemon.mjs:506-529`). With a
// client still registered the call only logs `shutdown deferred (..)` and the daemon stays up; with none it shuts down.
//
// Recorded from the real daemon of the tree (`ensureDaemon`, `attachSession`, `shutdownDaemon` of
// `standalone/session-client.mjs`) in an isolated data dir: per case how many session clients were attached, whether the
// daemon was alive 2 s after the request, and the daemon-log lines of the deferral and of the shutdown (timestamps removed).
//
//   node benchmarks/rust-core/recorders/record-self-shutdown-deferral.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'self-shutdown-deferral');
const stage = stageSet(outDir);

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

const discovery = await client.ensureDaemon({ cwd: dirs.workspace, attempts: 2, readyTimeoutMs: 60_000 });
const attached = await client.attachSession({ discovery, cwd: dirs.workspace, onFrame() {} });
await client.shutdownDaemon(discovery);
await settle(2000);
const aliveWithClient = alive(discovery.pid);

await attached.close();
const exited = await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 });
// The daemon's log is written behind: it is read once the daemon is gone, and split at the client's departure.
const lines = logLines();
const left = lines.findIndex((line) => line.startsWith('client dropped'));
const cases = [
  { name: 'a session client is attached', clients: 1, request: 'POST /shutdown', aliveAfter: aliveWithClient, log: lines.slice(0, left) },
  { name: 'no client is attached', clients: 0, request: 'POST /shutdown', aliveAfter: !exited, log: lines.slice(left + 1) },
];
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
