#!/usr/bin/env node
// Golden twin of the Claude version-floor capabilities: Node's answers, for a fixed id table, of
// `emitsAnthropicProgressUpdates`, `supportsAnthropicTurnScopedSystemMessages` (shared/llm/anthropic-thinking-contract.mjs),
// `threadsSupportModel` (providers/anthropic-message-threads.mjs), the id key and family version they read
// (`claudeModelKey`, `claudeFamilyVersion`), and which floor feature a provider rejection names
// (`anthropicCapabilityRejection`, providers/anthropic-capability-fallback.mjs). Rust `mixdog_ai::claude_floors`
// must give the same answers, the whole table. A third part drives the rejection fallback through the real sends
// of both Anthropic routes (`AnthropicProvider.send`, API key; `AnthropicOAuthProvider.send`, OAuth) against a
// scripted loopback server (`fallback`, below); Rust `AnthropicAdapter::attempt` must send the same requests and
// end the same way.
//
// The id table (claude-floors/ids.json plus the lists below): the ids the predicates were exact lists of before
// the floors, every Claude id of the installed catalogs and of Node's provider seeds, 5.2 and later versions,
// unknown families, dated, dotted and other spellings.
//
//   node benchmarks/rust-core/recorders/record-claude-floors.mjs --tree <git archive export of the commit> --commit <full commit>
//     [--only predicates|rejections|fallback|offline|<fallback scenario name>]
//
// The tree must be exactly `--commit` (`exactProductIdentity`). Output: native/core/fixtures/claude-floors/golden.json
// (+ MANIFEST.json). With --only, that part is printed and nothing is written.
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  FIXTURES_ROOT,
  commitStage,
  exactProductIdentity,
  importFrom,
  orderedStringify,
  parseArgs,
  recordingProvenance,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

// Every user directory is a fresh temp one before any product module loads: no cached catalog or provider
// state of the machine reaches the modules.
const sandbox = mkdtempSync(join(tmpdir(), 'claude-floors-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_QUIET_PROVIDER_LOG: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
  // `warmCliVersion` takes the named version instead of asking the npm registry.
  MIXDOG_CLI_VERSION: '2.1.400',
});
// The machine's display override must not reach the requests, nor its family id overrides the offline listings; Node
// reads both per call.
for (const name of ['MIXDOG_ANTHROPIC_THINKING_DISPLAY', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL']) {
  delete process.env[name];
}
// The OAuth route's signed-in credential (a fixed far expiry: no refresh is ever due).
writeFileSync(
  join(dirs.data, 'anthropic-oauth-credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-token',
      refreshToken: 'fixture-refresh-token',
      expiresAt: 4102444800000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  })
);

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit') ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit <full 40-hex commit> is required');
const identity = exactProductIdentity(tree, commit);
const only = args.get('only') ?? null;
const recorder = 'benchmarks/rust-core/recorders/record-claude-floors.mjs';

// One deadline per awaited thing; the failure names it.
class Deadline extends Error {}
async function within(ms, what, promise) {
  const signal = AbortSignal.timeout(ms);
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(new Deadline(`${what}: not settled within ${ms} ms`));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// The loopback server every Anthropic request lands on (installed before any product module loads, as
// lib/intercept.mjs does): a Messages POST to api.anthropic.com is recorded and answered from the current
// send's script; anything else (the OAuth route's catalog upkeep) gets a 404 and is not part of the recording.
let script = null;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const origin = req.headers['x-fixture-origin'] ?? null;
  if (!script || req.method !== 'POST' || origin !== 'https://api.anthropic.com' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not scripted"}');
    return;
  }
  const encoding = req.headers['content-encoding'] ?? null;
  const text = (encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
  // `bodyText` is the body's bytes as Node sent them (decoded when gzipped), `body` the same parsed.
  script.requests.push({ path: req.url, betaHeader: req.headers['anthropic-beta'] ?? null, contentEncoding: encoding, bodyText: text, body: JSON.parse(text) });
  const reply = script.replies[script.requests.length - 1] ?? NO_REPLY;
  res.writeHead(reply.status, { 'content-type': reply.contentType });
  res.end(reply.body);
});
server.listen(0, '127.0.0.1');
await within(10_000, 'the fixture server listening on 127.0.0.1', once(server, 'listening'));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  const headers = new Headers(init?.headers ?? req?.headers ?? {});
  headers.set('x-fixture-origin', url.origin);
  const local = `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`;
  return realFetch(local, req ? { method: req.method, headers, body: req.body, duplex: 'half', signal: req.signal, ...init, headers } : { ...init, headers });
};

const contract = await importFrom(tree, 'src/runtime/shared/llm/anthropic-thinking-contract.mjs');
const threads = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic-message-threads.mjs');
const fallback = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic-capability-fallback.mjs');

// The exact lists the three predicates were before the floors.
const OLD_PROGRESS_UPDATES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5'];
const OLD_TURN_SCOPED = [
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-haiku-5-5',
];
const OLD_THREADS = [
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview', 'claude-opus-5-5',
  'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8',
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929',
];
const LATER = [
  'claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-6', 'claude-opus-6', 'claude-sonnet-5-6', 'claude-sonnet-6-0',
  'claude-haiku-5-6', 'claude-haiku-6-1', 'claude-fable-6', 'claude-mythos-7-12', 'claude-opus-99999999999',
];
const UNKNOWN = ['claude-nova-9', 'claude-nova-9-1', 'claude-quasar-5-5', 'claude-newfamily-5-2', 'gpt-6', 'claude', ''];
// Every listed id in its dated, ISO-dated, dotted, upper-case and padded spellings, plus shapes no floor reads.
const spellings = (id) => {
  const alias = id.replace(/-\d{8}$/, '');
  return [
    id,
    alias,
    `${alias}-20261101`,
    `${alias}-2026-11-01`,
    alias.replace(/-(\d+)-(\d+)$/, '-$1.$2'),
    `${alias.replace(/-(\d+)-(\d+)$/, '-$1.$2')}-20261101`,
    alias.toUpperCase(),
    ` ${alias}\t`,
  ];
};
const SHAPES = [
  'claude-opus-5-5-fast', 'claude-opus-5-5@20261101', 'claude-opus-5-5-v1:0', 'claude-opus-5-5-latest', 'anthropic/claude-opus-5-5',
  'claude-opus-5-123', 'claude-opus-5-5-5', 'claude-opus5-5', 'claude-0pus-5', 'claude-opus--5', 'claude-opus-5-', 'claude-opus-',
  'claude-mythos-preview-20261101', 'claude-mythos-preview.1', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219',
  'claude-opus-5.2026.11.01', 'claude-opus-5-2026-1-01', 'claude-opus-5-1234567',
];

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'claude-floors', 'ids.json'), 'utf8'));
// The boundaries of every floor Node has, generated from its own tables (`ANTHROPIC_PROGRESS_UPDATES`,
// `ANTHROPIC_TURN_SCOPED_SYSTEM`, `ANTHROPIC_MESSAGE_THREADS`): per family, one below, at and one above the floor in
// the minor and in the major, the bare major, a padded and a two-digit minor; and majors at and past 2^53 and 2^64,
// at 1e20 / 1e21 and past Number's range (Node reads the version with `Number`). Digits the version pattern does not
// take (`\d` is ASCII) go with them.
const FLOOR_TABLES = [contract.ANTHROPIC_PROGRESS_UPDATES, contract.ANTHROPIC_TURN_SCOPED_SYSTEM, threads.ANTHROPIC_MESSAGE_THREADS];
const BIG_MAJORS = [
  '9007199254740991', '9007199254740992', '9007199254740993', '18446744073709551615', '18446744073709551616',
  '18446744073709551617', '100000000000000000000', '1000000000000000000000', '9'.repeat(400),
];
const boundaries = FLOOR_TABLES.flatMap(({ floors }) =>
  Object.entries(floors).flatMap(([family, [major, minor]]) => {
    const id = (...version) => `claude-${family}-${version.join('-')}`;
    return [
      ...(minor > 0 ? [id(major, minor - 1)] : []),
      id(major - 1, 99),
      id(major, minor),
      id(major, minor + 1),
      id(major - 1, minor),
      id(major + 1, minor),
      id(major - 1),
      id(major),
      id(major + 1),
      id(major, String(minor).padStart(2, '0')),
      id(major, 10),
      id(major, '\uff15'),
      id('\u0665', minor),
      ...BIG_MAJORS.flatMap((big) => [id(big), id(big, minor)]),
    ];
  })
);
const ids = [
  ...new Set([
    ...[...OLD_PROGRESS_UPDATES, ...OLD_TURN_SCOPED, ...OLD_THREADS, ...LATER].flatMap(spellings),
    ...UNKNOWN,
    ...SHAPES,
    ...boundaries,
    ...table.catalog,
    ...table.seeds,
    ...table.tails,
  ]),
];

function predicates() {
  return ids.map((model) => {
    const parsed = contract.claudeFamilyVersion(model);
    return {
      model,
      key: contract.claudeModelKey(model),
      familyVersion: parsed ? [parsed.family, ...parsed.version] : null,
      progressUpdates: contract.emitsAnthropicProgressUpdates(model),
      turnScopedSystem: contract.supportsAnthropicTurnScopedSystemMessages(model),
      messageThreads: threads.threadsSupportModel(model),
    };
  });
}

const REJECTION_TEXTS = [
  "thinking.adaptive.display: Input should be 'summarized' or 'omitted'",
  "thinking.display: Input should be 'summarized' or 'omitted'",
  'Unexpected value(s) `thinking-display-updates-2026-08-18` for the `anthropic-beta` header.',
  'messages.1.clear_at: Extra inputs are not permitted',
  'Unexpected value(s) `mid-conversation-system-clear-at-2026-08-21` for the `anthropic-beta` header.',
  'a turn-scoped system message is not supported by this model',
  "messages.3: a turn-scoped system message supports text blocks only (clear_at: 'next_user_message')",
  "messages.3: output_config is not permitted on a turn-scoped system message (clear_at: 'next_user_message')",
  "messages.3.content.0: cache_control is not permitted on a turn-scoped system message (clear_at: 'next_user_message')",
  'Unexpected value(s) `mid-conversation-output-config-2026-07-01` for the `anthropic-beta` header.',
  'output_config: Extra inputs are not permitted',
  'prompt is too long: 210000 tokens > 200000 maximum',
  'mythinking.display is wrong',
  '{"type":"error","error":{"type":"invalid_request_error","message":"messages.5.clear_at: Extra inputs are not permitted"}}',
  '',
];

function rejections() {
  return [400, 404, 500, null].flatMap((status) =>
    REJECTION_TEXTS.map((text) => ({ status, text, feature: fallback.anthropicCapabilityRejection(status, text) }))
  );
}

// The rejection fallback through the REAL sends of both routes: `AnthropicProvider.send` (providers/anthropic.mjs,
// `withAnthropicCapabilityFallback` around the API-key send) and `AnthropicOAuthProvider.send` (anthropic-oauth.mjs,
// `anthropicCapabilityReplay` on a rejected initial response), first-party origin, each Messages POST answered from
// the send's script. Recorded per send: every request (path, `anthropic-beta`, whole body), the text deltas that
// reached the caller and how the send ended. The switch-off is process-wide: sends of one scenario see each
// other's, and every scenario uses models no other scenario rejects. `claude-opus-5-5` is the bystander no scenario
// ever rejects.
const { AnthropicProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic.mjs');
const { AnthropicOAuthProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs');
const HISTORIES = {
  single: [
    { role: 'system', content: 'You are a fixture assistant.' },
    { role: 'user', content: 'Look up the answer.' },
  ],
  // A finished assistant turn: the turn-scoped layout sends its string content as a text block.
  multi: [
    { role: 'system', content: 'You are a fixture assistant.' },
    { role: 'user', content: 'Look up the answer.' },
    { role: 'assistant', content: 'It is in the table.' },
    { role: 'user', content: 'Read it to me.' },
  ],
};
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const START = { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } };
const TEXT_START = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const streamed = (events) => ({ status: 200, contentType: 'text/event-stream', body: sse(events) });
const OK = streamed([
  START,
  TEXT_START,
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);
const errorBody = (message) => ({ type: 'error', error: { type: 'invalid_request_error', message } });
const refusal = (message) => ({ status: 400, contentType: 'application/json', body: JSON.stringify(errorBody(message)) });
const DISPLAY_TEXT = "thinking.adaptive.display: Input should be 'summarized' or 'omitted'";
const DISPLAY_REJECTED = refusal(DISPLAY_TEXT);
const CLEAR_AT_REJECTED = refusal('messages.3.clear_at: Extra inputs are not permitted');
const TURN_SCOPED_CONTENT_RULE = refusal("messages.3: a turn-scoped system message supports text blocks only (clear_at: 'next_user_message')");
const UNRELATED = refusal('prompt is too long: 210000 tokens > 200000 maximum');
// The same rejection text as an in-stream error event, after a text delta reached the caller or before any.
const DISPLAY_ERROR_AFTER_TEXT = streamed([
  START,
  TEXT_START,
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
  { ...errorBody(DISPLAY_TEXT) },
]);
const DISPLAY_ERROR_BEFORE_OUTPUT = streamed([START, { ...errorBody(DISPLAY_TEXT) }]);
const NO_REPLY = { status: 418, contentType: 'application/json', body: JSON.stringify(errorBody('fixture: no scripted reply')) };

const ROUTES = ['anthropic', 'anthropic-oauth'];
const BYSTANDER = 'claude-opus-5-5';
const otherRoute = (route) => ROUTES.find((r) => r !== route);
const dotted = (model) => model.replace(/-(\d+)-(\d+)$/, '-$1.$2');
// name -> per route: [model, sends(route, model)]. Every model below is on its floor for the feature it rejects.
const FALLBACK_SCENARIOS = {
  a_rejected_progress_update_display_is_off_for_that_model_on_that_route_for_the_process: {
    models: { anthropic: 'claude-mythos-5-2', 'anthropic-oauth': 'claude-fable-5-2' },
    sends: (route, model) => [
      { route, model, history: 'single', replies: [DISPLAY_REJECTED, OK] },
      { route, model, history: 'single', replies: [OK] },
      { route, model: `${model}-20261101`, history: 'single', replies: [OK] },
      { route, model: dotted(model), history: 'single', replies: [OK] },
      { route: otherRoute(route), model, history: 'single', replies: [OK] },
      { route, model: BYSTANDER, history: 'single', replies: [OK] },
    ],
  },
  a_rejected_turn_scoped_system_message_is_off_for_that_model_on_that_route_for_the_process: {
    models: { anthropic: 'claude-opus-5-7', 'anthropic-oauth': 'claude-haiku-5-6' },
    sends: (route, model) => [
      { route, model, history: 'multi', replies: [CLEAR_AT_REJECTED, OK] },
      { route, model, history: 'multi', replies: [OK] },
      { route: otherRoute(route), model, history: 'multi', replies: [OK] },
      { route, model: BYSTANDER, history: 'multi', replies: [OK] },
    ],
  },
  a_turn_scoped_content_rule_is_not_a_rejection_of_the_feature: {
    models: { anthropic: 'claude-sonnet-5-7', 'anthropic-oauth': 'claude-opus-5-8' },
    sends: (route, model) => [
      { route, model, history: 'multi', replies: [TURN_SCOPED_CONTENT_RULE, OK] },
      { route, model, history: 'multi', replies: [OK] },
    ],
  },
  a_rejection_naming_no_floor_feature_is_not_replayed: {
    models: { anthropic: 'claude-fable-5-3', 'anthropic-oauth': 'claude-mythos-5-3' },
    sends: (route, model) => [
      { route, model, history: 'multi', replies: [UNRELATED, OK] },
      { route, model, history: 'multi', replies: [OK] },
    ],
  },
  a_feature_rejected_again_on_its_replay_is_not_replayed_twice: {
    models: { anthropic: 'claude-sonnet-5-6', 'anthropic-oauth': 'claude-sonnet-6-2' },
    sends: (route, model) => [{ route, model, history: 'single', replies: [DISPLAY_REJECTED, DISPLAY_REJECTED, OK] }],
  },
  each_rejected_feature_gets_its_own_single_replay: {
    models: { anthropic: 'claude-mythos-6', 'anthropic-oauth': 'claude-fable-6' },
    sends: (route, model) => [
      { route, model, history: 'multi', replies: [DISPLAY_REJECTED, CLEAR_AT_REJECTED, OK] },
      { route, model, history: 'multi', replies: [OK] },
    ],
  },
  a_rejection_after_output_reached_the_caller_is_not_replayed_and_switches_nothing_off: {
    models: { anthropic: 'claude-opus-6-1', 'anthropic-oauth': 'claude-mythos-6-1' },
    sends: (route, model) => [
      { route, model, history: 'single', replies: [DISPLAY_ERROR_AFTER_TEXT, OK] },
      { route, model, history: 'single', replies: [OK] },
    ],
  },
  an_in_stream_rejection_before_output: {
    models: { anthropic: 'claude-opus-6-2', 'anthropic-oauth': 'claude-fable-6-1' },
    sends: (route, model) => [
      { route, model, history: 'single', replies: [DISPLAY_ERROR_BEFORE_OUTPUT, OK] },
      { route, model, history: 'single', replies: [OK] },
    ],
  },
};
if (only && !['predicates', 'rejections', 'fallback', 'offline'].includes(only) && !FALLBACK_SCENARIOS[only]) {
  throw new Error(`--only predicates|rejections|fallback|offline|${Object.keys(FALLBACK_SCENARIOS).join('|')}, got ${only}`);
}

async function runSend(label, providers, send) {
  const requests = [];
  const emitted = [];
  script = { replies: send.replies, requests };
  providers[send.route] ??=
    send.route === 'anthropic-oauth' ? new AnthropicOAuthProvider({}) : new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', maxRetries: 0 });
  let outcome;
  try {
    const result = await within(60_000, `${label}: the send`, providers[send.route].send(HISTORIES[send.history], send.model, [], {
      onTextDelta: (...a) => emitted.push(a.findLast((v) => typeof v === 'string') ?? null),
    }));
    // The usage the send answers: the attempt that answered, whatever a rejected attempt before it reported.
    outcome = { ok: { content: result.content, usage: result.usage } };
  } catch (error) {
    if (error instanceof Deadline) throw error;
    // The usage a failed stream reported (`partialUsage`, anthropic-sse-turn/turn-outcome.mjs), which the ledger
    // records for a failure the caller gets; a rejected attempt that is replayed is swallowed with it.
    outcome = { error: { status: error.status ?? error.httpStatus ?? null, partialUsage: error.partialUsage ?? null } };
  } finally {
    script = null;
  }
  return { route: send.route, model: send.model, messages: HISTORIES[send.history], replies: send.replies, requests, emitted, outcome };
}

async function fallbackScenarios(names = Object.keys(FALLBACK_SCENARIOS)) {
  const out = [];
  for (const name of names) {
    for (const route of ROUTES) {
      const scenario = FALLBACK_SCENARIOS[name];
      const providers = {};
      const sends = [];
      for (const [i, send] of scenario.sends(route, scenario.models[route]).entries()) {
        sends.push(await runSend(`${name} on ${route} #${i}`, providers, send));
      }
      out.push({ name: `${name}_on_${route.replace('-', '_')}`, sends });
    }
  }
  return out;
}

// The offline floor each route's real `listModels` answers when its roster fetch fails (`MODELS`,
// lib/anthropic-models.mjs; the fixture server answers the GET /v1/models with a 404), and on the OAuth route with a
// family variable naming its id (`ANTHROPIC_DEFAULT_<FAMILY>_MODEL`, read per call).
const OFFLINE_LISTINGS = [
  { route: 'anthropic', env: {} },
  { route: 'anthropic-oauth', env: {} },
  { route: 'anthropic-oauth', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-custom' } },
];
async function offlineListings() {
  const out = [];
  for (const { route, env } of OFFLINE_LISTINGS) {
    const provider =
      route === 'anthropic-oauth' ? new AnthropicOAuthProvider({}) : new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', maxRetries: 0 });
    Object.assign(process.env, env);
    try {
      out.push({ route, env, rows: await within(60_000, `the ${route} offline listing`, provider.listModels()) });
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
  }
  return out;
}

try {
  if (only === 'predicates') process.stdout.write(orderedStringify(predicates()));
  else if (only === 'rejections') process.stdout.write(orderedStringify(rejections()));
  else if (only === 'fallback') process.stdout.write(orderedStringify(await fallbackScenarios()));
  else if (only === 'offline') process.stdout.write(orderedStringify(await offlineListings()));
  else if (only) process.stdout.write(orderedStringify(await fallbackScenarios([only])));
  else {
    const finalDir = join(FIXTURES_ROOT, 'claude-floors');
    const stage = stageSet(finalDir);
    const fallbackRecorded = await fallbackScenarios();
    writeJson(join(stage, 'golden.json'), {
      predicates: predicates(),
      rejections: rejections(),
      fallback: fallbackRecorded,
      offlineListings: await offlineListings(),
    });
    writeSetManifest(stage, {
      set: 'claude-floors',
      recorder,
      command: `node ${recorder} --tree <tree> --commit ${commit}`,
      identity,
      extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/claude-floors/ids.json', 'benchmarks/rust-core/recorders/lib/common.mjs']),
    });
    commitStage(stage, finalDir);
  }
} finally {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
  await within(10_000, 'the fixture server closing', once(server, 'close'));
}
