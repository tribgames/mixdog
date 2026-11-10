#!/usr/bin/env node
// Golden twin of the Claude version-floor capabilities: Node's answers, for a fixed id table, of
// `emitsAnthropicProgressUpdates`, `supportsAnthropicTurnScopedSystemMessages` (shared/llm/anthropic-thinking-contract.mjs),
// `threadsSupportModel` (providers/anthropic-message-threads.mjs), the id key and family version they read
// (`claudeModelKey`, `claudeFamilyVersion`), and which floor feature a provider rejection names
// (`anthropicCapabilityRejection`, providers/anthropic-capability-fallback.mjs). Rust `mixdog_ai::claude_floors`
// must give the same answers, the whole table. A third scenario drives the rejection fallback through the real
// API-key send (`fallback`, below); Rust `AnthropicAdapter::attempt` must send the same requests.
//
// The id table (claude-floors/ids.json plus the lists below): the ids the predicates were exact lists of before
// the floors, every Claude id of the installed catalogs and of Node's provider seeds, 5.2 and later versions,
// unknown families, dated, dotted and other spellings.
//
//   node benchmarks/rust-core/recorders/record-claude-floors.mjs --tree <Node tree> --base <full commit> [--only predicates|rejections|fallback]
//
// `--base` is the commit the tree's changes sit on; the manifest names it with the sha256 of every module of the
// floor change, so a recording from an uncommitted tree still says exactly what it ran.
// Output: native/core/fixtures/claude-floors/golden.json (+ MANIFEST.json). With --only, the scenario is printed
// and nothing is written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES_ROOT,
  commitStage,
  importFrom,
  orderedStringify,
  parseArgs,
  resolveTree,
  sha256,
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
});
delete process.env.MIXDOG_ANTHROPIC_THINKING_DISPLAY;

const args = parseArgs();
const tree = resolveTree(args);
const base = args.get('base');
if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('--base <full 40-hex commit> is required');
const only = args.get('only') ?? null;
if (only && !['predicates', 'rejections', 'fallback'].includes(only)) throw new Error(`--only predicates|rejections|fallback, got ${only}`);
const recorder = 'benchmarks/rust-core/recorders/record-claude-floors.mjs';

// The modules of the floor change (Part 1 of the version-floor brief), hashed into the manifest.
const FLOOR_MODULES = [
  'src/runtime/shared/llm/anthropic-thinking-contract.mjs',
  'src/runtime/agent/orchestrator/providers/anthropic-message-threads.mjs',
  'src/runtime/agent/orchestrator/providers/anthropic-capability-fallback.mjs',
  'src/runtime/agent/orchestrator/providers/lib/replay-before-output.mjs',
  'src/runtime/agent/orchestrator/providers/effort-configuration.mjs',
  'src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs',
  'src/runtime/agent/orchestrator/providers/anthropic-api-request.mjs',
  'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs',
  'src/runtime/agent/orchestrator/providers/anthropic.mjs',
  'src/runtime/agent/orchestrator/providers/lib/anthropic-models.mjs',
  'src/runtime/agent/orchestrator/session/manager/context-meta.mjs',
  'src/runtime/agent/orchestrator/runtime-core/effort.mjs',
  'src/runtime/shared/model-display.mjs',
  'src/vendor/statusline/bin/statusline-route.mjs',
  'src/vendor/statusline/src/gateway/claude-current.mjs',
];

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
const ids = [
  ...new Set([
    ...[...OLD_PROGRESS_UPDATES, ...OLD_TURN_SCOPED, ...OLD_THREADS, ...LATER].flatMap(spellings),
    ...UNKNOWN,
    ...SHAPES,
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

// The rejection fallback through the REAL `AnthropicProvider.send` (providers/anthropic.mjs, API-key route) against
// a local server that answers each POST from a script: what each request carried of the progress-update feature
// (`thinking.display`, the display beta) and how the send ended. Sends of one scenario share the process-wide
// switch-off; each scenario has its own model, so none sees another's.
const { AnthropicProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic.mjs');
const MESSAGES = [
  { role: 'system', content: 'You are a fixture assistant.' },
  { role: 'user', content: 'Look up the answer.' },
];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const OK = {
  status: 200,
  contentType: 'text/event-stream',
  body: sse([
    { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]),
};
const refusal = (message) => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }) });
const DISPLAY_REJECTED = refusal("thinking.adaptive.display: Input should be 'summarized' or 'omitted'");
const UNRELATED = refusal('prompt is too long: 210000 tokens > 200000 maximum');
const FALLBACK_SCENARIOS = [
  {
    name: 'a_rejected_progress_update_display_is_switched_off_and_the_send_replayed_once',
    model: 'claude-mythos-5-2',
    sends: [{ replies: [DISPLAY_REJECTED, OK] }, { replies: [OK] }],
  },
  { name: 'a_rejection_naming_no_floor_feature_is_not_replayed', model: 'claude-fable-5-2', sends: [{ replies: [UNRELATED] }] },
  {
    name: 'a_feature_rejected_again_on_its_replay_is_not_replayed_twice',
    model: 'claude-sonnet-5-6',
    sends: [{ replies: [DISPLAY_REJECTED, DISPLAY_REJECTED] }],
  },
];

async function withServer(replies, fn) {
  const requests = [];
  const queue = [...replies];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({
      display: body.thinking?.display ?? null,
      displayBeta: String(req.headers['anthropic-beta'] ?? '').includes('thinking-display-updates'),
    });
    const reply = queue.shift();
    res.writeHead(reply.status, { 'content-type': reply.contentType });
    res.end(reply.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function fallbackScenarios() {
  const out = [];
  for (const scenario of FALLBACK_SCENARIOS) {
    const sends = [];
    for (const send of scenario.sends) {
      sends.push(
        await withServer(send.replies, async (base, requests) => {
          let outcome;
          try {
            const result = await new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', baseURL: base, maxRetries: 0 }).send(
              MESSAGES,
              scenario.model,
              [],
              {}
            );
            outcome = { ok: { content: result.content } };
          } catch (error) {
            outcome = { error: { status: error.status ?? error.httpStatus ?? null } };
          }
          return { replies: send.replies, requests, outcome };
        })
      );
    }
    out.push({ name: scenario.name, model: scenario.model, sends });
  }
  return out;
}

if (only === 'predicates') process.stdout.write(orderedStringify(predicates()));
else if (only === 'rejections') process.stdout.write(orderedStringify(rejections()));
else if (only === 'fallback') process.stdout.write(orderedStringify(await fallbackScenarios()));
else {
  const git = (...a) => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }).trim();
  const changedModules = FLOOR_MODULES.map((path) => {
    let baseBlob = null;
    try {
      baseBlob = git('rev-parse', `${base}:${path}`);
    } catch {
      // a module the change adds
    }
    const file = join(tree, path);
    return { path, sha256: existsSync(file) ? sha256(readFileSync(file)) : null, baseBlob };
  });
  const finalDir = join(FIXTURES_ROOT, 'claude-floors');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { predicates: predicates(), rejections: rejections(), fallback: await fallbackScenarios() });
  writeSetManifest(stage, {
    set: 'claude-floors',
    recorder,
    command: `node ${recorder} --tree <tree> --base ${base}`,
    identityTree: tree,
    identityRef: base,
    extra: { nodeTree: { baseCommit: base, changedModules } },
  });
  commitStage(stage, finalDir);
}
