// Records what Node's real Grok provider (b6f10295a, `GrokOAuthProvider` and the undici client under it) writes on the
// wire for every scenario of `native/core/fixtures/grok-wire/scenarios.json`: each one is sent to a loopback server
// (server.mjs) that keeps the bytes it receives. The only substitution is the connection: `tls.connect` hands the client a
// plain socket to the loopback server, so the client writes what it would write inside TLS to the real host (request line,
// `host`, headers in the order sent, body). The credentials are fixed fakes and stay in the recording, compared.
//
// The recording is two runs of the whole thing, each in its own process. A value that differs between the two is random per
// run; it is replaced by `<random:N>` (N numbers the distinct values of a scenario in the order they first appear, so a
// value reused within a scenario stays one value) and both runs' raw values stay in `randomProof`. A difference anywhere
// else, or in a value other than the allowed header, fails the recording.
//
// Usage: node record.mjs --tree <git archive export of b6f10295a, with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import tls from 'node:tls';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..', '..', '..', '..');
const self = fileURLToPath(import.meta.url);
const finalDir = join(repo, 'native/core/fixtures/grok-wire');
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
/** The one header value Node draws at random for every request (`randomUUID()` in `proxyHeaders`). */
const RANDOM_HEADER = 'x-grok-req-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEADLINE_MS = 60_000;

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const scenarios = JSON.parse(readFileSync(join(finalDir, 'scenarios.json'), 'utf8'));

if (process.argv.includes('--raw-run')) {
  await rawRun(arg('--tree'), arg('--raw-run'));
} else {
  await record();
}

/** One run in this process: the scenarios in order, the traffic of each. */
async function rawRun(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-grokwire-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** Every await of the recording runs under a deadline that names what was awaited; nothing is retried or polled. */
  const within = (what, promise) => {
    let timer;
    const deadline = new Promise((_, reject) => { timer = realSetTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms awaiting ${what}`)), DEADLINE_MS); });
    return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer));
  };
  const load = (path) => within(`loading ${path}`, import(pathToFileURL(join(tree, path)).href));

  const { startWireServer } = await import('./server.mjs');
  const traffic = { sink: [], script: { http: [] }, unanswered: null };
  const server = await within('starting the loopback server', startWireServer({ traffic }));
  tls.connect = (options, onSecure) => {
    const socket = net.connect({ host: '127.0.0.1', port: server.port });
    Object.assign(socket, { encrypted: true, authorized: true, alpnProtocol: false, servername: options?.servername, getSession: () => undefined, setSession() {} });
    if (typeof onSecure === 'function') socket.once('secureConnect', onSecure);
    socket.once('connect', () => socket.emit('secureConnect'));
    return socket;
  };

  const P = 'src/runtime/agent/orchestrator/';
  const { GrokOAuthProvider } = await load(`${P}providers/grok-oauth.mjs`);
  const { buildRequestSendOptions } = await load(`${P}session/manager/ask-turn-loop-options.mjs`);
  const { recycleLlmDispatcher } = await load('src/runtime/shared/llm/http-agent.mjs');

  const replies = {
    ...Object.fromEntries(Object.entries(scenarios.replies).map(([name, events]) => [name, { events }])),
    refreshed: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenarios.refreshedTokens) },
    discovery: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenarios.discovery) },
  };
  const results = [];
  for (const scenario of scenarios.scenarios) {
    // A new pool and a new warm-up gate: each scenario is a provider constructed in a process that has not warmed the origin.
    recycleLlmDispatcher();
    const token = scenario.token ?? {};
    writeFileSync(join(dataDir, 'grok-oauth.json'), JSON.stringify({
      access_token: scenarios.accessToken,
      refresh_token: scenarios.refreshToken,
      expires_at: token.expiresInMs === undefined ? 4_102_444_800_000 : Date.now() + token.expiresInMs,
      token_endpoint: token.tokenEndpoint === undefined ? scenarios.tokenEndpoint : token.tokenEndpoint,
      user_id: scenarios.userId,
    }));
    server.restart();
    traffic.sink = [];
    traffic.script = { http: scenario.http.map((step) => (step.reply ? replies[step.reply] : step)) };
    const controller = new AbortController();
    let unanswered = null;
    traffic.unanswered = () => {
      unanswered = new Error(`${scenario.id}: the script has no answer for ${traffic.sink.at(-1).line} (after ${traffic.sink.slice(0, -1).map((event) => event.line).join(', ') || 'nothing'})`);
      controller.abort(unanswered);
    };
    const provider = new GrokOAuthProvider({});
    // A session's provider-scoped cache key is stored in its header at creation (providerCacheKey(provider)).
    const session = { provider: 'grok-oauth', model: scenario.model, promptCacheKey: scenarios.promptCacheKey };
    const opts = {
      ...buildRequestSendOptions({ sessionId: scenarios.sessionId, session, turnEffort: scenario.send.effort, effortConfiguration: undefined, stepAutoEffort: null, codexTurnId: undefined, startedAtMs: undefined, signal: controller.signal }),
      iteration: scenario.send.iteration,
      admissionOwner: scenarios.sessionId,
    };
    const tools = scenario.tools ? scenarios.tools : undefined;
    await within(`the reply of ${scenario.id}`, provider.send(scenario.messages, scenario.model, tools, opts));
    if (unanswered) throw unanswered;
    if (traffic.script.http.length) throw new Error(`${scenario.id}: the script was not consumed (${traffic.script.http.length} left)`);
    results.push({ id: scenario.id, traffic: traffic.sink });
  }
  server.stop();
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(outFile, JSON.stringify({ scenarios: results }));
  process.exit(0);
}

async function record() {
  const { commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import(pathToFileURL(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs')).href);
  const tree = resolveTree(parseArgs());
  const identity = exactProductIdentity(tree, COMMIT);
  const work = mkdtempSync(join(tmpdir(), 'mixdog-grokwire-runs-'));
  const runs = ['a', 'b'].map((name) => {
    const out = join(work, `${name}.json`);
    const child = spawnSync(process.execPath, [self, '--tree', tree, '--raw-run', out], { stdio: 'inherit', timeout: 5 * DEADLINE_MS * scenarios.scenarios.length, windowsHide: true });
    if (child.status !== 0) throw new Error(`run ${name} ended with status ${child.status} (${child.error ?? child.signal ?? ''})`);
    return JSON.parse(readFileSync(out, 'utf8'));
  });
  rmSync(work, { recursive: true, force: true });

  // Every leaf that differs between the two runs, with where it is.
  const differing = [];
  const walk = (a, b, path) => {
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], [...path, key]);
    } else if (a !== b) {
      differing.push({ path, a, b });
    }
  };
  walk(runs[0], runs[1], []);
  const at = (run, path) => path.slice(0, -1).reduce((value, step) => value[step], run);
  for (const { path, a, b } of differing) {
    const pair = at(runs[0], path);
    const isHeader = path.at(-1) === '1' && path.at(-3) === 'headers' && String(pair[0]).toLowerCase() === RANDOM_HEADER;
    if (!isHeader || !UUID.test(a) || !UUID.test(b)) throw new Error(`the two runs differ at ${path.join('.')} (${a} / ${b}), which is not the random ${RANDOM_HEADER} header`);
  }
  if (!differing.length) throw new Error(`the two runs are identical: ${RANDOM_HEADER} was not observed to vary`);

  // Replace each distinct random value of a scenario by <random:N>; a value of run A must always pair with the same value of run B.
  const randomProof = [];
  const recorded = structuredClone(runs[0]);
  const byScenario = new Map();
  for (const { path, a, b } of differing) {
    const id = runs[0].scenarios[path[1]].id;
    const seen = byScenario.get(id) ?? new Map();
    byScenario.set(id, seen);
    if (!seen.has(a)) seen.set(a, { n: seen.size + 1, b });
    const entry = seen.get(a);
    if (entry.b !== b) throw new Error(`${id}: one value of run A pairs with two values of run B`);
    at(recorded, path)[1] = `<random:${entry.n}>`;
    randomProof.push({ scenario: id, path: path.slice(2), runA: a, runB: b, placeholder: `<random:${entry.n}>` });
  }

  const stage = stageSet(finalDir, ['node-wire.json', 'MANIFEST.json']);
  writeJson(join(stage, 'node-wire.json'), { scenarios: recorded.scenarios, randomProof });
  const recorder = relative(repo, self).replaceAll('\\', '/');
  writeSetManifest(stage, { set: 'grok-wire', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity });
  commitStage(stage, finalDir);
  console.log(`${recorded.scenarios.length} scenarios, ${randomProof.length} random value(s) replaced`);
}