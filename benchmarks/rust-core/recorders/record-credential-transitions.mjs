#!/usr/bin/env node
// The credential registry's state transitions, driven through the product's own entry points against a scripted loopback
// endpoint (the custom-provider connection test, a real send through `testCustomProvider`, and the Devin sign-in's code
// exchange, `exchangeDevinCode`): what each send returns or throws, and which key sent each request.
//   - two accounts, one origin and one header: account A's key is read out of its variable and sent once; account B's key
//     is read out of its own variable and rotated past the registry's cap of retired values, each new key sent through the
//     same origin's `authorization`. Then a refusal of B's request quotes A's key and B's keys, oldest to newest: A's is
//     still configured and is redacted; of B's, the oldest two retired are gone (the cap's eviction order), the rest are not;
//   - keys seen only on requests (typed into an unsaved test, read out of no source) past the cap of such values: the least
//     recently carried go first;
//   - a key attached after a stream began: C's response stream starts, D's key is read and sent, then C's stream ends in an
//     error quoting D's key;
//   - a sign-in token scrubbed at once: the Devin code exchange grants a token, and the very next response (a refusal of
//     another account's test) quotes it before any request carried it.
// The registry is the patched Node's (node-patches/node-fix-scrub-canonical-credential.patch); the run is one process, the
// registry reset before each scenario.
//
//   node benchmarks/rust-core/recorders/record-credential-transitions.mjs --tree <export of b6f10295a with the patch applied> --patch <patch> [--only <scenario>]
//
// Output: native/core/fixtures/credential-transitions/golden.json.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeSetManifest, writeText } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

// mock.module needs the flag; run again with it when started without.
if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true, timeout: 280_000 });
  process.exit(run.status ?? 1);
}
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const cli = parseArgs();
const tree = resolveTree(cli);
const identity = nodeTreeIdentity(cli, tree, NODE_COMMIT);
const only = cli.get('only');
const finalDir = join(FIXTURES_ROOT, 'credential-transitions');
const href = (path) => pathToFileURL(join(tree, path)).href;
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'credential-transitions-'));
process.env.MIXDOG_HOME = join(process.env.MIXDOG_DATA_DIR, 'home');
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/.test(k) && !/^MIXDOG_/.test(k)) delete process.env[k];
// The warm-up gate (`preconnect`, 50 s by default) never lapses inside a scenario: a scenario that runs past it would warm its
// endpoint again, at a moment that depends on the machine's speed.
const KEEPALIVE_MS = '3600000';
process.env.MIXDOG_LLM_KEEPALIVE_MS = KEEPALIVE_MS;
mock.module(href('src/runtime/shared/file-permissions.mjs'), {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
const secrets = new Map();
createRequire(import.meta.url)(join(tree, 'src/lib/keychain-cjs.cjs')).getSecret = (account) => secrets.get(account) ?? null;
const original = await import(href('src/runtime/shared/config.mjs'));
mock.module(href('src/runtime/shared/config.mjs'), {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => {
      secrets.set(account, value);
    },
    deleteSecretAsync: async (account) => {
      secrets.delete(account);
    },
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
const admin = await import(href('src/session-runtime/services/provider-admin.mjs'));
const { exchangeDevinCode } = await import(href('src/runtime/agent/orchestrator/providers/devin-auth.mjs'));
const { getLlmDispatcher, recycleLlmDispatcher } = await import(href('src/runtime/shared/llm/http-agent.mjs'));
const { RETIRED_CAP, CARRIED_CAP, resetRegistry } = await import(href('src/runtime/agent/orchestrator/providers/lib/credential-canonical.mjs'));

// ---- the scripted endpoint ----------------------------------------------------------------------------------------------
// `/models` lists `m-a`; a chat request streams `OK` unless the scenario scripted its answer (`answers`, by authorization).
// Each exchange is recorded as [origin, method, path, authorization, served]: `served` indexes the `served` table (status,
// content type and body; a held stream's two chunks and the exchange of its scenario it waited for).
const servedTable = [];
const servedIndex = (entry) => {
  const text = JSON.stringify(entry);
  const at = servedTable.findIndex((e) => JSON.stringify(e) === text);
  return at < 0 ? servedTable.push(entry) - 1 : at;
};
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', model: 'm-a', choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } : null })}\n\n`;
const OK_STREAM = chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const MODELS = JSON.stringify({ data: [{ id: 'm-a' }] });
let exchanges = [];
let warmups = [];
// The warm-up is fire-and-forget: the product starts a `HEAD` inside a send and never awaits it. The global dispatcher it sends on
// counts each one as it starts (`watchHeads`), so a scenario ends only once every one has arrived at the endpoint
// (`headsSettled`): none is lost, none is counted in the scenario after.
let headsStarted = 0;
const headWaiters = [];
const watched = new WeakSet();
const watchHeads = () => {
  getLlmDispatcher();
  const router = createRequire(join(tree, 'package.json'))('undici').getGlobalDispatcher();
  if (watched.has(router)) return;
  watched.add(router);
  const dispatch = router.dispatch.bind(router);
  router.dispatch = (options, handler) => {
    if (options.method === 'HEAD') headsStarted++;
    return dispatch(options, handler);
  };
};
const answers = new Map();
const ended = new Map();
const finished = new Set();
const server = createServer((req, res) => {
  const parts = [];
  req.on('data', (part) => parts.push(part));
  req.on('end', async () => {
    const origin = req.headers['x-bench-origin'] ?? null;
    const path = req.url;
    const authorization = req.headers.authorization ?? '';
    // The connection warm-up (`HEAD /` of an origin, once per origin as the process's `preconnect` gates it): answered empty,
    // recorded in the order the warm-ups arrive.
    if (req.method === 'HEAD') {
      warmups.push([origin, req.method, path, authorization]);
      res.end();
      if (warmups.length >= headsStarted) for (const arrived of headWaiters.splice(0)) arrived();
      return;
    }
    const exchange = [origin, req.method, path, authorization, null];
    const at = exchanges.push(exchange) - 1;
    for (const waiting of arrivals) {
      if (waiting.authorization !== authorization || waiting.path !== path) continue;
      arrivals.delete(waiting);
      waiting.resolve(at);
    }
    res.on('finish', () => {
      finished.add(at);
      ended.get(at)?.();
    });
    const reply = (status, type, body) => {
      exchange[4] = servedIndex({ status, contentType: type, body });
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (origin === 'https://api.devin.ai') return reply(200, 'application/json', JSON.stringify({ token: SIGN_IN_TOKEN }));
    if (path === '/v1/models') return reply(200, 'application/json', MODELS);
    const answer = answers.get(authorization);
    if (!answer) return reply(200, 'text/event-stream', OK_STREAM);
    answers.delete(authorization);
    if (!answer.held) return reply(answer.status, answer.contentType, answer.body);
    // A held stream: its first chunk, then the rest once the exchange it waits for has been answered whole.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(answer.first);
    const waited = await answer.held;
    exchange[4] = servedIndex({ status: 200, contentType: 'text/event-stream', chunks: [answer.first, answer.rest], heldUntil: waited });
    res.end(answer.rest);
  });
});
const DEADLINE_MS = 60_000;
/** `wait`, or a rejection naming `what` when it has not happened within the deadline. */
const within = (what, wait) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the recorder waited ${DEADLINE_MS}ms for ${what}, which never happened`)), DEADLINE_MS);
  });
  return Promise.race([wait, expired]).finally(() => clearTimeout(timer));
};
/** Resolves once every `HEAD` the product started has arrived. */
const headsSettled = () =>
  warmups.length >= headsStarted
    ? Promise.resolve()
    : within(`the ${headsStarted} warm-ups the product started to arrive (${warmups.length} did)`, new Promise((resolve) => headWaiters.push(resolve)));
await within('the endpoint to listen', new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
}));
const base = `http://127.0.0.1:${server.address().port}/v1`;
// A request to the Devin token endpoint goes to the endpoint instead, naming the origin it addressed. The model catalog's
// background fetches (models.dev, the price list) are refused without reaching the network or the recording.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin !== 'https://api.devin.ai') return Promise.resolve(new Response('', { status: 404 }));
  const headers = new Headers(init?.headers ?? {});
  headers.set('x-bench-origin', url.origin);
  return realFetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, { ...init, headers });
};
/** The index of the exchange carrying `authorization` to `path`, once it has arrived: the server's arrival signals it. */
const arrivals = new Set();
const arrival = (authorization, path) => {
  const at = exchanges.findIndex((e) => e[3] === authorization && e[2] === path);
  if (at >= 0) return Promise.resolve(at);
  return within(
    `a request with ${authorization} to ${path}`,
    new Promise((resolve) => arrivals.add({ authorization, path, resolve }))
  );
};
/** Resolves with the index of the next exchange carrying `authorization` to `path` once its response has ended. */
const answered = async (authorization, path) => {
  const at = await arrival(authorization, path);
  if (!finished.has(at)) await within(`the response to ${authorization} ${path} to end`, new Promise((resolve) => ended.set(at, resolve)));
  return at;
};

let config = { providers: {}, modelSettings: {} };
const cfg = {
  loadConfig: () => structuredClone(config),
  saveConfig: (next) => {
    config = structuredClone(next);
  },
};
const save = (name, settings) => admin.saveCustomProvider(cfg, { name, protocol: 'openai-chat', baseURL: base, ...settings });
/** The connection test of `probe`: [its answer, null] or [null, the exact text it threw]. */
const test = async (probe) => {
  try {
    return [await admin.testCustomProvider(cfg, { schemaVersion: 2, protocol: 'openai-chat', baseURL: base, ...probe }), null];
  } catch (thrown) {
    return [null, thrown.message];
  }
};
const refusal = (quoted) => ({
  status: 400,
  contentType: 'application/json',
  body: JSON.stringify({ error: { message: `refused; the keys on file: ${quoted.join(', ')}`, type: 'invalid_request_error' } }),
});
const pad = (i) => String(i).padStart(5, '0');
// The values avoid what the custom error's own text rules redact (`key-…`, `sk-…`, `token=…`): only the registry redacts them.
const SIGN_IN_TOKEN = 'devin-sign-in-grant-41c7d09e';
const DEVIN_SIGN_IN_NOW = 1_800_000_000_000;

// ---- the scenarios ------------------------------------------------------------------------------------------------------
const SCENARIOS = {
  // Finding 1 of reviews 1124m/n, through the product: B's rotations on A's origin and header never retire A.
  'two-accounts-one-origin': async (steps) => {
    const a = await save('account a', { apiKeyEnv: 'CT_KEY_A' });
    const b = await save('account b', { apiKeyEnv: 'CT_KEY_B' });
    const keyA = 'account-a-credential-5f3c';
    const keyB = (i) => `account-b-credential-${pad(i)}`;
    process.env.CT_KEY_A = keyA;
    steps.push(['a', keyA, ...(await test({ id: a.id, name: 'account a', apiKeyEnv: 'CT_KEY_A' }))]);
    const rotations = RETIRED_CAP + 2;
    for (let i = 0; i <= rotations; i++) {
      process.env.CT_KEY_B = keyB(i);
      if (i === rotations) answers.set(`Bearer ${keyB(i)}`, refusal([keyA, keyB(0), keyB(1), keyB(2), keyB(rotations - 1), keyB(rotations)]));
      steps.push(['b', keyB(i), ...(await test({ id: b.id, name: 'account b', apiKeyEnv: 'CT_KEY_B' }))]);
    }
  },
  // Keys typed into an unsaved test come out of no source: past the cap, the least recently carried go first; one carried
  // again is the newest.
  'keys-seen-only-on-requests': async (steps) => {
    const typed = (i) => `typed-credential-${pad(i)}`;
    const count = CARRIED_CAP + 2;
    for (let i = 0; i <= count; i++) {
      const key = i === count ? typed(0) : typed(i);
      if (i === count) answers.set(`Bearer ${key}`, refusal([typed(0), typed(1), typed(2), typed(3), typed(count - 1)]));
      steps.push(['typed', key, ...(await test({ name: 'unsaved', apiKey: key }))]);
    }
  },
  // A key read and sent after C's response began streaming is redacted from the rest of that stream.
  'attached-after-the-stream-began': async (steps) => {
    const c = await save('account c', { apiKeyEnv: 'CT_KEY_C' });
    const d = await save('account d', { apiKeyEnv: 'CT_KEY_D' });
    const keyC = 'account-c-credential-7d21';
    const keyD = 'attached-after-the-stream-began-0b9e';
    process.env.CT_KEY_C = keyC;
    process.env.CT_KEY_D = keyD;
    const error = JSON.stringify({ error: { message: `the upstream quoted ${keyD} and ${keyC}`, type: 'invalid_request_error' } });
    answers.set(`Bearer ${keyC}`, { held: answered(`Bearer ${keyD}`, '/v1/chat/completions'), first: chunk({ role: 'assistant', content: 'O' }, null), rest: `data: ${error}\n\n` });
    const [first, second] = await Promise.all([
      test({ id: c.id, name: 'account c', apiKeyEnv: 'CT_KEY_C' }),
      (async () => {
        // D starts once C's stream has begun.
        await arrival(`Bearer ${keyC}`, '/v1/chat/completions');
        return test({ id: d.id, name: 'account d', apiKeyEnv: 'CT_KEY_D' });
      })(),
    ]);
    steps.push(['c', keyC, ...first]);
    steps.push(['d', keyD, ...second]);
  },
  // The sign-in's token is a credential from the exchange that granted it: the next response quoting it is redacted.
  'sign-in-token-scrubbed-at-once': async (steps) => {
    // The token has no `exp` claim: its record expires a year after the clock, which the recording fixes.
    mock.timers.enable({ apis: ['Date'], now: DEVIN_SIGN_IN_NOW });
    let record;
    try {
      record = await exchangeDevinCode('sign-in-code-5a1d', 'sign-in-verifier-0c3e');
    } finally {
      mock.timers.reset();
    }
    steps.push(['devin sign-in', 'sign-in-code-5a1d', record, null]);
    const e = await save('account e', { apiKeyEnv: 'CT_KEY_E' });
    const keyE = 'account-e-credential-2f88';
    process.env.CT_KEY_E = keyE;
    answers.set(`Bearer ${keyE}`, refusal([SIGN_IN_TOKEN]));
    steps.push(['e', keyE, ...(await test({ id: e.id, name: 'account e', apiKeyEnv: 'CT_KEY_E' }))]);
  },
};

const stage = stageSet(finalDir);
const recorded = {};
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  resetRegistry();
  // A scenario starts as a new process: no origin has been warmed (its first request to the endpoint is preceded by the
  // `HEAD` warm-up, as the replay's process is).
  recycleLlmDispatcher();
  headsStarted = 0;
  watchHeads();
  config = { providers: {}, modelSettings: {} };
  exchanges = [];
  warmups = [];
  arrivals.clear();
  ended.clear();
  finished.clear();
  // Each step: [who, the key it read (a variable's value, a typed key) or the sign-in's code, the answer, the thrown text].
  const steps = [];
  await run(steps);
  await headsSettled();
  recorded[name] = { steps, exchanges, warmups };
  console.log(`${name}: ${steps.length} steps, ${exchanges.length} exchanges, ${warmups.length} warm-ups`);
}
server.close();
// One line per step and per exchange: two scenarios run past the caps (some 16,000 exchanges).
const lines = (rows) => `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]`;
const scenarioText = Object.entries(recorded).map(([name, { steps, exchanges: seen, warmups: warmed }]) => `${JSON.stringify(name)}: {"steps": ${lines(steps)}, "exchanges": ${lines(seen)}, "warmups": ${lines(warmed)}}`);
writeText(
  join(stage, 'golden.json'),
  `{"caps": ${JSON.stringify({ retired: RETIRED_CAP, carried: CARRIED_CAP })},\n"devinSignInNow": ${DEVIN_SIGN_IN_NOW},\n"served": ${lines(servedTable)},\n"scenarios": {\n${scenarioText.join(',\n')}\n}}\n`
);
const provenance = recorderProvenance(import.meta.url);
writeSetManifest(stage, {
  set: 'credential-transitions',
  recorder: provenance.recorder,
  extra: {
    ...provenance,
    clock: 'the Devin sign-in runs on a fixed clock (`devinSignInNow`, mock.timers Date): its record expires a year after it, and the replay gives the core that clock',
    environment: `MIXDOG_LLM_KEEPALIVE_MS=${KEEPALIVE_MS}: the connection warm-up gate does not lapse within a scenario, so each endpoint is warmed once per scenario (a \`HEAD /\`, recorded in \`warmups\`); the replay sets the same variable`,
    exclusions: [
      'the position of a warm-up (`HEAD /`) among the other requests is not compared: it travels on a connection of its own, fire-and-forget, so its arrival against the requests of the other connections is a race in Node itself (it came before the first request in three recordings and after it in the fourth); its occurrence and its order among the warm-ups are compared whole (`warmups`), the other requests whole and in order (`exchanges`)',
      'the Devin sign-in\'s result is the record `exchangeDevinCode` returns, recorded whole; the core\'s entry (`exchange_checked`) returns the account label and stores the record, so the replay compares the stored file with the recorded record',
    ],
  },
  command: `node benchmarks/rust-core/recorders/record-credential-transitions.mjs --tree <export of ${NODE_COMMIT} with ${cli.get('patch')} applied> --patch ${cli.get('patch')}`,
  identity,
});
commitStage(stage, finalDir);
process.exit(0);
