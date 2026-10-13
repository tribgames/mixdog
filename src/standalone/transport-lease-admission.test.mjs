import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createChannelTransport } from './channel-transport.mjs';
import { createSessionTransport } from './session-transport.mjs';
import { SESSION_PROTOCOL } from './session-wire.mjs';

// Regression: the owner-lease admission ran only before the request body was
// read. A daemon fenced while a body was still arriving dispatched the call
// anyway. Each route must re-check right before it hands the work on.

const TOKEN = 'tok';

/** POSTs `body` in two halves; `between()` runs after the route has started
 *  reading (first admission passed) and before the rest arrives. */
function postInHalves(port, path, body, between = () => {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          'X-Mixdog-Daemon-Token': TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }
    );
    req.on('error', reject);
    const half = Math.floor(payload.length / 2);
    req.write(payload.subarray(0, half));
    delay(80).then(() => {
      between();
      req.end(payload.subarray(half));
    });
  });
}

function post(port, path, body) {
  return postInHalves(port, path, body);
}

function leaseGate() {
  const gate = { admitted: true, asked: 0 };
  gate.admit = () => {
    gate.asked += 1;
    return gate.admitted;
  };
  return gate;
}

test('session transport: a lease fenced while the /call body arrives is not dispatched', async (t) => {
  const gate = leaseGate();
  const calls = [];
  const transport = createSessionTransport({
    handleCall: async (name) => {
      calls.push(name);
      return { ok: true };
    },
    serverToken: TOKEN,
    admitWork: gate.admit,
  });
  const { port } = await transport.start();
  t.after(() => transport.stop());
  const registered = await post(port, '/client/register', {
    protocol: SESSION_PROTOCOL,
    leadPid: process.pid,
    cwd: process.cwd(),
    lifecycle: false,
  });
  assert.equal(registered.status, 200, registered.body);
  const clientToken = JSON.parse(registered.body).token;

  // Control: admitted throughout, the same slow body is dispatched.
  const served = await postInHalves(port, '/call', { token: clientToken, name: 'first', args: {} });
  assert.equal(served.status, 200, served.body);
  assert.deepEqual(calls, ['first']);

  const fenced = await postInHalves(port, '/call', { token: clientToken, name: 'second', args: {} }, () => {
    gate.admitted = false;
  });
  assert.equal(fenced.status, 503);
  assert.match(fenced.body, /daemon owner lease is not held/);
  assert.deepEqual(calls, ['first'], 'the call was not dispatched after fencing');

  // Registration is gated after its body too.
  const late = await postInHalves(port, '/client/register', { protocol: SESSION_PROTOCOL, leadPid: process.pid });
  assert.equal(late.status, 503);
});

test('channel transport: register, call and agent dispatch fenced mid-body are not handled', async (t) => {
  const gate = leaseGate();
  const calls = [];
  const dispatched = [];
  const transport = createChannelTransport({
    handleCall: async (name) => {
      calls.push(name);
      return { ok: true };
    },
    serverToken: TOKEN,
    admitWork: gate.admit,
    agentBroker: {
      dispatch: async (params) => {
        dispatched.push(params.id);
        return { ok: true };
      },
      cancel: () => false,
    },
  });
  const { port } = await transport.start();
  t.after(() => transport.stop());

  // Controls, admitted throughout.
  const registered = await postInHalves(port, '/client/register', { leadPid: process.pid, cwd: process.cwd() });
  assert.equal(registered.status, 200, registered.body);
  const clientToken = JSON.parse(registered.body).token;
  const served = await postInHalves(port, '/call', { token: clientToken, name: 'first', args: {} });
  assert.equal(served.status, 200, served.body);
  assert.deepEqual(calls, ['first']);
  const agentServed = await postInHalves(port, '/agent/dispatch', { callId: 'a1', params: { id: 'a1' } });
  assert.equal(agentServed.status, 200, agentServed.body);
  assert.deepEqual(dispatched, ['a1']);

  const fence = () => {
    gate.admitted = false;
  };
  const cases = [
    ['/client/register', { leadPid: process.pid, cwd: process.cwd() }],
    ['/call', { token: clientToken, name: 'second', args: {} }],
    ['/agent/dispatch', { callId: 'a2', params: { id: 'a2' } }],
  ];
  for (const [path, body] of cases) {
    gate.admitted = true;
    const asked = gate.asked;
    const response = await postInHalves(port, path, body, fence);
    assert.equal(response.status, 503, `${path}: ${response.body}`);
    assert.match(response.body, /daemon owner lease is not held/);
    assert.ok(gate.asked - asked >= 2, `${path} re-checked admission after its body`);
  }
  assert.deepEqual(calls, ['first'], 'no call dispatched after fencing');
  assert.deepEqual(dispatched, ['a1'], 'no agent dispatch after fencing');
  gate.admitted = true;
  const health = await new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve(JSON.parse(text)));
      })
      .on('error', reject);
  });
  assert.equal(health.clients, 1, 'no client registered after fencing');
});
