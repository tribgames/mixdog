// Records what Node's custom-provider connection test and model discovery
// answer (session-runtime/services/provider-admin.mjs `testCustomProvider`,
// `discoverCustomProviderModels`, `discoveryErrorView`, `sanitizeCustomError`)
// against a scripted local endpoint:
//   node record.mjs > golden.json
// from the Mixdog Node tree (MIXDOG_NODE_ROOT, default C:/Project/mixdog).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.MIXDOG_NODE_ROOT || 'C:/Project/mixdog';
const at = (path) => import(pathToFileURL(join(root, path)).href);
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const { normalizeCustomProviderConfig } = await at('src/runtime/agent/orchestrator/providers/custom-provider-config.mjs');

const KEY = 'sk-probe-secret-0123456789';
const roster = (...ids) => ({ status: 200, body: { data: ids.map((id) => ({ id })) } });
const chatOk = { status: 200, sse: [{ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] }, { id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }] };

const CASES = [
  { name: 'discovery lists the endpoint models', op: 'discover', input: {}, models: roster('m-b', 'm-a', 'm-b') },
  { name: 'discovery honours a manual override and a hidden default', op: 'discover', input: { schemaVersion: 2, discovery: { newModelsHidden: true }, modelOverrides: { 'm-a': { name: 'Alpha', contextWindow: 9000, maxOutputTokens: 800 }, 'm-manual': { manual: true, hidden: false } } }, models: roster('m-a', 'm-c') },
  { name: 'an authentication refusal redacts the key', op: 'discover', input: {}, models: { status: 401, body: { error: `bad key ${KEY}` } } },
  { name: 'a forbidden listing is authentication too', op: 'discover', input: {}, models: { status: 403, body: { error: 'no' } } },
  { name: 'a missing listing is unavailable', op: 'discover', input: {}, models: { status: 404, body: { error: 'no' } } },
  { name: 'a method refusal is unavailable', op: 'discover', input: {}, models: { status: 405, body: { error: 'no' } } },
  { name: 'a server error is a request failure', op: 'discover', input: {}, models: { status: 503, body: { error: 'down' } } },
  { name: 'a failed discovery keeps the manual rows and reports its error', op: 'discover', input: { schemaVersion: 2, modelOverrides: { 'm-manual': { manual: true } } }, models: { status: 403, body: { error: 'no' } } },
  { name: 'a keyless endpoint is listed without a key', op: 'discover', input: { auth: 'none' }, apiKey: false, models: roster('m-a') },
  { name: 'a manual model is tested without discovery', op: 'test', input: { schemaVersion: 2, modelOverrides: { 'm-manual': { manual: true } } }, models: { status: 500, body: {} }, chat: chatOk },
  { name: 'a hidden manual model is skipped for the first discovered', op: 'test', input: { schemaVersion: 2, modelOverrides: { 'm-manual': { manual: true, hidden: true } } }, models: roster('m-a'), chat: chatOk },
  { name: 'the first discovered model is tested', op: 'test', input: {}, models: roster('m-a', 'm-b'), chat: chatOk },
  { name: 'a hidden discovery leaves no model to test', op: 'test', input: { schemaVersion: 2, discovery: { newModelsHidden: true } }, models: roster('m-a'), chat: chatOk },
  { name: 'an empty listing is an empty result', op: 'test', input: {}, models: roster(), chat: chatOk },
  { name: 'a failed discovery is the test result', op: 'test', input: {}, models: { status: 401, body: { error: 'no' } }, chat: chatOk },
  { name: 'a refused send is thrown with the key redacted', op: 'test', input: {}, models: roster('m-a'), chat: { status: 401, body: { error: { message: `bad key ${KEY}` } } } },
  { name: 'a server error on the send is thrown', op: 'test', input: {}, models: roster('m-a'), chat: { status: 400, body: { error: { message: 'unknown model' } } } },
];

const server = createServer((req, res) => {
  const script = server.script;
  const answer = req.url.endsWith('/models') ? script.models : script.chat;
  const sent = answer ?? { status: 404, body: {} };
  const authorization = req.headers.authorization ?? null;
  server.seen.push({ method: req.method, path: req.url.replace(/^\/v1/, ''), authorization: authorization && authorization.replace(KEY, '<key>') });
  if (sent.sse) {
    res.writeHead(sent.status, { 'content-type': 'text/event-stream' });
    res.end(sent.sse.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
    return;
  }
  res.writeHead(sent.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(sent.body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const clean = (value) => JSON.parse(JSON.stringify(value).split(base).join('<base>'));
const cfgMod = { loadConfig: () => ({ providers: {} }), saveConfig() {} };

const out = [];
for (const spec of CASES) {
  server.script = spec;
  server.seen = [];
  const input = { name: 'Probe', protocol: 'openai-chat', baseURL: base, ...(spec.apiKey === false ? {} : { apiKey: KEY }), ...spec.input };
  const config = normalizeCustomProviderConfig({ ...input, apiKey: undefined });
  let result;
  let error;
  try {
    result = spec.op === 'test' ? await admin.testCustomProvider(cfgMod, input) : await admin.discoverCustomProviderModels(cfgMod, input);
  } catch (thrown) {
    error = thrown.message;
  }
  out.push({ name: spec.name, op: spec.op, apiKey: spec.apiKey === false ? '' : KEY, input: clean({ ...input, apiKey: undefined }), config: clean(config), models: spec.models, chat: spec.chat ?? null, result: clean(result ?? null), error: error === undefined ? null : clean(error), seen: server.seen.filter((s) => s.path !== '/').filter((s, i, all) => all.findIndex((o) => o.path === s.path) === i) });
}
server.close();
console.log(JSON.stringify({ key: KEY, cases: out }, null, 2));
process.exit(0);
