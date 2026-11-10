import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { expandEnvVars, findMissingMcpEnvVars, resolveMcpHttpHeaders } from './client-config.mjs';
import { createMcpTransport } from './client-transport.mjs';
import { pluginServerEnv, resolvePluginPlaceholders } from './plugin-placeholders.mjs';

const env = { A: 'a', EMPTY: '', SECRET: 'sekret-value' };

test('expandEnvVars: plain, env: prefix and defaults', () => {
  assert.equal(expandEnvVars('${A}-${env:A}', env), 'a-a');
  assert.equal(expandEnvVars('${NOPE:-fb}', env), 'fb');
  assert.equal(expandEnvVars('[${NOPE:-}]', env), '[]');
  assert.equal(expandEnvVars('${env:NOPE:-x y}', env), 'x y');
  assert.equal(expandEnvVars('${A:-fb}', env), 'a');
  assert.equal(expandEnvVars('${EMPTY:-fb}', env), '');
  // default ends at the first `}`; no nesting
  assert.equal(expandEnvVars('${NOPE:-${A}}', env), '${A}');
  assert.equal(expandEnvVars('${1BAD} $A', env), '${1BAD} $A');
});

test('expandEnvVars collects missing names only when asked', () => {
  const missing = new Set();
  assert.equal(expandEnvVars('${X}${Y:-d}${Z}', env, missing), 'd');
  assert.deepEqual([...missing], ['X', 'Z']);
  assert.equal(expandEnvVars('${X}', env), '');
});

test('findMissingMcpEnvVars scans every field, deduplicated', () => {
  const cfg = {
    command: '${C1}',
    args: ['${A}', '${C1}', '${ARG:-d}'],
    env: { K: '${E1}' },
    url: 'https://h/${U1}',
    headers: { H: '${H1}' },
    cwd: '${CW1}',
  };
  assert.deepEqual(findMissingMcpEnvVars(cfg, env), ['C1', 'E1', 'U1', 'H1', 'CW1']);
  assert.deepEqual(findMissingMcpEnvVars({ command: 'x' }, env), []);
});

test('findMissingMcpEnvVars also checks variables named by credential and passthrough fields', () => {
  const cfg = {
    type: 'http',
    url: 'https://h/mcp',
    bearer_token_env_var: 'BEARER_MISSING',
    env_http_headers: { 'X-Key': 'HEADER_MISSING', 'X-Ok': 'A' },
    env_vars: ['PASS_MISSING', 'SECRET'],
  };
  assert.deepEqual(findMissingMcpEnvVars(cfg, env), ['BEARER_MISSING', 'HEADER_MISSING', 'PASS_MISSING']);
  assert.deepEqual(
    findMissingMcpEnvVars({ ...cfg, bearer_token_env_var: 'A', env_http_headers: {}, env_vars: [] }, env),
    []
  );

  const sdk = fakeSdk();
  const strict = { type: 'http', url: 'https://h/mcp', bearer_token_env_var: 'MIXDOG_TEST_BEARER_UNSET' };
  assert.throws(
    () => createMcpTransport({ name: 'p', cfg: strict, sdk, log: () => {}, strictEnv: true }),
    (e) => e.message === 'missing environment variable(s): MIXDOG_TEST_BEARER_UNSET'
  );
  const user = createMcpTransport({
    name: 'u',
    cfg: { command: 'node', env_vars: ['MIXDOG_TEST_PASS_UNSET'] },
    sdk,
    log: () => {},
  });
  assert.deepEqual(user.warnings, ['missing environment variable(s): MIXDOG_TEST_PASS_UNSET']);
});

test('headers honour defaults', () => {
  assert.deepEqual(resolveMcpHttpHeaders({ headers: { X: '${NOPE:-v}' } }, env), { X: 'v' });
});

function fakeSdk() {
  class T {
    constructor(...args) {
      this.args = args;
    }
  }
  class WS extends T {
    start() {
      return new globalThis.WebSocket('ws://x', 'mcp');
    }
  }
  return {
    StdioClientTransport: T,
    StreamableHTTPClientTransport: T,
    SSEClientTransport: T,
    WebSocketClientTransport: WS,
  };
}

test('transport results, connect logs and the stdio stderr tail per kind', async () => {
  const { EventEmitter } = await import('node:events');
  class Stdio {
    constructor(params) {
      this.params = params;
      this.stderr = new EventEmitter();
    }
  }
  const sdk = { ...fakeSdk(), StdioClientTransport: Stdio };
  const logs = [];
  const log = (m) => logs.push(m);

  const stdio = createMcpTransport({ name: 's', cfg: { command: 'node' }, sdk, log });
  assert.deepEqual(Object.keys(stdio), ['transport', 'autoDetectAdvert', 'stderrTail', 'warnings']);
  assert.equal(stdio.autoDetectAdvert, null);
  assert.equal(stdio.transport.params.stderr, 'pipe');
  stdio.transport.stderr.emit('data', 'boom ');
  stdio.transport.stderr.emit('data', 'x'.repeat(5000));
  assert.equal(stdio.stderrTail().length, 4096);
  assert.equal(logs[0], '[mcp:s:stderr] boom ');

  logs.length = 0;
  const http = createMcpTransport({
    name: 'h',
    cfg: { type: 'http', url: 'https://h.example/mcp', headers: { 'X-Key': 'k' } },
    sdk,
    log,
  });
  assert.deepEqual(Object.keys(http), ['transport', 'autoDetectAdvert', 'stderrTail', 'warnings']);
  assert.equal(http.stderrTail(), '');
  assert.equal(http.transport.oauth, undefined, 'configured auth never turns into OAuth');
  assert.deepEqual(http.transport.args[1], { requestInit: { headers: { 'X-Key': 'k' } } });
  assert.deepEqual(logs, ['[mcp-client] Connecting "h" via HTTP: https://h.example/mcp\n']);
});

test('strict (plugin-declared) server fails with names only; others unaffected', () => {
  const sdk = fakeSdk();
  const logs = [];
  const log = (m) => logs.push(m);
  const plugin = { command: 'node', env: { MIXDOG_PLUGIN_ROOT: '/r', TOKEN: '${MISSING_A}' }, args: ['${MISSING_B}'] };
  assert.throws(
    () => createMcpTransport({ name: 'p', cfg: plugin, sdk, log, strictEnv: true }),
    (e) => e.message === 'missing environment variable(s): MISSING_B, MISSING_A'
  );
  // The root marker alone no longer decides strictness; the catalog passes it.
  assert.deepEqual(createMcpTransport({ name: 'p', cfg: plugin, sdk, log }).warnings, [
    'missing environment variable(s): MISSING_B, MISSING_A',
  ]);
  const ok = createMcpTransport({ name: 'o', cfg: { command: 'node', args: ['${A_OK:-1}'] }, sdk, log });
  assert.deepEqual(ok.warnings, []);
});

test('non-plugin server keeps working: empty expansion plus warning', () => {
  const sdk = fakeSdk();
  const r = createMcpTransport({
    name: 'legacy',
    cfg: { command: 'node', args: ['${MISSING_LEGACY}'] },
    sdk,
    log: () => {},
  });
  assert.deepEqual(r.transport.args[0].args, ['']);
  assert.deepEqual(r.warnings, ['missing environment variable(s): MISSING_LEGACY']);
  assert.throws(
    () =>
      createMcpTransport({
        name: 'legacy',
        cfg: { command: 'node', args: ['${MISSING_LEGACY}'] },
        sdk,
        log: () => {},
        strictEnv: true,
      }),
    /MISSING_LEGACY/
  );
});

test('cwd is expanded; absent or literal cwd unchanged', () => {
  const sdk = fakeSdk();
  process.env.MCP_TEST_CWD = '/work';
  const mk = (cwd) =>
    createMcpTransport({ name: 'n', cfg: { command: 'x', cwd }, sdk, log: () => {} }).transport.args[0].cwd;
  assert.equal(mk('${MCP_TEST_CWD}/p'), '/work/p');
  assert.equal(mk('/plain'), '/plain');
  assert.equal(mk(undefined), undefined);
  delete process.env.MCP_TEST_CWD;
});

test('ws transport sends configured headers on the upgrade; none configured keeps the stock transport', async () => {
  const { WebSocketClientTransport } = await import('@modelcontextprotocol/sdk/client/websocket.js');
  const { JSONRPCMessageSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const sdk = { ...fakeSdk(), WebSocketClientTransport, JSONRPCMessageSchema };
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const upgrade = new Promise((resolve) => {
    server.once('upgrade', (req, socket) => {
      resolve(req.headers);
      socket.destroy();
    });
  });
  try {
    const { transport } = createMcpTransport({
      name: 'w',
      cfg: { type: 'ws', url: `ws://127.0.0.1:${server.address().port}/mcp`, headers: { 'X-K': 'v-${HDR_DEF:-1}' } },
      sdk,
      log: () => {},
    });
    assert.ok(transport instanceof WebSocketClientTransport);
    transport.start().catch(() => {});
    const headers = await upgrade;
    assert.equal(headers['x-k'], 'v-1');
    assert.equal(headers['sec-websocket-protocol'], 'mcp');
    assert.throws(() => transport.start(), /already started/);
  } finally {
    server.close();
  }

  const plain = createMcpTransport({ name: 'w', cfg: { type: 'ws', url: 'ws://127.0.0.1:1/mcp' }, sdk, log: () => {} });
  assert.equal(plain.transport.constructor, WebSocketClientTransport);
});

test('plugin placeholders replace across all fields, all aliases', () => {
  const cfg = {
    command: '${CLAUDE_PLUGIN_ROOT}/bin',
    args: ['${CODEX_PLUGIN_ROOT}/a', '${PLUGIN_DATA}/d'],
    env: { R: '${MIXDOG_PLUGIN_ROOT}', D: '${CLAUDE_PLUGIN_DATA}', X: '${MIXDOG_PLUGIN_DATA}' },
    url: 'http://127.0.0.1/${PLUGIN_ROOT}',
    headers: { H: '${PLUGIN_ROOT}' },
    cwd: '${PLUGIN_ROOT}',
    other: '${PLUGIN_ROOT}',
  };
  const out = resolvePluginPlaceholders(cfg, { root: '/r', data: '/d', platform: 'linux' });
  assert.equal(out.command, '/r/bin');
  assert.deepEqual(out.args, ['/r/a', '/d/d']);
  assert.deepEqual(out.env, { R: '/r', D: '/d', X: '/d' });
  assert.equal(out.url, 'http://127.0.0.1//r');
  assert.deepEqual(out.headers, { H: '/r' });
  assert.equal(out.cwd, '/r');
  assert.equal(out.other, '${PLUGIN_ROOT}');
  assert.equal(cfg.command, '${CLAUDE_PLUGIN_ROOT}/bin');
});

test('plugin placeholders: Windows separators, $ safety, missing data left literal', () => {
  const win = resolvePluginPlaceholders(
    { command: '${PLUGIN_ROOT}\\x', args: ['${PLUGIN_DATA}'] },
    { root: 'C:\\p\\$&q', platform: 'win32' }
  );
  assert.equal(win.command, 'C:/p/$&q\\x');
  assert.deepEqual(win.args, ['${PLUGIN_DATA}']);
  const posix = resolvePluginPlaceholders({ command: '${PLUGIN_ROOT}' }, { root: '/a\\b', platform: 'linux' });
  assert.equal(posix.command, '/a\\b');
});

test('placeholders run before env expansion; pluginServerEnv', () => {
  const out = resolvePluginPlaceholders({ args: ['${PLUGIN_ROOT}/${A}'] }, { root: '/r', platform: 'linux' });
  assert.equal(expandEnvVars(out.args, env)[0], '/r/a');
  assert.deepEqual(pluginServerEnv({ root: 'C:\\r', data: 'C:\\d' }), {
    CLAUDE_PLUGIN_ROOT: 'C:\\r',
    MIXDOG_PLUGIN_ROOT: 'C:\\r',
    PLUGIN_ROOT: 'C:\\r',
    CLAUDE_PLUGIN_DATA: 'C:\\d',
    MIXDOG_PLUGIN_DATA: 'C:\\d',
    PLUGIN_DATA: 'C:\\d',
  });
});
