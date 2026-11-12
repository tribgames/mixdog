#!/usr/bin/env node
// The environment switches of the OpenAI and Antigravity wires, recorded from Node's own sends with the transport captured (the whole request as
// it arrived at the loopback endpoint: method, path, every header in arrival order, the body bytes; over the WebSocket the upgrade request and
// every frame):
//   MIXDOG_OAI_STATELESS_HTTP           the OpenAI OAuth provider's HTTP/SSE send (`sendViaHttpSse`, `_buildOpenAIHttpFallbackHeaders`)
//   MIXDOG_OAI_DISABLE_REASONING_REPLAY the same send, with an assistant turn that carries encrypted reasoning in its history
//   MIXDOG_OAI_TRANSPORT                the public OpenAI provider's WebSocket send, two turns of one session (`ws-full`, `ws-delta`, an invalid value, unset)
//   MIXDOG_ANTIGRAVITY_FC_MODE          the Antigravity provider's send with a tool
// Every case is ONE provider instance sent several times, the setting changed between the sends: the order of the sends and the value of each are the
// input, so a recording also shows WHEN Node reads a setting (on every send, not once at construction): each send's requests carry its own value.
//   node benchmarks/rust-core/recorders/record-provider-env-switches.mjs --tree <exact export of b6f10295a> [--only <case id>]
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-env-switches',
  net: true,
  pure: {},
  exclusions: [
    'the Sec-WebSocket-Key and x-client-request-id values of every `upgrade-request` event: random per connection, written as the markers <handshake-nonce> and <random:hex32> (lib/headers.mjs), the headers stay. The x-client-request-id of an HTTP request is a seeded draw of the recorder\'s deterministic world and is kept as sent; a replay supplies its own id and compares the two as <random:hex32>',
    'HTTP cases: the answer the endpoint gives is scripted (one completed Responses stream, one Gemini stream); the sends only exist to put their request on the wire, and what the provider returned is not recorded',
    'HTTP cases: the GET requests in `requests` (the provider\'s background catalog refreshes: its models list, the price table, the Antigravity manifest) are recorded but not compared, and their position among the POSTs is a race; a replay compares the POST requests in recorded order, one per setting',
    'HTTP cases: the request headers the Node HTTP client adds under the product\'s own (host, connection, accept-language, sec-fetch-mode, accept-encoding, content-length) are recorded and not compared: the Rust transport adds its own',
    'HTTP cases: the OAuth provider\'s User-Agent carries the recording host\'s OS and architecture; a replay builds its client identity from the recorded value',
    'oai-transport-ws: the events of the case in `result.events` (setting markers, the upgrade requests, every frame both ways, closes); a replay compares per setting the upgrade requests and the client->server frames in recorded order; the server side is its script, the Sec-WebSocket-* headers, Connection, Upgrade and Host are the WebSocket client library\'s and are not compared',
  ],
  maskRow: (row) => {
    for (const event of row.result?.events ?? []) {
      if (event.event !== 'upgrade-request') continue;
      for (const header of event.headers) {
        if (header[0] === 'Sec-WebSocket-Key') header[1] = '<handshake-nonce>';
        else if (header[0] === 'x-client-request-id') header[1] = '<random:hex32>';
      }
    }
  },
  entry: 'src/runtime/agent/orchestrator/providers/openai-oauth.mjs OpenAIOAuthProvider#send (HTTP/SSE), openai-ws.mjs OpenAIDirectProvider#send (WebSocket), antigravity-oauth.mjs AntigravityOAuthProvider#send',
  compare: 'mixdog-ai tests/it/openai_env_switches.rs (HTTP bodies and headers of the OAuth provider), registry/builder/tests.rs (the WebSocket frames of the transport switch), providers/google/codec.rs tests (the Antigravity request): per case, the requests of each send compared whole with the recording.',
  replay: 'Rust: OpenAiCodec::encode, the OpenAI adapter over a scripted dial, GoogleCodec::encode.',
});
const P = 'agent/orchestrator/providers/';
const j = JSON.stringify;
const FAR = rec.T0 + 10 * 365 * 24 * 3600 * 1000;
const SYSTEM = { role: 'system', content: 'You are a fixture assistant.' };
const USER = { role: 'user', content: 'Look up the answer.' };
const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const sse = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${j(e)}\n\n`).join('');
const completed = (id) => [
  { type: 'response.created', response: { id, model: 'gpt-fixture' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'The result is 42.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] } },
  { type: 'response.completed', response: { id, model: 'gpt-fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] }] } },
];
const geminiStream = sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'The result is 42.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }, modelVersion: 'fixture' }]);
const oauthDoc = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: FAR, account_id: 'acct-fixture', email: 'fixture@example.invalid' };

// Runs `fn` with the process setting `name` set to `value` (null: unset), then puts the previous value back.
const withSetting = async (name, value, fn) => {
  const saved = process.env[name];
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
};
const settled = (promise) => promise.then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error).slice(0, 200) }));

// One provider instance, one send per setting value; the result says which of the case's recorded requests each send made.
const httpCase = (id, source, { switchName, values, make, model, tools, messages, sendOpts = {}, env = {}, setup, answer }) => rec.run(id, source, { switch: switchName, settings: values, model, messages, tools, sendOpts, env }, async ({ net }) => {
  setup?.();
  net.reply = (record) => (record.method === 'GET' ? { status: 200, contentType: 'application/json', body: j({ object: 'list', data: [] }) } : { status: 200, contentType: 'text/event-stream', body: answer });
  const provider = await make();
  const sends = [];
  Object.assign(process.env, env);
  try {
    for (const value of values) {
      const from = net.records.length;
      const outcome = await withSetting(switchName, value, () => settled(provider.send(messages, model, tools, sendOpts)));
      sends.push({ setting: value, firstRequest: from, requests: net.records.length - from, ...outcome });
    }
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
  return { sends };
});

const STATELESS = [null, '1', 'true', 'yes', 'on', ' ON ', '0', 'false', 'off', 'no', 'bogus', ''];
const oauthProvider = async () => new (await rec.P(`${P}openai-oauth.mjs`)).OpenAIOAuthProvider({});
const oauthSetup = () => rec.write('openai-oauth.json', j(oauthDoc));
await httpCase('oai-stateless-http', 'openai-oauth-http-sse.mjs:146', { switchName: 'MIXDOG_OAI_STATELESS_HTTP', values: STATELESS, make: oauthProvider, setup: oauthSetup, model: 'gpt-fixture', tools: TOOLS, messages: [SYSTEM, USER], sendOpts: { sessionId: 'env-session' }, env: { MIXDOG_OAI_TRANSPORT: 'http-sse' }, answer: sse(completed('resp_http'), true) });

const { createProviderReplay } = await rec.raw(`${P}lib/provider-replay.mjs`);
const reasoned = createProviderReplay('openai-responses', [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-REASONING', summary: [] },
  { type: 'message', id: 'm0', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer.' }] },
]);
const HISTORY = [SYSTEM, { role: 'user', content: 'Before.' }, { role: 'assistant', content: 'Earlier answer.', providerReplay: reasoned }, { role: 'user', content: 'More.' }];
await httpCase('oai-disable-reasoning-replay', 'openai-responses-payload.mjs:159', { switchName: 'MIXDOG_OAI_DISABLE_REASONING_REPLAY', values: [null, '1', 'true', 'yes', 'on', '0', 'false', 'off', 'bogus', ''], make: oauthProvider, setup: oauthSetup, model: 'gpt-fixture', tools: TOOLS, messages: HISTORY, sendOpts: { sessionId: 'env-session' }, env: { MIXDOG_OAI_TRANSPORT: 'http-sse' }, answer: sse(completed('resp_http'), true) });

await httpCase('antigravity-fc-mode', 'antigravity-request.mjs:36', {
  switchName: 'MIXDOG_ANTIGRAVITY_FC_MODE',
  values: [null, 'any', 'ANY', ' Auto ', 'auto', 'AUTO', 'validated', 'bogus', ''],
  make: async () => new (await rec.P(`${P}antigravity-oauth.mjs`)).AntigravityOAuthProvider({}),
  setup: () => rec.write('antigravity-oauth.json', j({ ...oauthDoc, project_id: 'fixture-project' })),
  model: 'gemini-3-pro', tools: TOOLS, messages: [SYSTEM, USER], answer: geminiStream,
});

// The public provider over a real loopback WebSocket: two turns of one session per setting, the second extending the first with what the first returned.
const world = await rec.wsWorld();
const AGAIN = 'And again.';
const wsCase = (id, source, values) => rec.run(id, source, { switch: 'MIXDOG_OAI_TRANSPORT', settings: values, model: 'gpt-fixture', first: [USER], second: { history: 'the first turn, then each send\'s `reply` (the assistant turn the first send returned), then the user turn', user: AGAIN } }, async () => {
  let frames = 0;
  world.reset({
    refuse: () => undefined,
    onFrame: (conn) => {
      frames += 1;
      for (const frame of completed(`resp_${frames}`)) conn.send(frame);
    },
  });
  const { OpenAIDirectProvider } = await rec.P(`${P}openai-ws.mjs`);
  const sends = [];
  for (const [n, value] of values.entries()) {
    const provider = new OpenAIDirectProvider({ apiKey: 'fixture-key' });
    const opts = { sessionId: `env-ws-${n}`, onTextDelta: () => {}, onStreamDelta: () => {}, onStageChange: () => {} };
    world.note({ event: 'setting', n, value });
    const outcome = await withSetting('MIXDOG_OAI_TRANSPORT', value, async () => {
      const first = await provider.send([USER], 'gpt-fixture', [], opts);
      world.note({ event: 'second-turn', n });
      const reply = { role: 'assistant', content: first.content, ...(first.providerReplay ? { providerReplay: first.providerReplay } : {}) };
      return { reply, ...(await settled(provider.send([USER, reply, { role: 'user', content: AGAIN }], 'gpt-fixture', [], opts))) };
    });
    sends.push({ setting: value, ...outcome });
  }
  for (const conn of world.conns) conn.close?.(1000, 'recorder-end');
  await world.until(() => world.count((e) => e.event === 'closed') >= world.count((e) => e.event === 'open'), 'all sockets closed');
  return { sends, events: world.trace.map((e) => ({ ...e })) };
});
await wsCase('oai-transport-ws', 'openai-transport-policy.mjs:107', [null, 'ws-full', 'ws-delta', 'WS_FULL', 'bogus', '']);
await rec.finish();
