// Records, from today's Node product, what the pure MCP server helpers answer: the editor input
// normalizer (mcp-glue/server-input.mjs), the partial-edit merges (resource-mcp-servers.mjs,
// plugin-mcp.mjs mergeMcpServerConfig) and the connector account model (connector-catalog.mjs).
// <BASE> stands for the scratch folder (working folder and home), recreated by the replay.
// Usage: node mcpinput.mjs <repo-root> <base-dir> <out.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
process.env.USERPROFILE = join(base, 'home');
process.env.HOME = join(base, 'home');
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createMcpServerInput } = await load('session-runtime/mcp-glue/server-input.mjs');
const client = await load('runtime/agent/orchestrator/mcp/client-config.mjs');
const servers = await load('session-runtime/resource-mcp-servers.mjs');
const plugin = await load('runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs');
const catalog = await load('runtime/shared/connector-catalog.mjs');
const cwd = join(base, 'work');
const { normalizeMcpServerInput } = createMcpServerInput({ mcpClient: client, getCurrentCwd: () => cwd });

const maskText = (text) => text.split(JSON.stringify(base).slice(1, -1)).join('<BASE>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const unmask = (value) => JSON.parse(JSON.stringify(value).split('<BASE>').join(JSON.stringify(base).slice(1, -1)));

const cases = [];
const record = (fn, args, run) => {
  let result = null;
  let error = null;
  try {
    result = run(unmask(args));
  } catch (e) {
    error = e.message;
  }
  cases.push({ fn, args: mask(args), result: mask(result), error: error === null ? null : maskText(error) });
};

const normalizeInputs = [
  {},
  { name: '  ' },
  { name: 'My Server!!' },
  { name: '--A..b__c--', command: 'node' },
  { name: 'Ünï Çode', command: 'x' },
  { name: 'x' },
  { name: 'x', command: 'node', args: ['a', '', 5, 'b c'] },
  { name: 'x', command: 'node', args: ' a  b\tc\nd ' },
  { name: 'x', command: 'node', args: 5 },
  { name: 'x', command: 'node', args: null },
  { name: 'x', command: ' node ', cwd: '~' },
  { name: 'x', command: 'node', cwd: '~/proj' },
  { name: 'x', command: 'node', cwd: '~\\proj' },
  { name: 'x', command: 'node', cwd: '~user' },
  { name: 'x', command: 'node', cwd: 'sub/dir' },
  { name: 'x', command: 'node', cwd: '../up' },
  { name: 'x', command: 'node', cwd: join(cwd, 'abs', '..', 'norm') },
  { name: 'x', command: 'node', env: { A: 1, B: null, C: undefined, D: true, E: { x: 1 }, F: [1, 2] } },
  { name: 'x', command: 'node', env: {} },
  { name: 'x', command: 'node', env: [1] },
  { name: 'x', command: 'node', env: 'str' },
  { name: 'x', command: 'node', env_vars: ['A', ' B ', '', 5] },
  { name: 'x', command: 'node', envVars: ['C'] },
  { name: 'x', command: 'node', env_vars: 'A' },
  { name: 'x', command: 'node', env_vars: [], envVars: ['Z'] },
  { name: 'x', url: 'https://example.com/mcp' },
  { name: 'x', url: 'https://example.com' },
  { name: 'x', url: 'https://example.com/' },
  { name: 'x', url: 'https://example.com/mcp#frag' },
  { name: 'x', url: 'https://example.com/a?b=1#c' },
  { name: 'x', url: ' https://Example.COM:443/p ' },
  { name: 'x', url: 'http://example.com/mcp' },
  { name: 'x', url: 'http://localhost:3000/mcp' },
  { name: 'x', url: 'http://127.0.0.1/mcp' },
  { name: 'x', url: 'http://[::1]:8080/mcp' },
  { name: 'x', url: 'https://user:pw@example.com/mcp' },
  { name: 'x', url: 'not a url' },
  { name: 'x', url: 'ftp://example.com' },
  { name: 'x', url: 'wss://example.com/ws' },
  { name: 'x', url: 'ws://example.com/ws' },
  { name: 'x', url: 'ws://localhost:1/ws' },
  { name: 'x', url: 'WSS://example.com/ws' },
  { name: 'x', url: 'https://example.com/ws', type: 'ws' },
  { name: 'x', url: 'wss://example.com/ws', type: 'http' },
  { name: 'x', url: 'https://example.com/sse', type: 'SSE' },
  { name: 'x', url: 'https://example.com/m', type: 'streamable-http' },
  { name: 'x', url: 'https://example.com/m', type: 'stdio' },
  { name: 'x', url: 'https://example.com/m', type: 'bogus' },
  { name: 'x', url: 'https://example.com/m', headers: { A: 1, B: null, C: 'c' } },
  { name: 'x', url: 'https://example.com/m', headers: {} },
  { name: 'x', url: 'https://example.com/m', headers: ['a'] },
  { name: 'x', url: 'https://example.com/m', bearer_token_env_var: ' TOK ' },
  { name: 'x', url: 'https://example.com/m', bearerTokenEnvVar: 'TOK2' },
  { name: 'x', url: 'https://example.com/m', bearer_token_env_var: '', bearerTokenEnvVar: 'TOK3' },
  { name: 'x', url: 'https://example.com/m', env_http_headers: { X: 'ENV_X' } },
  { name: 'x', url: 'https://example.com/m', envHttpHeaders: { Y: 'ENV_Y' } },
  { name: 'x', url: 'https://example.com/m', oauthClientId: ' client ' },
  { name: 'x', url: 'https://example.com/m', oauthClientId: '', oauthClientSecret: 'never stored' },
  { name: 'x', url: 'https://example.com/m', command: 'ignored', args: ['ignored'] },
  { name: 'x', command: 'node', headers: { A: 'b' }, oauthClientId: 'c' },
  { name: 'x', command: 'node', startupTimeoutSec: 5 },
  { name: 'x', command: 'node', startup_timeout_sec: '7' },
  { name: 'x', command: 'node', startupTimeoutSec: 0 },
  { name: 'x', command: 'node', startupTimeoutSec: -1 },
  { name: 'x', command: 'node', startupTimeoutSec: 'abc' },
  { name: 'x', command: 'node', startupTimeoutSec: '' },
  { name: 'x', command: 'node', startupTimeoutSec: null, startupTimeoutMs: 1500 },
  { name: 'x', command: 'node', startupTimeoutSec: '', startupTimeoutMs: 1500 },
  { name: 'x', command: 'node', startupTimeoutMs: 'x' },
  { name: 'x', command: 'node', startupTimeoutMs: 2.5 },
  { name: 'x', command: 'node', toolTimeoutSec: 2.5 },
  { name: 'x', command: 'node', toolTimeoutSec: 0.0004 },
  { name: 'x', command: 'node', toolTimeoutSec: 1.0005 },
  { name: 'x', command: 'node', toolTimeoutSec: 30, timeoutMs: 5 },
  { name: 'x', command: 'node', timeoutMs: 1234.5 },
  { name: 'x', command: 'node', timeoutMs: 1234.4 },
  { name: 'x', command: 'node', timeoutMs: 0 },
  { name: 'x', command: 'node', timeoutMs: '90000' },
  { name: 'x', command: 'node', toolTimeoutSec: 'nope' },
  { name: 'x', url: 'https://example.com/m', startupTimeoutSec: 3, toolTimeoutSec: 4 },
  { name: 'x', command: 'node', startupTimeoutSec: true },
  { name: 'x', command: 'node', timeoutMs: [5] },
  { name: 'x', command: 'node', extra: 'dropped', enabled: false },
];
for (const input of normalizeInputs) record('normalize', input, (a) => normalizeMcpServerInput(a));

const mergeCases = [
  [{ command: 'a', args: ['x'], env: { A: '1' }, enabled: false, timeoutMs: 5, note: 'keep' }, { type: 'stdio', command: 'b', args: [] }],
  [{ url: 'https://e.com', headers: { A: 'b' }, startupTimeoutSec: 3, startup_timeout_ms: 4 }, { type: 'http', url: 'https://f.com', startupTimeoutMs: 9 }],
  [{ url: 'https://e.com', timeout_ms: 5, callTimeoutMs: 6, timeoutMs: 7 }, { type: 'http', url: 'https://e.com', timeoutMs: 8 }],
  [{ command: 'a', oauthClientId: 'c', autoDetect: true, bearer_token_env_var: 'T', env_vars: ['A'], cwd: '/x', transport: 'http' }, { type: 'stdio', command: 'a' }],
  [{ connector: 'notion', accounts: [{ name: 'n' }], enabled: true }, { type: 'http', url: 'https://u' }],
  [null, { type: 'stdio', command: 'a' }],
  [[1], { type: 'stdio', command: 'a' }],
  [{}, {}],
  [{ a: 1, b: 2 }, { b: 3, c: 4 }],
];
for (const [existing, next] of mergeCases) record('merge', [existing, next], ([e, n]) => plugin.mergeMcpServerConfig(e, n));

const mergedInputs = [
  [{ name: 'x', env: { B: '2' } }, { command: 'a', env: { A: '1' }, startupTimeoutSec: 3 }, 'x'],
  [{ env: { B: '2' }, headers: { H: 'v' } }, { command: 'a', env: { A: '1' }, headers: { G: 'g' } }, 'orig'],
  [{ name: ' New ', command: 'b' }, { command: 'a', env: { A: '1' } }, 'orig'],
  [{ type: 'http', url: 'https://n' }, { command: 'a', env: { A: '1' } }, 'orig'],
  [{ type: 'streamable-http' }, { url: 'https://e', headers: { A: '1' } }, 'orig'],
  [{ type: 'stdio' }, { url: 'https://e', headers: { A: '1' } }, 'orig'],
  [{ type: 'sse' }, { type: 'sse', url: 'https://e', headers: { A: '1' } }, 'orig'],
  [{ command: 'b' }, { url: 'https://e', headers: { A: '1' } }, 'orig'],
  [{ url: 'https://n' }, { command: 'a' }, 'orig'],
  [{ url: 'https://n' }, { url: 'https://e', env_http_headers: { X: 'Y' } }, 'orig'],
  [{ env_http_headers: { Z: 'W' } }, { url: 'https://e', env_http_headers: { X: 'Y' } }, 'orig'],
  [{ env: null }, { command: 'a', env: { A: '1' } }, 'orig'],
  [{ env: 'str' }, { command: 'a', env: { A: '1' } }, 'orig'],
  [{ description: 'd' }, { command: 'a', timeoutMs: 0, startup_timeout_sec: 'off', callTimeoutMs: 7, note: 'n' }, 'orig'],
  [{ name: '' }, {}, 'orig'],
  [{}, {}, ''],
];
for (const [input, existing, original] of mergedInputs) record('mergedInput', [input, existing, original], ([i, e, o]) => servers.mergedServerInput(i, e, o));

const acct = (name, extra = {}) => ({ name, url: `https://${name}.example/mcp`, ...extra });
const notion = {
  type: 'http',
  url: catalog.connectorAccountsUrl('notion'),
  connector: 'notion',
  timeoutMs: 5000,
  accounts: [acct('notion', { id: 'a1', oauthKey: 'k1' }), acct('notion-2', { enabled: false, headers: { A: 'b' } }), { name: 'bad' }, 'str', { name: '', url: 'u' }, { name: 'cmd', command: 'x', args: ['1'], env: { E: '1' }, type: 'stdio' }],
};
const gmailPw = { type: 'http', url: 'https://gmail-imap.mixdog.invalid/mcp/', headers: { 'x-mixdog-gmail-account': 'Me@Example.com ' }, connector: 'gmail' };
const maps = [
  { notion, plain: { command: 'x' }, gmail: { ...gmailPw, accounts: [{ name: 'gmail', url: 'https://gmail-imap.mixdog.invalid/mcp', headers: { 'X-Mixdog-Gmail-Account': 'me@example.com' } }] }, legacy: { connector: 'notion', url: 'https://x' }, unknown: { connector: 'nope', accounts: [{ name: 'q', url: 'u' }] } },
  { a: null, b: 5, c: [1] },
];
for (const map of maps) {
  for (const name of ['notion', 'notion-2', 'cmd', 'plain', 'gmail', 'bad', 'q', 'nope', '']) {
    record('accountTarget', [map, name], ([m, n]) => servers.accountTarget(m, n));
    record('nameTaken', [map, name], ([m, n]) => servers.nameTakenError(m, n).message);
  }
}
const configs = [...Object.values(maps[0]), null, [], 'x', { connector: 'notion' }, { connector: 'notion', accounts: [] }, { connector: 'notion', accounts: [{ name: 'a', url: 'u', enabled: false }] }];
for (const cfg of configs) {
  record('accountsOf', [cfg], ([c]) => catalog.connectorAccountsOf(c));
  record('accountServers', [cfg], ([c]) => catalog.connectorAccountServers(c));
  record('liveAccountServers', [cfg], ([c]) => catalog.connectorLiveAccountServers(c));
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) record('serverSettings', [cfg], ([c]) => catalog.connectorServerSettings(c));
  record('connectorOfServer', [cfg], ([c]) => catalog.connectorOfServer(c));
  record('gmailAppPasswordAccount', [cfg], ([c]) => catalog.gmailAppPasswordAccount(c));
}
for (const name of ['notion', 'notion-2', 'cmd', 'zzz']) {
  for (const enabled of [true, false]) record('withAccountEnabled', [notion, name, enabled], ([c, n, e]) => catalog.withConnectorAccountEnabled(c, n, e));
}
record('withAccountEnabled', [{ connector: 'notion', accounts: [{ name: 'only', url: 'u' }] }, 'only', false], ([c, n, e]) => catalog.withConnectorAccountEnabled(c, n, e));
for (const c of [{ type: 'http', url: 'u', headers: { A: 1 }, oauthKey: 'k', extra: 1 }, { type: 'stdio', command: 'c', args: [1], env: { E: 1 } }, { url: 'u' }, null, {}]) {
  record('accountEntry', [c], ([x]) => catalog.connectorAccountEntry('nm', x));
}
for (const id of ['notion', 'google drive', 'a/b?c', "it's (1)!~*"]) record('accountsUrl', [id], ([x]) => catalog.connectorAccountsUrl(x));
for (const value of ['Me@Example.com', ' a@b.co ', 'bad', 'a@b', '', null, 5, 'x y@b.co', 'a@b.c.d', 'a@@b.co', 'a@b..co', 'a@b.co.']) record('gmailAddress', [value], ([x]) => catalog.gmailAddress(x));
for (const value of ['abcd efgh ijkl mnop', 'abcdefghijklmnop', 'short', '', null, 'abcdefghijklmnop ', 'ab\tcd\nefghijklmnop', 'abcdefghijklmnopq', '한글한글한글한글한글한글한글한글']) record('gmailPassword', [value], ([x]) => catalog.gmailAppPasswordValue(x));
record('gmailServerInput', ['g', 'Me@Example.com', 'abcd efgh ijkl mnop'], (a) => catalog.gmailAppPasswordServerInput(...a));
record('gmailServerInput', ['g', 'bad', 'abcd efgh ijkl mnop'], (a) => catalog.gmailAppPasswordServerInput(...a));
record('gmailServerInput', ['g', 'a@b.co', 'short'], (a) => catalog.gmailAppPasswordServerInput(...a));
for (const entry of catalog.CONNECTOR_CATALOG) {
  for (const key of ['', ' sk-123 ', null, 0]) record('connectorServerInput', [entry.id, key], ([id, k]) => catalog.connectorServerInput(catalog.connectorById(id), 'nm', k));
}
writeFileSync(out, JSON.stringify({ base, cases }, null, 1));
console.log(cases.length, 'cases', cases.filter((c) => c.error).length, 'errors');
