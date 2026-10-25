import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  GLOBAL_FAIL_LIMIT,
  IP_BACKOFF_BASE_MS,
  IP_FAILS_PER_STRIKE,
  PAIR_CODE_TTL_MS,
  PairCodes,
} from './pair-codes.mjs';
import { startRelay } from '../server.mjs';

const clock = () => {
  const state = { now: 1_000_000 };
  return { state, now: () => state.now };
};

const LEASE = 'lease-0001';
let leaseCounter = 0;
const nextLease = () => {
  leaseCounter += 1;
  return `lease-${String(leaseCounter).padStart(6, '0')}`;
};
const issue = (codes, deviceId = randomUUID(), name = '') => {
  const issued = codes.issue(deviceId, nextLease(), name);
  assert.equal(issued.status, 'ok');
  return { ...issued, deviceId };
};

test('a code resolves once, to its device, and is then spent', () => {
  const { now } = clock();
  const codes = new PairCodes({ now });
  const deviceId = randomUUID();
  const issued = codes.issue(deviceId, LEASE, 'Home PC');
  assert.equal(issued.status, 'ok');
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(issued.lease, LEASE);
  assert.equal(issued.ttlMs, PAIR_CODE_TTL_MS);
  const first = codes.resolve(issued.code, '1.1.1.1');
  assert.equal(first.status, 'ok');
  assert.equal(first.deviceId, deviceId);
  assert.equal(first.name, 'Home PC');
  assert.equal(first.lease, LEASE);
  assert.match(first.ticket, /^[0-9a-f]{32}$/);
  assert.equal(codes.resolve(issued.code, '1.1.1.1').status, 'invalid');
});

test('a code expires after five minutes and a new lease replaces the old without extending it', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  const deviceId = randomUUID();
  const first = codes.issue(deviceId, nextLease(), '');
  state.now += PAIR_CODE_TTL_MS - 1_000;
  const second = codes.issue(deviceId, nextLease(), '');
  assert.notEqual(second.lease, first.lease);
  assert.equal(codes.codes.size, 1, 'one live code per device');
  state.now += PAIR_CODE_TTL_MS - 1_000;
  assert.equal(codes.resolve(second.code, 'a').status, 'ok');
  const third = codes.issue(deviceId, nextLease(), '');
  state.now += PAIR_CODE_TTL_MS + 1;
  assert.equal(codes.resolve(third.code, 'b').status, 'invalid');
});

test('callers cannot choose codes: malformed leases are refused and issued codes are relay-generated', () => {
  const codes = new PairCodes();
  const a = randomUUID();
  for (const bad of ['short', 'has space!!', 123456, null, '123456'])
    assert.equal(codes.issue(a, bad, '').status, 'invalid');
  assert.equal(codes.issue('not-an-id', LEASE, '').status, 'invalid');
  assert.equal(typeof codes.register, 'undefined');
  const issued = new Set();
  for (let i = 0; i < 200; i += 1) issued.add(issue(codes).code);
  assert.equal(issued.size, 200, 'concurrent devices never share a code');
});

test('a ticket is single use and bound to its device', () => {
  const codes = new PairCodes();
  const deviceId = randomUUID();
  const { ticket } = codes.resolve(issue(codes, deviceId).code, 'ip');
  assert.equal(codes.takeTicket(ticket, randomUUID()), false);
  const second = codes.resolve(issue(codes, deviceId).code, 'ip');
  assert.equal(codes.takeTicket(second.ticket, deviceId), true);
  assert.equal(codes.takeTicket(second.ticket, deviceId), false);
  assert.equal(codes.takeTicket('nope', deviceId), false);
});

test('wrong guesses lock a source out with a growing backoff, even for a right code', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  const right = issue(codes).code;
  const wrong = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) assert.equal(codes.resolve(wrong, 'bad').status, 'invalid');
  const locked = codes.resolve(right, 'bad');
  assert.equal(locked.status, 'limited');
  assert.equal(locked.retryAfterMs, IP_BACKOFF_BASE_MS);
  // Another source is unaffected.
  state.now += 1;
  state.now -= 1;
  state.now += IP_BACKOFF_BASE_MS;
  for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) codes.resolve(wrong, 'bad');
  assert.equal(codes.resolve(right, 'bad').retryAfterMs, IP_BACKOFF_BASE_MS * 2);
  state.now += IP_BACKOFF_BASE_MS * 2;
  assert.equal(codes.resolve(right, 'bad').status, 'ok');
});

test('the whole code space shares one guess budget across sources', () => {
  const { state, now } = clock();
  const codes = new PairCodes({ now });
  const right = issue(codes).code;
  const wrong = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < GLOBAL_FAIL_LIMIT; i += 1) assert.equal(codes.resolve(wrong, `src-${i}`).status, 'invalid');
  const blocked = codes.resolve(right, 'fresh-source');
  assert.equal(blocked.status, 'limited');
  state.now += 10 * 60_000 + 1;
  const fresh = issue(codes).code;
  assert.equal(codes.resolve(fresh, 'fresh-source').status, 'ok');
});

async function withRelay(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-paircode-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  const sockets = [];
  try {
    await run(relay, `http://127.0.0.1:${relay.port}`, sockets);
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function connectDesktop(relay, sockets, { pairV2 = true } = {}) {
  const deviceId = randomUUID();
  relay.store.authenticate(deviceId, '0123456789abcdef');
  const auth = `Basic ${Buffer.from(`${deviceId}:0123456789abcdef`).toString('base64')}`;
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, { headers: { Authorization: auth } });
  sockets.push(socket);
  const frames = [];
  socket.on('message', (raw, binary) => {
    if (!binary) frames.push(JSON.parse(String(raw)));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'desktop-lanes', media: true, e2ee: 1, ...(pairV2 ? { pairV2: 1 } : {}) }));
  return { deviceId, socket, frames };
}

const until = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached');
};

const post = (origin, path, body, headers = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function requestCode(desktop, lease, name = '') {
  desktop.socket.send(JSON.stringify({ type: 'pair-code-request', lease, name }));
  await until(() => desktop.frames.some((frame) => frame.type === 'pair-code-issued' && frame.lease === lease));
  return desktop.frames.find((frame) => frame.type === 'pair-code-issued' && frame.lease === lease);
}

test('relay: a desktop can no longer register a chosen code or probe for occupied ones', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const victim = await connectDesktop(relay, sockets);
    const attacker = await connectDesktop(relay, sockets);
    const issued = await requestCode(victim, 'victim-lease-1');
    attacker.socket.send(JSON.stringify({ type: 'pair-code', code: issued.code, name: 'x' }));
    attacker.socket.send(JSON.stringify({ type: 'pair-code-request', lease: 'attacker-1', code: issued.code }));
    await until(() => attacker.frames.some((frame) => frame.type === 'pair-code-issued'));
    const answer = attacker.frames.find((frame) => frame.type === 'pair-code-issued');
    assert.equal(answer.ok, true);
    assert.equal(
      attacker.frames.some((frame) => frame.type === 'pair-code-ack'),
      false
    );
    assert.doesNotMatch(
      JSON.stringify(attacker.frames),
      new RegExp(issued.code === answer.code ? 'never' : issued.code)
    );
    assert.equal((await post(origin, '/pair-code/resolve', { code: issued.code })).status, 200);
  });
});

test('relay: a redial gets a fresh code and the old leg code dies with its socket', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    const issued = await requestCode(desktop, 'lease-first-1');
    assert.ok(issued.expiresInMs > 0);
    desktop.socket.close();
    await new Promise((resolve) => desktop.socket.once('close', resolve));
    let status = 0;
    for (let i = 0; i < 100 && status !== 404; i += 1) {
      status = (await post(origin, '/pair-code/resolve', { code: issued.code })).status;
      if (status !== 404) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status, 404);
  });
});

test('relay: /support is throttled and never returns a host name', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    desktop.socket.send(JSON.stringify({ type: 'desktop-name', name: 'Secret Host' }));
    await requestCode(desktop, 'lease-name-01', 'Secret Host');
    const first = await fetch(`${origin}/pair-code/support?deviceId=${desktop.deviceId}`);
    assert.doesNotMatch(await first.text(), /Secret Host/);
    let limited = 0;
    for (let i = 0; i < 80; i += 1) {
      const res = await fetch(`${origin}/pair-code/support?deviceId=${desktop.deviceId}`);
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0);
  });
});

test('relay: a registered code redeems into a claim the desktop sees as a code claim', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    const issued = await requestCode(desktop, 'lease-main-01', 'Home PC');
    assert.equal(issued.ok, true);
    assert.match(issued.code, /^\d{6}$/);

    const support = await (await fetch(`${origin}/pair-code/support?deviceId=${desktop.deviceId}`)).json();
    assert.deepEqual(support, { online: true, pairV2: true });

    const resolved = await post(origin, '/pair-code/resolve', { code: issued.code });
    assert.equal(resolved.status, 200);
    const body = await resolved.json();
    assert.equal(body.deviceId, desktop.deviceId);
    assert.equal(body.name, 'Home PC');
    await until(() => desktop.frames.some((frame) => frame.type === 'pair-code-used'));
    assert.equal(desktop.frames.find((frame) => frame.type === 'pair-code-used').lease, 'lease-main-01');

    const spent = await post(origin, '/pair-code/resolve', { code: issued.code });
    assert.equal(spent.status, 404);
    assert.equal((await spent.json()).status, 'invalid-code');

    const publicKey = 'A'.repeat(87);
    const claim = (ticket) =>
      post(
        origin,
        '/claim',
        { deviceId: desktop.deviceId, clientId: randomUUID(), publicKey, name: 'Phone', ...(ticket ? { ticket } : {}) },
        { Origin: origin }
      );
    assert.equal((await claim(body.ticket)).status, 202);
    await until(() => desktop.frames.some((frame) => frame.type === 'client-claim'));
    assert.equal(desktop.frames.find((frame) => frame.type === 'client-claim').method, 'code');
    // The ticket is spent: reusing it, or sending none, is a plain QR claim.
    assert.equal((await claim(body.ticket)).status, 202);
    assert.equal((await claim('0'.repeat(32))).status, 202);
    // A client retrying a code-started pairing has no ticket left: the claim is
    // labelled a retry, never a code.
    assert.equal(
      (
        await post(
          origin,
          '/claim',
          { deviceId: desktop.deviceId, clientId: randomUUID(), publicKey, name: 'Phone', retry: true },
          { Origin: origin }
        )
      ).status,
      202
    );
    await until(() => desktop.frames.filter((frame) => frame.type === 'client-claim').length === 4);
    assert.deepEqual(
      desktop.frames.filter((frame) => frame.type === 'client-claim').map((frame) => frame.method),
      ['code', 'qr', 'qr', 'retry']
    );
  });
});

test('relay: wrong guesses are limited per source and never echo the code', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const desktop = await connectDesktop(relay, sockets);
    const { code } = await requestCode(desktop, 'lease-limit-1');
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < IP_FAILS_PER_STRIKE; i += 1) {
      assert.equal((await post(origin, '/pair-code/resolve', { code: wrong })).status, 404);
    }
    const limited = await post(origin, '/pair-code/resolve', { code });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.doesNotMatch(JSON.stringify(await limited.json()), new RegExp(code));
  });
});

test('relay: oversize and malformed code requests are refused, cross-origin callers too', async () => {
  await withRelay(async (_relay, origin) => {
    assert.equal((await post(origin, '/pair-code/resolve', { code: 'x'.repeat(5000) })).status, 400);
    assert.equal((await post(origin, '/pair-code/resolve', { code: 'abc' })).status, 404);
    assert.equal(
      (await post(origin, '/pair-code/resolve', { code: '123456' }, { Origin: 'https://evil.example' })).status,
      403
    );
    const preflight = await fetch(`${origin}/pair-code/resolve`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    const page = await fetch(`${origin}/connect`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/);
  });
});

test('relay: /app is a parameterless install page, never the web client or an app launcher', async () => {
  await withRelay(async (_relay, origin) => {
    for (const path of ['/app', `/app?d=${randomUUID()}&x=1`]) {
      const page = await fetch(`${origin}${path}`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') || '', /text\/html/);
      const html = await page.text();
      assert.match(html, /https:\/\/testflight\.apple\.com\/join\/UNPBM2hU/);
      assert.match(html, /github\.com\/tribgames\/mixdog\/releases/);
      assert.match(html, /Install Mixdog/);
      assert.doesNotMatch(html, /mixdog:\/\//);
      assert.doesNotMatch(html, /<a[^>]+href="[^"]*\/d\//);
    }
    const raw = await (await fetch(`${origin}/app`)).text();
    assert.match(raw, /<h1 class="mxp-title" id="heading">Install Mixdog<\/h1>/);
    assert.match(raw, /<a[^>]+href="https:\/\/testflight\.apple\.com\/join\/UNPBM2hU"[^>]*>Get it for iPhone<\/a>/);
    assert.match(raw, /<a[^>]+href="[^"]*releases[^"]*"[^>]*>Get it for Android<\/a>/);
    assert.equal((await fetch(`${origin}/app`, { method: 'POST' })).status, 405);
  });
});

test('relay: an old desktop is reported as not supporting pairing v2, and presence is per route', async () => {
  await withRelay(async (relay, origin, sockets) => {
    const old = await connectDesktop(relay, sockets, { pairV2: false });
    await until(() => old.frames.length > 0);
    const support = await (await fetch(`${origin}/pair-code/support?deviceId=${old.deviceId}`)).json();
    assert.deepEqual(support, { online: true, pairV2: false });
    const stranger = randomUUID();
    const presence = await (await post(origin, '/pair-code/presence', { ids: [old.deviceId, stranger] })).json();
    assert.deepEqual(presence, { online: { [old.deviceId]: true } });
  });
});
