#!/usr/bin/env node
// One cache warm on a provider as the product runs it: providers/anthropic-cache-warm.mjs
// `sendAnthropicCacheWarm` with its real account gate (cache-warm-admission.mjs) over a real
// account roster and the real admission scheduler, and the gate on its own. The POST is a scripted
// response; everything else is Node's. Rust `mixdog_ai::warmer::{send, gate}` and
// `AnthropicAdapter::send_cache_warm` must give the same answers for the same inputs.
//
//   node benchmarks/rust-core/recorders/record-cache-warm-send.mjs [--tree <dir>]
//
// Output: native/core/fixtures/cache-warm-send/golden.json.
process.env.TZ = 'UTC';
// The stall policy floors the first-byte deadline at 30 s and the SSE idle one at 10 s; those floors
// are the shortest real deadlines the timeout scenarios can be recorded under.
process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS = '30000';
process.env.MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS = '10000';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'cache-warm-send');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-cache-warm-send.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'cache-warm-send-rec-'));
const at = (path) => importFrom(tree, path);
const accounts = await at('src/runtime/shared/provider-accounts.mjs');
const { sendAnthropicCacheWarm } = await at('src/runtime/agent/orchestrator/providers/anthropic-cache-warm.mjs');
const { PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_SSE_IDLE_TIMEOUT_MS } = await at('src/runtime/agent/orchestrator/stall-policy.mjs');
const { cacheWarmAccountBlock } = await at('src/runtime/agent/orchestrator/providers/cache-warm-admission.mjs');
const { providerAdmissionKey, providerAdmissionScheduler } = await at('src/runtime/agent/orchestrator/providers/admission-scheduler.mjs');

const MODEL = 'claude-opus-4-7';
const HOUR = 3_600_000;
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const START = { type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 70000, cache_creation_input_tokens: 0, output_tokens: 1 } } };
const CONTENT = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const OK = { kind: 'sse', chunks: [sse([START, CONTENT])] };
const FRESH = { quotaWindows: [{ label: '5H', usedPct: 10 }] };

// ---- the scenarios: data only; each independent one owns its roster account ---------------------
// A 429 with quota headers, a 401 and the like block or throttle the account they hit, so a scenario
// that shares one with another would skip it before any POST. Only repeated warms of one scenario
// share state: that is what they are for.
const E429 = { kind: 'status', status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', headers: { 'retry-after': '20' } };
const E529 = { kind: 'status', status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' };
const E401 = { kind: 'status', status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' };
const sseError = (type, message) => ({ kind: 'sse', chunks: [sse([START, { type: 'error', error: { type, message } }])] });
const OAUTH = 'anthropic-oauth';
const SCENARIOS = [
  { name: 'a roster account with room', provider: OAUTH, own: true, responses: [OK], posts: 1 },
  { name: 'a provider without a roster', provider: 'anthropic', ref: '', responses: [OK], posts: 1 },
  { name: 'the account is unknown: skipped before any POST', provider: OAUTH, ref: '', responses: [OK], posts: 0 },
  { name: 'the account is blocked: skipped', provider: OAUTH, ref: 'blocked', responses: [OK], posts: 0 },
  { name: 'a 429 lands in the lane cooldown and the next warm is skipped', provider: OAUTH, own: true, responses: [E429, OK], repeat: 2, posts: 1 },
  { name: 'a 529 is not retried and leaves no cooldown', provider: OAUTH, own: true, responses: [E529, OK], repeat: 2, posts: 2 },
  { name: 'a 429 with the unified quota headers', provider: OAUTH, own: true, responses: [{ kind: 'status', status: 429, body: '', headers: { 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'retry-after': '120' } }], posts: 1 },
  { name: 'a 401 body', provider: OAUTH, own: true, responses: [E401], posts: 1 },
  { name: 'a 500 without a body', provider: OAUTH, own: true, responses: [{ kind: 'status', status: 500, body: '' }], posts: 1 },
  { name: 'the POST itself fails', provider: OAUTH, own: true, responses: [{ kind: 'throw', message: 'connect ECONNREFUSED' }], posts: 1 },
  { name: 'an error frame after usage carries the usage', provider: OAUTH, own: true, responses: [sseError('overloaded_error', 'busy')], posts: 1 },
  // An SSE error carries no Retry-After, so the lane's cooldown is zero: the next warm still goes out.
  { name: 'an SSE rate_limit_error is a 429 with its type; without advice the lane stays open', provider: OAUTH, own: true, responses: [sseError('rate_limit_error', 'slow down'), OK], repeat: 2, posts: 2 },
  { name: 'the message ends without content', provider: OAUTH, own: true, responses: [{ kind: 'sse', chunks: [sse([START, { type: 'message_delta', usage: { output_tokens: 1 } }, { type: 'message_stop' }])] }], posts: 1 },
  { name: 'a caller that aborted first is no refusal', provider: OAUTH, own: true, aborted: true, responses: [E429], posts: 1 },
  { name: 'an API-key POST refused with a 401', provider: 'anthropic', ref: '', responses: [E401], posts: 1 },
  { name: 'an API-key 429 lands in the lane cooldown', provider: 'anthropic', ref: '', responses: [E429, OK], repeat: 2, posts: 1 },
  { name: 'a POST that never answers ends at the first-byte deadline', provider: OAUTH, own: true, timed: true, responses: [{ kind: 'hang' }], posts: 1 },
  { name: 'a stream that goes quiet after usage ends at the idle deadline', provider: OAUTH, own: true, timed: true, responses: [{ kind: 'sse-hang', chunks: [sse([START])] }], posts: 1 },
  { name: 'a caller aborting while the POST is pending', provider: OAUTH, own: true, timed: true, abortAfterMs: 100, responses: [{ kind: 'hang' }], posts: 1 },
  { name: 'a caller aborting mid-stream after usage', provider: OAUTH, own: true, timed: true, abortAfterMs: 100, responses: [{ kind: 'sse-hang', chunks: [sse([START])] }], posts: 1 },
];
SCENARIOS.forEach((scenario, index) => {
  if (scenario.own) scenario.ref = `send-${index}`;
});

// ---- the roster: accounts are added in this order, as the Rust replay adds them ---------------
const ROSTER = [
  { ref: 'ok', usage: FRESH },
  { ref: 'unmeasured', usage: null },
  { ref: 'full', usage: { quotaWindows: [{ label: '5H', usedPct: 100, resetAt: 'in-1h' }] } },
  { ref: 'blocked', usage: FRESH, blockMs: 600_000 },
  ...SCENARIOS.filter((s) => s.own).map((s) => ({ ref: s.ref, usage: FRESH })),
];
const ids = new Map();
async function buildRoster() {
  for (const row of ROSTER) {
    const id = accounts.newProviderAccountId();
    ids.set(row.ref, id);
    await accounts.registerProviderAccount('anthropic-oauth', id);
    if (row.usage) {
      const usage = { quotaWindows: row.usage.quotaWindows.map((w) => ({ ...w, ...(w.resetAt === 'in-1h' ? { resetAt: Date.now() + HOUR } : {}) })) };
      await accounts.recordProviderAccountUsage('anthropic-oauth', id, usage);
    }
    if (row.blockMs) await accounts.blockProviderAccount('anthropic-oauth', id, Date.now() + row.blockMs, '', 'retry-after');
  }
}

// ---- the gate on its own ----------------------------------------------------------------------
const gate = [];
const gateCase = (name, provider, ref, extra = {}) => {
  const accountId = ref === '' ? '' : ref === 'nobody' ? 'nobody' : ids.get(ref);
  const now = extra.nowPlusMs ? Date.now() + extra.nowPlusMs : undefined;
  const instance = { name: provider, credentials: { accountId: `gate-${name}` } };
  const reason = cacheWarmAccountBlock(provider, instance, { accountId, model: MODEL, ...(now ? { now } : {}) });
  gate.push({ name, provider, ref, nowPlusMs: extra.nowPlusMs ?? 0, reason });
};
// The roster is empty and no reading is stored: the provider has nothing to judge by.
gateCase('empty roster, no stored reading', 'anthropic-oauth', '');
gateCase('a provider without a roster', 'anthropic', '');
await buildRoster();
gateCase('a fresh account', 'anthropic-oauth', 'ok');
gateCase('the account is unknown', 'anthropic-oauth', '');
gateCase('the account is not connected', 'anthropic-oauth', 'nobody');
gateCase('an account never measured', 'anthropic-oauth', 'unmeasured');
gateCase('a reading older than the roster trusts', 'anthropic-oauth', 'ok', { nowPlusMs: 2 * HOUR });
gateCase('a full window', 'anthropic-oauth', 'full');
gateCase('a blocked account', 'anthropic-oauth', 'blocked');

// ---- the whole send ---------------------------------------------------------------------------
// A real fetch rejects, and a real body errors, with the signal's reason once it aborts.
const whenAborted = (signal, fail) => {
  if (signal.aborted) fail(signal.reason);
  else signal.addEventListener('abort', () => fail(signal.reason), { once: true });
};
const responseOf = (spec, signal) => {
  if (spec.kind === 'throw') throw new Error(spec.message);
  if (spec.kind === 'status') return new Response(spec.body ?? '', { status: spec.status, headers: spec.headers ?? {} });
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of spec.chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (spec.kind === 'sse-hang') whenAborted(signal, (reason) => controller.error(reason));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
};
// The warm's own deadline timers are unref'd, so something must keep the process alive while a
// scenario waits on one.
const keepAlive = setInterval(() => {}, 1000);
const sends = [];
let serial = 0;
for (const scenario of SCENARIOS) {
  const accountId = scenario.ref === '' ? '' : ids.get(scenario.ref);
  const instance = { name: scenario.provider, credentials: { accountId: `send-${(serial += 1)}` } };
  const key = providerAdmissionKey(scenario.provider, instance);
  const runs = [];
  let posts = 0;
  for (let i = 0; i < (scenario.repeat ?? 1); i += 1) {
    const reports = [];
    const run = { reports };
    const controller = new AbortController();
    if (scenario.aborted) controller.abort(new Error('caller left'));
    if (scenario.abortAfterMs) setTimeout(() => controller.abort(), scenario.abortAfterMs);
    const response = scenario.responses[Math.min(i, scenario.responses.length - 1)];
    try {
      run.usage = await sendAnthropicCacheWarm({
        providerName: scenario.provider,
        instance,
        accountId,
        model: MODEL,
        opts: { signal: controller.signal },
        onUsage: (u) => reports.push(u),
        post: (signal) => {
          posts += 1;
          if (response.kind !== 'hang') return Promise.resolve(responseOf(response, signal));
          return new Promise((_resolve, reject) => whenAborted(signal, reject));
        },
      });
    } catch (error) {
      run.error = { message: error.message, code: error.code ?? null, status: error.status ?? null, providerErrorType: error.providerErrorType ?? null, usage: error.usage ?? null };
    }
    run.laneBlock = providerAdmissionScheduler.immediateBlock(key);
    runs.push(run);
  }
  if (posts !== scenario.posts) throw new Error(`${scenario.name}: ${posts} POSTs, expected ${scenario.posts}`);
  sends.push({ name: scenario.name, provider: scenario.provider, ref: scenario.ref, aborted: scenario.aborted ?? false, timed: scenario.timed ?? false, abortAfterMs: scenario.abortAfterMs ?? 0, responses: scenario.responses, runs, posts });
}
clearInterval(keepAlive);
writeJson(join(stage, 'golden.json'), { deadlines: { firstByteMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS, sseIdleMs: PROVIDER_SSE_IDLE_TIMEOUT_MS }, roster: ROSTER, gate, sends });
writeSetManifest(stage, { set: 'cache-warm-send', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
