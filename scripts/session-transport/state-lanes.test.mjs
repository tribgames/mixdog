import test from 'node:test';
import assert from 'node:assert/strict';
import {
  http,
  applySessionStatePatch,
  diffSessionState,
  createSessionService,
  createChannelTransport,
  attachSession,
  SESSION_PROTOCOL,
  daemonPost,
  waitForSseFrame,
  waitForValue,
  withDaemon,
  waitFor,
  itemsFromFrames,
} from './_shared.mjs';


test('wire-safe runtime state crosses the daemon without a transcript clone', async () => {
  const state = {
    sessionId: 'wire-safe-retention',
    items: [{ id: 'answer', kind: 'assistant', text: 'x'.repeat(64 * 1024) }],
    queued: [],
  };
  const runtime = {
    isWireSafe: true,
    getState: () => state,
    subscribe: () => () => {},
    dispose: async () => {},
  };
  const service = createSessionService({
    createSessionRuntime: async () => runtime,
  });
  try {
    const result = await service.handleCall(
      'session.create',
      { sessionId: state.sessionId },
      { clientToken: 'memory-retention-test' },
    );
    assert.equal(result.full, state);
    assert.equal(result.full.items, state.items);
    assert.equal(result.full.items[0], state.items[0]);
  } finally {
    await service.stop('memory retention test');
  }
});

test('a 2k-item tool-card update sends only the changed transcript suffix', () => {
  const items = Array.from({ length: 2_000 }, (_, index) => ({
    id: `item-${index}`,
    kind: index === 1_999 ? 'tool' : 'message',
    status: 'settled',
    text: `row-${index}`,
  }));
  const nextItems = items.slice();
  nextItems[1_999] = { ...nextItems[1_999], status: 'completed', text: 'tool result' };
  const previous = { sessionId: 'suffix-test', busy: true, items };
  const next = { sessionId: 'suffix-test', busy: false, items: nextItems };
  const patch = diffSessionState(previous, next);

  assert.equal(Object.hasOwn(patch.set, 'items'), false);
  assert.deepEqual(patch.itemsAppend, { from: 1_999, values: [nextItems[1_999]] });
  assert.ok(JSON.stringify(patch).length < 512, 'one tool update stays independent of transcript size');
  assert.deepEqual(applySessionStatePatch(previous, patch), next);
});

test('an unknown session subscription is rejected before a session runtime is created', async () => {
  let creations = 0;
  const service = createSessionService({
    createSessionRuntime: async () => {
      creations += 1;
      throw new Error('an unknown session must not reach the runtime factory');
    },
    sessionExists: async () => false,
  });
  try {
    await assert.rejects(
      service.handleCall('session.subscribe', {
        sessionId: 'missing_session',
      }, { clientToken: 'stale_pane' }),
      /session missing_session is not available/,
    );
    assert.equal(creations, 0);
    assert.equal(service.size, 0);
  } finally {
    await service.stop('test end');
  }
});

test('an agent session publishes through the ordinary subscribed session-state lane', async () => {
  let publishAgentSession = null;
  let creations = 0;
  const frames = [];
  const service = createSessionService({
    createSessionRuntime: async () => {
      creations += 1;
      throw new Error('a live agent projection must not create another runtime');
    },
    readStoredSession: async (sessionId) => ({
      sessionId,
      items: [{ id: 'brief', kind: 'user', text: 'worker brief' }],
      queued: [],
    }),
    subscribeExternalSessionStates(listener) {
      publishAgentSession = listener;
      return () => { publishAgentSession = null; };
    },
    onFrame(frame, targets) {
      frames.push({ frame, targets: [...(targets || [])] });
    },
  });
  const client = { clientToken: 'desktop-pane' };
  try {
    const subscribed = await service.handleCall('session.subscribe', {
      sessionId: 'agent_child',
    }, client);
    assert.equal(subscribed.subscribed, true);
    assert.equal(subscribed.revision, 0);
    assert.deepEqual(subscribed.full.items.map((item) => item.id), ['brief']);

    publishAgentSession({
      sessionId: 'agent_child',
      snapshot: {
        sessionId: 'agent_child',
        items: [
          { id: 'brief', kind: 'user', text: 'worker brief' },
          { id: 'tool-1', kind: 'tool', text: 'read source' },
        ],
        queued: [],
        busy: true,
      },
    });

    assert.equal(frames.length, 1);
    assert.equal(frames[0].frame.type, 'session-state');
    assert.equal(frames[0].frame.sessionId, 'agent_child');
    assert.deepEqual(frames[0].frame.full.items.map((item) => item.id), ['brief', 'tool-1']);
    assert.deepEqual(frames[0].targets, ['desktop-pane']);
    assert.equal(service.status.pendingViewerSessions, 0);
    assert.equal(creations, 0);

    const reread = await service.handleCall('session.read', {
      sessionId: 'agent_child',
    }, client);
    assert.deepEqual(reread.full.items.map((item) => item.id), ['brief', 'tool-1']);

    await service.handleCall('session.unsubscribe', {
      sessionId: 'agent_child',
    }, client);
    const frameCount = frames.length;
    publishAgentSession({
      sessionId: 'agent_child',
      snapshot: {
        sessionId: 'agent_child',
        items: [{ id: 'ignored', kind: 'assistant', text: 'not observed' }],
        queued: [],
      },
    });
    assert.equal(frames.length, frameCount);
  } finally {
    await service.stop('test end');
  }
});

test('a live daemon SSE stream reconnects in place with the same client registration', async () => {
  const serverToken = 'server-token';
  const clientToken = 'client-token';
  const streamResponses = [];
  const reconnects = [];
  const fatals = [];
  let registrations = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (value, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send({ error: 'temporarily overloaded' }, 503);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      res.write(': attached\n\n');
      streamResponses.push(res);
      return;
    }
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/client/register') {
        registrations += 1;
        send({ token: clientToken, pid: process.pid });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/client/deregister') {
        send({ ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        send({ result: 'still-connected' });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  let client = null;
  try {
    client = await attachSession({
      discovery: { port: address.port, token: serverToken, pid: process.pid },
      onFatal: (reason) => fatals.push(reason),
      onStreamReconnect: (details) => reconnects.push(details),
      streamReconnectBaseMs: 5,
      streamReconnectMaxMs: 10,
    });
    await waitForValue(() => streamResponses.length === 1);
    streamResponses[0].end();
    assert.equal(await client.call('probe'), 'still-connected',
      'ordinary calls remain usable while only the event stream reconnects');
    await waitForValue(() => streamResponses.length === 2);
    await waitForValue(() => reconnects.length === 1);
    assert.equal(registrations, 1, 'SSE recovery reuses the original client token');
    assert.equal(fatals.length, 0);
    assert.equal(reconnects[0].reason, 'sse ended');
  } finally {
    await client?.close('test end');
    for (const response of streamResponses) {
      try { response.end(); } catch {}
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a disconnected client receives bounded session resync markers instead of a huge backlog', async () => {
  await withDaemon(async ({ discovery, transport }) => {
    const registered = await daemonPost(discovery, '/client/register', {
      protocol: SESSION_PROTOCOL,
      leadPid: process.pid,
      cwd: process.cwd(),
      lifecycle: false,
    });
    const target = new Set([registered.token]);
    const large = 'x'.repeat(160 * 1024);
    for (let index = 0; index < 3; index += 1) {
      transport.broadcast({
        type: 'session-state',
        key: `session-state:budget-${index}`,
        sessionId: `budget-${index}`,
        revision: index + 1,
        full: { sessionId: `budget-${index}`, items: [{ text: large }] },
      }, target);
    }
    const marker = await waitForSseFrame(
      discovery,
      registered.token,
      (frame) => frame?.resyncRequired === true,
    );
    assert.equal(marker.type, 'session-state');
    await daemonPost(discovery, '/client/deregister', { token: registered.token });
  });
});

test('disconnected channel remote-state churn keeps only the latest frame', async () => {
  const transport = createChannelTransport({
    handleCall: async () => ({ ok: true }),
  });
  const endpoint = await transport.start();
  try {
    const registered = await daemonPost(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
    });
    const client = transport._clientsForTest.get(registered.token);
    assert.ok(client);
    for (let index = 0; index < 10_000; index += 1) {
      transport._writeRemoteStateToForTest(client, `state-${index}`);
    }
    assert.equal(typeof client.pendingRemoteStateFrame, 'string');
    assert.equal(JSON.parse(client.pendingRemoteStateFrame).params.state, 'state-9999');
    assert.equal(Object.hasOwn(client, 'pending'), false);
  } finally {
    await transport.stop();
  }
});

test('channel transport publishes the pinned remote session independently of state-file persistence', async () => {
  const states = [];
  let transport = null;
  transport = createChannelTransport({
    handleCall: async (name, args) => {
      if (name === 'activate_channel_bridge' && args.active === true) {
        transport.notify('notifications/mixdog/remote', { state: 'acquired' });
      }
      return { ok: true };
    },
    onRemoteStateChange: (state) => states.push(state),
  });
  const endpoint = await transport.start();
  try {
    const registered = await daemonPost(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
    });
    await daemonPost(endpoint, '/call', {
      token: registered.token,
      name: 'activate_channel_bridge',
      args: { active: true, sessionId: 'session_remote' },
    });
    assert.equal(states.at(-1)?.enabled, true);
    assert.equal(states.at(-1)?.sessionId, 'session_remote');

    await daemonPost(endpoint, '/call', {
      token: registered.token,
      name: 'activate_channel_bridge',
      args: { active: false, sessionId: 'session_remote' },
    });
    assert.equal(states.at(-1)?.enabled, false);
    assert.equal(states.at(-1)?.sessionId, null);
  } finally {
    await transport.stop();
  }
});

test('every attached client observes the same session snapshot stream', async () => {
  await withDaemon(async ({ discovery }) => {
    const terminalFrames = [];
    const desktopFrames = [];
    const unrelatedFrames = [];
    const terminal = await attachSession({
      discovery, cwd: process.cwd(), onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachSession({
      discovery, cwd: process.cwd(), onFrame: (frame) => desktopFrames.push(frame),
    });
    const unrelated = await attachSession({
      discovery, cwd: process.cwd(), onFrame: (frame) => unrelatedFrames.push(frame),
    });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    assert.match(created.sessionId, /^sess_daemon_/);
    const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
    assert.equal(subscribed.subscribed, true);
    // Subscription state is the RPC baseline; SSE carries only later changes
    // to subscribed clients and never broadcasts another session globally.
    desktopFrames.push({
      type: 'session-state',
      sessionId: created.sessionId,
      revision: subscribed.revision,
      full: subscribed.full,
      patch: subscribed.patch,
    });

    // A terminal-side submit reaches the desktop view as shared state.
    await terminal.call('session.submit', {
      sessionId: created.sessionId, prompt: 'from terminal',
    });
    const seen = await waitFor(
      () => {
        const items = itemsFromFrames(desktopFrames);
        return items.length === 1 ? items : null;
      },
      'desktop view receives the terminal submission',
    );
    assert.equal(seen[0].text, 'from terminal');

    // ... and the reverse direction is symmetric.
    await desktop.call('session.submit', {
      sessionId: created.sessionId, prompt: 'from desktop',
    });
    await waitFor(
      () => itemsFromFrames(terminalFrames).length === 2,
      'terminal view receives the desktop submission',
    );
    assert.equal(
      unrelatedFrames.some((frame) => frame.sessionId === created.sessionId),
      false,
      'an unrelated client never receives another session transcript',
    );

    await terminal.close('test');
    await desktop.close('test');
    await unrelated.close('test');
  });
});

test('an in-daemon transport connection receives frames without owning daemon lifetime', async () => {
  await withDaemon(async ({ discovery, transport, clientsEmpty }) => {
    const external = await attachSession({ discovery, cwd: process.cwd() });
    const internal = await attachSession({
      discovery,
      cwd: process.cwd(),
      lifecycle: false,
    });
    assert.equal(transport.clientCount, 1);
    assert.equal(transport.connectionCount, 2);
    await external.close('external client closed');
    await waitFor(() => clientsEmpty() === 'empty', 'lifecycle emptiness ignores internal connection');
    assert.equal(transport.clientCount, 0);
    assert.equal(transport.connectionCount, 1);
    await internal.close('test');
  });
});

test('a silent SSE is reconnected and a continuous reconnect storm exhausts its budget', async () => {
  const serverToken = 'server-token';
  const clientToken = 'client-token';
  const fatals = [];
  const disconnects = [];
  let eventRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send({ status: 'ok', pid: process.pid });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      eventRequests += 1;
      if (eventRequests === 1) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        res.write(': attached\n\n');
      } else {
        send({ error: 'temporary stream failure' }, 503);
      }
      return;
    }
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/client/register') {
        send({ token: clientToken, pid: process.pid });
      } else if (req.method === 'POST' && url.pathname === '/client/deregister') {
        send({ ok: true });
      } else {
        send({ error: 'not found' }, 404);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  let client = null;
  try {
    client = await attachSession({
      discovery: { port: address.port, token: serverToken, pid: process.pid },
      onFatal: (reason) => fatals.push(reason),
      onStreamDisconnect: (details) => disconnects.push(details),
      streamReconnectBaseMs: 5,
      streamReconnectMaxMs: 10,
      streamLivenessTimeoutMs: 20,
      streamReconnectBudgetMs: 60,
    });
    await waitForValue(() => fatals.length === 1);
    assert.match(disconnects[0]?.reason || '', /sse liveness timeout after 20ms/);
    assert.match(fatals[0], /reconnect budget exhausted/);
    assert.ok(eventRequests >= 2, 'liveness timeout must open a replacement stream');
  } finally {
    await client?.close('test end');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
