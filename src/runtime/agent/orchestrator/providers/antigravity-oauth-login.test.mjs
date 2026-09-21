import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

// The token store follows the selected account in provider-accounts.json,
// which outranks ANTIGRAVITY_OAUTH_CREDENTIALS_PATH. Isolate the data dir so a
// developer's connected account is never overwritten by a login test.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-antigravity-login-data-'));

import { beginOAuthLogin, discoverProject, exchangeAuthorizationCode } from './antigravity-oauth-login.mjs';
import {
  antigravityHeaders,
  codeAssistMetadata,
  TOKEN_URL,
  USERINFO_URL,
  LOGIN_TIMEOUT_MS,
} from './antigravity-oauth-tokens.mjs';

const baseUrl = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const metadata = { ideType: 'ANTIGRAVITY' };
const onboardResponse = {
  '@type': 'type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse',
  cloudaicompanionProject: 'provisioned-project',
};

function account(projectId = 'current-project') {
  return {
    currentTier: { id: 'free-tier' },
    paidTier: { id: 'standard-tier' },
    cloudaicompanionProject: projectId,
  };
}

function scriptedFetch(replies) {
  const calls = [];
  const fetchFn = async (url, init) => {
    init.signal.throwIfAborted();
    assert.ok(calls.length < replies.length, `Unexpected request: ${url}`);
    const index = calls.length;
    calls.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const reply = typeof replies[index] === 'function' ? await replies[index](url, init) : replies[index];
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return { fetchFn, calls };
}

function isolateTokenStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-antigravity-login-'));
  const tokenPath = join(directory, 'credentials.json');
  const previous = process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH;
  process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH = tokenPath;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH;
    else process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH = previous;
  });
  return tokenPath;
}

test('hub identity and control-plane metadata exclude unsupported platform fields', (t) => {
  const previous = process.env.MIXDOG_ANTIGRAVITY_VERSION;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_ANTIGRAVITY_VERSION;
    else process.env.MIXDOG_ANTIGRAVITY_VERSION = previous;
  });
  delete process.env.MIXDOG_ANTIGRAVITY_VERSION;
  assert.deepEqual(antigravityHeaders(), {
    'User-Agent': 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)',
  });
  process.env.MIXDOG_ANTIGRAVITY_VERSION = ' 2.9.0 ';
  assert.equal(
    antigravityHeaders()['User-Agent'],
    'antigravity/hub/2.9.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)'
  );
  assert.deepEqual(codeAssistMetadata(), metadata);
  const changed = codeAssistMetadata();
  changed.platform = 'WINDOWS';
  assert.deepEqual(codeAssistMetadata(), metadata);
});

test('existing accounts return the refreshed project without onboarding', async () => {
  const { fetchFn, calls } = scriptedFetch([account('old-project'), account('fresh-project')]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'fresh-project');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, `${baseUrl}:loadCodeAssist`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { metadata });
    assert.deepEqual(call.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer access-token',
      ...antigravityHeaders(),
    });
    assert.equal(call.redirect, 'error');
  }
});

test('missing or null paidTier causes a project-scoped reload on both status loads', async () => {
  const { fetchFn, calls } = scriptedFetch([
    { currentTier: {}, cloudaicompanionProject: 'first-project' },
    account('first-project'),
    { currentTier: {}, paidTier: null, cloudaicompanionProject: 'next-project' },
    account('final-project'),
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'final-project');
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { metadata },
      { metadata, cloudaicompanionProject: 'first-project' },
      { metadata },
      { metadata, cloudaicompanionProject: 'next-project' },
    ]
  );
  assert.ok(calls.every((call) => call.url === `${baseUrl}:loadCodeAssist`));
});

test('onboarding uses free-tier once and refreshes instead of trusting the operation project', async () => {
  const { fetchFn, calls } = scriptedFetch([
    { currentTier: null, allowedTiers: [{ id: 'standard-tier', isDefault: true }, { id: 'free-tier' }] },
    { done: true, response: onboardResponse },
    account('refreshed-project'),
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'refreshed-project');
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${baseUrl}:loadCodeAssist`, `${baseUrl}:onboardUser`, `${baseUrl}:loadCodeAssist`]
  );
  assert.deepEqual(calls[1].body, { tierId: 'free-tier', metadata });
});

test('pending provisioning polls the named operation with GET, never repeated POST', async () => {
  const { fetchFn, calls } = scriptedFetch([
    {},
    { name: 'operations/provision-1', done: false },
    { done: true, response: onboardResponse },
    account(),
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'current-project');
  assert.equal(calls.length, 4);
  assert.equal(calls[2].url, `${baseUrl}/operations/provision-1`);
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].body, undefined);
  assert.equal(calls[2].headers.Authorization, 'Bearer access-token');
  assert.equal(calls.filter((call) => call.url === `${baseUrl}:onboardUser`).length, 1);
});

test('free-tier denial retains its reason and validation URL without onboarding', async () => {
  const validationUrl = `https://accounts.google.com/validation?context=${'a'.repeat(300)}`;
  const { fetchFn, calls } = scriptedFetch([
    {
      ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'Account validation required.', validationUrl }],
    },
  ]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), (error) => {
    assert.ok(error.message.includes('Account validation required.'));
    assert.ok(error.message.includes(validationUrl));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('a subscription tier is onboarded when the free tier is denied but another tier is allowed', async () => {
  const { fetchFn, calls } = scriptedFetch([
    {
      allowedTiers: [
        { id: 'standard-tier', userDefinedCloudaicompanionProject: true },
        { id: 'pro-tier', isDefault: true },
      ],
      ineligibleTiers: [
        { tierId: 'free-tier', reasonMessage: 'Not eligible', validationUrl: 'https://accounts.google.com/verify' },
      ],
    },
    { done: true, response: onboardResponse },
    { ...account('pro-project'), currentTier: { id: 'pro-tier' } },
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'pro-project');
  assert.deepEqual(calls[1].body, { tierId: 'pro-tier', metadata });
});

test('an already onboarded account skips tier eligibility checks', async () => {
  const { fetchFn, calls } = scriptedFetch([
    {
      ...account('existing-project'),
      currentTier: { id: 'pro-tier' },
      allowedTiers: [],
      ineligibleTiers: [
        { tierId: 'free-tier', reasonMessage: 'Not eligible', validationUrl: 'https://accounts.google.com/verify' },
      ],
    },
    { ...account('existing-project'), currentTier: { id: 'pro-tier' } },
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'existing-project');
  assert.equal(calls.length, 2);
});

test('denial errors list the reported tiers for diagnosis', async () => {
  const { fetchFn } = scriptedFetch([
    {
      allowedTiers: [{ id: 'standard-tier', userDefinedCloudaicompanionProject: true }],
      ineligibleTiers: [
        { tierId: 'free-tier', reasonMessage: 'Not eligible', validationUrl: 'https://accounts.google.com/verify' },
      ],
    },
  ]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), (error) => {
    assert.equal(error.code, 'VALIDATION_REQUIRED');
    assert.ok(error.message.includes('allowed tiers: [standard-tier]; ineligible tiers: [free-tier]'));
    return true;
  });
});

test('an explicitly allowed free tier takes precedence over ineligibility details', async () => {
  const { fetchFn, calls } = scriptedFetch([
    {
      currentTier: null,
      allowedTiers: [{ id: 'free-tier' }],
      ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'Stale denial' }],
    },
    { done: true, response: onboardResponse },
    account(),
  ]);
  assert.equal(await discoverProject('access-token', { fetchFn }), 'current-project');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, `${baseUrl}:onboardUser`);
  assert.deepEqual(calls[1].body, { tierId: 'free-tier', metadata });
});

for (const status of [201, 400, 403, 500]) {
  test(`status ${status} stops discovery without alternate-endpoint retries`, async () => {
    const validationUrl = `https://accounts.google.com/validation?context=${'b'.repeat(300)}`;
    const { fetchFn, calls } = scriptedFetch([
      new Response(`Invalid metadata or account: ${validationUrl}`, { status }),
    ]);
    await assert.rejects(discoverProject('access-token', { fetchFn }), (error) => {
      assert.ok(error.message.includes(`loadCodeAssist failed: ${status}`));
      assert.ok(error.message.includes(validationUrl));
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('transport failures are not hidden behind endpoint fallback', async () => {
  const failure = new Error('connection reset');
  let requests = 0;
  await assert.rejects(
    discoverProject('access-token', {
      fetchFn: async () => {
        requests += 1;
        throw failure;
      },
    }),
    (error) => error === failure
  );
  assert.equal(requests, 1);
});

test('onboard HTTP failures surface immediately instead of retrying or saving a guessed project', async () => {
  const { fetchFn, calls } = scriptedFetch([{}, new Response('Provisioning denied', { status: 403 })]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), /onboardUser failed: 403.*Provisioning denied/);
  assert.equal(calls.length, 2);
});

test('completed operation errors retain the server code and message', async () => {
  const { fetchFn, calls } = scriptedFetch([{}, { done: true, error: { code: 7, message: 'Permission denied' } }]);
  await assert.rejects(
    discoverProject('access-token', { fetchFn }),
    /onboardUser operation failed: 7: Permission denied/
  );
  assert.equal(calls.length, 2);
});

test('a completed operation must contain the typed onboarding response', async () => {
  for (const response of [undefined, null, {}, { cloudaicompanionProject: 'untyped-project' }]) {
    const { fetchFn, calls } = scriptedFetch([{}, { done: true, response }]);
    await assert.rejects(discoverProject('access-token', { fetchFn }), /invalid onboardUser response/);
    assert.equal(calls.length, 2);
  }
});

test('pending operations without a name fail rather than re-posting onboarding', async () => {
  const { fetchFn, calls } = scriptedFetch([{}, { done: false }]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), /operation without a name/);
  assert.equal(calls.length, 2);
});

test('the entire onboarding operation shares a 30-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { fetchFn, calls } = scriptedFetch([
    {},
    () => {
      t.mock.timers.tick(30_000);
      return { name: 'operations/too-slow' };
    },
  ]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), /onboardUser timed out after 30000ms/);
  assert.equal(calls.length, 2);
});

test('missing projects do not fall back to stale or unrelated project fields', async () => {
  for (const payload of [
    { currentTier: {} },
    { currentTier: {}, projectId: 'guessed', project: 'guessed' },
    { currentTier: {}, cloudaicompanionProject: { id: 'guessed' } },
  ]) {
    const { fetchFn, calls } = scriptedFetch([account('old-project'), payload]);
    await assert.rejects(discoverProject('access-token', { fetchFn }), /did not return a cloudaicompanionProject/);
    assert.equal(calls.length, 2);
  }
});

test('non-object status responses are rejected', async () => {
  for (const payload of [null, [], 'project']) {
    const { fetchFn } = scriptedFetch([payload]);
    await assert.rejects(discoverProject('access-token', { fetchFn }), /invalid loadCodeAssist response/);
  }
});

test('cancellation stops pending onboarding without polling', async () => {
  const controller = new AbortController();
  const { fetchFn, calls } = scriptedFetch([
    {},
    () => {
      controller.abort();
      return { name: 'operations/cancelled' };
    },
  ]);
  await assert.rejects(discoverProject('access-token', { fetchFn, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

test('a cancelled login never exchanges an authorization code', async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(
    exchangeAuthorizationCode({
      code: 'code',
      verifier: 'verifier',
      signal: controller.signal,
      fetchFn: async () => {
        requests += 1;
        throw new Error('Unexpected request');
      },
    }),
    { name: 'AbortError' }
  );
  assert.equal(requests, 0);
});

test('authorization exchange saves only the final discovered project', async (t) => {
  const tokenPath = isolateTokenStore(t);
  const project = scriptedFetch([account('old-project'), account('saved-project')]);
  const tokens = await exchangeAuthorizationCode({
    code: 'authorization-code',
    verifier: 'pkce-verifier',
    fetchFn: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (url === TOKEN_URL) {
        assert.equal(init.body.get('grant_type'), 'authorization_code');
        assert.equal(init.body.get('code'), 'authorization-code');
        assert.equal(init.body.get('code_verifier'), 'pkce-verifier');
        assert.equal(init.body.get('redirect_uri'), 'http://127.0.0.1:51121/oauth-callback');
        return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return Response.json({ email: 'account@example.test' });
      return project.fetchFn(url, init);
    },
  });
  assert.equal(project.calls.length, 2);
  assert.equal(tokens.project_id, 'saved-project');
  const saved = JSON.parse(readFileSync(tokenPath, 'utf8'));
  assert.equal(saved.project_id, 'saved-project');
  assert.equal(saved.refresh_token, 'refresh-token');
  assert.equal(saved.email, 'account@example.test');
});

test('failed project discovery never persists the exchanged credentials', async (t) => {
  const tokenPath = isolateTokenStore(t);
  await assert.rejects(
    exchangeAuthorizationCode({
      code: 'authorization-code',
      verifier: 'pkce-verifier',
      fetchFn: async (url) => {
        if (url === TOKEN_URL) return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token' });
        if (url === USERINFO_URL) return Response.json({});
        return new Response('Invalid metadata.platform', { status: 400 });
      },
    }),
    /loadCodeAssist failed: 400/
  );
  assert.equal(existsSync(tokenPath), false);
});

function loginFetch(
  projectReplies = [account(), account()],
  { tokenStep = null, email = 'signed-in@example.test' } = {}
) {
  const project = scriptedFetch(projectReplies);
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      init.signal.throwIfAborted();
      calls.push({ url, init });
      if (url === TOKEN_URL) {
        if (tokenStep) await tokenStep(init);
        return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return Response.json({ email });
      return project.fetchFn(url, init);
    },
  };
}

async function callbackLogin(t, fetchFn) {
  const tokenPath = isolateTokenStore(t);
  const listening = Promise.withResolvers();
  let server;
  const opened = [];
  const login = await beginOAuthLogin({
    fetchFn,
    openBrowserFn: async (url) => {
      opened.push(url);
    },
    createServerFn: (handler) => {
      server = createServer(handler);
      const listen = server.listen.bind(server);
      // Only the test listener uses an ephemeral port. The OAuth wire
      // redirect remains the provider's registered loopback URI.
      server.listen = (_port, hostname, callback) => listen(0, hostname, callback);
      server.once('listening', listening.resolve);
      return server;
    },
  });
  const outcome = login.waitForCallback.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  t.after(() => {
    login.cancel();
    server.closeAllConnections();
  });
  await listening.promise;
  const authUrl = new URL(login.url);
  const callbackUrl = `http://127.0.0.1:${server.address().port}/oauth-callback`;
  return {
    login,
    outcome,
    tokenPath,
    server,
    authUrl,
    opened,
    request: (params) => {
      const target = new URL(callbackUrl);
      target.searchParams.set('state', authUrl.searchParams.get('state'));
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      return fetch(target);
    },
  };
}

test('structured verification errors identify the exchanged account and retain the complete URL', async (t) => {
  const tokenPath = isolateTokenStore(t);
  const validationUrl = `https://accounts.google.com/signin/continue?plt=${'v'.repeat(400)}&authuser=2`;
  const api = loginFetch([
    new Response(
      JSON.stringify({
        error: {
          code: 403,
          message: 'Verify your account to continue.',
          details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: validationUrl } }],
        },
      }),
      { status: 403 }
    ),
  ]);
  await assert.rejects(
    exchangeAuthorizationCode({ code: 'code', verifier: 'verifier', fetchFn: api.fetchFn }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_REQUIRED');
      assert.ok(error.message.includes('Account verification required for signed-in@example.test.'));
      assert.ok(error.message.includes('Verify your account to continue.'));
      assert.ok(error.message.includes(validationUrl));
      assert.equal(error.validationUrl, validationUrl);
      assert.ok(error.message.includes('then sign in again'));
      return true;
    }
  );
  assert.equal(existsSync(tokenPath), false);
  assert.deepEqual(
    api.calls.map((call) => call.url),
    [
      'https://oauth2.googleapis.com/token',
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      `${baseUrl}:loadCodeAssist`,
    ]
  );
});

test('native free-tier verification errors also name the authenticated account', async (t) => {
  const tokenPath = isolateTokenStore(t);
  const validationUrl = 'https://accounts.google.com/signin/continue?plt=verification';
  const api = loginFetch([
    {
      ineligibleTiers: [
        {
          tierId: 'free-tier',
          reasonMessage: 'Your current account is not eligible for Antigravity.',
          validationUrl,
        },
      ],
    },
  ]);
  await assert.rejects(
    exchangeAuthorizationCode({ code: 'code', verifier: 'verifier', fetchFn: api.fetchFn }),
    (error) => {
      assert.match(error.message, /Account verification required for signed-in@example\.test/);
      assert.ok(error.message.includes('Your current account is not eligible for Antigravity.'));
      assert.ok(error.message.includes(validationUrl));
      return true;
    }
  );
  assert.equal(existsSync(tokenPath), false);
});

test('verification without a known email does not invent an account identity', async () => {
  const { fetchFn } = scriptedFetch([
    new Response(
      JSON.stringify({
        error: {
          details: [
            { reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/verify' } },
          ],
        },
      }),
      { status: 403 }
    ),
  ]);
  await assert.rejects(discoverProject('access-token', { fetchFn }), (error) => {
    assert.match(error.message, /Account verification required\./);
    assert.doesNotMatch(error.message, /required for|undefined|null/);
    return true;
  });
});

test('unrelated or incomplete API errors are not rewritten as verification requests', async () => {
  for (const body of [
    'not JSON: VALIDATION_REQUIRED',
    JSON.stringify({ error: { details: [{ reason: 'VALIDATION_REQUIRED' }] } }),
    JSON.stringify({ error: { details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: '' } }] } }),
    JSON.stringify({
      error: {
        details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', metadata: { validation_url: 'https://example.test' } }],
      },
    }),
  ]) {
    const { fetchFn } = scriptedFetch([new Response(body, { status: 403 })]);
    await assert.rejects(discoverProject('access-token', { fetchFn }), (error) => {
      assert.match(error.message, /loadCodeAssist failed: 403/);
      assert.doesNotMatch(error.message, /Account verification required/);
      return true;
    });
  }
});

test('browser and manual callbacks share one exchange and show success only for a saved project', async (t) => {
  const tokenStarted = Promise.withResolvers();
  const releaseToken = Promise.withResolvers();
  const api = loginFetch(undefined, {
    tokenStep: async () => {
      tokenStarted.resolve();
      await releaseToken.promise;
    },
  });
  const fixture = await callbackLogin(t, api.fetchFn);
  assert.equal(fixture.authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:51121/oauth-callback');
  assert.equal(fixture.authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(fixture.authUrl.searchParams.get('prompt'), 'consent');
  assert.equal(fixture.authUrl.searchParams.get('access_type'), 'offline');
  assert.deepEqual(fixture.opened, [fixture.login.url]);

  const first = fixture.request({ code: 'browser-code' });
  await tokenStarted.promise;
  const secondReceived = once(fixture.server, 'request');
  const second = fixture.request({ code: 'duplicate-browser-code' });
  await secondReceived;
  const manual = fixture.login.completeCode(`manual-code#${fixture.authUrl.searchParams.get('state')}`);
  assert.equal(api.calls.filter((call) => call.url === TOKEN_URL).length, 1);
  assert.equal(existsSync(fixture.tokenPath), false);
  releaseToken.resolve();

  const [firstResponse, secondResponse, tokens, outcome] = await Promise.all([first, second, manual, fixture.outcome]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.match(await firstResponse.text(), /Antigravity connected/);
  assert.match(await secondResponse.text(), /Antigravity connected/);
  assert.equal(tokens, outcome.value);
  assert.equal(tokens.project_id, 'current-project');
  assert.equal(api.calls[0].init.body.get('code'), 'browser-code');
  assert.equal(api.calls.filter((call) => call.url === TOKEN_URL).length, 1);
  assert.equal(JSON.parse(readFileSync(fixture.tokenPath, 'utf8')).project_id, 'current-project');
});

test('a manual-first exchange is shared with a later browser callback', async (t) => {
  const tokenStarted = Promise.withResolvers();
  const releaseToken = Promise.withResolvers();
  const api = loginFetch(undefined, {
    tokenStep: async () => {
      tokenStarted.resolve();
      await releaseToken.promise;
    },
  });
  const fixture = await callbackLogin(t, api.fetchFn);
  const manual = fixture.login.completeCode('manual-code');
  await tokenStarted.promise;
  const browserReceived = once(fixture.server, 'request');
  const browser = fixture.request({ code: 'browser-code' });
  await browserReceived;
  releaseToken.resolve();
  const [tokens, response] = await Promise.all([manual, browser]);
  assert.equal(response.status, 200);
  assert.equal(tokens.project_id, 'current-project');
  assert.equal(api.calls[0].init.body.get('code'), 'manual-code');
  assert.equal(api.calls.filter((call) => call.url === TOKEN_URL).length, 1);
});

test('failed eligibility produces a failure page, never premature browser success', async (t) => {
  const api = loginFetch([new Response('Account eligibility denied', { status: 403 })]);
  const fixture = await callbackLogin(t, api.fetchFn);
  const response = await fixture.request({ code: 'browser-code' });
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /sign-in was not completed/);
  assert.doesNotMatch(html, /login successful|Antigravity connected/);
  assert.match((await fixture.outcome).error.message, /Account eligibility denied/);
  assert.equal(existsSync(fixture.tokenPath), false);
});

test('invalid callbacks and pasted states do not terminate the pending login', async (t) => {
  const api = loginFetch();
  const fixture = await callbackLogin(t, api.fetchFn);
  for (const params of [
    { code: 'forged-code', state: 'wrong-state' },
    { code: '' },
    { error: 'access_denied', state: 'wrong-state' },
    { error: 'access_denied', state: '' },
  ]) {
    assert.equal((await fixture.request(params)).status, 400);
  }
  await assert.rejects(fixture.login.completeCode('code#wrong-state'), /state mismatch/);
  await assert.rejects(
    fixture.login.completeCode('http://127.0.0.1:51121/oauth-callback?code=code&state=wrong'),
    /state mismatch/
  );
  await assert.rejects(fixture.login.completeCode(''), /authorization code is required/);
  assert.equal(api.calls.length, 0);
  const tokens = await fixture.login.completeCode(`valid-code#${fixture.authUrl.searchParams.get('state')}`);
  assert.equal(tokens.project_id, 'current-project');
  assert.equal((await fixture.outcome).value, tokens);
});

test('a genuine authorization denial is reported without echoing provider text into HTML', async (t) => {
  const api = loginFetch();
  const fixture = await callbackLogin(t, api.fetchFn);
  const description = 'Consent declined <script>alert(1)</script>';
  const response = await fixture.request({ error: 'access_denied', error_description: description });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /<script>|Consent declined/);
  assert.ok((await fixture.outcome).error.message.includes('Consent declined'));
  assert.equal(api.calls.length, 0);
  assert.equal(existsSync(fixture.tokenPath), false);
});

test('a late denial does not cancel an accepted authorization code', async (t) => {
  const tokenStarted = Promise.withResolvers();
  const releaseToken = Promise.withResolvers();
  const api = loginFetch(undefined, {
    tokenStep: async () => {
      tokenStarted.resolve();
      await releaseToken.promise;
    },
  });
  const fixture = await callbackLogin(t, api.fetchFn);
  const manual = fixture.login.completeCode('accepted-code');
  await tokenStarted.promise;
  assert.equal((await fixture.request({ error: 'access_denied' })).status, 400);
  assert.equal(api.calls[0].init.signal.aborted, false);
  releaseToken.resolve();
  assert.equal((await manual).project_id, 'current-project');
  assert.equal((await fixture.outcome).value.project_id, 'current-project');
});

test('the five-minute browser deadline ends when a code is accepted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tokenStarted = Promise.withResolvers();
  const releaseToken = Promise.withResolvers();
  const api = loginFetch(undefined, {
    tokenStep: async () => {
      tokenStarted.resolve();
      await releaseToken.promise;
    },
  });
  const fixture = await callbackLogin(t, api.fetchFn);
  t.mock.timers.tick(LOGIN_TIMEOUT_MS - 1);
  const manual = fixture.login.completeCode('accepted-code');
  await tokenStarted.promise;
  t.mock.timers.tick(LOGIN_TIMEOUT_MS);
  assert.equal(api.calls[0].init.signal.aborted, false);
  releaseToken.resolve();
  assert.equal((await manual).project_id, 'current-project');
  assert.equal((await fixture.outcome).value.project_id, 'current-project');
});

test('an unanswered browser login reports its timeout rather than success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = loginFetch();
  const fixture = await callbackLogin(t, api.fetchFn);
  t.mock.timers.tick(LOGIN_TIMEOUT_MS);
  assert.match((await fixture.outcome).error.message, /browser authentication timed out after 300000ms/);
  assert.equal(api.calls.length, 0);
  assert.equal(existsSync(fixture.tokenPath), false);
});

test('cancelling an in-flight exchange prevents credential persistence', async (t) => {
  const tokenStarted = Promise.withResolvers();
  const releaseToken = Promise.withResolvers();
  const api = loginFetch(undefined, {
    tokenStep: async () => {
      tokenStarted.resolve();
      await releaseToken.promise;
    },
  });
  const fixture = await callbackLogin(t, api.fetchFn);
  const manual = fixture.login.completeCode('accepted-code');
  const rejected = assert.rejects(manual, { name: 'AbortError' });
  await tokenStarted.promise;
  fixture.login.cancel();
  releaseToken.resolve();
  await rejected;
  assert.equal((await fixture.outcome).value, null);
  assert.equal(api.calls[0].init.signal.aborted, true);
  assert.equal(existsSync(fixture.tokenPath), false);
});
