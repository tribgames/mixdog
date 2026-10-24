import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';
import { waitUntil } from '../../../shared/wait-until.test-support.mjs';

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
  async close() {}
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
  start() {}
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
    this.sdkOncloseCalls = 0;
    // A handler the SDK side installed before connectServer: must be chained.
    this.onclose = () => {
      this.sdkOncloseCalls += 1;
    };
    clients.push(this);
  }
  async callTool(params, _schema, options) {
    return this.behavior.callTool(this, params, options);
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
  async listTools(params) {
    if (this.behavior.listTools) return this.behavior.listTools(this, params);
    return {
      tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: {} } } }],
    };
  }
  async close() {
    if (this.behavior.close) await this.behavior.close(this);
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

const {
  _registerMcpServerForTest,
  cancelMcpLogin,
  connectMcpServers,
  disconnectAll,
  disconnectMcpServer,
  executeMcpTool,
  getMcpServerInstructionsMap,
  getMcpServerStatus,
  getMcpTools,
  isMcpLoginPending,
  reconnectSingleMcpServer,
} = await import('./client.mjs');

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

test('a malformed listTools shape closes the client before the connect fails', async () => {
  const scopeId = freshScope();
  behavior = { listTools: async () => ({ tools: 'nope' }) };
  await connectMcpServers({ bad: { command: 'node', args: ['server.mjs'] } }, { scopeId }).catch(() => {});
  assert.deepEqual(getMcpTools(scopeId), []);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);
});

test('remote transports receive the normalized URL; headers reach HTTP, SSE and WebSocket', async () => {
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

test('disconnect cancels pending OAuth before waiting for the server operation queue', async () => {
  const scopeId = freshScope();
  behavior = { connect: () => new Promise(() => {}) };
  const connect = reconnectSingleMcpServer(scopeId, 'oauth', { type: 'http', url: 'https://mcp.example/mcp' });
  // No login had started yet: a plain cancelled connect, not a failed login.
  const rejected = assert.rejects(connect, /MCP server "oauth" connect cancelled/);
  await waitUntil(() => transports.some((transport) => transport.oauth));
  await disconnectMcpServer('oauth', { scopeId });
  await rejected;
  assert.equal(transports[0].oauth.signal.aborted, true);
  assert.equal(getMcpServerStatus(scopeId).length, 0);
});

test('cancelMcpLogin aborts only the named pending OAuth connect', async () => {
  const scopeId = freshScope();
  behavior = { connect: () => new Promise(() => {}) };
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  const target = reconnectSingleMcpServer(scopeId, 'target', cfg);
  const rejected = assert.rejects(target, /MCP server "target" connect cancelled/);
  reconnectSingleMcpServer(scopeId, 'other', cfg).catch(() => {});
  await waitUntil(() => transports.filter((transport) => transport.oauth).length === 2);
  cancelMcpLogin('target', { scopeId });
  await rejected;
  const [targetTransport, otherTransport] = transports;
  assert.equal(targetTransport.oauth.signal.aborted, true);
  assert.equal(otherTransport.oauth.signal.aborted, false);
  cancelMcpLogin('other', { scopeId });
});

test('isMcpLoginPending reports only a pending connect whose interactive login started', async () => {
  const scopeId = freshScope();
  behavior = { connect: () => new Promise(() => {}) };
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  const login = reconnectSingleMcpServer(scopeId, 'login', cfg);
  const quiet = reconnectSingleMcpServer(scopeId, 'quiet', cfg);
  await waitUntil(() => transports.filter((transport) => transport.oauth).length === 2);
  assert.equal(isMcpLoginPending('login', { scopeId }), false);
  // The browser login of the first connect starts (oauth.test.mjs pins when
  // the real flag flips).
  Object.defineProperty(transports[0].oauth, 'loginStarted', { get: () => true });
  assert.equal(isMcpLoginPending('login', { scopeId }), true);
  assert.equal(isMcpLoginPending('quiet', { scopeId }), false);
  assert.equal(isMcpLoginPending('login', { scopeId: `${scopeId}-other` }), false);
  cancelMcpLogin('login', { scopeId });
  cancelMcpLogin('quiet', { scopeId });
  await assert.rejects(login, /connect cancelled/);
  await assert.rejects(quiet, /connect cancelled/);
  assert.equal(isMcpLoginPending('login', { scopeId }), false);
});

test('an explicit sign-in that times out, is denied or is cancelled is flagged authRequired', async () => {
  const scopeId = freshScope();
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  // Login started, then the login deadline or a denied callback failed it.
  for (const message of ['MCP OAuth login failed, cancelled, or timed out', 'access_denied']) {
    behavior = {
      connect: (client) => {
        Object.defineProperty(client.transport.oauth, 'loginStarted', { get: () => true });
        throw new Error(message);
      },
    };
    await assert.rejects(reconnectSingleMcpServer(scopeId, 'login', cfg, { interactive: true }), (error) => {
      assert.equal(error.message, message);
      return error.authRequired === true;
    });
  }
  // The sign-in obtained tokens, then the server failed: a real failure.
  behavior = {
    connect: (client) => {
      Object.defineProperty(client.transport.oauth, 'loginStarted', { get: () => true });
      Object.defineProperty(client.transport.oauth, 'loginCompleted', { get: () => true });
      throw new Error('tools unavailable');
    },
  };
  await assert.rejects(
    reconnectSingleMcpServer(scopeId, 'login', cfg, { interactive: true }),
    (error) => error.authRequired === undefined
  );
  // Cancelled before the login could start: only an explicit sign-in still
  // needs one; a background connect cancelled that way is just cancelled.
  behavior = { connect: () => new Promise(() => {}) };
  for (const interactive of [true, false]) {
    transports.length = 0;
    const connect = reconnectSingleMcpServer(scopeId, 'early', cfg, { interactive });
    await waitUntil(() => transports[0]?.oauth);
    cancelMcpLogin('early', { scopeId });
    await assert.rejects(connect, (error) => {
      assert.match(error.message, /connect cancelled/);
      return error.authRequired === (interactive ? true : undefined);
    });
  }
});

test('a sign-in the provider granted without a requested scope fails with its message, not as authRequired', async () => {
  const scopeId = freshScope();
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  const { scopeNotGranted } = await import('./oauth-shared.mjs');
  behavior = {
    connect: (client) => {
      Object.defineProperty(client.transport.oauth, 'loginStarted', { get: () => true });
      throw scopeNotGranted(['https://www.googleapis.com/auth/calendar.events']);
    },
  };
  await assert.rejects(reconnectSingleMcpServer(scopeId, 'scoped', cfg, { interactive: true }), (error) => {
    assert.match(error.message, /scopeNotGranted.*calendar\.events/);
    return error.authRequired === undefined;
  });
});

test('a connect that needs an OAuth sign-in is flagged authRequired for both connect paths', async () => {
  const scopeId = freshScope();
  behavior = {
    connect: () => {
      throw Object.assign(new Error('MCP OAuth reauthenticationRequired: sign in to connect'), {
        code: 'reauthenticationRequired',
      });
    },
  };
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  await assert.rejects(reconnectSingleMcpServer(scopeId, 'signin', cfg), (error) => error.authRequired === true);
  await assert.rejects(connectMcpServers({ signin: cfg }, { scopeId }), (error) => {
    assert.deepEqual(error.failures, [
      { name: 'signin', msg: 'MCP OAuth reauthenticationRequired: sign in to connect', authRequired: true },
    ]);
    return true;
  });
  behavior = {
    connect: () => {
      throw new Error('fetch failed');
    },
  };
  await assert.rejects(reconnectSingleMcpServer(scopeId, 'down', cfg), (error) => error.authRequired === undefined);
});

test('OAuth tokens are scrubbed from connect failures, liveness errors, tool-call errors and results', async () => {
  const scopeId = freshScope();
  const secret = 'oauth-access-secret';
  const withSecret = (transport) => {
    transport.oauth.secrets = () => [secret];
  };
  behavior = {
    connect: (client) => {
      withSecret(client.transport);
      throw new Error(`Error POSTing to endpoint (HTTP 500): echoed Authorization: Bearer ${secret}`);
    },
  };
  const cfg = { type: 'http', url: 'https://mcp.example/mcp' };
  await assert.rejects(reconnectSingleMcpServer(scopeId, 'leaky', cfg), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /Bearer \[redacted\]/);
    return true;
  });

  behavior = { connect: (client) => withSecret(client.transport) };
  await reconnectSingleMcpServer(scopeId, 'leaky', cfg);
  try {
    const client = clients.at(-1);
    client.onerror(new Error(`HTTP 500: Bearer ${secret}`));
    client.onclose();
    const [row] = getMcpServerStatus(scopeId);
    assert.equal(row.connected, false);
    assert.equal(row.error, 'HTTP 500: Bearer [redacted]');
  } finally {
    await disconnectAll({ scopeId });
  }

  _registerMcpServerForTest(scopeId, 'leaky', [{ name: 'echo' }, { name: 'failed' }, { name: 'ok' }], {
    transport: { oauth: { secrets: () => [secret], close() {} } },
    callTool: async ({ name }) => {
      if (name === 'echo') {
        // A JSON-RPC error whose data echoes the request.
        throw Object.assign(new Error(`invalid params: Bearer ${secret}`), {
          code: -32602,
          data: { request: { headers: { authorization: `Bearer ${secret}` } }, [secret]: [secret] },
        });
      }
      return { content: [{ type: 'text', text: `${name}: Bearer ${secret}` }], isError: name === 'failed' };
    },
  });
  try {
    await assert.rejects(executeMcpTool('mcp__leaky__echo', {}, { scopeId }), (error) => {
      assert.equal(error.message, 'invalid params: Bearer [redacted]');
      assert.deepEqual(error.data, {
        request: { headers: { authorization: 'Bearer [redacted]' } },
        '[redacted]': ['[redacted]'],
      });
      return true;
    });
    assert.equal(await executeMcpTool('mcp__leaky__failed', {}, { scopeId }), 'Error: failed: Bearer [redacted]');
    assert.equal(await executeMcpTool('mcp__leaky__ok', {}, { scopeId }), 'ok: Bearer [redacted]');
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('OAuth tokens are scrubbed at any length; short configured URL values are not', async () => {
  const scopeId = freshScope();
  behavior = {
    connect: (client) => {
      client.transport.oauth.secrets = () => ['abc'];
    },
  };
  await reconnectSingleMcpServer(scopeId, 'short', { type: 'http', url: 'https://mcp.example/mcp?v=1' });
  try {
    clients.at(-1).onerror(new Error('HTTP 500 for v=1: Bearer abc'));
    clients.at(-1).onclose();
    assert.equal(getMcpServerStatus(scopeId)[0].error, 'HTTP 500 for v=1: Bearer [redacted]');
  } finally {
    await disconnectAll({ scopeId });
  }
  _registerMcpServerForTest(scopeId, 'short', [{ name: 'echo' }], {
    transport: { oauth: { secrets: () => ['abc'], close() {} } },
    callTool: async () => ({ content: [{ type: 'text', text: 'Bearer abc' }], isError: true }),
  });
  try {
    assert.equal(await executeMcpTool('mcp__short__echo', {}, { scopeId }), 'Error: Bearer [redacted]');
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
  await waitUntil(() => clients[0].closed, { message: 'timed-out client closed' });
  assert.equal(clients[0].closed, true);
  assert.deepEqual(getMcpTools(scopeId), []);
});

test('handshake and refresh follow nextCursor until exhausted and stop on a repeated cursor', async () => {
  const scopeId = freshScope();
  const pages = {
    '': { tools: [{ name: 'a' }], nextCursor: 'p2' },
    p2: { tools: [{ name: 'b' }], nextCursor: 'p3' },
    p3: { tools: [{ name: 'c' }] },
  };
  const cursors = [];
  behavior = {
    listTools: async (_client, params) => {
      cursors.push(params?.cursor ?? '');
      return pages[params?.cursor ?? ''];
    },
  };
  await connectMcpServers({ paged: { command: 'node' } }, { scopeId });
  try {
    assert.deepEqual(cursors, ['', 'p2', 'p3']);
    assert.deepEqual(
      getMcpTools(scopeId).map((tool) => tool.name),
      ['mcp__paged__a', 'mcp__paged__b', 'mcp__paged__c']
    );
    // Refresh: a server that keeps returning the same cursor cannot loop us.
    const [client] = clients;
    cursors.length = 0;
    client.behavior = {
      listTools: async (_client, params) => {
        cursors.push(params?.cursor ?? '');
        return { tools: [{ name: `x${cursors.length}` }], nextCursor: 'same' };
      },
    };
    await client.notificationHandlers.get('ToolListChanged')();
    assert.deepEqual(cursors, ['', 'same']);
    assert.deepEqual(
      getMcpTools(scopeId).map((tool) => tool.name),
      ['mcp__paged__x1', 'mcp__paged__x2']
    );
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('overlapping tool refreshes apply in order', async () => {
  const scopeId = freshScope();
  await connectMcpServers({ srv: { command: 'node' } }, { scopeId });
  try {
    const [client] = clients;
    const slow = Promise.withResolvers();
    let n = 0;
    client.behavior = {
      listTools: async () => {
        n += 1;
        if (n === 1) {
          await slow.promise;
          return { tools: [{ name: 'old' }] };
        }
        return { tools: [{ name: 'new' }] };
      },
    };
    const first = client.notificationHandlers.get('ToolListChanged')();
    const second = client.notificationHandlers.get('ToolListChanged')();
    slow.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(
      getMcpTools(scopeId).map((tool) => tool.name),
      ['mcp__srv__new']
    );
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('onclose marks the server not connected (chaining the existing handler)', async () => {
  const scopeId = freshScope();
  await connectMcpServers({ crashy: { command: 'node' } }, { scopeId });
  try {
    assert.equal(getMcpServerStatus(scopeId)[0].connected, true);
    clients[0].transport.stderr.emit('data', 'fatal: out of cheese\n');
    clients[0].onclose();
    assert.equal(getMcpServerStatus(scopeId)[0].connected, false);
    assert.equal(clients[0].sdkOncloseCalls, 1);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('a failed or timed-out handshake carries the stdio stderr tail', async () => {
  const scopeId = freshScope();
  behavior = {
    connect: async (client) => {
      client.transport.stderr.emit('data', `${'x'.repeat(6000)}\nModuleNotFoundError: no module named foo\n`);
      throw new Error('Connection closed');
    },
  };
  await assert.rejects(connectMcpServers({ broken: { command: 'node' } }, { scopeId }), (error) => {
    const msg = error.failures[0].msg;
    assert.match(msg, /Connection closed\n--- server stderr \(tail\) ---\n/);
    assert.match(msg, /ModuleNotFoundError: no module named foo$/);
    assert.ok(msg.length < 4096 + 200, 'the tail is bounded');
    return true;
  });
  const scope2 = freshScope();
  behavior = {
    connect: (client) => {
      client.transport.stderr.emit('data', 'still installing deps...\n');
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    connectMcpServers({ slow: { command: 'node', startupTimeoutMs: 20 } }, { scopeId: scope2 }),
    (error) => {
      assert.match(error.failures[0].msg, /startup exceeded 20ms budget[\s\S]*still installing deps/);
      return true;
    }
  );
});

test('a failure after send reconnects for the next call but is not replayed; "Not connected" is', async () => {
  const scopeId = freshScope();
  const calls = [];
  behavior = {
    callTool: async (client) => {
      calls.push(clients.indexOf(client));
      if (calls.length === 1) throw Object.assign(new Error('Connection closed'), { code: -32000 });
      if (calls.length === 2) throw new Error('Not connected');
      return { content: [{ type: 'text', text: `ran on client ${clients.indexOf(client)}` }] };
    },
  };
  await connectMcpServers({ srv: { command: 'node' } }, { scopeId });
  try {
    await assert.rejects(executeMcpTool('mcp__srv__echo', {}, { scopeId }), /was not replayed/);
    assert.deepEqual(calls, [0], 'the delivered call ran once');
    assert.equal(clients.length, 2, 'the dead server was reconnected for the next call');
    assert.equal(clients[0].closed, true);
    // Undelivered (no live connection to send on): safe to replay once.
    assert.equal(await executeMcpTool('mcp__srv__echo', {}, { scopeId }), 'ran on client 2');
    assert.deepEqual(calls, [0, 1, 2]);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('a JSON-RPC error answer from a live server is not reconnected', async () => {
  const scopeId = freshScope();
  behavior = {
    callTool: async () => {
      throw Object.assign(new Error('Invalid params'), { code: -32602 });
    },
  };
  await connectMcpServers({ srv: { command: 'node' } }, { scopeId });
  try {
    await assert.rejects(executeMcpTool('mcp__srv__echo', {}, { scopeId }), /Invalid params/);
    assert.equal(clients.length, 1);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('reconnectSingleMcpServer / disconnectMcpServer touch only the named server', async () => {
  const scopeId = freshScope();
  await connectMcpServers({ one: { command: 'node' }, two: { command: 'node' } }, { scopeId });
  try {
    const [one, two] = clients;
    assert.equal(await reconnectSingleMcpServer(scopeId, 'one'), true);
    assert.equal(one.closed, true);
    assert.equal(two.closed, false);
    assert.equal(clients.length, 3);
    assert.deepEqual(
      getMcpServerStatus(scopeId)
        .map((s) => [s.name, s.connected])
        .sort(),
      [
        ['one', true],
        ['two', true],
      ]
    );
    // A new server with an explicit config, then a disable.
    assert.equal(await reconnectSingleMcpServer(scopeId, 'three', { command: 'node' }), true);
    assert.equal(await reconnectSingleMcpServer(scopeId, 'three', { command: 'node', enabled: false }), false);
    assert.equal(await disconnectMcpServer('two', { scopeId }), true);
    assert.equal(two.closed, true);
    assert.deepEqual(
      getMcpServerStatus(scopeId).map((s) => s.name),
      ['one']
    );
    await assert.rejects(reconnectSingleMcpServer(scopeId, 'ghost'), /no config/);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('a shutdown during a single-server reconnect close never registers the replacement', async () => {
  const scopeId = freshScope();
  const closeGate = Promise.withResolvers();
  const closeEntered = Promise.withResolvers();
  behavior = {
    close: () => {
      closeEntered.resolve();
      return closeGate.promise;
    },
  };
  await connectMcpServers({ srv: { command: 'node' } }, { scopeId });
  const reconnect = reconnectSingleMcpServer(scopeId, 'srv');
  reconnect.catch(() => {});
  await closeEntered.promise;
  // Shutdown lands while the reconnect is blocked inside _closeServer.
  const shutdown = disconnectAll({ scopeId });
  closeGate.resolve();
  await shutdown;
  await assert.rejects(reconnect, /"srv" connect aborted by shutdown/);
  assert.equal(clients.length, 1, 'no replacement client was ever created');
  assert.deepEqual(getMcpTools(scopeId), []);
  assert.deepEqual(getMcpServerStatus(scopeId), []);
});

test('an in-flight call failed by disconnectAll does not reconnect the server after shutdown', async () => {
  const scopeId = freshScope();
  const closeGate = Promise.withResolvers();
  const callEntered = Promise.withResolvers();
  let rejectCall;
  behavior = {
    callTool: () => {
      callEntered.resolve();
      return new Promise((_resolve, reject) => {
        rejectCall = reject;
      });
    },
    // Shutdown's close fails the pending request (as the SDK does on
    // transport close) and then stays blocked, keeping the entry registered.
    close: () => {
      rejectCall(Object.assign(new Error('Connection closed'), { code: -32000 }));
      return closeGate.promise;
    },
  };
  await connectMcpServers({ srv: { command: 'node' } }, { scopeId });
  const call = executeMcpTool('mcp__srv__echo', {}, { scopeId });
  call.catch(() => {});
  await callEntered.promise;
  const shutdown = disconnectAll({ scopeId });
  await assert.rejects(call);
  closeGate.resolve();
  await shutdown;
  assert.equal(clients.length, 1, 'no replacement client was ever constructed');
  assert.deepEqual(getMcpServerStatus(scopeId), []);
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
