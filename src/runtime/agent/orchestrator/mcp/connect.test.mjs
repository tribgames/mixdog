import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';

// connectServer builds SDK clients/transports from config: the SDK modules are
// replaced with recording fakes so the handshake, registration, timeout and
// shutdown-abort paths are pinned without spawning anything.
const transports = [];
class FakeTransport {
  constructor(kind, ...args) {
    this.kind = kind;
    this.args = args;
    transports.push(this);
  }
}
class FakeStdioTransport extends FakeTransport {
  constructor(options) {
    super('stdio', options);
    this.stderr = new EventEmitter();
  }
}
class FakeHttpTransport extends FakeTransport {
  constructor(...args) {
    super('http', ...args);
  }
}
class FakeSseTransport extends FakeTransport {
  constructor(...args) {
    super('sse', ...args);
  }
}
class FakeWsTransport extends FakeTransport {
  constructor(...args) {
    super('ws', ...args);
  }
}

let behavior = {};
const clients = [];
class FakeClient {
  constructor(info, options) {
    this.info = info;
    this.options = options;
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.closed = false;
    this.behavior = behavior;
    clients.push(this);
  }
  setRequestHandler(schema, handler) {
    this.requestHandlers.set(schema, handler);
  }
  setNotificationHandler(schema, handler) {
    this.notificationHandlers.set(schema, handler);
  }
  async connect(transport) {
    this.transport = transport;
    if (this.behavior.connect) await this.behavior.connect(this);
  }
  getInstructions() {
    return this.behavior.instructions ?? '  Use echo sparingly.  ';
  }
  getServerCapabilities() {
    return this.behavior.capabilities ?? { tools: { listChanged: true } };
  }
  async listTools() {
    if (this.behavior.listTools) return this.behavior.listTools(this);
    return {
      tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: {} } } }],
    };
  }
  async close() {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/index.js', { namedExports: { Client: FakeClient } });
mock.module('@modelcontextprotocol/sdk/client/stdio.js', {
  namedExports: { StdioClientTransport: FakeStdioTransport },
});
mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
  namedExports: { StreamableHTTPClientTransport: FakeHttpTransport },
});
mock.module('@modelcontextprotocol/sdk/client/sse.js', { namedExports: { SSEClientTransport: FakeSseTransport } });
mock.module('@modelcontextprotocol/sdk/client/websocket.js', {
  namedExports: { WebSocketClientTransport: FakeWsTransport },
});
mock.module('@modelcontextprotocol/sdk/types.js', {
  namedExports: { ListRootsRequestSchema: 'ListRoots', ToolListChangedNotificationSchema: 'ToolListChanged' },
});
process.env.MIXDOG_QUIET_MCP_LOG = '1';

const { connectMcpServers, disconnectAll, getMcpServerInstructionsMap, getMcpServerStatus, getMcpTools } = await import(
  './client.mjs'
);

let scopeSeq = 0;
function freshScope() {
  scopeSeq += 1;
  behavior = {};
  transports.length = 0;
  clients.length = 0;
  return `connect-test-${scopeSeq}`;
}

test('a stdio server registers prefixed tools, instructions, roots and a live tool-list refresh', async () => {
  const scopeId = freshScope();
  const cfg = { command: 'node', args: ['server.mjs'], cwd: process.cwd(), env: { EXTRA: '1' } };
  await connectMcpServers({ echo: cfg }, { scopeId });
  try {
    const [transport] = transports;
    assert.equal(transport.kind, 'stdio');
    assert.equal(transport.args[0].command, 'node');
    assert.deepEqual(transport.args[0].args, ['server.mjs']);
    assert.equal(transport.args[0].cwd, process.cwd());
    assert.equal(transport.args[0].stderr, 'pipe');
    assert.equal(transport.args[0].env.EXTRA, '1');
    const [client] = clients;
    assert.equal(client.info.name, 'mixdog-agent/echo');
    assert.deepEqual(client.options.capabilities, { roots: { listChanged: false } });
    const roots = await client.requestHandlers.get('ListRoots')();
    assert.equal(roots.roots[0].uri, pathToFileURL(process.cwd()).href);

    assert.deepEqual(
      getMcpTools(scopeId).map((tool) => tool.name),
      ['mcp__echo__echo']
    );
    assert.equal(getMcpTools(scopeId)[0].description, 'Echo text');
    assert.deepEqual(getMcpServerInstructionsMap(scopeId), { echo: 'Use echo sparingly.' });
    assert.deepEqual(getMcpServerStatus(scopeId)[0].capabilities, { tools: true, prompts: false, resources: false });
    assert.equal(getMcpServerStatus(scopeId)[0].transport, 'stdio');

    client.behavior = { listTools: async () => ({ tools: [{ name: 'shout' }, { name: 'echo' }] }) };
    await client.notificationHandlers.get('ToolListChanged')();
    assert.deepEqual(
      getMcpTools(scopeId).map((tool) => tool.name),
      ['mcp__echo__shout', 'mcp__echo__echo']
    );
    assert.deepEqual(getMcpTools(scopeId)[0].inputSchema, { type: 'object', properties: {} });
  } finally {
    await disconnectAll({ scopeId });
  }
  assert.deepEqual(getMcpTools(scopeId), []);
  assert.equal(clients[0].closed, true);
});

test('remote transports receive the normalized URL; headers reach HTTP and SSE but never WebSocket', async () => {
  const scopeId = freshScope();
  behavior = { capabilities: { tools: {} } };
  await connectMcpServers(
    {
      web: { url: 'http://127.0.0.1:9000/mcp#frag', headers: { 'X-Key': 'k' } },
      events: { type: 'sse', url: 'https://mcp.example/sse', headers: { 'X-Key': 'k' } },
      socket: { type: 'ws', url: 'wss://mcp.example/ws', headers: { 'X-Key': 'k' } },
    },
    { scopeId }
  );
  try {
    const byKind = Object.fromEntries(transports.map((transport) => [transport.kind, transport.args]));
    assert.equal(String(byKind.http[0]), 'http://127.0.0.1:9000/mcp');
    assert.deepEqual(byKind.http[1], { requestInit: { headers: { 'X-Key': 'k' } } });
    assert.equal(String(byKind.sse[0]), 'https://mcp.example/sse');
    assert.deepEqual(byKind.sse[1], { requestInit: { headers: { 'X-Key': 'k' } } });
    assert.equal(String(byKind.ws[0]), 'wss://mcp.example/ws');
    assert.equal(byKind.ws.length, 1);
    assert.equal(
      clients.every((client) => client.notificationHandlers.size === 0),
      true
    );
    assert.equal(
      clients.every((client) => client.requestHandlers.size === 0),
      true,
      'no cwd → no roots handler'
    );
    assert.equal(getMcpTools(scopeId).length, 3);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('disabled servers are skipped and every failed server is reported by name', async () => {
  const scopeId = freshScope();
  behavior = {
    listTools: async (client) => (client.info.name.endsWith('/broken') ? { nope: true } : { tools: [] }),
  };
  await assert.rejects(
    connectMcpServers(
      {
        off: { command: 'node', enabled: false },
        bad: { nonsense: true },
        broken: { command: 'node' },
        fine: { command: 'node' },
      },
      { scopeId }
    ),
    (error) => {
      assert.match(error.message, /2 MCP server\(s\) failed to connect/);
      assert.deepEqual(
        error.failures.map((failure) => failure.name),
        ['bad', 'broken']
      );
      assert.match(error.failures[0].msg, /^Invalid config: need autoDetect/);
      assert.match(error.failures[1].msg, /ListTools returned invalid shape for "broken"/);
      return true;
    }
  );
  try {
    assert.deepEqual(
      getMcpServerStatus(scopeId).map((server) => server.name),
      ['fine']
    );
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('a hung handshake fails on the startup budget and tears the pending transport down', async () => {
  const scopeId = freshScope();
  behavior = { connect: () => new Promise(() => {}) };
  await assert.rejects(connectMcpServers({ slow: { command: 'node', startupTimeoutMs: 20 } }, { scopeId }), (error) => {
    assert.match(error.failures[0].msg, /"slow" startup exceeded 20ms budget/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(clients[0].closed, true);
  assert.deepEqual(getMcpTools(scopeId), []);
});

test('a shutdown issued mid-handshake aborts the connect instead of registering the server', async () => {
  const scopeId = freshScope();
  const gate = Promise.withResolvers();
  behavior = { connect: () => gate.promise };
  const pending = connectMcpServers({ late: { command: 'node' } }, { scopeId });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await disconnectAll({ scopeId });
  gate.resolve();
  await assert.rejects(pending, (error) => {
    assert.match(error.failures[0].msg, /"late" connect aborted by shutdown/);
    return true;
  });
  assert.deepEqual(getMcpTools(scopeId), []);
  assert.equal(clients[0].closed, true);
});
