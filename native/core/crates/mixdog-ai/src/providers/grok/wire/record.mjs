// Records the request Node's real Grok provider (b6f10295a) puts on the wire for fixed inputs, with fake credentials in
// an isolated data dir and fetch replaced by a recorder, into `node_wire.json` (the Rust test compares it exactly).
// Usage: node record.mjs <Node b6f10295a export root>   (a `git archive` export of that commit, never a working copy)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-grokwire-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
const FAKE = 'fake-credential-not-a-secret';
writeFileSync(join(dataDir, 'grok-oauth.json'), JSON.stringify({ access_token: FAKE, refresh_token: FAKE, expires_at: Date.now() + 86_400_000 }));

const captured = [];
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers || {})), body: typeof init.body === 'string' ? init.body : null });
  throw new Error('captured');
};
const { GrokOAuthProvider } = await import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator/providers/grok-oauth.mjs')).href);

const str = { type: 'string' };
const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: str, mode: { anyOf: [str, { type: 'array', items: str }] } }, required: ['path'] } },
  { name: 'pick', description: 'Pick a kind', inputSchema: { type: 'object', properties: { kind: { enum: ['a', 'b'] }, n: { type: 'integer', minimum: 1 } } } },
];
const messages = [
  { role: 'system', content: 'You are a test agent.' },
  { role: 'system', content: 'Environment: test.' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'calling', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'file text' },
  { role: 'user', content: 'thanks' },
];
const SEND = { sessionId: 'rec-session', requestId: 'rec-request-id', iteration: 2, promptCacheKey: 'rec-cache-key' };
const provider = new GrokOAuthProvider({ preconnect: false });
await provider.send(messages, 'grok-4.7', tools, { ...SEND }).catch(() => {});
const request = captured.find((c) => /\/responses$/.test(c.url));
if (!request) throw new Error(`no model request captured: ${JSON.stringify(captured.map((c) => c.url))}`);
const recording = { node: 'b6f10295a', host: { platform: process.platform, arch: process.arch, version: process.version }, send: { ...SEND, model: 'grok-4.7' }, messages, tools, request: { url: request.url, method: request.method, headers: request.headers, body: JSON.parse(request.body) } };
delete recording.request.headers.authorization;
writeFileSync(join(here, 'node_wire.json'), `${JSON.stringify(recording, null, 1)}\n`);
console.log(Object.keys(request.headers).join(','));
