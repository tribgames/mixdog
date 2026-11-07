#!/usr/bin/env node
// A request that asks for fast speed and meets a fast-pool refusal (WP-AI-CORE): the REAL
// `AnthropicProvider.send` (providers/anthropic.mjs, API-key route) against a local server that
// answers each POST from a script. The recording is what the wire saw (does each request carry
// `speed: "fast"`, the fast-mode beta) and how the request ended, plus the process-wide fast-mode
// state after every send (`fastModeAvailable`, `fastModeDisabledReason`, the cooldown in whole
// seconds). Rust `AnthropicAdapter::attempt` must send the same requests and leave the same state.
//
//   node benchmarks/rust-core/recorders/record-fast-replay.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/fast-replay/golden.json. Only replays that need no wait are
// scripted: a short Retry-After (kept at fast speed) is the ordinary retry path and waits in real
// time, so it is covered by the fast-mode policy golden, not here. Every user directory is a fresh
// temp one BEFORE any product module loads.
import http from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'fast-replay-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'fast-replay');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-fast-replay.mjs';
const P = 'src/runtime/agent/orchestrator/providers';
const { AnthropicProvider } = await importFrom(tree, `${P}/anthropic.mjs`);
const fastMode = await importFrom(tree, `${P}/anthropic-fast-mode.mjs`);

const MODEL = 'claude-opus-4-8';
const MESSAGES = [
  { role: 'system', content: 'You are a fixture assistant.' },
  { role: 'user', content: 'Look up the answer.' },
];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const OK = {
  status: 200,
  contentType: 'text/event-stream',
  body: sse([
    { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]),
};
const refusal = (status, type, message, headers = {}) => ({ status, contentType: 'application/json', headers, body: JSON.stringify({ type: 'error', error: { type, message } }) });
const R429 = (headers) => refusal(429, 'rate_limit_error', 'fast pool is out of capacity', headers);
const R529 = refusal(529, 'overloaded_error', 'Overloaded');
const R400 = refusal(400, 'invalid_request_error', 'Fast mode is not enabled for this organization');
const OVERAGE = 'anthropic-ratelimit-unified-overage-disabled-reason';

// A scenario is a list of sends, each with the scripted responses its POSTs get, in order, and
// whether it asks for fast speed. The fast-mode state carries from one send to the next.
const SCENARIOS = [
  { name: 'fast_ok', sends: [{ fast: true, replies: [OK] }] },
  { name: 'fast_pool_429_with_a_long_window_replays_at_standard_speed', sends: [{ fast: true, replies: [R429({ 'retry-after': '3600' }), OK] }] },
  { name: 'fast_pool_529_without_a_window_replays_at_standard_speed', sends: [{ fast: true, replies: [R529, OK] }] },
  { name: 'fast_mode_not_enabled_400_replays_at_standard_speed', sends: [{ fast: true, replies: [R400, OK] }] },
  { name: 'overage_unavailable_replays_and_switches_fast_off', sends: [{ fast: true, replies: [R429({ [OVERAGE]: 'org_level_disabled' }), OK] }] },
  { name: 'transient_overage_replays_without_a_cooldown', sends: [{ fast: true, replies: [R429({ [OVERAGE]: 'out_of_credits' }), OK] }] },
  {
    name: 'a_cooldown_keeps_the_next_send_at_standard_speed',
    sends: [{ fast: true, replies: [R429({ 'retry-after': '3600' }), OK] }, { fast: true, replies: [OK] }],
  },
  { name: 'a_disabled_fast_mode_keeps_the_next_send_at_standard_speed', sends: [{ fast: true, replies: [R400, OK] }, { fast: true, replies: [OK] }] },
  { name: 'a_send_that_did_not_ask_for_fast_is_never_touched', sends: [{ fast: false, replies: [OK] }] },
];

async function withServer(replies, fn) {
  const requests = [];
  const queue = [...replies];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ speed: body.speed ?? null, fastBeta: String(req.headers['anthropic-beta'] ?? '').includes('fast-mode'), maxTokens: body.max_tokens });
    const reply = queue.shift();
    res.writeHead(reply.status, { 'content-type': reply.contentType, ...(reply.headers ?? {}) });
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

const stderrWrite = process.stderr.write;
const recorded = [];
for (const scenario of SCENARIOS) {
  fastMode.clearFastModeCooldown();
  const sends = [];
  for (const send of scenario.sends) {
    const row = await withServer(send.replies, async (base, requests) => {
      let outcome;
      process.stderr.write = () => true;
      try {
        const result = await new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', baseURL: base, maxRetries: 0 }).send(MESSAGES, MODEL, [], send.fast ? { fast: true } : {});
        outcome = { ok: { content: result.content } };
      } catch (error) {
        outcome = { error: { status: error.status ?? error.httpStatus ?? null } };
      } finally {
        process.stderr.write = stderrWrite;
      }
      return { fast: send.fast, replies: send.replies, requests, outcome };
    });
    const remaining = fastMode.fastModeCooldownRemainingMs(Date.now());
    row.state = {
      available: fastMode.fastModeAvailable(),
      disabledReason: fastMode.fastModeDisabledReason(),
      cooldownSeconds: Number.isFinite(remaining) ? Math.round(remaining / 1000) : 'Infinity',
    };
    sends.push(row);
  }
  recorded.push({ name: scenario.name, model: MODEL, sends });
}
writeJson(join(stage, 'golden.json'), { scenarios: recorded });
writeSetManifest(stage, { set: 'fast-replay', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
