import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBridgeRequestHandler } from './bridge-server-request.ts';

const TOKEN = 'request-token';
const GENERATION = 3;
const IDENTITY = { token: TOKEN, generation: GENERATION, port: 4100, pid: 1, startedAt: 2 };

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
  return response;
}

/** One handler over a stub host; `answered` resolves with each response's first reply. */
function bridge({ host = {}, state = {} } = {}) {
  const replies = new Map();
  const aborted = [];
  const reaped = [];
  const live = { activeRequests: 0, discoveryRecord: IDENTITY, ...state };
  const handle = createBridgeRequestHandler(
    {
      host: {
        abortComputerSession: async (command) => {
          aborted.push(command);
          return { text: 'aborted' };
        },
        executeSerialized: async (command) => ({ text: `ran ${command.action}` }),
        reapIdleSessionWorkers: () => reaped.push(true),
        ...host,
      },
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
  return { handle, send, aborted, reaped, state: live };
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
  const { send } = bridge();
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
});

test('a malformed or forbidden command is a 400 naming why', async () => {
  const { send, reaped } = bridge();
  assert.equal((await send(requestOf({ body: '{' }))).status, 400);
  assert.match((await send(requestOf({ body: '{' }))).body.error, /^invalid request: /);
  assert.deepEqual(await send(command([])), {
    status: 400,
    body: { ok: false, error: 'invalid request: invalid_request: computer command must be an object' },
  });
  assert.deepEqual(reaped, []);
});

test('capacity leaves lifecycle controls headroom over ordinary commands', async () => {
  const refused = { status: 429, body: { ok: false, error: 'computer_capacity_exhausted: too many active requests' } };
  const busy = bridge({ state: { activeRequests: 32 } });
  assert.deepEqual(await busy.send(command({ action: 'list_windows', session_id: 's' })), refused);
  assert.deepEqual(await busy.send(command({ action: 'execution_end', session_id: 's' })), {
    status: 200,
    body: { ok: true, value: { text: 'ran execution_end' } },
  });
  const full = bridge({ state: { activeRequests: 40 } });
  assert.deepEqual(await full.send(command({ action: 'execution_end', session_id: 's' })), refused);
});

test('a command runs once, reclaims idle workers first and releases its slot', async () => {
  const seen = [];
  const { send, reaped, state } = bridge({
    host: {
      executeSerialized: async (request) => {
        seen.push([request.action, state.activeRequests, reaped.length]);
        return { text: 'done' };
      },
    },
  });
  assert.deepEqual(await send(command({ action: 'list_windows', session_id: 's' })), {
    status: 200,
    body: { ok: true, value: { text: 'done' } },
  });
  assert.deepEqual(seen, [['list_windows', 1, 1]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.activeRequests, 0);
});

test('an oversized or failed reply is an error reply, never a partial value', async () => {
  const invalid = bridge({ host: { executeSerialized: async () => ({ text: 'x'.repeat(1_000_001) }) } });
  assert.deepEqual(await invalid.send(command({ action: 'list_windows', session_id: 's' })), {
    status: 200,
    body: { ok: false, error: 'computer bridge returned invalid or oversized text' },
  });
  // Valid in every field, yet past the transport budget as a whole.
  const huge = bridge({
    host: { executeSerialized: async () => ({ text: 'big', padding: 'x'.repeat(33 * 1024 * 1024) }) },
  });
  assert.deepEqual(await huge.send(command({ action: 'list_windows', session_id: 's' })), {
    status: 200,
    body: {
      ok: false,
      error: 'computer response exceeds byte limit; input may have executed and was not replayed',
    },
  });
  const failing = bridge({
    host: {
      executeSerialized: async () => {
        throw new Error('worker gone');
      },
    },
  });
  assert.deepEqual(await failing.send(command({ action: 'list_windows', session_id: 's' })), {
    status: 200,
    body: { ok: false, error: 'worker gone' },
  });
});

test('a dropped caller aborts its session once, except a user wait or a lifecycle control', async () => {
  for (const [action, expectAbort] of [
    ['list_windows', true],
    ['wait_for_user', false],
    ['execution_end', false],
  ]) {
    let started;
    const running = new Promise((resolve) => (started = resolve));
    const { handle, aborted } = bridge({
      host: {
        executeSerialized: (request) => {
          started(request);
          return new Promise(() => {});
        },
        waitForUser: (request) => {
          started(request);
          return new Promise(() => {});
        },
      },
    });
    const request = command({ action, session_id: 'dropped' });
    const response = responseOf();
    handle(request, response);
    await running;
    response.emit('close');
    request.emit('aborted');
    assert.deepEqual(
      aborted.map((entry) => entry.action),
      expectAbort ? [action] : [],
      action
    );
  }
});

test('session_abort ends the visible execution after the host abort', async () => {
  const { send, aborted } = bridge();
  assert.deepEqual(await send(command({ action: 'session_abort', session_id: 'gone' })), {
    status: 200,
    body: { ok: true, value: { text: 'aborted' } },
  });
  assert.deepEqual(
    aborted.map((entry) => entry.session_id),
    ['gone']
  );
});
