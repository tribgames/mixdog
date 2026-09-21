import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

// Ordinary test discovery re-executes with VM modules. No host environment,
// credentials, sockets, timers, browser, or provider dependencies enter the VM.
// Direct: node --experimental-vm-modules --test <this file>
if (!vm.SourceTextModule) {
  test('Grok OAuth isolated contracts', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)],
      { env: {}, encoding: 'utf8', timeout: 30_000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  registerTests();
}

const NOW = 1_800_000_000_000;
const TOKEN_URL = 'https://auth.x.ai/token';
const AUTH_URL = 'https://auth.x.ai/authorize';
const plain = (value) => JSON.parse(JSON.stringify(value));
const jwt = (claims) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const token = (extra = {}) => ({
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expires_at: NOW + 3_600_000,
  token_endpoint: TOKEN_URL,
  ...extra,
});
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

async function isolated() {
  const root = resolve('virtual-grok-fixtures');
  const s = {
    env: {},
    boundPath: null,
    files: new Map(),
    mtimes: new Map(),
    writes: [],
    locks: [],
    requests: [],
    replies: [],
    timers: [],
    timeouts: [],
    logs: [],
    servers: [],
    opened: [],
    inners: [],
    sends: [],
    sendReplies: [],
    preconnects: [],
    cache: null,
    cacheSaves: [],
    metadata: {},
    normalizedTools: [],
    preloads: 0,
  };
  const path = () => resolve(s.boundPath || s.env.GROK_OAUTH_CREDENTIALS_PATH || join(root, 'grok-oauth.json'));
  s.store = (value) => {
    s.files.set(path(), typeof value === 'string' ? value : JSON.stringify(value));
    s.mtimes.set(path(), (s.mtimes.get(path()) || 0) + 1);
  };
  class Clock extends Date {
    static now() {
      return NOW;
    }
  }
  const context = vm.createContext({
    Buffer,
    URL,
    URLSearchParams,
    Date: Clock,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    process: { env: s.env, stderr: { write: (text) => s.logs.push(text) } },
    AbortSignal: { timeout: (ms) => ({ ms }) },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      s.timers.push(timer);
      if (ms < 5_000) fn();
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    fetch: async (url, options) => {
      s.requests.push({ url, options });
      assert.ok(s.replies.length, `Unconfigured mock fetch: ${url}`);
      const reply = s.replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply() : reply;
    },
  });
  const mocks = {
    'node:crypto': {
      createHash,
      randomBytes: (size) => Buffer.alloc(size, 7),
      randomUUID: () => 'fixture-request-id',
    },
    'node:path': { join, resolve },
    'node:fs': {
      existsSync: (p) => s.files.has(p),
      mkdirSync: (p, options) => {
        assert.deepEqual(plain(options), { recursive: true });
        s.files.set(p, null);
      },
      readFileSync: (p) => {
        assert.ok(s.files.has(p), `Unconfigured mock file: ${p}`);
        return s.files.get(p);
      },
      statSync: (p) => {
        if (!s.mtimes.has(p)) throw new Error('fixture missing file');
        return { mtimeMs: s.mtimes.get(p) };
      },
      unlinkSync: (p) => s.files.delete(p),
    },
    '../config.mjs': { getPluginData: () => root },
    '../../../shared/provider-auth-binding.mjs': { boundProviderAuthPath: () => s.boundPath },
    '../../../shared/atomic-file.mjs': {
      writeJsonAtomicSync: (p, value, options) => {
        assert.equal(p, path());
        s.writes.push({ path: p, value: plain(value), options: plain(options) });
        s.store(value);
      },
      withFileLock: async (p, run, options) => {
        s.locks.push({ path: p, options: plain(options) });
        return run();
      },
    },
    '../stall-policy.mjs': {
      createTimeoutSignal: (_parent, ms, label) => {
        const timeout = { ms, label, signal: {}, cleaned: false };
        s.timeouts.push(timeout);
        return { signal: timeout.signal, cleanup: () => (timeout.cleaned = true) };
      },
    },
    '../../../shared/llm/http-agent.mjs': {
      getLlmDispatcher: () => 'fixture-dispatcher',
      preconnect: (url) => s.preconnects.push(url),
    },
    'node:http': {
      createServer: (handler) => {
        const server = {
          handler,
          closed: 0,
          close() {
            this.closed++;
          },
          listen(port, host, ready) {
            Object.assign(this, { port, host, ready });
          },
          on(event, listener) {
            assert.equal(event, 'error');
            this.error = listener;
          },
        };
        s.servers.push(server);
        return server;
      },
    },
    '../../../shared/open-url.mjs': { openInBrowser: (url) => s.opened.push(url) },
    './model-cache.mjs': {
      makeModelCache: (options) => {
        s.cacheOptions = plain(options);
        return {
          loadSync: () => s.cache,
          save: (models) => {
            s.cache = models;
            s.cacheSaves.push(models);
          },
        };
      },
    },
    './model-catalog.mjs': {
      enrichModels: async (models) => models,
      getModelMetadataSync: (id) => s.metadata[id],
    },
    './model-list-sanitize.mjs': { sanitizeModelList: (models) => models },
    './lib/grok-tool-schema.mjs': {
      normalizeGrokToolSchemas: (tools) => {
        s.normalizedTools.push(tools);
        return s.toolResult;
      },
    },
    './openai-compat.mjs': {
      preloadOpenAICompatRuntime: () => s.preloads++,
      OpenAICompatProvider: class {
        constructor(provider, config) {
          Object.assign(this, { provider, config });
          s.inners.push(this);
        }
        async _doSend(...args) {
          s.sends.push({ inner: this, args });
          assert.ok(s.sendReplies.length, 'Unconfigured mock send');
          const reply = s.sendReplies.shift();
          if (reply instanceof Error) throw reply;
          return reply;
        }
      },
    },
  };
  // Only these reviewed source files can be read by the host-side loader.
  const sources = new Set([
    'grok-oauth.mjs',
    'grok-oauth-login.mjs',
    'grok-oauth-tokens.mjs',
    'provider-model-identities.mjs',
    'lib/oauth-token-utils.mjs',
    'lib/oauth-pkce.mjs',
  ]);
  const modules = new Map();
  function load(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    let module;
    if (Object.hasOwn(mocks, specifier)) {
      const exports = mocks[specifier];
      module = new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        },
        { context, identifier: specifier }
      );
    } else {
      const name = specifier.replace(/^\.\//, '');
      assert.ok(sources.has(name), `Unmocked dependency: ${specifier}`);
      module = new vm.SourceTextModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
        context,
        identifier: specifier,
        importModuleDynamically: async (dependency) => {
          const imported = load(dependency);
          await imported.link(load);
          await imported.evaluate();
          return imported;
        },
      });
    }
    modules.set(specifier, module);
    return module;
  }
  const provider = load('./grok-oauth.mjs');
  await provider.link(load);
  await provider.evaluate();
  return {
    s,
    provider: provider.namespace,
    tokens: modules.get('./grok-oauth-tokens.mjs').namespace,
    login: modules.get('./grok-oauth-login.mjs').namespace,
  };
}

function registerTests() {
  test('public exports, account paths, identity and atomic persistence', async () => {
    const { s, tokens: t, provider, login } = await isolated();
    assert.deepEqual(Object.keys(provider), [
      'GrokOAuthProvider',
      'beginOAuthLogin',
      'describeGrokOAuthCredentials',
      'forgetGrokOAuthCredentials',
      'hasGrokOAuthCredentials',
      'loginOAuth',
      'normalizeGrokModelId',
    ]);
    assert.deepEqual(Object.keys(login), [
      'beginOAuthLogin',
      'exchangeAuthorizationCode',
      'generatePKCE',
      'loginOAuth',
    ]);
    assert.deepEqual(Object.keys(t), [
      'CALLBACK_HOST',
      'CALLBACK_PATH',
      'CALLBACK_PORT',
      'CLIENT_ID',
      'GROK_MODEL_CACHE_SCHEMA_VERSION',
      'INFERENCE_BASE_URL',
      'LOGIN_TIMEOUT_MS',
      'MODEL_CACHE_TTL_MS',
      'PROXY_BASE_URL',
      'REDIRECT_URI',
      'SCOPE',
      'TOKEN_REFRESH_SKEW_MS',
      'TOKEN_TIMEOUT_MS',
      '_getRefreshInFlight',
      '_identityFromAccessToken',
      '_loadOwnTokens',
      '_mtimeMs',
      '_normalizeExpiresAt',
      '_scrubTokens',
      '_setRefreshInFlight',
      'describeGrokOAuthCredentials',
      'fetchDiscovery',
      'forgetGrokOAuthCredentials',
      'getOwnTokenPath',
      'getRefreshLockPath',
      'hasGrokOAuthCredentials',
      'isProxyOnlyModel',
      'loadTokens',
      'normalizeGrokModelId',
      'proxyHeaders',
      'refreshTokens',
      'resolveGrokOAuthResponsesTransport',
      'saveTokens',
    ]);
    assert.equal(t.loadTokens(), null);
    assert.equal(s.files.has(resolve('virtual-grok-fixtures')), true);
    s.env.GROK_OAUTH_CREDENTIALS_PATH = 'fixture-explicit.json';
    assert.equal(t.getOwnTokenPath(), resolve('fixture-explicit.json'));
    s.boundPath = 'fixture-account-a.json';
    assert.equal(t.getOwnTokenPath(), resolve('fixture-account-a.json'));
    const access = jwt({
      userId: 'jwt-user',
      principalId: 'jwt-principal',
      principalType: 'user',
      exp: NOW / 1000 + 60,
    });
    t.saveTokens(token({ access_token: access, userId: 'explicit-user' }));
    assert.deepEqual(s.writes[0], {
      path: resolve('fixture-account-a.json'),
      value: token({
        access_token: access,
        user_id: 'explicit-user',
        principal_id: 'jwt-principal',
        principal_type: 'user',
      }),
      options: { lock: true, fsyncDir: true, mode: 0o600, secret: true },
    });
    assert.equal(t.loadTokens().user_id, 'explicit-user');
    const pending = Promise.resolve('account-a');
    assert.equal(t._setRefreshInFlight(pending), pending);
    s.boundPath = 'fixture-account-b.json';
    assert.equal(t._getRefreshInFlight(), null);
    s.boundPath = 'fixture-account-a.json';
    assert.equal(t._getRefreshInFlight(), pending);
    t._setRefreshInFlight(null);
    assert.equal(t._getRefreshInFlight(), null);
    assert.deepEqual(plain(t.forgetGrokOAuthCredentials()), { removed: true });
    assert.deepEqual(plain(t.forgetGrokOAuthCredentials()), { removed: false });
  });

  test('expiry normalization, JWT fallback and malformed stores', async () => {
    const { s, tokens: t } = await isolated();
    for (const [value, expected] of [
      [NOW / 1000, NOW],
      [NOW, NOW],
      [new Date(NOW).toISOString(), NOW],
      ['invalid', 0],
      [0, 0],
      [-1, 0],
      [Infinity, 0],
      [null, 0],
    ])
      assert.equal(t._normalizeExpiresAt(value), expected);
    for (const [stored, expected] of [
      [token({ expires_at: NOW / 1000 }), NOW],
      [token({ expires_at: undefined, expiresAt: new Date(NOW).toISOString() }), NOW],
      [token({ expires_at: 0, access_token: jwt({ exp: NOW / 1000 }) }), NOW],
      [token({ expires_at: 'invalid', access_token: jwt({ exp: NOW / 1000 }) }), NOW],
      [token({ expires_at: 0 }), 0],
      [token({ expires_at: 0, access_token: jwt({ exp: -1 }) }), 0],
    ]) {
      s.store(stored);
      assert.equal(t._loadOwnTokens().expires_at, expected);
    }
    assert.deepEqual(plain(t._identityFromAccessToken(jwt({ principal_id: 'principal', sub: 'subject' }))), {
      user_id: 'principal',
      principal_id: 'principal',
    });
    assert.deepEqual(plain(t._identityFromAccessToken(jwt({ sub: 'subject' }))), { user_id: 'subject' });
    assert.deepEqual(plain(t._identityFromAccessToken('opaque')), {});
    for (const invalid of ['broken json', {}, { access_token: 'access-only' }]) {
      s.store(invalid);
      assert.equal(t.loadTokens(), null);
      assert.equal(t.hasGrokOAuthCredentials(), false);
      assert.equal(t.describeGrokOAuthCredentials().status, 'Not Set');
    }
    for (const [expires_at, status, usable] of [
      [0, 'Valid', true],
      [NOW + 3_600_000, 'Valid', true],
      [NOW + 60_000, 'Refresh Soon', true],
      [NOW, 'Refresh Required', false],
    ]) {
      s.store(token({ expires_at }));
      assert.equal(t.hasGrokOAuthCredentials(), true);
      assert.equal(t.describeGrokOAuthCredentials().status, status);
      assert.equal(t.describeGrokOAuthCredentials().usable, usable);
    }
    assert.equal(t._mtimeMs('missing'), 0);
  });

  test('proxy headers preserve session identity, version cache and HTTP pinning', async () => {
    const { s, tokens: t } = await isolated();
    s.env.MIXDOG_GROK_CLIENT_VERSION = '  fixture-version  ';
    assert.deepEqual(
      plain(
        t.proxyHeaders({
          model: 'grok-build',
          userId: 'user',
          sendOpts: { session: { id: ' session ' }, iteration: 0 },
        })
      ),
      {
        'x-grok-client-version': 'fixture-version',
        'x-grok-client-identifier': 'grok-shell',
        'User-Agent': 'xai-grok-build/fixture-version',
        'x-grok-session-id': 'session',
        'x-grok-req-id': 'fixture-request-id',
        'x-grok-model-override': 'grok-build',
        'x-grok-turn-idx': '0',
        'x-grok-user-id': 'user',
      }
    );
    s.env.MIXDOG_GROK_CLIENT_VERSION = 'changed';
    assert.equal(t.proxyHeaders()['x-grok-client-version'], 'fixture-version');
    assert.equal(t.proxyHeaders()['x-grok-req-id'], undefined);
    assert.equal(
      t.proxyHeaders({ sendOpts: { requestId: ' request ', iteration: 'invalid' } })['x-grok-req-id'],
      'request'
    );
    assert.equal(t.proxyHeaders({ sendOpts: { iteration: 'invalid' } })['x-grok-turn-idx'], undefined);
    assert.equal(t.resolveGrokOAuthResponsesTransport(), 'http');
    assert.equal(t.isProxyOnlyModel('grok-build'), true);
    assert.equal(t.isProxyOnlyModel('GROK-COMPOSER-2.5'), true);
    assert.equal(t.isProxyOnlyModel('grok-build-0.1'), false);
  });

  test('discovery caches only trusted endpoints and cleans timeout on errors', async () => {
    const { s, tokens: t } = await isolated();
    for (const endpoint of ['http://auth.x.ai/token', 'https://x.ai.evil.test/token', 'not a URL']) {
      s.replies.push(response({ authorization_endpoint: AUTH_URL, token_endpoint: endpoint }));
      await assert.rejects(t.fetchDiscovery(), /untrusted token endpoint|invalid token endpoint/);
    }
    s.replies.push(response({}, 503));
    await assert.rejects(t.fetchDiscovery(), /discovery 503/);
    s.replies.push(response({ authorization_endpoint: AUTH_URL, token_endpoint: TOKEN_URL }));
    const discovery = await t.fetchDiscovery();
    assert.equal(await t.fetchDiscovery(), discovery);
    assert.equal(s.requests.length, 5);
    assert.ok(
      s.requests.every(
        ({ url, options }) =>
          url === 'https://auth.x.ai/.well-known/openid-configuration' && options.redirect === 'error'
      )
    );
    assert.ok(s.timeouts.every((timeout) => timeout.cleaned));
  });

  test('refresh preserves wire fields, rotation, retries, lock and secret errors', async () => {
    const { s, tokens: t } = await isolated();
    const initial = token({ user_id: 'account-user', principal_type: 'user', principal_id: 'principal' });
    s.store(initial);
    s.replies.push(new Error('temporary'), response({}, 503), response({ access_token: 'fresh', expires_in: 60 }));
    const fresh = await t.refreshTokens(initial, { force: true });
    assert.equal(fresh.access_token, 'fresh');
    assert.equal(fresh.refresh_token, initial.refresh_token);
    assert.equal(fresh.user_id, 'account-user');
    assert.equal(fresh.expires_at, NOW + 60_000);
    assert.deepEqual(
      s.timers.map(({ ms }) => ms),
      [200, 400]
    );
    assert.deepEqual(Object.fromEntries(s.requests[0].options.body), {
      grant_type: 'refresh_token',
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      refresh_token: 'fixture-refresh',
      principal_type: 'user',
      principal_id: 'principal',
    });
    assert.ok(
      s.requests.every(
        ({ url, options }) => url === TOKEN_URL && options.method === 'POST' && options.redirect === 'error'
      )
    );
    assert.deepEqual(s.locks[0], {
      path: `${t.getOwnTokenPath()}.refresh.lock`,
      options: { timeoutMs: 120_000, staleMs: 120_000, secret: true },
    });
    assert.ok(s.timeouts.every((timeout) => timeout.cleaned));
    s.replies.push(response({ error: 'invalid_client', access_token: 'secret-fixture' }, 400));
    await assert.rejects(t.refreshTokens(fresh, { force: true }), (err) => {
      assert.equal(err.isTerminalRefresh, true);
      assert.equal(err.isInvalidGrant, false);
      assert.equal(err.oauthError, 'invalid_client');
      assert.match(err.message, /\[REDACTED\]/);
      assert.doesNotMatch(err.message, /secret-fixture/);
      return true;
    });
    assert.equal(s.requests.length, 4);
    await assert.rejects(t.refreshTokens({}), /refresh token not available/);
  });

  test('refresh adopts disk generations and invalid_grant races without rotating twice', async () => {
    const { s, tokens: t } = await isolated();
    const initial = token();
    const rotated = token({ refresh_token: 'rotated-refresh' });
    s.store(rotated);
    assert.equal((await t.refreshTokens(initial)).refresh_token, 'rotated-refresh');
    assert.equal(s.requests.length, 0);
    s.store(initial);
    s.replies.push(() => {
      s.store(rotated);
      return response({ error: 'invalid_grant' }, 400);
    });
    assert.equal((await t.refreshTokens(initial)).refresh_token, 'rotated-refresh');
    assert.equal(s.requests.length, 1);
    s.store(initial);
    s.replies.push(
      () => {
        s.store(token({ refresh_token: 'expired-rotation', expires_at: NOW - 1 }));
        return response({ error: 'invalid_grant' }, 400);
      },
      response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    );
    assert.equal((await t.refreshTokens(initial)).refresh_token, 'new-refresh');
    assert.equal(s.requests.at(-1).options.body.get('refresh_token'), 'expired-rotation');
  });

  test('refresh rejects untrusted endpoints, malformed success and exhausted retries', async () => {
    for (const reply of [response('not json'), response({}), new Error('offline')]) {
      const { s, tokens: t } = await isolated();
      s.replies.push(reply, reply, reply);
      await assert.rejects(t.refreshTokens(token()), /no access token|offline/);
      assert.equal(s.requests.length, 3);
      assert.equal(s.writes.length, 0);
      assert.ok(s.timeouts.every((timeout) => timeout.cleaned));
    }
    const { s, tokens: t } = await isolated();
    await assert.rejects(
      t.refreshTokens(token({ token_endpoint: 'https://evil.test/token' })),
      /untrusted token endpoint/
    );
    assert.equal(s.requests.length, 0);
  });

  test('PKCE exchange pins OAuth wire data, identity, expiry and errors', async () => {
    const { s, login } = await isolated();
    const pkce = login.generatePKCE();
    assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'));
    const discovery = { token_endpoint: TOKEN_URL };
    await assert.rejects(
      login.exchangeAuthorizationCode({ discovery, pkce, code: ' ' }),
      /authorization code is required/
    );
    const access = jwt({ user_id: 'jwt-user', principal_type: 'jwt-type', principal_id: 'jwt-principal' });
    s.replies.push(
      response({ access_token: access, refresh_token: 'refresh', expires_in: 120, principal_id: 'server-id' })
    );
    const result = await login.exchangeAuthorizationCode({ discovery, pkce, code: ' code ' });
    assert.deepEqual(plain(result), {
      access_token: access,
      refresh_token: 'refresh',
      expires_at: NOW + 120_000,
      token_endpoint: TOKEN_URL,
      user_id: 'jwt-user',
      principal_type: 'jwt-type',
      principal_id: 'server-id',
    });
    assert.deepEqual(Object.fromEntries(s.requests[0].options.body), {
      grant_type: 'authorization_code',
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      code: 'code',
      code_verifier: pkce.verifier,
      redirect_uri: 'http://127.0.0.1:56121/callback',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    assert.equal(s.requests[0].options.redirect, 'error');
    assert.equal(s.requests[0].options.signal.ms, 30_000);
    s.replies.push(response({ access_token: 'only-access' }));
    await assert.rejects(
      login.exchangeAuthorizationCode({ discovery, pkce, code: 'code' }),
      /missing access_token or refresh_token/
    );
    s.replies.push(response({ access_token: 'secret-fixture' }, 400));
    await assert.rejects(
      login.exchangeAuthorizationCode({ discovery, pkce, code: 'code' }),
      (err) =>
        err.message.includes('token exchange 400') &&
        err.message.includes('[REDACTED]') &&
        !err.message.includes('secret-fixture')
    );
    assert.equal(s.writes.length, 1);
  });

  test('login manual completion, callback, cancellation and server timeout stay isolated', async () => {
    for (const mode of ['manual', 'callback', 'invalid', 'cancel', 'timeout', 'error']) {
      const { s, login } = await isolated();
      s.replies.push(response({ authorization_endpoint: AUTH_URL, token_endpoint: TOKEN_URL }));
      const started = await login.beginOAuthLogin();
      const url = new URL(started.url);
      assert.equal(started.provider, 'grok-oauth');
      assert.equal(url.origin + url.pathname, AUTH_URL);
      assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access grok-cli:access api:access');
      assert.equal(url.searchParams.get('plan'), 'generic');
      assert.equal(url.searchParams.get('referrer'), 'mixdog');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const server = s.servers[0];
      assert.equal(server.port, 56121);
      assert.equal(server.host, '127.0.0.1');
      await server.ready();
      assert.deepEqual(s.opened, [started.url]);
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          this.body = body;
        },
      };
      await server.handler({ url: '/unrelated' }, res);
      assert.equal(res.status, 404);
      assert.equal(server.closed, 0);
      if (mode === 'manual' || mode === 'callback') {
        s.replies.push(response({ access_token: 'access', refresh_token: 'refresh', expires_at: NOW }));
        if (mode === 'manual') {
          await assert.rejects(started.completeCode('code#wrong-state'), /OAuth state mismatch/);
          await started.completeCode(`code#${url.searchParams.get('state')}`);
        } else {
          await server.handler({ url: `/callback?code=code&state=${url.searchParams.get('state')}` }, res);
          assert.equal(res.status, 200);
          assert.equal(res.body, '<html><body><h2>Grok login successful! You can close this tab.</h2></body></html>');
        }
        assert.equal((await started.waitForCallback).access_token, 'access');
        assert.equal(s.writes.length, 1);
      } else if (mode === 'error') {
        const rejected = assert.rejects(started.waitForCallback, /callback server failed on 127.0.0.1:56121: occupied/);
        server.error(new Error('occupied'));
        await rejected;
      } else {
        if (mode === 'invalid') {
          await server.handler({ url: '/callback?code=code&state=wrong' }, res);
          assert.equal(res.status, 400);
          assert.equal(res.body, 'Invalid');
        } else if (mode === 'cancel') started.cancel();
        else s.timers[0].fn();
        assert.equal(await started.waitForCallback, null);
      }
      started.cancel();
      assert.equal(server.closed, 1);
      assert.equal(s.timers[0].cleared, true);
    }
  });

  test('catalog display, reasoning and context survive cached and fresh normalization', async () => {
    const {
      s,
      provider: { GrokOAuthProvider },
    } = await isolated();
    s.store(token());
    const provider = new GrokOAuthProvider({ preconnect: false });
    const models = [
      { id: 'grok-4.5-non-reasoning-0309', context_length: 500000 },
      { id: 'grok-4.5-multi-agent-0309', reasoningEfforts: ['LOW', { value: 'xhigh' }, 'low', 'invalid'] },
      { id: 'grok-build' },
      { id: 'grok-composer-2.5-fast' },
      { id: 'grok-custom', name: 'Native Name' },
      { id: 'grok-display', display: 'Custom Display' },
      { id: 'grok-4.6', created: 30 },
      { id: 'grok-image', created: 100 },
      { id: 'grok-video' },
      { id: '' },
    ];
    s.replies.push(response({ data: models }), response({ data: [] }));
    const listed = await provider.listModels();
    assert.deepEqual(plain(listed.map((model) => model.display)), [
      'Grok 4.5 Non Reasoning',
      'Grok 4.5 Multi Agent',
      'Grok Build',
      'Composer 2.5 Fast',
      'Native Name',
      'Custom Display',
      'Grok 4.6',
    ]);
    assert.deepEqual(plain(listed[0].reasoningLevels), []);
    assert.deepEqual(plain(listed[1].reasoningLevels), ['low', 'xhigh']);
    assert.deepEqual(plain(listed[6].reasoningLevels), ['low', 'medium', 'high']);
    assert.equal(listed[0].contextWindow, 500000);
    assert.equal(listed[2].contextWindow, 512000);
    assert.equal(listed[3].contextWindow, 200000);
    assert.equal(listed[6].latest, true);
    s.cache = models.map((model) => ({ ...model, outputTokens: 500000 }));
    const cached = await provider.listModels();
    assert.deepEqual(plain(cached.map((model) => model.display)), plain(listed.map((model) => model.display)));
    assert.ok(cached.every((model) => model.outputTokens === null));
    assert.equal(s.requests.length, 2);
  });

  test('catalog merging, default release date, proxy fallback and API failures', async () => {
    const {
      s,
      provider: { GrokOAuthProvider },
    } = await isolated();
    s.store(token());
    const provider = new GrokOAuthProvider({ preconnect: false });
    s.replies.push(
      response({
        data: [
          { id: 'grok-4.3', created: 20 },
          { id: 'grok-4.20', created: 10 },
        ],
      }),
      response({
        data: [
          { id: 'grok-4.3', created: 1 },
          { id: 'grok-build', created: 100 },
        ],
      })
    );
    const models = await provider._refreshModelCache();
    assert.equal(models.find((model) => model.id === 'grok-4.3').created, 20);
    s.sendReplies.push('sent');
    assert.equal(await provider.send([], null, []), 'sent');
    assert.equal(s.sends[0].args[1], 'grok-4.3');
    s.cache = null;
    s.replies.push(response({ data: [{ id: 'grok-4.6' }] }), new Error('proxy offline'));
    assert.equal((await provider.listModels()).length, 1);
    s.cache = null;
    s.replies.push(response({}, 503), response({ data: [] }));
    await assert.rejects(provider.listModels(), /models 503/);
    s.replies.push(response({}), response({ data: [] }));
    assert.equal(await provider._refreshModelCache(), null);
    assert.ok(s.timeouts.every((timeout) => timeout.cleaned));
  });

  test('send preserves aliases, tools, request identity and warmup on safe 401/403 retry', async () => {
    for (const status of [401, 403]) {
      const {
        s,
        provider: { GrokOAuthProvider },
      } = await isolated();
      s.store(token({ user_id: 'user' }));
      const provider = new GrokOAuthProvider({ preconnect: false, responsesTransport: 'websocket' });
      const warmup = { usage: { inputTokens: 10 } };
      s.sendReplies.push(Object.assign(new Error('rejected'), { httpStatus: status, __warmup: warmup }), 'retried');
      s.replies.push(response({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }));
      const tools = [{ name: 'fixture-tool' }];
      s.toolResult = [{ name: 'normalized-tool' }];
      const opts = { effort: 'high', sessionId: 'session', iteration: 2 };
      assert.equal(await provider.send([], 'grok-code-fast', tools, opts), 'retried');
      assert.equal(s.sends.length, 2);
      assert.equal(s.sends[0].args[1], 'grok-build-0.1');
      assert.equal(s.sends[0].args[2], s.toolResult);
      assert.equal(s.normalizedTools[0], tools);
      assert.equal(s.sends[0].args[3].effort, 'none');
      assert.equal(s.sends[1].args[3]._carriedWarmup, warmup);
      assert.equal(opts.effort, 'high');
      assert.equal(s.inners[1].config.extraHeaders, s.inners[0].config.extraHeaders);
      assert.equal(s.inners[1].config.apiKey, 'fresh');
      assert.ok(
        s.inners.every(
          ({ provider: name, config }) =>
            name === 'xai' &&
            config.baseURL === 'https://cli-chat-proxy.grok.com/v1' &&
            config.responsesTransport === 'http'
        )
      );
    }
  });

  test('strict replay guards and preconnect false are not truthiness checks', async () => {
    for (const properties of [
      { httpStatus: 401, liveTextEmitted: true },
      { status: 403, emittedToolCall: true },
      { status: 401, unsafeToRetry: true },
      { status: 500 },
      {},
    ]) {
      const {
        s,
        provider: { GrokOAuthProvider },
      } = await isolated();
      s.store(token());
      const provider = new GrokOAuthProvider({ preconnect: false });
      const error = Object.assign(new Error('401 message only'), properties);
      s.sendReplies.push(error);
      await assert.rejects(provider.send([], 'grok-4.5', [], {}), (err) => err === error);
      assert.equal(s.requests.length, 0);
      assert.equal(s.sends.length, 1);
      assert.equal(s.preconnects.length, 0);
    }
    const {
      s,
      provider: { GrokOAuthProvider },
    } = await isolated();
    s.store(token());
    const provider = new GrokOAuthProvider({ preconnect: 0 });
    s.sendReplies.push(Object.assign(new Error('retry'), { status: 401, unsafeToRetry: 1 }), 'done');
    s.replies.push(response({ access_token: 'fresh', expires_in: 3600 }));
    assert.equal(await provider.send([], 'grok-4.5', [], {}), 'done');
    assert.equal(s.preconnects.length, 2);
  });

  test('auth reload, shared refresh, grace window and forced errors preserve boundaries', async () => {
    const {
      s,
      tokens: t,
      provider: { GrokOAuthProvider },
    } = await isolated();
    const provider = new GrokOAuthProvider({ preconnect: false });
    assert.equal(await provider.isAvailable(), false);
    await assert.rejects(provider.ensureAuth(), /credentials not found/);
    s.store(token({ expires_at: NOW + 60_000 }));
    assert.equal(await provider.isAvailable(), true);
    s.replies.push(response({ error: 'invalid_client' }, 400));
    assert.equal((await provider.ensureAuth()).access_token, 'fixture-access');
    assert.equal((await provider.ensureAuth()).access_token, 'fixture-access');
    assert.equal(s.requests.length, 1);
    s.replies.push(response({ error: 'invalid_client' }, 400));
    await assert.rejects(provider.ensureAuth({ forceRefresh: true }), /token refresh 400/);
    s.store(token({ access_token: 'external-rotation' }));
    assert.equal((await provider.ensureAuth()).access_token, 'external-rotation');
    const shared = token({ access_token: 'shared-access' });
    t._setRefreshInFlight(Promise.resolve(shared));
    assert.equal(await provider.ensureAuth({ forceRefresh: true }), shared);
    t._setRefreshInFlight(null);
  });
}
