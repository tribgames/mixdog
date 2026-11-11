#!/usr/bin/env node
// mimo-oauth-wire.test.mjs (19 tests): the real MimoOAuthProvider (and the Token Plan region probe) against a scripted local MiMo
// gateway. The gateway records each request as it arrived (header pairs in arrival order, parsed body), so the recorded requests are
// exactly what the product sent; its answers are scripted per case (held answers are released by arrival, not by time). Probe cases use
// the product's own `fetchImpl` injection point with a scripted fetch that records its calls. Virtual time: the one case with a
// transient 5xx moves the virtual clock to the retry timer (each step is recorded in `clockSteps`).
// The stream-wait widening case (:466) is recorded on the virtual clock (case widened-stream-waits-and-explicit-first-byte-allowance).
// Not recorded: the enrichment-supersession part of the stale-publish test (:~345-395: it drives the private `_inner._fetchModelItems` and a getter hook counting reads of `name`).
//   node benchmarks/rust-core/recorders/record-mimo-oauth-wire.mjs --tree <exact export of b6f10295a>
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { T0, startRecording } from './lib/provider-case-recorder.mjs';
import { gateway as startGateway, json } from './lib/scripted-gateway.mjs';

// A gateway this recorder starts is reached directly (its port is registered); every other address goes to the scripted endpoint.
let registerPort = () => {};
const gateway = async (respond) => {
  const gw = await startGateway(respond);
  registerPort(new URL(gw.baseUrl).port);
  return gw;
};
const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-mimo-oauth-wire',
  entry: 'src/runtime/agent/orchestrator/providers/mimo-oauth.mjs MimoOAuthProvider({ preconnect: false, ... }).send/.listModels/.isAvailable, mimo-oauth-tokens.mjs probeTokenPlanBaseUrl / ensureTokenPlanBaseUrl / loadTokens, mimo-oauth-profile.mjs chooseDefaultModel / SEED_MODELS, provider-catalog-cache.mjs providerCachedModelsSync, model-catalog.mjs getModelMetadataSync, runtime-core/effort.mjs effortOptionsFor, over a scripted loopback gateway (real fetch + the OpenAI SDK; credentials file MIMO_OAUTH_CREDENTIALS_PATH in the data directory). Not run: the private-hook supersession race of the stale-publish test (see the recorder header). The widened stream waits are recorded (widened-stream-waits-and-explicit-first-byte-allowance).',
  compare: 'mixdog-ai providers::compat (chat/options.rs, listing.rs, creds.rs, login/mimo.rs:51-107, error.rs:298-304, adapter.rs) and mixdog-ai catalog store.rs:201-205: replay each case\'s scripted answers and compare `requests` (method, url, header pairs, body) in order, the results/errors (message, status, reauthRequired, mimoGatewayCode), the cached roster and the credentials file. `requests[*].headers` are the headers the gateway received over the real client: host, connection, accept-encoding, accept-language, sec-fetch-mode and a `user-agent: node` come from undici, the rest from the product.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
  exclusions: ['result.persisted.mtimeMs of the token-plan probe case is the real modification time of a file the product rewrote, written as a marker (it is not part of the behaviour)', 'the n-th gateway of the recording listens on 127.0.0.1:47831+n (0-based, file order); the address appears literally in urls and stored credentials'],
});
// The declared header rule of lib/provider-case-recorder.mjs (the three SDK headers that carry the recording host are written as `<recording host <header name>>`) applies to every copy of a request the
// manifest names, including the request records a case result holds: the record is normalised when the endpoint receives it, whatever the case does with it afterwards.
{
  let scripted = null;
  Object.defineProperty(rec.net, 'reply', {
    configurable: true,
    get: () => scripted,
    set: (fn) => {
      scripted = fn && ((record, n) => {
        for (const pair of record.headers) if (/^x-stainless-(os|arch|runtime-version)$/i.test(pair[0])) pair[1] = `<recording host ${pair[0].toLowerCase()}>`;
        return fn(record, n);
      });
    },
  });
}
registerPort = rec.allowDirect;
const P = 'agent/orchestrator/providers/';
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(rec.dataDir, 'mimo-oauth.json');
const { MimoOAuthProvider } = await rec.P(`${P}mimo-oauth.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { effortOptionsFor } = await rec.P('agent/orchestrator/runtime-core/effort.mjs');
const { consumeCompatChatCompletionStream } = await rec.P(`${P}openai-compat-stream.mjs`);
const { loadTokens, ensureTokenPlanBaseUrl, probeTokenPlanBaseUrl, TOKEN_PLAN_BASE_URLS } = await rec.P(`${P}mimo-oauth-tokens.mjs`);
const profile = await rec.P(`${P}mimo-oauth-profile.mjs`);
const { providerCachedModelsSync } = await rec.P(`${P}provider-catalog-cache.mjs`);
const { getModelMetadataSync } = await rec.P(`${P}model-catalog.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/mimo-oauth-wire.test.mjs';
const realSetImmediate = setImmediate;

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OK_STREAM = chunk({ role: 'assistant', reasoning_content: 'thinking' }) + chunk({ content: 'done' }) + chunk({}, 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
const streamOk = (_req, _body, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(OK_STREAM);
};
const credentialsPath = process.env.MIMO_OAUTH_CREDENTIALS_PATH;
// Each write gets its own fixed modification time (the product keys its token cache on mtime, so successive writes must differ).
let signIns = 0;
const signIn = (baseUrl, apiKey = 'sk-wire') => {
  writeFileSync(credentialsPath, JSON.stringify({ apiKey, uid: 'u', baseUrl }));
  utimesSync(credentialsPath, 1_700_000_000 + ++signIns, 1_700_000_000 + signIns);
};
const newProvider = (config = {}) => new MimoOAuthProvider({ preconnect: false, ...config });
const chatRequests = (gw) => gw.requests.filter((r) => r.url.endsWith('/chat/completions'));
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};
// One case against a gateway (127.0.0.1:47831 + the gateway's number).
const withGateway = async (respond, fn) => {
  const gw = await gateway(respond);
  try {
    const out = await fn(gw);
    return { ...out, requests: gw.requests };
  } finally {
    gw.close();
  }
};
const hi = [{ role: 'user', content: 'hi' }];
// The token file's modification time is the real file system's clock, not the virtual one: written as a marker.
// The token file the product itself rewrites carries the real modification time of that write: a marker at result.persisted.mtimeMs.
const stamped = (tokens) => ({ ...tokens, mtimeMs: '<token file mtime (real clock)>' });
const HISTORY = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }], reasoningContent: 'plan the read' },
  { role: 'tool', toolCallId: 'call_1', content: 'file text' },
];
const TOOLS = [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }];
const signedIn = (gw, key) => (signIn(gw.baseUrl, key), { credentials: { apiKey: key ?? 'sk-wire', uid: 'u', baseUrl: gw.baseUrl } });

await rec.run('replays-stored-reasoning-never-invents', `${SRC}:77`, { history: HISTORY, tools: TOOLS }, () => withGateway(streamOk, async (gw) => {
  signIn(gw.baseUrl);
  const provider = newProvider();
  const first = await provider.send(HISTORY, 'mimo-v2.6-pro', TOOLS, {});
  const bare = HISTORY.map(({ reasoningContent: _drop, ...m }) => m);
  const second = await provider.send(bare, 'mimo-v2.6-pro', TOOLS, {});
  return { first, second };
}));
await rec.run('effort-maps-to-thinking-and-levels', `${SRC}:97`, { efforts: [{ effort: 'minimal' }, { effort: 'xhigh' }, { effort: 'none' }, { thinking: false }, {}] }, () =>
  withGateway((req, body, res) => (req.url.endsWith('/models') ? json(res, 200, { data: [{ id: 'mimo-v2.6-pro' }] }) : streamOk(req, body, res)), async (gw) => {
    signIn(gw.baseUrl);
    const provider = newProvider();
    for (const opts of [{ effort: 'minimal' }, { effort: 'xhigh' }, { effort: 'none' }, { thinking: false }, {}]) await provider.send(hi, 'mimo-v2.6-pro', [], opts);
    const [row] = await provider.listModels();
    return { row, effortOptions: effortOptionsFor('mimo-oauth', row) };
  }));
await rec.run('sampling-defaults-output-clamp-tool-choice', `${SRC}:125`, {}, () =>
  withGateway((req, body, res) => (req.url.endsWith('/models') ? json(res, 200, { data: [{ id: 'mimo-small', max_output_tokens: 64000, context_window: 100000 }] }) : streamOk(req, body, res)), async (gw) => {
    signIn(gw.baseUrl);
    const provider = newProvider();
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, {});
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { temperature: 0.2, maxOutputTokens: 500, toolChoice: 'required' });
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { toolChoice: { name: 'read' } });
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { toolChoice: 'none' });
    await provider.send(hi, 'mimo-v2.6-pro', [], { toolChoice: 'required' });
    await provider.listModels();
    await provider.send(hi, 'mimo-small', [], {});
    return {};
  }));
await rec.run('default-model-from-discovered-roster', `${SRC}:164`, {}, async () => {
  let roster = [{ id: 'mimo-v2.5' }, { id: 'mimo-v2.6-pro' }];
  return withGateway((req, body, res) => (req.url.endsWith('/models') ? json(res, 200, { data: roster }) : streamOk(req, body, res)), async (gw) => {
    signIn(gw.baseUrl);
    await newProvider().send(hi, undefined, [], {});
    roster = [{ id: 'mimo-v2.5-tts' }, { id: 'mimo-x' }, { id: 'mimo-y' }];
    signIn(gw.baseUrl, 'sk-other');
    await newProvider().send(hi, undefined, [], {});
    roster = [];
    signIn(gw.baseUrl, 'sk-third');
    await newProvider().send(hi, undefined, [], {});
    return { models: chatRequests(gw).map((r) => r.body.model), chooseDefault: [profile.chooseDefaultModel(['a-asr', 'mimo-z']), profile.chooseDefaultModel([])] };
  });
});
await rec.run('discovery-drops-speech-keeps-names-seed-fallback', `${SRC}:195`, {}, async () => {
  let mode = 'ok';
  return withGateway((req, _body, res) => {
    if (mode === 'down') return json(res, 500, { error: { message: 'boom' } });
    json(res, 200, { data: mode === 'empty' ? [] : [{ id: 'mimo-v2.6-pro', display_name: 'MiMo Pro' }, { id: 'mimo-v2.5-tts' }, { id: 'mimo-v2-asr' }, { id: 'mimo-v2.6-flash', context_window: 5000, max_output_tokens: 700 }] });
  }, async (gw) => {
    signIn(gw.baseUrl);
    const rows = await newProvider().listModels();
    const cached = providerCachedModelsSync('mimo-oauth');
    const metadata = { flashContext: getModelMetadataSync('mimo-v2.6-flash', 'mimo-oauth').contextWindow, proContext: getModelMetadataSync('mimo-v2.6-pro', 'mimo-oauth').contextWindow };
    const fallbacks = {};
    for (mode of ['empty', 'down']) fallbacks[mode] = await newProvider().listModels();
    return { rows, cached, metadata, fallbacks };
  });
});
await rec.run('stale-or-other-credential-discovery-not-published', `${SRC}:242`, {}, async () => {
  const held = [];
  const gw = await gateway((_req, _body, res) => held.push(res));
  const answer = (i, id) => json(held[i], 200, { data: [{ id, context_window: 7000 }] });
  const cachedModels = () => providerCachedModelsSync('mimo-oauth');
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const older = provider.listModels();
    await gw.arrived(1);
    const newer = provider.listModels();
    await gw.arrived(2);
    answer(1, 'mimo-v2.6-flash');
    const newerRows = await newer;
    answer(0, 'mimo-v2.6-pro');
    const olderRows = await older;
    const afterOlder = { cachedModels: cachedModels(), liveModels: provider._inner._enrichedModels, rosterItems: provider._rosterItems };
    const switched = provider.listModels();
    await gw.arrived(3);
    signIn(gw.baseUrl, 'sk-other');
    answer(2, 'mimo-v2.6-pro');
    const switchedRows = await switched;
    const afterSwitch = { cachedModels: cachedModels(), liveModels: provider._inner._enrichedModels, rosterItems: provider._rosterItems };
    // Supersession during catalog enrichment (after the fetch settled): `name` is read once more right after enrichment finishes, and the
    // test hooks that read (private _inner members) to supersede the request at exactly that point.
    signIn(gw.baseUrl);
    const base = provider.listModels();
    await gw.arrived(4);
    answer(3, 'mimo-v2.6-flash');
    await base;
    const inner = provider._inner;
    const afterBase = { innerModels: inner._enrichedModels, rosterItems: provider._rosterItems };
    const innerName = inner.name;
    let onEnriched = null;
    let reads = 0;
    Object.defineProperty(inner, 'name', { configurable: true, get() { if (onEnriched && ++reads === 2) onEnriched(); return innerName; } });
    const duringEnrichment = async (action, heldIndex) => {
      reads = 0;
      onEnriched = action;
      const pending = provider.listModels();
      await gw.arrived(heldIndex + 1);
      answer(heldIndex, 'mimo-v2.6-pro');
      const got = await pending;
      onEnriched = null;
      return got;
    };
    let newerFetch;
    const gotOlder = await duringEnrichment(() => { newerFetch = inner._fetchModelItems({}); }, 4);
    await gw.arrived(6);
    answer(5, 'mimo-v2.6-flash');
    await newerFetch;
    const afterNewerClaimed = { innerModels: inner._enrichedModels, rosterItems: provider._rosterItems };
    const gotSwitched = await duringEnrichment(() => signIn(gw.baseUrl, 'sk-other'), 6);
    const afterKeySwitchedDuringEnrichment = { innerModels: inner._enrichedModels, rosterItems: provider._rosterItems };
    return { order: 'request 2 answered first, then request 1; then the key switches while request 3 is in flight; then supersession during enrichment', newerRows, olderRows, afterOlder, switchedRows, afterSwitch, afterBase, gotOlder, afterNewerClaimed, gotSwitched, afterKeySwitchedDuringEnrichment, requests: gw.requests };
  } finally {
    gw.close();
  }
});
// WIRE: the product's own default fetch (redirected to the loopback endpoint) makes the regional probes; the endpoint's answer for request n is the scripted behaviour
// (1: the connection is reset, 2: HTTP 401, then 200); the probes that arrived are `requests` of the case (URL, Authorization header, body).
const ok200 = { status: 200, contentType: 'application/json', body: '{}' };
await rec.run('token-plan-probe-sgp-ams-cn-persists', `${SRC}:360`, { answers: ['connection reset', '401 {"error":"denied"}', '200 {}'], then: ['persist through ensureTokenPlanBaseUrl', 'no probe for a non-token-plan key or a known URL', 'a 500 answer'] }, async ({ net }) => {
  net.reply = (_record, n) => (n === 1 ? { destroy: true } : n === 2 ? { status: 401, contentType: 'application/json', body: '{"error":"denied"}' } : ok200);
  const probed = await probeTokenPlanBaseUrl('tp-abc');
  const first = { probed, regions: TOKEN_PLAN_BASE_URLS };
  signIn('', 'tp-abc');
  const before = net.records.length;
  net.reply = (_record, n) => (n === before + 1 ? { destroy: true } : n === before + 2 ? { status: 401, contentType: 'application/json', body: '{"error":"denied"}' } : ok200);
  const tokens = await ensureTokenPlanBaseUrl(loadTokens());
  const persisted = loadTokens();
  const afterEnsure = net.records.length;
  await ensureTokenPlanBaseUrl({ apiKey: 'sk-1', uid: '', baseUrl: '' });
  await ensureTokenPlanBaseUrl({ apiKey: 'tp-1', uid: '', baseUrl: 'https://x.test/v1' });
  const probesForNonTokenPlanOrKnownUrl = net.records.length - afterEnsure;
  net.reply = () => ({ status: 500, contentType: 'text/plain', body: 'nope' });
  const nonAuth = await attempt(probeTokenPlanBaseUrl('tp-abc'));
  return { first, ensured: tokens, persisted: stamped(persisted), probesForNonTokenPlanOrKnownUrl, nonAuth };
});
await rec.run('caller-cannot-move-mimo-to-responses', `${SRC}:382`, { opts: { compatWireApi: 'responses', responsesTransport: 'ws' } }, () => withGateway(streamOk, async (gw) => {
  signIn(gw.baseUrl);
  await newProvider().send(hi, 'mimo-v2.6-pro', [], { compatWireApi: 'responses', responsesTransport: 'ws' });
  return {};
}));
await rec.run('session-affinity-and-user-agent-headers', `${SRC}:399`, {}, () => withGateway(streamOk, async (gw) => {
  signIn(gw.baseUrl, 'sk-hdr');
  const provider = newProvider();
  await provider.send(hi, 'mimo-v2.6-pro', [], { sessionId: 'sess-1', parentSessionId: 'sess-0' });
  await provider.send(hi, 'mimo-v2.6-pro', [], { sessionId: 'sess-2', ephemeral: true });
  return {};
}));
await rec.run('gateway-failures-keep-detail-relabel-quota-not-retried', `${SRC}:452`, {}, async () => {
  let reply = null;
  return withGateway((_req, _body, res) => reply(res), async (gw) => {
    signIn(gw.baseUrl, 'sk-secret-key');
    const provider = newProvider();
    const out = {};
    reply = (res) => json(res, 400, { error: { code: 441, message: 'generic', param: 'prompt flagged' } });
    out.risk441 = await attempt(provider.send(hi, 'm', [], {}));
    reply = (res) => json(res, 400, { error: { code: '421', message: 'x' } });
    out.moderation421 = await attempt(provider.send(hi, 'm', [], {}));
    reply = (res) => json(res, 400, { error: { code: 'bad', message: 'plain text', param: 'temperature' } });
    out.plain400 = await attempt(provider.send(hi, 'm', [], {}));
    reply = (res) => json(res, 401, { error: { message: 'key sk-secret-key is revoked' } });
    out.unauthorized401 = await attempt(provider.send(hi, 'm', [], {}));
    out.keyInMessage = JSON.stringify(out.unauthorized401.error.message).includes('sk-secret-key');
    const before = gw.requests.length;
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ error: { code: 'insufficient_quota', message: 'out of quota' } })}\n\ndata: [DONE]\n\n`);
    };
    out.quota = await attempt(provider.send(hi, 'm', [], {}));
    out.quotaRequests = gw.requests.length - before;
    return out;
  });
});
await rec.run('plain-compat-provider-no-mimo-sampling-defaults', `${SRC}:488`, {}, () => withGateway(streamOk, async (gw) => {
  const plain = new OpenAICompatProvider('deepseek', { baseURL: gw.baseUrl, apiKey: 'k', preconnect: false });
  await plain.send(hi, 'deepseek-chat', [], {});
  return {};
}));
await rec.run('regional-probe-continues-past-failure', `${SRC}:499`, { answers: ['503 busy', '200 {}'], then: ['every region 503', 'a pre-aborted signal'] }, async ({ net }) => {
  net.reply = (_record, n) => (n === 1 ? { status: 503, contentType: 'text/plain', body: 'busy' } : ok200);
  const probed = await probeTokenPlanBaseUrl('tp-abc');
  net.reply = () => ({ status: 503, contentType: 'text/plain', body: 'gone' });
  const down = await attempt(probeTokenPlanBaseUrl('tp-abc'));
  const ctl = new AbortController();
  ctl.abort();
  const aborted = await attempt(probeTokenPlanBaseUrl('tp-abc', { signal: ctl.signal }));
  return { probed, down, aborted };
});
await rec.run('topP-topK-forwarded', `${SRC}:521`, {}, () => withGateway(streamOk, async (gw) => {
  signIn(gw.baseUrl);
  const provider = newProvider();
  await provider.send(hi, 'mimo-v2.6-pro', [], { topP: 0.9, topK: 40 });
  await provider.send(hi, 'mimo-v2.6-pro', [], {});
  return {};
}));
await rec.run('seeds-ultraspeed-lineage-limits', `${SRC}:538`, {}, () => withGateway((req, body, res) => (req.url.endsWith('/models') ? json(res, 200, { data: [{ id: 'mimo-v2.6-pro-ultraspeed' }, { id: 'mimo-v2.6-flash-20260101' }, { id: 'other' }] }) : streamOk(req, body, res)), async (gw) => {
  signIn(gw.baseUrl);
  return { seedUltraspeed: profile.SEED_MODELS.find((m) => m.id === 'mimo-v2.6-pro-ultraspeed'), rows: await newProvider().listModels() };
}));
await rec.run('org-project-env-never-sent', `${SRC}:561`, { env: { OPENAI_ORG_ID: 'org-x', OPENAI_PROJECT_ID: 'proj-x' } }, () => withGateway(streamOk, async (gw) => {
  process.env.OPENAI_ORG_ID = 'org-x';
  process.env.OPENAI_PROJECT_ID = 'proj-x';
  try {
    signIn(gw.baseUrl);
    await newProvider().send(hi, 'mimo-v2.6-pro', [], {});
  } finally {
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
  }
  return {};
}));
await rec.run('three-regional-401s-typed-reauth', `${SRC}:578`, {}, async () => {
  // The regional probes are real requests to the product\'s regional hosts, answered by the loopback endpoint (no injected fetch): 401 on every host, then 503.
  const net = rec.net;
  net.reply = () => ({ status: 401, contentType: 'application/json', body: '{"error":{"message":"bad key tp-secret"}}' });
  const out = { three401: await attempt(probeTokenPlanBaseUrl('tp-secret')) };
  net.reply = () => ({ status: 503, contentType: 'text/plain', body: 'x' });
  out.busy = await attempt(probeTokenPlanBaseUrl('tp-secret'));
  net.reply = () => ({ status: 401, contentType: 'application/json', body: '{"error":{"message":"bad key tp-secret"}}' });
  signIn('https://api.xiaomimimo.com/v1', 'tp-secret');
  const provider = newProvider();
  out.send = await attempt(provider.send(hi, 'm', [], {}));
  out.list = await attempt(provider.listModels());
  return out;
});
await rec.run('stored-key-redacted-in-logs-and-400', `${SRC}:615`, { key: 'sk-very-secret-key-123' }, async () => {
  const KEY = 'sk-very-secret-key-123';
  let n = 0;
  return withGateway((req, _body, res) => {
    if (req.url.endsWith('/models')) return json(res, 200, { data: [] });
    n += 1;
    if (n === 1) return json(res, 503, { error: { message: `upstream rejected ${KEY}` } });
    if (n === 2) return streamOk(req, _body, res);
    return json(res, 400, { error: { message: `bad request for ${KEY}`, param: `key ${KEY}` } });
  }, async (gw) => {
    signIn(gw.baseUrl, KEY);
    const provider = newProvider();
    // The 503 is retried after the product's backoff timer: the virtual clock is moved to the earliest armed timer (recorded) until the retry arrives.
    const lines = [];
    const original = process.stderr.write;
    process.stderr.write = (c, ...rest) => (lines.push(String(c)), typeof rest.at(-1) === 'function' ? rest.at(-1)() : true);
    let first;
    try {
      // The 503 is retried after the product's backoff timer: the virtual clock follows each retry sleep (every step is in the recorded clock trace) until the send ends; the wait for the timer is woken by its arming, with the case deadline.
      first = await rec.clock.followRetries(provider.send(hi, 'mimo-v2.6-pro', [], {}), { what: 'mimo 503 retry backoff' });
    } finally {
      process.stderr.write = original;
    }
    const stderr = lines.join('');
    const err = await provider.send(hi, 'mimo-v2.6-pro', [], {}).catch((e) => e);
    return { first, stderr, keyInStderr: stderr.includes(KEY), err, keyInError: JSON.stringify([err.message, err.error, err.mimoGatewayParam]).includes(KEY) };
  });
});
await rec.run('probe-finishing-after-newer-sign-in-does-not-overwrite', `${SRC}:644`, {}, async () => {
  signIn('https://api.xiaomimimo.com/v1', 'tp-old');
  // The probe is a real request to the loopback endpoint; the newer sign-in is made while that request is in flight (the response cannot arrive before this synchronous call returns).
  rec.net.reply = () => ({ status: 200, contentType: 'application/json', body: '{}' });
  const pending = ensureTokenPlanBaseUrl(loadTokens());
  signIn('https://new.example/v1', 'sk-new');
  await pending;
  return { stored: loadTokens() };
});
await rec.run('deleted-token-file-signs-out', `${SRC}:662`, {}, () => withGateway(streamOk, async (gw) => {
  signIn(gw.baseUrl);
  const provider = newProvider();
  await provider.send(hi, 'mimo-v2.6-pro', [], {});
  rmSync(credentialsPath);
  const after = await attempt(provider.send(hi, 'mimo-v2.6-pro', [], {}));
  return { after, tokens: provider.tokens, available: await provider.isAvailable() };
}));
await rec.run('abort-during-regional-probe-is-cancellation', `${SRC}:684`, {}, async () => {
  signIn('https://api.xiaomimimo.com/v1', 'tp-abort');
  const ctl = new AbortController();
  const reason = new Error('caller cancelled');
  reason.name = 'CallerCancel';
  // The first regional probe is answered 503, the second is accepted and never answered; the caller cancels once the second request has arrived (an event wait with the case deadline).
  rec.net.reply = (_record, n) => (n === 1 ? { status: 503, contentType: 'application/json', body: '{}' } : { status: 200, contentType: 'application/json', chunks: [], hold: true });
  const provider = newProvider();
  const sent = provider.send(hi, 'm', [], { signal: ctl.signal }).catch((e) => e);
  await rec.clock.advance(0, { until: () => rec.net.records.length >= 2, what: 'the second regional probe arrived' });
  ctl.abort(reason);
  const err = await sent;
  const urls = rec.net.records.map((record) => record.origin + record.path);
  return { error: err, isTheCallersReason: err === reason, urls };
});
await rec.run('widened-stream-waits-and-explicit-first-byte-allowance', `${SRC}:466`, { gateway: 'answers 200 with the SSE head and never writes a body byte', clock: 'every armed timer in due order until the send ends', plainSend: { provider: 'deepseek', model: 'deepseek-chat' } }, async () => {
  const stall = await rec.P('agent/orchestrator/stall-policy.mjs');
  const policy = { shared: { PROVIDER_FIRST_BYTE_TIMEOUT_MS: stall.PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS: stall.PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS }, mimo: { MIMO_FIRST_BYTE_TIMEOUT_MS: profile.MIMO_FIRST_BYTE_TIMEOUT_MS, MIMO_SEMANTIC_IDLE_TIMEOUT_MS: profile.MIMO_SEMANTIC_IDLE_TIMEOUT_MS, MIMO_CHAT_PROFILE: profile.MIMO_CHAT_PROFILE } };
  // WIRE: the MiMo provider sends to a gateway that answers 200 with the SSE head and never writes a body byte; the virtual clock moves to every timer the send arms (its widened first-byte wait, then its retries) until the send ends.
  const stalled = await withGateway((_req, _body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }, async (silentGw) => {
    signIn(silentGw.baseUrl);
    const settled = newProvider().send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], {}).then((response) => ({ response }), (error) => ({ error }));
    return rec.clock.followRetries(settled, { sites: /./, what: 'mimo widened stream waits' });
  });
  const gw = await gateway(streamOk);
  try {
    const plain = new OpenAICompatProvider('deepseek', { baseURL: gw.baseUrl, apiKey: 'k', preconnect: false });
    await plain.send([{ role: 'user', content: 'hi' }], 'deepseek-chat', [], {});
    return { policy, stalled, plainSendRequests: gw.requests };
  } finally {
    gw.close();
  }
});
await rec.finish({ clockStartMs: T0 });
