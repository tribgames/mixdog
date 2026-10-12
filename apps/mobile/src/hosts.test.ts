import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_RELAY_ORIGIN, emptyHostBook, parseCodeInput, redeemCode, rememberHost } from './hosts.ts';

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

test('the first screen offers the QR scanner and the code only, with no link field', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./pairing-ui.ts', import.meta.url), 'utf8');
  assert.match(ui, /act\('scan'/);
  assert.match(ui, /act\('enter-code'/);
  assert.doesNotMatch(html + ui, /type="url"|id="link"/);
});
