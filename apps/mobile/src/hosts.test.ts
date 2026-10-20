import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_RELAY_ORIGIN,
  emptyHostBook,
  fetchHostPresence,
  launchTarget,
  parseCodeInput,
  redeemCode,
  rememberHost,
} from './hosts.ts';

const DEVICE = '0123456789abcdef0123456789abcdef';
const json = (status: number, body: unknown): typeof fetch => (async () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

test('a code is six digits however it is typed', () => {
  assert.equal(parseCodeInput('482917'), '482917');
  assert.equal(parseCodeInput('482·917'), '482917');
  assert.equal(parseCodeInput(' 482 917 '), '482917');
  assert.equal(parseCodeInput('48291'), null);
  assert.equal(parseCodeInput('4829175'), null);
  assert.equal(parseCodeInput('abcdef'), null);
});

test('a right code yields the host route and a one-time ticket, nothing else', async () => {
  const result = await redeemCode(
    DEFAULT_RELAY_ORIGIN,
    '482917',
    json(200, { deviceId: DEVICE, name: 'Home PC', ticket: 'a'.repeat(32) })
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.link.url, `${DEFAULT_RELAY_ORIGIN}/d/${DEVICE}/`);
  assert.equal(result.name, 'Home PC');
  const book = rememberHost(emptyHostBook(), result.link, 1, result.name);
  assert.equal(book.hosts[0].name, 'Home PC');
});

test('failures say what to do: wrong code, rate limit, old main PC, no network', async () => {
  const reason = async (doFetch: typeof fetch) => {
    const result = await redeemCode(DEFAULT_RELAY_ORIGIN, '000000', doFetch);
    return result.ok ? 'ok' : result.reason;
  };
  assert.equal(await reason(json(404, { status: 'invalid-code' })), 'invalid');
  assert.equal(await reason(json(429, { status: 'rate-limited', retryAfter: 30 })), 'rate-limited');
  // A relay or host that predates codes answers without the new JSON.
  assert.equal(await reason((async () => new Response('Not found', { status: 404 })) as typeof fetch), 'outdated');
  assert.equal(
    await reason((async () => {
      throw new TypeError('offline');
    }) as typeof fetch),
    'network'
  );
});

test('a code redemption is bounded by a timeout signal', async () => {
  let signal: AbortSignal | null | undefined;
  await redeemCode(DEFAULT_RELAY_ORIGIN, '000000', (async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal;
    throw new TypeError('timed out');
  }) as typeof fetch);
  assert.ok(signal instanceof AbortSignal);
});

const OTHER = 'fedcba9876543210fedcba9876543210';
const twoPcs = () => {
  let book = rememberHost(emptyHostBook(), { url: `https://a.example/d/${OTHER}/`, deviceId: OTHER }, 1, 'Office');
  book = rememberHost(book, { url: `https://a.example/d/${DEVICE}/`, deviceId: DEVICE }, 2, 'Desk');
  return book;
};

test('launch: one saved PC opens without a lookup; with several, an offline last PC yields the list', async () => {
  let asked = 0;
  const presence = (states: Record<string, boolean>) => async () => {
    asked += 1;
    return new Map(Object.entries(states));
  };
  assert.equal(await launchTarget(emptyHostBook(), presence({})), '');
  const one = rememberHost(emptyHostBook(), { url: `https://a.example/d/${DEVICE}/`, deviceId: DEVICE }, 1);
  assert.equal(await launchTarget(one, presence({ [one.last]: false })), one.last);
  assert.equal(asked, 0, 'a single PC never waits on the network');

  const book = twoPcs();
  const desk = `https://a.example/d/${DEVICE}/`;
  assert.equal(book.last, desk);
  assert.equal(await launchTarget(book, presence({ [desk]: true })), desk);
  assert.equal(await launchTarget(book, presence({ [desk]: false })), '', 'offline last PC: the list');
  assert.equal(await launchTarget(book, presence({})), desk, 'unknown state keeps the last PC');
});

test('presence: one lookup per relay, keyed by host, unknown when the relay cannot answer', async () => {
  const book = twoPcs();
  const third = rememberHost(book, { url: `https://b.example/d/${DEVICE}/`, deviceId: DEVICE }, 3, 'Laptop');
  const calls: Array<[string, unknown, boolean]> = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push([url, JSON.parse(String(init?.body)), init?.signal instanceof AbortSignal]);
    if (url.startsWith('https://b.example')) throw new TypeError('offline');
    return new Response(JSON.stringify({ online: { [DEVICE]: true } }), { status: 200 });
  }) as unknown as typeof fetch;
  const online = await fetchHostPresence(third.hosts, doFetch);
  assert.deepEqual(calls.sort(), [
    ['https://a.example/pair-code/presence', { ids: [DEVICE, OTHER] }, true],
    ['https://b.example/pair-code/presence', { ids: [DEVICE] }, true],
  ]);
  assert.deepEqual(
    [...online].sort(),
    [
      [`https://a.example/d/${DEVICE}/`, true],
      [`https://a.example/d/${OTHER}/`, false],
    ],
    'the unreachable relay leaves its PC unknown'
  );
  const old = await fetchHostPresence(book.hosts, (async () => new Response('Not found', { status: 404 })) as typeof fetch);
  assert.equal(old.size, 0, 'a relay without the lookup says nothing');
});

test('the first screen offers the QR scanner and the code only, with no link field', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./pairing-ui.ts', import.meta.url), 'utf8');
  assert.match(ui, /act\('scan'/);
  assert.match(ui, /act\('enter-code'/);
  assert.doesNotMatch(html + ui, /type="url"|id="link"/);
});
