import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mimo-oauth-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(dir, 'mimo-oauth.json');
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { beginOAuthLogin, decryptMimoPayload, generateLoginKeyPair } = await import('./mimo-oauth-login.mjs');
const { loadTokens, getKeyName, hasMimoOAuthCredentials, forgetMimoOAuthCredentials, describeMimoOAuthCredentials } =
  await import('./mimo-oauth-tokens.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

// Seal `doc` to the public key (base64url SPKI) the way the platform does.
function seal(pkB64, doc) {
  const target = createPublicKey({ key: Buffer.from(pkB64, 'base64url'), format: 'der', type: 'spki' });
  const eph = generateKeyPairSync('x25519');
  const key = createHash('sha256')
    .update(diffieHellman({ privateKey: eph.privateKey, publicKey: target }))
    .digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf-8'), cipher.final()]);
  const ephRaw = eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return Buffer.concat([ephRaw, nonce, body, cipher.getAuthTag()]).toString('base64url');
}

test('decryptMimoPayload round-trips a sealed payload', () => {
  const { privateKey, publicKeyB64 } = generateLoginKeyPair();
  const u = seal(publicKeyB64, { sk: 'sk-test', uid: 42, url: 'https://token-plan-cn.xiaomimimo.com/v1' });
  assert.deepEqual(decryptMimoPayload(u, privateKey), {
    apiKey: 'sk-test',
    uid: '42',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  });
});

test('decryptMimoPayload accepts only allowlisted HTTPS Xiaomi MiMo gateway URLs', () => {
  const { privateKey, publicKeyB64 } = generateLoginKeyPair();
  const decode = (url) => decryptMimoPayload(seal(publicKeyB64, { sk: 'sk-test', url }), privateKey);
  for (const ok of [
    'https://api.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com/v1/',
    'https://TOKEN-PLAN-SGP.xiaomimimo.com/v1',
    'https://token-plan-ams.xiaomimimo.com/v1',
  ]) {
    assert.match(decode(ok).baseUrl, /^https:\/\/[a-z-]+\.xiaomimimo\.com\/v1$/, ok);
  }
  assert.equal(decode(undefined).baseUrl, '');
  assert.equal(decode('').baseUrl, '');
  for (const bad of [
    'http://api.xiaomimimo.com/v1',
    'https://example.test/v1',
    'https://evil.com/v1',
    'https://xiaomimimo.com/v1',
    'https://api.xiaomimimo.com.evil.com/v1',
    'https://evil.com/.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com@evil.com/v1',
    'https://user:pw@api.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com:8443/v1',
    'https://api.xiaomimimo.com/v1?next=evil',
    'https://api.xiaomimimo.com/v1#x',
    'https://api.xiaomimimo.com/v1/a b%00',
    'https://token-plan-eu.xiaomimimo.com/v1',
    'ftp://api.xiaomimimo.com/v1',
    'not a url',
    `https://api.xiaomimimo.com/${'a'.repeat(3000)}`,
    42,
    { href: 'https://api.xiaomimimo.com/v1' },
    ['https://api.xiaomimimo.com/v1'],
  ]) {
    assert.throws(() => decode(bad), /outside the Xiaomi MiMo API hosts/, String(bad).slice(0, 60));
  }
});

test('decryptMimoPayload validates field types and lengths before anything is stored', () => {
  const { privateKey, publicKeyB64 } = generateLoginKeyPair();
  const decode = (doc) => decryptMimoPayload(seal(publicKeyB64, doc), privateKey);
  assert.throws(() => decode(['sk-test']), /not an object/);
  assert.throws(() => decode(null), /not an object/);
  assert.throws(() => decode({ sk: 123 }), /no API key/);
  assert.throws(() => decode({ sk: 'a'.repeat(513) }), /malformed API key/);
  assert.throws(() => decode({ sk: 'sk with space' }), /malformed API key/);
  assert.throws(() => decode({ sk: 'sk-\nnewline' }), /malformed API key/);
  assert.throws(() => decode({ sk: 'sk-test', uid: { id: 1 } }), /malformed account id/);
  assert.throws(() => decode({ sk: 'sk-test', uid: ['1'] }), /malformed account id/);
  assert.throws(() => decode({ sk: 'sk-test', uid: 'u'.repeat(129) }), /malformed account id/);
  assert.throws(() => decode({ sk: 'sk-test', uid: 'u\n1' }), /malformed account id/);
  assert.equal(decode({ sk: 'a'.repeat(512), uid: 'u'.repeat(128) }).uid.length, 128);
  assert.equal(decode({ sk: 'sk-test' }).uid, '');
});

test('decryptMimoPayload rejects tampered, foreign-key and key-less payloads', () => {
  const { privateKey, publicKeyB64 } = generateLoginKeyPair();
  const u = Buffer.from(seal(publicKeyB64, { sk: 'sk-test', uid: 1 }), 'base64url');
  u[u.length - 20] ^= 1;
  assert.throws(() => decryptMimoPayload(u.toString('base64url'), privateKey), /could not decrypt/);
  const other = generateLoginKeyPair();
  assert.throws(() => decryptMimoPayload(seal(publicKeyB64, { sk: 'x' }), other.privateKey), /could not decrypt/);
  assert.throws(() => decryptMimoPayload(seal(publicKeyB64, { uid: 1 }), privateKey), /no API key/);
  assert.throws(() => decryptMimoPayload('abc', privateKey), /too short/);
});

test('key name is generated once and reused', () => {
  const first = getKeyName();
  assert.match(first, /^mimo-code-cli-key-[0-9a-f]{8}$/);
  assert.equal(getKeyName(), first);
});

test('browser callback stores credentials and redirects to success', async () => {
  const login = await beginOAuthLogin({ openBrowser: false });
  const url = new URL(login.url);
  assert.equal(url.origin + url.pathname, 'https://platform.xiaomimimo.com/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${login.port}/`);
  assert.equal(url.searchParams.get('kn'), 'mimocode');
  assert.equal(url.searchParams.get('key_name'), getKeyName());
  assert.equal(new URL(login.manualUrl).searchParams.get('redirect_uri'), 'https://platform.xiaomimimo.com/authorize/code/callback');

  // A request without `u` is ignored and does not end the login.
  const stray = await fetch(`http://localhost:${login.port}/favicon.ico`);
  assert.equal(stray.status, 404);

  const u = seal(url.searchParams.get('pk'), { sk: 'sk-live', uid: 'u1' });
  const res = await fetch(`http://localhost:${login.port}/?u=${u}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://platform.xiaomimimo.com/authorize/callback?status=success');
  const tokens = await login.waitForCallback;
  assert.equal(tokens.apiKey, 'sk-live');
  assert.deepEqual(JSON.parse(readFileSync(process.env.MIMO_OAUTH_CREDENTIALS_PATH, 'utf-8')), {
    apiKey: 'sk-live',
    uid: 'u1',
    baseUrl: 'https://api.xiaomimimo.com/v1',
  });
  assert.equal(loadTokens().apiKey, 'sk-live');
  assert.equal(hasMimoOAuthCredentials(), true);
  assert.equal(describeMimoOAuthCredentials().usable, true);
});

test('a bad or unrelated request is answered with an error and does not end the login', async () => {
  forgetMimoOAuthCredentials();
  const login = await beginOAuthLogin({ openBrowser: false });
  const base = `http://localhost:${login.port}`;
  const garbage = await fetch(`${base}/?u=${Buffer.alloc(80, 1).toString('base64url')}`, { redirect: 'manual' });
  assert.equal(garbage.status, 400);
  const short = await fetch(`${base}/?u=abc`, { redirect: 'manual' });
  assert.equal(short.status, 400);
  const wrongPath = await fetch(`${base}/other?u=abc`, { redirect: 'manual' });
  assert.equal(wrongPath.status, 404);
  assert.equal(loadTokens(), null);

  const u = seal(new URL(login.url).searchParams.get('pk'), { sk: 'sk-after-bad', uid: 'u6' });
  const ok = await fetch(`${base}/?u=${u}`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal((await login.waitForCallback).apiKey, 'sk-after-bad');
  assert.equal(loadTokens().apiKey, 'sk-after-bad');
});

test('a payload sealed to a different login key is rejected without ending the login', async () => {
  const login = await beginOAuthLogin({ openBrowser: false });
  try {
    const foreign = seal(generateLoginKeyPair().publicKeyB64, { sk: 'sk-foreign', uid: 'x' });
    const res = await fetch(`http://localhost:${login.port}/?u=${foreign}`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    const state = await Promise.race([login.waitForCallback, new Promise((r) => setTimeout(() => r('pending'), 50))]);
    assert.equal(state, 'pending');
  } finally {
    login.cancel();
  }
});

test('a payload with a foreign gateway URL is rejected without settling or storing the login', async () => {
  forgetMimoOAuthCredentials();
  const login = await beginOAuthLogin({ openBrowser: false });
  try {
    const pk = new URL(login.url).searchParams.get('pk');
    const evil = seal(pk, { sk: 'sk-evil', uid: 'e', url: 'https://evil.example/v1' });
    const res = await fetch(`http://localhost:${login.port}/?u=${evil}`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    await assert.rejects(login.completeCode(evil), /outside the Xiaomi MiMo API hosts/);
    assert.equal(loadTokens(), null);
    const state = await Promise.race([login.waitForCallback, new Promise((r) => setTimeout(() => r('pending'), 50))]);
    assert.equal(state, 'pending');

    const good = seal(pk, { sk: 'sk-good', uid: 'g', url: 'https://api.xiaomimimo.com/v1' });
    const ok = await fetch(`http://localhost:${login.port}/?u=${good}`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal((await login.waitForCallback).apiKey, 'sk-good');
  } finally {
    login.cancel();
  }
});

test('the authorization URL is shown only to a headless login, never by an interactive begin', async () => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  let interactive;
  let headless;
  try {
    interactive = await beginOAuthLogin({ openBrowser: false });
    const quiet = lines.join('');
    interactive.cancel();
    headless = await beginOAuthLogin({ openBrowser: false, printUrl: true });
    headless.cancel();
    const loud = lines.join('');
    const pk = new URL(interactive.url).searchParams.get('pk');
    assert.equal(quiet.includes(pk), false);
    assert.equal(quiet.includes('/authorize'), false);
    assert.equal(loud.includes(new URL(headless.url).searchParams.get('pk')), true);
  } finally {
    process.stderr.write = original;
  }
});

test('pasted code (bare or inside a URL) completes the login and cancel resolves null', async () => {
  const login = await beginOAuthLogin({ openBrowser: false });
  const pk = new URL(login.manualUrl).searchParams.get('pk');
  const u = seal(pk, { sk: 'sk-paste', uid: 'u2', url: 'https://token-plan-sgp.xiaomimimo.com/v1/' });
  const tokens = await login.completeCode(`https://platform.xiaomimimo.com/authorize/code/callback?u=${u}`);
  assert.equal(tokens.apiKey, 'sk-paste');
  assert.equal(await login.waitForCallback, tokens);
  assert.equal(loadTokens().baseUrl, 'https://token-plan-sgp.xiaomimimo.com/v1');
  await assert.rejects(login.completeCode(''), /code is required/);

  const second = await beginOAuthLogin({ openBrowser: false });
  second.cancel();
  assert.equal(await second.waitForCallback, null);
});

test('the callback listens on every loopback address localhost resolves to', async () => {
  const { lookup } = await import('node:dns/promises');
  const addresses = (await lookup('localhost', { all: true })).map((entry) => entry.address);
  const login = await beginOAuthLogin({ openBrowser: false });
  try {
    for (const address of addresses) {
      const host = address.includes(':') ? `[${address}]` : address;
      const res = await fetch(`http://${host}:${login.port}/probe`);
      assert.equal(res.status, 404, address);
    }
  } finally {
    login.cancel();
  }
});

test('an unanswered login rejects with an explicit timeout error', async () => {
  const login = await beginOAuthLogin({ openBrowser: false, timeoutMs: 25 });
  await assert.rejects(login.waitForCallback, /login timed out after/);
});

test('MIMO_PLATFORM_URL moves the authorize, manual and result URLs', async () => {
  process.env.MIMO_PLATFORM_URL = 'https://platform.example.test/';
  try {
    const login = await beginOAuthLogin({ openBrowser: false });
    assert.equal(new URL(login.url).origin, 'https://platform.example.test');
    assert.equal(new URL(login.url).pathname, '/authorize');
    assert.equal(
      new URL(login.manualUrl).searchParams.get('redirect_uri'),
      'https://platform.example.test/authorize/code/callback'
    );
    const u = seal(new URL(login.url).searchParams.get('pk'), { sk: 'sk-env', uid: 'u3' });
    const res = await fetch(`http://localhost:${login.port}/?u=${u}`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), 'https://platform.example.test/authorize/callback?status=success');
    await login.waitForCallback;
  } finally {
    delete process.env.MIMO_PLATFORM_URL;
  }
});

test('a Token Plan key without a URL is routed to its region during login', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response('{}', { status: seen.length === 1 ? 401 : 200 });
  };
  const login = await beginOAuthLogin({ openBrowser: false, fetchImpl });
  const u = seal(new URL(login.manualUrl).searchParams.get('pk'), { sk: 'tp-plan-key', uid: 'u4' });
  const tokens = await login.completeCode(u);
  assert.equal(tokens.baseUrl, 'https://token-plan-ams.xiaomimimo.com/v1');
  assert.equal(loadTokens().baseUrl, 'https://token-plan-ams.xiaomimimo.com/v1');
  assert.equal(seen.length, 2);
});

test('forget removes stored credentials', () => {
  assert.deepEqual(forgetMimoOAuthCredentials(), { removed: true });
  assert.equal(hasMimoOAuthCredentials(), false);
  assert.deepEqual(forgetMimoOAuthCredentials(), { removed: false });
});

test('a failed secondary bind is ignored while one listener is up; none up fails', async () => {
  const login = await beginOAuthLogin({ openBrowser: false, addresses: ['127.0.0.1', '203.0.113.77'] });
  try {
    const res = await fetch(`http://127.0.0.1:${login.port}/probe`);
    assert.equal(res.status, 404);
    const u = seal(new URL(login.url).searchParams.get('pk'), { sk: 'sk-sec', uid: 'u5' });
    const ok = await fetch(`http://127.0.0.1:${login.port}/?u=${u}`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal((await login.waitForCallback).apiKey, 'sk-sec');
  } finally {
    login.cancel();
  }
  await assert.rejects(beginOAuthLogin({ openBrowser: false, addresses: ['203.0.113.77'] }), /EADDRNOTAVAIL|address/i);
});
test('a cancelled or finished login never writes credentials', async () => {
  forgetMimoOAuthCredentials();
  const cancelled = await beginOAuthLogin({ openBrowser: false });
  const pk = new URL(cancelled.manualUrl).searchParams.get('pk');
  cancelled.cancel();
  await assert.rejects(cancelled.completeCode(seal(pk, { sk: 'sk-late', uid: 'u9' })), /no longer active/);
  assert.equal(loadTokens(), null);

  const done = await beginOAuthLogin({ openBrowser: false });
  const donePk = new URL(done.manualUrl).searchParams.get('pk');
  await done.completeCode(seal(donePk, { sk: 'sk-first', uid: 'u1' }));
  await assert.rejects(done.completeCode(seal(donePk, { sk: 'sk-second', uid: 'u2' })), /no longer active/);
  const late = await fetch(`http://localhost:${done.port}/?u=${seal(donePk, { sk: 'sk-third', uid: 'u3' })}`, {
    redirect: 'manual',
  }).catch(() => null);
  assert.ok(!late || late.status === 404);
  assert.equal(loadTokens().apiKey, 'sk-first');
});