import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBridgeServer } from './bridge-server.ts';
import { createBridgeRequestHandler } from './bridge-server-request.ts';
import { createBridgeServerState } from './bridge-server-contract.ts';

// The bridge runs against a fake core: it answers `computer/bridge/run` and `computer/bridge/abort` as the core does
// (a refused request carries its HTTP status), and these tests look at what the bridge sends and answers around it.
const TOKEN = 'request-token';
const GENERATION = 3;
const IDENTITY = { token: TOKEN, generation: GENERATION, port: 4100, pid: 1, startedAt: 2 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeCore(run = async (params) => ({ ok: true, value: { text: `ran ${params.command.action}` } })) {
  const calls = [];
  const callCore = async (method, params) => {
    calls.push({ method, params });
    if (method === 'computer/bridge/abort') return { ok: true, cancelled: 0 };
    return run(params);
  };
  return {
    calls,
    callCore,
    runs: () => calls.filter((call) => call.method === 'computer/bridge/run').map((call) => call.params),
    aborts: () => calls.filter((call) => call.method === 'computer/bridge/abort').map((call) => call.params),
  };
}

function requestOf({ method = 'POST', url = '/command', token = TOKEN, body = '' } = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = url;
  request.headers = token ? { authorization: `Bearer ${token}` } : {};
  return request;
}

function responseOf() {
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroy = () => {};
  response.writeHead = (status) => {
    response.opened = status;
  };
  response.write = (text) => {
    response.written = text;
  };
  return response;
}

function bridge({ core = fakeCore(), state = {} } = {}) {
  const replies = new Map();
  const live = { ...createBridgeServerState(), discoveryRecord: IDENTITY, ...state };
  const handle = createBridgeRequestHandler(
    {
      host: { callCore: core.callCore },
      state: live,
      respond: (response, status, body) => {
        response.writableEnded = true;
        replies.get(response)?.({ status, body });
      },
    },
    TOKEN,
    GENERATION
  );
  const send = (request, response = responseOf()) => {
    const answered = new Promise((resolve) => replies.set(response, resolve));
    handle(request, response);
    return answered;
  };
  return { handle, send, core, state: live };
}

const command = (body) => requestOf({ body: JSON.stringify(body) });

test('health answers only an authorized probe of the active generation', async () => {
  const { send } = bridge();
  assert.deepEqual(await send(requestOf({ method: 'GET', url: '/health', token: 'wrong' })), {
    status: 401,
    body: { ok: false, error: 'unauthorized' },
  });
  const { token: _token, ...publicIdentity } = IDENTITY;
  assert.deepEqual(await send(requestOf({ method: 'GET', url: '/health' })), {
    status: 200,
    body: { ok: true, identity: publicIdentity },
  });
  for (const discoveryRecord of [null, { ...IDENTITY, token: 'old' }, { ...IDENTITY, generation: 2 }]) {
    assert.deepEqual(await bridge({ state: { discoveryRecord } }).send(requestOf({ method: 'GET', url: '/health' })), {
      status: 503,
      body: { ok: false, error: 'bridge generation is not active' },
    });
  }
});

test('unknown routes are not found before authorization; known posts need the token', async () => {
  const { send, core } = bridge();
  for (const request of [
    requestOf({ method: 'GET', url: '/command', token: '' }),
    requestOf({ url: '/other', token: '' }),
  ]) {
    assert.deepEqual(await send(request), { status: 404, body: { ok: false, error: 'not found' } });
  }
  for (const url of ['/command', '/owner']) {
    assert.deepEqual(await send(requestOf({ url, token: 'wrong' })), {
      status: 401,
      body: { ok: false, error: 'unauthorized' },
    });
  }
  assert.deepEqual(core.calls, []);
});

test('a malformed or forbidden command is a 400 naming why, and never reaches the core', async () => {
  const { send, core } = bridge();
  assert.equal((await send(requestOf({ body: '{' }))).status, 400);
  assert.match((await send(requestOf({ body: '{' }))).body.error, /^invalid request: /);
  assert.deepEqual(await send(command([])), {
    status: 400,
    body: { ok: false, error: 'invalid request: invalid_request: computer command must be an object' },
  });
  for (const body of [
    { action: 'capture', session_id: '__computer_host_warmup__' },
    { action: 'capture', session_id: '__computer_user_wait__' },
    { action: 'capture', session_id: '__computer_window_arrivals__' },
    { action: 'capture', session_id: '__mixdog_browser_chrome_setup__' },
    { action: 'capture', session_id: 's', known_injection_tick: 1 },
  ]) {
    assert.match((await send(command(body))).body.error, /^invalid request: computer_policy_denied: /);
  }
  // The owner connection's actions are only ever sent through /owner.
  for (const action of ['owner_attach', 'owner_detach', 'launch_anything']) {
    assert.deepEqual(await send(command({ action, session_id: 's' })), {
      status: 400,
      body: { ok: false, error: 'invalid request: invalid_action: computer bridge action is not available' },
    });
  }
  assert.deepEqual(core.calls, []);
});

test('a command runs once in the core under its session and is answered with the core reply', async () => {
  const core = fakeCore();
  const { send } = bridge({ core });
  assert.deepEqual(await send(command({ action: 'list_windows', session_id: 's', turn_id: 4, runtime_id: 'r' })), {
    status: 200,
    body: { ok: true, value: { text: 'ran list_windows' } },
  });
  const [run] = core.runs();
  assert.equal(core.runs().length, 1);
  assert.deepEqual(run.command, { action: 'list_windows', session_id: 's', turn_id: 4, runtime_id: 'r' });
  assert.equal(run.sessionKey, 's');
  assert.ok(run.signalId);
  await send(command({ action: 'list_windows' }));
  assert.equal(core.runs()[1].sessionKey, 'default');
});

test('a reply carries its image; a refusal keeps the status the core gave it', async () => {
  const image = { data: 'AAAA', mimeType: 'image/png' };
  const core = fakeCore(async ({ command: sent }) => {
    if (sent.action === 'capture') return { ok: true, value: { text: 'frame', image } };
    if (sent.action === 'list_windows') return { ok: false, error: 'computer_capacity_exhausted: too many active requests', status: 429 };
    if (sent.action === 'execution_end') return { ok: false, error: 'invalid request: nope', status: 400 };
    return { ok: false, error: 'worker gone' };
  });
  const { send } = bridge({ core });
  assert.deepEqual(await send(command({ action: 'capture', session_id: 's' })), {
    status: 200,
    body: { ok: true, value: { text: 'frame', image } },
  });
  assert.deepEqual(await send(command({ action: 'list_windows', session_id: 's' })), {
    status: 429,
    body: { ok: false, error: 'computer_capacity_exhausted: too many active requests' },
  });
  assert.deepEqual(await send(command({ action: 'execution_end', session_id: 's' })), {
    status: 400,
    body: { ok: false, error: 'invalid request: nope' },
  });
  assert.deepEqual(await send(command({ action: 'click', session_id: 's' })), {
    status: 200,
    body: { ok: false, error: 'worker gone' },
  });
});

test('a call the core could not take is a failed command, not a dropped connection', async () => {
  const core = fakeCore(async () => {
    throw new Error('core is not connected');
  });
  assert.deepEqual(await bridge({ core }).send(command({ action: 'list_windows', session_id: 's' })), {
    status: 200,
    body: { ok: false, error: 'core is not connected' },
  });
});

test('the commands the runtime alone sends run in the core like any other', async () => {
  const core = fakeCore();
  const { send } = bridge({ core });
  for (const body of [
    { action: 'secret_bind', session_id: 's', request_id: 'q', window_id: 'hwnd:0x1', ref: 'e1' },
    { action: 'secret_input', session_id: 's', request_id: 'q', window_id: 'hwnd:0x1', ref: 'e1' },
    { action: 'fill_saved_login', session_id: 's', turn_id: 7, runtime_id: 'r' },
    { action: 'turn_settle', session_id: 's', turn_id: 7, runtime_id: 'r' },
    { action: 'session_abort', session_id: 's' },
    { action: 'execution_end', session_id: 's' },
    { action: 'session_release', session_id: 's' },
    { action: 'wait_for_user', session_id: 's', timeout_ms: 3000 },
  ]) {
    assert.equal((await send(command(body))).status, 200, body.action);
  }
  assert.deepEqual(
    core.runs().map((run) => run.command.action),
    ['secret_bind', 'secret_input', 'fill_saved_login', 'turn_settle', 'session_abort', 'execution_end', 'session_release', 'wait_for_user']
  );
});

test('a dropped caller ends its own call in the core once, and a finished call is not ended', async () => {
  let started;
  const running = new Promise((resolve) => (started = resolve));
  const core = fakeCore(async () => {
    started();
    return new Promise(() => {});
  });
  const { handle } = bridge({ core });
  const request = command({ action: 'list_windows', session_id: 'dropped' });
  const response = responseOf();
  handle(request, response);
  await running;
  response.emit('close');
  request.emit('aborted');
  await settle();
  assert.deepEqual(core.aborts(), [{ sessionKey: 'dropped', signalId: core.runs()[0].signalId }]);

  const finished = fakeCore();
  const kept = bridge({ core: finished });
  const response2 = responseOf();
  await kept.send(command({ action: 'list_windows', session_id: 'kept' }), response2);
  response2.emit('close');
  await settle();
  assert.deepEqual(finished.aborts(), []);
});

test('the saved-login owner is attached with its process and detached once when its connection closes', async () => {
  const core = fakeCore();
  const { handle } = bridge({ core });
  const response = responseOf();
  handle(requestOf({ url: '/owner', body: JSON.stringify({ runtime_id: 'owner-1', pid: 4242 }) }), response);
  await settle();
  assert.equal(response.opened, 200);
  assert.equal(response.written, '{"ok":true}\n');
  assert.deepEqual(core.runs().map((run) => run.command), [{ action: 'owner_attach', runtime_id: 'owner-1', pid: 4242 }]);
  response.emit('close');
  response.emit('close');
  await settle();
  assert.deepEqual(core.runs().map((run) => run.command).slice(1), [{ action: 'owner_detach', runtime_id: 'owner-1' }]);

  const refusing = fakeCore(async () => ({ ok: false, error: 'invalid request: unknown or ended runtime owner' }));
  const refused = { status: 400, body: { ok: false, error: 'invalid request: unknown or ended runtime owner' } };
  assert.deepEqual(
    await bridge({ core: refusing }).send(requestOf({ url: '/owner', body: JSON.stringify({ runtime_id: 'o', pid: 1 }) })),
    refused
  );
  // No process to bind: refused without asking the core.
  const idle = fakeCore();
  for (const body of ['{', JSON.stringify({ runtime_id: 'o' }), JSON.stringify({ runtime_id: 'o', pid: 0 })]) {
    assert.deepEqual(await bridge({ core: idle }).send(requestOf({ url: '/owner', body })), refused);
  }
  assert.deepEqual(idle.calls, []);
});

test('a connection that closes while its owner is being attached detaches at once and is never answered', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const core = fakeCore(async ({ command: sent }) => {
    if (sent.action === 'owner_attach') await gate;
    return { ok: true, value: { text: 'done' } };
  });
  const { handle } = bridge({ core });
  const response = responseOf();
  handle(requestOf({ url: '/owner', body: JSON.stringify({ runtime_id: 'owner-2', pid: 7 }) }), response);
  await settle();
  response.emit('close');
  release();
  await settle();
  assert.equal(response.opened, undefined);
  assert.deepEqual(core.runs().map((run) => run.command.action), ['owner_attach', 'owner_detach']);
});

test('the published bridge forwards over loopback and a stop ends every session that used it in the core', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-bridge-forward-'));
  let enabled = true;
  let watcher;
  let deadline;
  const discovery = new Promise((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('discovery timeout')), 5000);
    watcher = watch(directory, async () => {
      try {
        const value = JSON.parse(await readFile(join(directory, 'computer-bridge.json'), 'utf8'));
        if (!value.port) return;
        clearTimeout(deadline);
        watcher.close();
        resolve(value);
      } catch {
        /* discovery is atomically published */
      }
    });
  });
  const core = fakeCore();
  const server = createBridgeServer({
    dataDirectory: () => directory,
    isBridgeWanted: () => enabled,
    isDisposed: () => false,
    diagnose() {},
    callCore: core.callCore,
  });
  try {
    server.startBridge();
    const record = await discovery;
    const send = (body) =>
      fetch(`http://127.0.0.1:${record.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json());
    assert.deepEqual(await send({ action: 'list_windows', session_id: 'a' }), {
      ok: true,
      value: { text: 'ran list_windows' },
    });
    assert.equal((await send({ action: 'list_windows', session_id: 'b' })).ok, true);
    assert.equal((await send({ action: 'input_idle_state', session_id: '__computer_user_wait__' })).ok, false);
    assert.deepEqual(core.aborts(), []);
    enabled = false;
    await server.stopBridge();
    assert.deepEqual(
      core.aborts().map((abort) => abort.sessionKey).sort(),
      ['a', 'b']
    );
    assert.ok(core.aborts().every((abort) => abort.signalId === undefined));
  } finally {
    clearTimeout(deadline);
    watcher?.close();
    enabled = false;
    await server.stopBridge();
    await rm(directory, { recursive: true, force: true });
  }
});
