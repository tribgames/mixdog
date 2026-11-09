// Node request capture: the real provider send of each route, with fake credentials in an isolated data dir and the
// network (fetch, WebSocket) replaced by a recorder, so the wire request is exactly what Node's builders produce.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const root = resolve(process.argv[2]);
const out = process.argv[3];
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-nodecap-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
process.env.MIXDOG_OAI_TRANSPORT = 'http';
export const PROBE = 'parity probe';
const FAKE = 'fake-credential-not-a-secret';
const SOON = Date.now() + 86_400_000;
const put = (f, v) => writeFileSync(join(dataDir, f), JSON.stringify(v));
put('anthropic-oauth-credentials.json', { claudeAiOauth: { accessToken: FAKE, refreshToken: FAKE, expiresAt: SOON, scopes: ['user:inference'] } });
put('openai-oauth.json', { access_token: FAKE, refresh_token: FAKE, account_id: 'fake', expires_at: SOON });
put('grok-oauth.json', { access_token: FAKE, refresh_token: FAKE, expires_at: SOON });
put('gemini-api-key.json', { apiKey: FAKE });

const captured = [];
class Stop extends Error {}
const bodyText = (body, headers) => {
  if (typeof body === 'string') return body;
  if (!body) return null;
  const bytes = Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
  const encoding = new Headers(headers || {}).get('content-encoding');
  if (encoding === 'gzip') return gunzipSync(bytes).toString('utf8');
  if (encoding === 'zstd') return zstdDecompressSync(bytes).toString('utf8');
  return bytes.toString('utf8');
};
globalThis.fetch = async (url, init = {}) => {
  captured.push({ via: 'fetch', url: String(url), method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers || {})), body: bodyText(init.body, init.headers) });
  throw new Stop('captured');
};
globalThis.WebSocket = class {
  constructor(url, opts) { captured.push({ via: 'ws', url: String(url), headers: opts?.headers || null, frames: [] }); setTimeout(() => { this.onerror?.({ message: 'captured' }); }, 0); }
  send(frame) { captured[captured.length - 1].frames.push(String(frame)); }
  close() {}
  addEventListener() {}
};
const load = (p) => import(pathToFileURL(join(root, p)).href);
const P = 'src/runtime/agent/orchestrator/providers/';
const CLASSES = {
  gemini: async () => new (await load(P + 'gemini.mjs')).GeminiProvider({ apiKey: FAKE }),
  'grok-oauth': async () => new (await load(P + 'grok-oauth.mjs')).GrokOAuthProvider({ preconnect: false }),
  'anthropic-oauth': async () => new (await load(P + 'anthropic-oauth.mjs')).AnthropicOAuthProvider({}),
  'openai-oauth': async () => new (await load(P + 'openai-oauth.mjs')).OpenAIOAuthProvider({}),
};
const rust = JSON.parse((await import('node:fs')).readFileSync(process.argv[4], 'utf8'));
const { captureRoute, ROUTES } = await import('./node-capture.mjs');
const results = [];
for (const route of ROUTES) {
  captured.length = 0;
  const entry = { ...route };
  try {
    const { active: tools } = await captureRoute(root, route);
    const system = rust.find((r) => r.provider === route.provider)?.snapshot?.system;
    if (!system) throw new Error('no Rust snapshot system texts for ' + route.provider);
    const provider = await CLASSES[route.provider]();
    const messages = [...system.map((content) => ({ role: 'system', content })), { role: 'user', content: PROBE }];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 8000);
    await provider.send(messages, route.model, tools, { signal: ac.signal, sessionId: 'parity-session' }).catch((e) => { entry.sendError = String(e?.message || e).slice(0, 300); });
  } catch (error) {
    entry.error = String(error?.stack || error).slice(0, 600);
  }
  entry.captured = captured.map((c) => ({ ...c }));
  results.push(entry);
}
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(results.map((r) => `${r.provider}: ${r.captured.length} captured ${r.sendError || r.error || ''}`).join('\n'));
process.exit(0);




