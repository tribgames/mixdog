import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPairCodeManager,
  PAIR_CODE_RENEW_BEFORE_MS,
  PAIR_CODE_REQUEST_TIMEOUT_MS,
  PAIR_CODE_TTL_MS,
} from './remote-pair-code.ts';
import {
  fetchHostPresence,
  parsePairCodeInput,
  redeemPairCode,
  relayHttpOrigin,
  remoteHostId,
} from './remote-hosts.ts';

const setup = ({ connected = true } = {}) => {
  const sent = [];
  const clock = { now: 1_000 };
  let leases = 0;
  const link = { connected };
  const manager = createPairCodeManager({
    sendEnvelope: (frame) => {
      if (!link.connected) return false;
      sent.push(frame);
      return true;
    },
    hostName: 'Home PC',
    now: () => clock.now,
    newLease: () => `lease-${(leases += 1)}`,
  });
  const issue = (lease, code, expiresInMs = PAIR_CODE_TTL_MS) =>
    manager.onIssued({ type: 'pair-code-issued', lease, ok: true, code, expiresInMs });
  return { manager, sent, clock, issue, link };
};

test('no code is shown until the relay issues one, and the lease expiry is not extended', () => {
  const { manager, sent, clock, issue } = setup();
  assert.equal(manager.ensure(), null);
  assert.deepEqual(sent, [{ type: 'pair-code-request', lease: 'lease-1', name: 'Home PC' }]);
  assert.equal(manager.ensure(), null);
  assert.equal(sent.length, 1, 'one outstanding request');
  issue('lease-1', '111111');
  const first = manager.ensure();
  assert.deepEqual(first, { code: '111111', expiresAt: 1_000 + PAIR_CODE_TTL_MS });
  clock.now += 10_000;
  assert.equal(manager.ensure().expiresAt, 1_000 + PAIR_CODE_TTL_MS);
  clock.now += PAIR_CODE_TTL_MS;
  assert.equal(manager.ensure(), null);
  assert.equal(sent.at(-1).lease, 'lease-2');
});

test('near expiry the next code is requested while the current one stays shown', () => {
  const { manager, sent, clock, issue } = setup();
  manager.ensure();
  issue('lease-1', '111111');
  clock.now += PAIR_CODE_TTL_MS - PAIR_CODE_RENEW_BEFORE_MS - 1;
  assert.equal(manager.ensure().code, '111111');
  assert.equal(sent.length, 1, 'no early request before the renew window');
  clock.now += 2;
  assert.equal(manager.ensure().code, '111111', 'the current code stays until the next one lands');
  assert.equal(sent.at(-1).lease, 'lease-2');
  assert.equal(manager.ensure().code, '111111');
  assert.equal(sent.length, 2, 'one outstanding early request');
  issue('lease-2', '222222');
  assert.deepEqual(manager.ensure(), { code: '222222', expiresAt: clock.now + PAIR_CODE_TTL_MS });
});

test('an issue answer for another lease is ignored', () => {
  const { manager, issue } = setup();
  manager.ensure();
  issue('lease-other', '222222');
  assert.equal(manager.ensure(), null);
});

test('renew asks for a new code; used spends only its own lease; release withdraws', () => {
  const { manager, sent, issue } = setup();
  manager.ensure();
  issue('lease-1', '111111');
  assert.equal(manager.ensure(true), null);
  assert.equal(sent.at(-1).lease, 'lease-2');
  issue('lease-2', '222222');
  manager.onUsed({ type: 'pair-code-used', lease: 'lease-1' });
  assert.equal(manager.ensure().code, '222222', 'a stale used notice spends nothing');
  manager.onUsed({ type: 'pair-code-used', lease: 'lease-2' });
  assert.equal(manager.ensure(), null);
  assert.equal(sent.at(-1).lease, 'lease-3');
  issue('lease-3', '333333');
  manager.release();
  assert.deepEqual(sent.at(-1), { type: 'pair-code-clear' });
  const count = sent.length;
  manager.release();
  assert.equal(sent.length, count, 'releasing nothing sends nothing');
});

test('a reconnect never republishes the old code: it requests a fresh one', () => {
  const { manager, sent, issue } = setup();
  manager.ensure();
  issue('lease-1', '111111');
  manager.onConnected();
  assert.deepEqual(sent.at(-1), { type: 'pair-code-request', lease: 'lease-2', name: 'Home PC' });
  assert.equal(sent.filter((frame) => frame.code).length, 0);
  assert.equal(manager.ensure(), null, 'the old code is not shown while the new one is pending');
  issue('lease-1', '111111');
  assert.equal(manager.ensure(), null, 'a late answer for the old lease is ignored');
  issue('lease-2', '444444');
  assert.equal(manager.ensure().code, '444444');
  manager.release();
  const count = sent.length;
  manager.onConnected();
  assert.equal(sent.length, count, 'a closed screen requests nothing on connect');
});

test('an unanswered or refused request reports unsupported instead of a code, until the next connection', () => {
  const { manager, clock, issue } = setup();
  assert.equal(manager.ensure(), null);
  clock.now += PAIR_CODE_REQUEST_TIMEOUT_MS + 1;
  assert.deepEqual(manager.ensure(), { unsupported: true });
  assert.deepEqual(manager.ensure(true), { unsupported: true });
  manager.onConnected();
  assert.equal(manager.ensure(), null);
  manager.onIssued({ type: 'pair-code-issued', lease: 'lease-2', ok: false });
  assert.deepEqual(manager.ensure(), { unsupported: true });
  issue('lease-2', '555555');
  assert.deepEqual(manager.ensure(), { unsupported: true });
});

test('a request made while offline is not counted as unanswered', () => {
  const { manager, clock, link, sent } = setup({ connected: false });
  assert.equal(manager.ensure(), null);
  clock.now += PAIR_CODE_REQUEST_TIMEOUT_MS * 3;
  assert.equal(manager.ensure(), null);
  link.connected = true;
  assert.equal(manager.ensure(), null);
  assert.equal(sent.length, 1);
});

test('codes are typed in any grouping and never contain anything but six digits', () => {
  assert.equal(parsePairCodeInput('482·917'), '482917');
  assert.equal(parsePairCodeInput('482 917'), '482917');
  assert.equal(parsePairCodeInput('48291'), null);
  assert.equal(parsePairCodeInput('12345a'), null);
  assert.equal(relayHttpOrigin('wss://relay.example.com/'), 'https://relay.example.com');
  assert.equal(relayHttpOrigin('ws://127.0.0.1:9800'), 'http://127.0.0.1:9800');
});

const reply = (status, body) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('redeeming a code maps every relay answer to a message that says what to do', async () => {
  const device = '0123456789abcdef0123456789abcdef';
  const ok = await redeemPairCode(
    'https://r',
    '482917',
    reply(200, { deviceId: device, name: 'Home PC', ticket: 'a'.repeat(32) })
  );
  assert.deepEqual(ok, { deviceId: device, name: 'Home PC', ticket: 'a'.repeat(32) });
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(404, { status: 'invalid-code' })),
    /wrong or has expired/
  );
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(429, { status: 'rate-limited', retryAfter: 42 })),
    /42 seconds/
  );
  // A relay that predates codes answers 404 without the JSON status.
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(404, 'Not found')),
    /Codes are not available on this connection server yet/
  );
});

test('saved PC presence is asked per relay and unknown relays stay unknown', async () => {
  const device = '0123456789abcdef0123456789abcdef';
  const url = `https://r.example/d/${device}/`;
  const calls = [];
  const online = await fetchHostPresence([{ id: remoteHostId(url), url }], async (target, init) => {
    calls.push([target, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ online: { [device]: true } }));
  });
  assert.equal(online.get(remoteHostId(url)), true);
  assert.deepEqual(calls, [['https://r.example/pair-code/presence', { ids: [device] }]]);
  const down = await fetchHostPresence([{ id: 'x', url }], async () => {
    throw new Error('offline');
  });
  assert.equal(down.has('x'), false);
});

test('redeemPairCode messages go through the supplied translator, in v4 wording', async () => {
  const translate = (key) => `[${key}]`;
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(429, { status: 'rate-limited', retryAfter: 42 }), translate),
    /\[Too many attempts. Try again in 42 seconds.\]/
  );
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(404, { status: 'invalid-code' }), translate),
    /\[The code is wrong or has expired.\]/
  );
  await assert.rejects(
    redeemPairCode('https://r', '000000', reply(404, 'Not found'), translate),
    /\[Codes are not available on this connection server yet/
  );
  const english = await redeemPairCode('https://r', '000000', reply(404, { status: 'invalid-code' })).catch(
    (error) => error.message
  );
  assert.doesNotMatch(english, /main PC/);
});
