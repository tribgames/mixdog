#!/usr/bin/env node
// The initial-response window of the OpenAI HTTP/SSE request (`PROVIDER_HTTP_RESPONSE_TIMEOUT_MS`, stall-policy.mjs:98), recorded from Node's own
// `openHttpSseResponse` (openai-http-sse-request.mjs) on both routes (the API key's and the OAuth one) with the virtual clock: a request that never gets
// an answer, the clock moved to one tick before the armed timer (nothing happened) and then onto it. The recording says how long the timer was armed for
// and what the request rejected with. Node reads the setting when its modules load, so every case imports a fresh copy of the two modules that hold it
// (`?gen=<n>` on stall-policy.mjs and openai-http-sse-request.mjs) after the case's environment is set.
// Cases: unset, smaller than the default, larger than the default, below the 10 s floor, above the ceiling, invalid values, and a `STALL_TIMEOUT_S`
// that moves the ceiling (`PROVIDER_MAX_BEFORE_WARN_MS`).
//   node benchmarks/rust-core/recorders/record-provider-http-response-timeout.mjs --tree <exact export of b6f10295a> [--only <case id>]
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-http-response-timeout',
  net: false,
  pure: { '*': 'native/core/crates/mixdog-ai/src/providers/google/cache/policy.rs:87 http_response_ms' },
  exclusions: [
    'the fetch of the request is a stand-in that never answers and rejects with its signal\'s reason when the signal aborts (undici\'s behaviour for an aborted fetch): the timer, its window and its error are Node\'s; nothing goes over a socket, so no request is recorded',
    'after the first attempt\'s timer fires the stand-in aborts the call\'s total signal, so Node\'s retry of a transient failure is not followed (the retry path is not the subject); `result` is the first attempt',
  ],
  entry: 'src/runtime/agent/orchestrator/providers/openai-http-sse-request.mjs openHttpSseResponse (fetchFn stood in), with stall-policy.mjs PROVIDER_HTTP_RESPONSE_TIMEOUT_MS read at module load',
  compare: 'mixdog-ai providers::openai::adapter tests: per case, the window the adapter gives its HTTP request (the setting read from the context when the adapter is built) and the text of the rejection, compared with `result.armedForMs` and `result.error.message`.',
  replay: 'Rust: OpenAiAdapter::attempt over a transport that never answers (TimingOut), its context carrying the recorded setting.',
});

register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const gen = context.parentURL && new URL(context.parentURL).searchParams.get('gen');
  if (!gen || !(resolved.url.includes('/stall-policy.mjs') || resolved.url.includes('/openai-http-sse-request.mjs'))) return resolved;
  return { ...resolved, url: resolved.url.split('?')[0] + '?gen=' + gen };
}`)}`);

const entryUrl = pathToFileURL(join(rec.tree, 'src/runtime/agent/orchestrator/providers/openai-http-sse-request.mjs')).href;
const SOURCE = 'openai-http-sse-request.mjs:101';
const SETTING = 'MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS';
const STALL = 'STALL_TIMEOUT_S';
const ROUTES = { direct: { type: 'openai-direct' }, oauth: { type: 'openai-oauth' } };
const SETTINGS = [
  ['unset', null], ['smaller', '10000'], ['larger', '120000'], ['below-floor', '5000'], ['above-ceiling', '900000'],
  ['invalid-text', 'bogus'], ['invalid-zero', '0'], ['invalid-negative', '-5'], ['empty', ''], ['exponent', '1e4'], ['padded', ' 20000 '],
];
const STALLS = [['stall-100s-larger', '120000', '100'], ['stall-20s', '30000', '20'], ['stall-invalid', '30000', 'soon']];

const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) (v === null ? delete process.env[k] : (process.env[k] = v));
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};

let gen = 0;
const timeoutCase = (id, route, setting, stall) => rec.run(id, SOURCE, { route, setting, [STALL]: stall }, ({ clock }) => withEnv({ [SETTING]: setting, [STALL]: stall }, async () => {
  const { openHttpSseResponse } = await import(`${entryUrl}?gen=${++gen}`);
  const total = new AbortController();
  const fetched = [];
  let rejectedAtMs = null;
  const fetchFn = (_url, init) => new Promise((_, reject) => {
    fetched.push(Date.now() - rec.T0);
    init.signal.addEventListener('abort', () => {
      rejectedAtMs = Date.now() - rec.T0;
      total.abort(new Error('recorder: first attempt over'));
      reject(init.signal.reason);
    }, { once: true });
  });
  const outcome = openHttpSseResponse({ auth: ROUTES[route], body: {}, headers: {}, poolKey: 'k', turnId: 't', useModel: 'gpt-fixture', fetchFn, totalTimeout: { signal: total.signal, cleanup() {} }, onStageChange() {} })
    .then(() => ({ answered: true }), (error) => ({ error }));
  await clock.until(() => clock.pendingFrom(/createTimeoutSignal/).length > 0, 'the initial-response timer armed');
  const [timer] = clock.pendingFrom(/createTimeoutSignal/);
  const armedForMs = timer.due - (Date.now() - rec.T0);
  await clock.advance(armedForMs - 1);
  const rejectedBefore = rejectedAtMs !== null;
  await clock.advance(1, { until: () => rejectedAtMs !== null, what: 'the initial-response timer firing' });
  const { error } = await outcome;
  return { fetchedAtMs: fetched, armedForMs, rejectedBeforeTheTimer: rejectedBefore, rejectedAtMs, error: { name: error.name, message: error.message, code: error.code } };
}));

for (const route of Object.keys(ROUTES)) {
  for (const [name, value] of SETTINGS) await timeoutCase(`${route}:${name}`, route, value, null);
  for (const [name, value, stall] of STALLS) await timeoutCase(`${route}:${name}`, route, value, stall);
}
await rec.finish();
