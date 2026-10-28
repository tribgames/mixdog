import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as auth from './vertex-ai-auth.mjs';

const ADC_FILE = join('gcloud', 'application_default_credentials.json');
const IMPERSONATE_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vx-adc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  return { dir, write, env: { CLOUDSDK_CONFIG: join(dir, 'gcloud') } };
}

function userLogin(overrides = {}) {
  return {
    type: 'authorized_user',
    client_id: 'client-1.apps.googleusercontent.com',
    client_secret: 'client-secret-1',
    refresh_token: 'refresh-1',
    account: 'me@example.com',
    ...overrides,
  };
}

function serviceAccountKey(overrides = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'runner@key-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ...overrides,
  };
}

// A fake OAuth and IAM Credentials endpoint; tokens name the grant that minted them.
function tokenEndpoint({ now = () => Date.now(), gate = null } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const index = calls.length;
    if (gate) await gate;
    if (url === auth.VERTEX_TOKEN_URI) {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const grant = form.grant_type === 'refresh_token' ? form.refresh_token : 'jwt';
      return Response.json({ access_token: `oauth-${index}-${grant}`, expires_in: 3600 });
    }
    if (url.startsWith(IMPERSONATE_URL)) {
      return Response.json({
        accessToken: `impersonated-${index}`,
        expireTime: new Date(now() + 3600_000).toISOString(),
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchFn };
}

const adcManager = (env, fetchFn, extra = {}) =>
  new auth.VertexAccessTokenManager({ authMode: 'adc', env, fetchFn, ...extra });

test('Vertex ADC reads GOOGLE_APPLICATION_CREDENTIALS before the gcloud login file', async (t) => {
  const { dir, write, env } = sandbox(t);
  write(ADC_FILE, userLogin({ refresh_token: 'from-gcloud' }));
  const explicit = write('explicit.json', userLogin({ refresh_token: 'from-env' }));
  const { calls, fetchFn } = tokenEndpoint();
  const token = (sourceEnv) => adcManager(sourceEnv, fetchFn).getAccessToken();

  assert.match(await token({ ...env, GOOGLE_APPLICATION_CREDENTIALS: explicit }), /from-env$/);
  assert.match(await token(env), /from-gcloud$/);
  // A set variable is the only source: its missing file is an error, not a fallthrough.
  await assert.rejects(
    token({ ...env, GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'missing.json') }),
    /GOOGLE_APPLICATION_CREDENTIALS points to .*missing\.json/
  );
  await assert.rejects(
    token({ CLOUDSDK_CONFIG: join(dir, 'empty') }),
    /No gcloud login found\. Run `gcloud auth application-default login`/
  );
  assert.equal(calls.length, 2);

  // Without CLOUDSDK_CONFIG: %APPDATA%\gcloud on Windows, ~/.config/gcloud elsewhere.
  const appData = 'C:\\Users\\me\\AppData\\Roaming';
  assert.equal(auth.gcloudConfigDir({ APPDATA: appData }, 'win32', 'C:\\Users\\me'), join(appData, 'gcloud'));
  assert.equal(auth.gcloudConfigDir({ APPDATA: appData }, 'linux', '/home/me'), join('/home/me', '.config', 'gcloud'));
  assert.equal(
    auth.gcloudConfigDir({ CLOUDSDK_CONFIG: '/custom/gcloud', APPDATA: appData }, 'win32', 'h'),
    '/custom/gcloud'
  );
});

test('Vertex ADC exchanges a gcloud user login refresh token at the OAuth endpoint', async (t) => {
  const { write, env } = sandbox(t);
  write(ADC_FILE, userLogin());
  const { calls, fetchFn } = tokenEndpoint();
  const manager = adcManager(env, fetchFn);

  const token = await manager.getAccessToken();
  assert.equal(token, 'oauth-1-refresh-1');
  assert.equal(calls[0].url, auth.VERTEX_TOKEN_URI);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    grant_type: 'refresh_token',
    client_id: 'client-1.apps.googleusercontent.com',
    client_secret: 'client-secret-1',
    refresh_token: 'refresh-1',
  });
  assert.equal(await manager.getAccessToken(), token);
  assert.equal(calls.length, 1);

  // A revoked login says how to sign in again, without echoing the refresh token.
  const revoked = adcManager(env, async () =>
    Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })
  );
  await assert.rejects(revoked.getAccessToken(), (error) => {
    assert.equal(error.code, 'EVERTEXAUTH');
    assert.match(error.message, /expired or was revoked.*gcloud auth application-default login/);
    assert.equal(error.message.includes('refresh-1'), false);
    return true;
  });
});

test('Vertex ADC signs a JWT for a service-account key named by GOOGLE_APPLICATION_CREDENTIALS', async (t) => {
  const { write, env } = sandbox(t);
  const key = serviceAccountKey();
  const path = write('sa.json', key);
  const { calls, fetchFn } = tokenEndpoint();
  const manager = adcManager({ ...env, GOOGLE_APPLICATION_CREDENTIALS: path }, fetchFn);

  assert.equal(await manager.getAccessToken(), 'oauth-1-jwt');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = JSON.parse(Buffer.from(form.get('assertion').split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.iss, key.client_email);
  assert.equal(claims.scope, auth.VERTEX_SCOPE);
  assert.equal(claims.aud, auth.VERTEX_TOKEN_URI);
  assert.equal(manager.projectId(), 'key-project');
});

test('Vertex ADC impersonates the target service account with the source login token', async (t) => {
  const { write, env } = sandbox(t);
  write(ADC_FILE, {
    type: 'impersonated_service_account',
    service_account_impersonation_url: `${IMPERSONATE_URL}/target@proj.iam.gserviceaccount.com:generateAccessToken`,
    delegates: ['hop@proj.iam.gserviceaccount.com'],
    source_credentials: userLogin(),
  });
  let now = 1_800_000_000_000;
  const { calls, fetchFn } = tokenEndpoint({ now: () => now });
  const manager = adcManager(env, fetchFn, { now: () => now });

  assert.equal(await manager.getAccessToken(), 'impersonated-2');
  assert.equal(new URLSearchParams(calls[0].init.body).get('refresh_token'), 'refresh-1');
  assert.equal(calls[1].url, `${IMPERSONATE_URL}/target@proj.iam.gserviceaccount.com:generateAccessToken`);
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), 'Bearer oauth-1-refresh-1');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    delegates: ['projects/-/serviceAccounts/hop@proj.iam.gserviceaccount.com'],
    scope: [auth.VERTEX_SCOPE],
    lifetime: '3600s',
  });
  // Cached until the refresh skew before expireTime.
  now += 50 * 60_000;
  assert.equal(await manager.getAccessToken(), 'impersonated-2');
  now += 6 * 60_000;
  assert.equal(await manager.getAccessToken(), 'impersonated-4');

  const refused = adcManager(env, async (url) =>
    url === auth.VERTEX_TOKEN_URI
      ? Response.json({ access_token: 'source', expires_in: 3600 })
      : Response.json(
          { error: { code: 403, message: 'Permission iam.serviceAccounts.getAccessToken denied' } },
          { status: 403 }
        )
  );
  await assert.rejects(
    refused.getAccessToken(),
    /impersonating target@proj\.iam\.gserviceaccount\.com .*Service Account Token Creator/
  );
});

test('Vertex ADC project resolution: explicit, environment, quota project, key project, then gcloud config', async (t) => {
  const { write, env } = sandbox(t);
  write(join('gcloud', 'active_config'), 'work\n');
  write(
    join('gcloud', 'configurations', 'config_work'),
    '[compute]\nproject = not-core\n\n[core]\naccount = me@example.com\nproject = gcloud-project\n'
  );
  const key = { type: 'service_account', client_email: 'sa@key-project.iam.gserviceaccount.com', private_key: 'pem' };
  write(ADC_FILE, { ...key, project_id: 'key-project', quota_project_id: 'quota-project' });
  const projectEnv = {
    GOOGLE_VERTEX_PROJECT: 'vertex-env',
    GOOGLE_CLOUD_PROJECT: 'cloud-env',
    GCP_PROJECT: 'gcp-env',
    GCLOUD_PROJECT: 'gcloud-env',
    // Vendor names, after the Google ones.
    VERTEXAI_PROJECT: 'vertexai-env',
    ANTHROPIC_VERTEX_PROJECT_ID: 'anthropic-vertex-env',
  };
  const project = (extra, explicit) =>
    auth.describeVertexAdc({ env: { ...env, ...extra }, projectId: explicit }).projectId;

  assert.equal(project(projectEnv, 'explicit-project'), 'explicit-project');
  const remaining = { ...projectEnv };
  for (const [name, value] of Object.entries(projectEnv)) {
    assert.equal(project(remaining), value, name);
    delete remaining[name];
  }
  assert.equal(project({}), 'quota-project');
  write(ADC_FILE, { ...key, project_id: 'key-project' });
  assert.equal(project({}), 'key-project');
  write(ADC_FILE, key);
  assert.equal(project({}), 'gcloud-project');
  assert.equal(adcManager(env, null).projectId(), 'gcloud-project');

  write(join('gcloud', 'active_config'), 'none\n');
  assert.equal(project({}), null);
  assert.throws(
    () => adcManager(env, null).projectId(),
    /could not find a Google Cloud project.*gcloud config set project/
  );
});

// A fake metadata server: `project` (null: none answers) and the token it mints.
function metadataServer({ project = 'meta-project', flavor = 'Google' } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (project === null) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND metadata.google.internal');
    const headers = flavor ? { 'Metadata-Flavor': flavor } : {};
    if (String(url).endsWith('/computeMetadata/v1/project/project-id')) return new Response(project, { headers });
    if (String(url).endsWith('/computeMetadata/v1/instance/service-accounts/default/token')) {
      return Response.json({ access_token: `meta-token-${calls.length}`, expires_in: 3599 }, { headers });
    }
    if (url === auth.VERTEX_TOKEN_URI) return Response.json({ access_token: 'file-token', expires_in: 3600 });
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchFn };
}

test('Vertex ADC falls back to the metadata server without a credentials file, and keeps a miss', async (t) => {
  const { write, env } = sandbox(t);
  const { calls, fetchFn } = metadataServer();
  const manager = adcManager(env, fetchFn);

  // Nothing has probed yet: the synchronous reads report the missing login.
  assert.throws(() => manager.identity(), /No gcloud login found/);
  await manager.ready();
  await manager.ready();
  assert.equal(calls.length, 1, 'one probe');
  assert.equal(calls[0].url, 'http://metadata.google.internal/computeMetadata/v1/project/project-id');
  assert.equal(new Headers(calls[0].init.headers).get('metadata-flavor'), 'Google');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the probe has a deadline');

  // The metadata server's project, unless one is named in the environment.
  assert.equal(manager.projectId(), 'meta-project');
  assert.equal(adcManager({ ...env, GOOGLE_CLOUD_PROJECT: 'env-project' }, fetchFn).projectId(), 'env-project');
  assert.deepEqual(auth.describeVertexAdc({ env, fetchFn }), {
    state: 'ready',
    type: 'metadata',
    account: null,
    projectId: 'meta-project',
  });

  // Its token, cached and bound to the metadata identity like any other.
  const identity = manager.identity();
  assert.equal(await manager.getAccessToken({ identity }), 'meta-token-2');
  assert.equal(await manager.getAccessToken({ identity }), 'meta-token-2');
  assert.equal(
    calls[1].url,
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
  );
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(new Headers(calls[1].init.headers).get('metadata-flavor'), 'Google');
  manager.invalidate('meta-token-2');
  assert.equal(await manager.getAccessToken({ identity }), 'meta-token-3');

  // A gcloud login written later takes over.
  write(ADC_FILE, userLogin());
  assert.notEqual(manager.identity(), identity);
  assert.equal(await manager.getAccessToken(), 'file-token');

  // No metadata server (or something else answering): the miss is kept, and the login hint stays.
  for (const server of [metadataServer({ project: null }), metadataServer({ flavor: '' })]) {
    const { env: bare } = sandbox(t);
    const missing = adcManager(bare, server.fetchFn);
    await missing.ready();
    await missing.ready();
    assert.equal(server.calls.length, 1);
    await assert.rejects(missing.getAccessToken(), /No gcloud login found/);
    assert.equal(auth.describeVertexAdc({ env: bare, fetchFn: server.fetchFn }).state, 'missing');
  }
  // GOOGLE_APPLICATION_CREDENTIALS naming a missing file is never replaced by the metadata server.
  const { dir: other } = sandbox(t);
  const named = adcManager({ ...env, GOOGLE_APPLICATION_CREDENTIALS: join(other, 'missing.json') }, fetchFn);
  await named.ready();
  assert.throws(() => named.identity(), /GOOGLE_APPLICATION_CREDENTIALS points to/);
});

test('Vertex ADC re-reads a rewritten login file: a new identity and a new token without a restart', async (t) => {
  const { write, env } = sandbox(t);
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-old' }));
  const { calls, fetchFn } = tokenEndpoint();
  const manager = adcManager(env, fetchFn);

  const before = manager.identity();
  const first = await manager.getAccessToken();
  assert.equal(await manager.getAccessToken(), first);
  assert.equal(before.includes('refresh-old'), false, 'the identity carries no secret');

  // `gcloud auth application-default login` again, as another account.
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-new-login', account: 'other@example.com' }));
  const after = manager.identity();
  assert.notEqual(after, before);
  const second = await manager.getAccessToken();
  assert.equal(second, 'oauth-2-refresh-new-login');

  // The same credential written again keeps its identity and its token.
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-new-login', account: 'other@example.com' }));
  assert.equal(manager.identity(), after);
  assert.equal(await manager.getAccessToken(), second);
  assert.equal(calls.length, 2);
});

test('Vertex ADC tokens stay bound to the login that minted them', async (t) => {
  const { write, env } = sandbox(t);
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-a' }));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchFn } = tokenEndpoint({ gate });
  const manager = adcManager(env, fetchFn);
  const changed = (error) =>
    error?.code === 'EVERTEXAUTH' && /credential changed during the request/.test(error.message);

  // Two requests for login A share one token request.
  const identityA = manager.identity();
  const first = manager.getAccessToken({ identity: identityA });
  const second = manager.getAccessToken({ identity: identityA });
  assert.equal(calls.length, 1);

  // The login switches to B while A's token is in flight.
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-b-longer' }));
  assert.throws(() => manager.assertIdentity(identityA), changed);
  release();
  assert.equal(await first, 'oauth-1-refresh-a');
  assert.equal(await second, 'oauth-1-refresh-a');

  // A's late token is never served for B, and a request built for A cannot run as B.
  const tokenB = await manager.getAccessToken();
  assert.equal(tokenB, 'oauth-2-refresh-b-longer');
  await assert.rejects(manager.getAccessToken({ identity: identityA }), changed);

  // Only the rejected token is dropped.
  manager.invalidate('oauth-1-refresh-a');
  assert.equal(await manager.getAccessToken(), tokenB);
  manager.invalidate(tokenB);
  const renewed = await manager.getAccessToken();
  assert.equal(renewed, 'oauth-3-refresh-b-longer');

  // A malformed rewrite is never recorded: it keeps failing until a valid file returns.
  const identityB = manager.identity();
  write(ADC_FILE, '{not json');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => manager.identity(), /not valid JSON/);
    await assert.rejects(manager.getAccessToken(), /not valid JSON/);
  }
  write(ADC_FILE, userLogin({ refresh_token: 'refresh-b-longer' }));
  assert.equal(manager.identity(), identityB);
  assert.equal(await manager.getAccessToken(), renewed);
  assert.equal(calls.length, 3);
});

test('Vertex ADC rejects credential types a desktop app cannot use with a clear error', async (t) => {
  const { write, env } = sandbox(t);
  const { calls, fetchFn } = tokenEndpoint();
  write(ADC_FILE, { type: 'external_account', audience: 'aud', credential_source: { file: '/token' } });
  await assert.rejects(
    adcManager(env, fetchFn).getAccessToken(),
    /does not support "external_account" credentials.*gcloud auth application-default login/
  );
  const described = auth.describeVertexAdc({ env });
  assert.equal(described.state, 'unsupported');
  assert.equal(described.type, 'external_account');

  write(ADC_FILE, {
    type: 'impersonated_service_account',
    service_account_impersonation_url: `${IMPERSONATE_URL}/t@p.iam.gserviceaccount.com:generateAccessToken`,
    source_credentials: { type: 'external_account' },
  });
  await assert.rejects(adcManager(env, fetchFn).getAccessToken(), /does not support "external_account" credentials/);
  assert.equal(calls.length, 0);
});

test('Vertex ADC explains a 403 for a login without Vertex AI access or a quota project', async (t) => {
  const { write, env } = sandbox(t);
  write(ADC_FILE, userLogin());
  const manager = adcManager(env, null);
  const denied = () =>
    Object.assign(
      new Error(
        `Vertex AI Gemini streamGenerateContent 403: {"error":{"code":403,"message":"Permission 'aiplatform.endpoints.predict' denied on resource","status":"PERMISSION_DENIED"}}`
      ),
      { status: 403, code: 'iam_permission_denied' }
    );

  const permission = manager.accessError(denied(), { project: 'my-project' });
  assert.equal(permission.status, 403);
  assert.equal(permission.code, 'iam_permission_denied');
  assert.match(permission.message, /me@example\.com does not have permission to use Vertex AI in project my-project/);
  assert.match(permission.message, /roles\/aiplatform\.user/);

  const quota = manager.accessError(
    Object.assign(
      new Error(
        'Vertex AI Claude streamRawPredict 403: Your application is authenticating by using local Application Default Credentials. The aiplatform.googleapis.com API requires a quota project, which is not set by default.'
      ),
      { status: 403 }
    ),
    { project: 'my-project' }
  );
  assert.match(quota.message, /requires a quota project.*impersonate-service-account/);

  // Other statuses and service-account keys keep the server's message.
  const notFound = Object.assign(new Error('Vertex AI 404: not found'), { status: 404 });
  assert.equal(manager.accessError(notFound).message, 'Vertex AI 404: not found');
  const keyed = new auth.VertexAccessTokenManager({ credentialResolver: () => JSON.stringify(serviceAccountKey()) });
  assert.equal(keyed.accessError(denied()).message, denied().message);
});
