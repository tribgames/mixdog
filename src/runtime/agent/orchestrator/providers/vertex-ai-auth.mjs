import { createHash, createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERTEX_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** The `authMode` that authenticates with the gcloud login (Application Default Credentials). */
export const VERTEX_ADC_MODE = 'adc';
/** The `authMode` that sends a stored express-mode API key (Gemini models on the global endpoint only). */
export const VERTEX_API_KEY_MODE = 'api-key';
const IAM_CREDENTIALS_URI = 'https://iamcredentials.googleapis.com/v1';
// The GCE / Cloud Run / GKE metadata server: ADC's source when there is no credentials file.
const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_HEADERS = Object.freeze({ 'Metadata-Flavor': 'Google' });
// Short, so a desktop without one is barely delayed; the outcome is kept either way.
const METADATA_PROBE_MS = 1000;
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const ADC_FILE = 'application_default_credentials.json';
const ADC_LOGIN_HINT = 'Run `gcloud auth application-default login`.';
// Project sources ahead of the credential's own, in precedence order.
const PROJECT_ENV = Object.freeze([
  'GOOGLE_VERTEX_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GCP_PROJECT',
  'GCLOUD_PROJECT',
  'VERTEXAI_PROJECT',
  'ANTHROPIC_VERTEX_PROJECT_ID',
]);
// A 403 asking for a quota project: user credentials on gcloud's own OAuth
// client, whose projects (764086051850, 32555940559) are named as the consumer.
const QUOTA_PROJECT_ERROR =
  /quota[ _]project|x-goog-user-project|user_project_denied|end user credentials from the google cloud sdk|\b(?:764086051850|32555940559)\b/i;
// A 403 naming a missing IAM permission (not a disabled API or billing).
const PERMISSION_ERROR =
  /iam_permission_denied|permission ['"][^'"]+['"] denied|does not have (?:required )?permission|caller does not have permission/i;

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function parseVertexServiceAccount(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ''));
  } catch {
    throw new Error('Vertex AI service-account JSON is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vertex AI service-account JSON is invalid.');
  }
  const clientEmail = String(value.client_email || '').trim();
  const privateKey = String(value.private_key || '').trim();
  const projectId = String(value.project_id || '').trim();
  const privateKeyId = String(value.private_key_id || '').trim();
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error('Vertex AI service-account JSON must include client_email, private_key, and project_id.');
  }
  // The identity every minted access token is bound to and checked against.
  // The key fingerprint does not depend on the optional private_key_id.
  const keyFingerprint = createHash('sha256').update(privateKey).digest('hex');
  const identity = JSON.stringify([clientEmail, privateKeyId, projectId, keyFingerprint]);
  return {
    kind: 'service_account',
    clientEmail,
    privateKey,
    privateKeyId,
    projectId,
    identity,
    tokenUri: VERTEX_TOKEN_URI,
  };
}

export function createVertexJwtAssertion(account, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const claims = base64url({
    iss: account.clientEmail,
    scope: VERTEX_SCOPE,
    aud: account.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const input = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const signature = signer
    .sign(account.privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${input}.${signature}`;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// `reason` (missing | invalid | unsupported) is what the settings status line reports.
const adcError = (message, reason, extra = {}) => Object.assign(new Error(message), { reason, ...extra });
const authError = (message, extra = {}) =>
  Object.assign(new Error(`Vertex AI authentication failed: ${message}`), { code: 'EVERTEXAUTH', ...extra });
const errorDetail = (payload, response) =>
  String(
    payload?.error_description ||
      payload?.error?.message ||
      (typeof payload?.error === 'string' ? payload.error : '') ||
      `HTTP ${response.status}`
  ).slice(0, 240);

/** gcloud's configuration directory: CLOUDSDK_CONFIG, else %APPDATA%\gcloud on Windows, else ~/.config/gcloud. */
export function gcloudConfigDir(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = text(env.CLOUDSDK_CONFIG);
  if (explicit) return explicit;
  if (platform === 'win32' && text(env.APPDATA)) return join(env.APPDATA, 'gcloud');
  return join(home, '.config', 'gcloud');
}

// GOOGLE_APPLICATION_CREDENTIALS, when set, is the only source: its missing
// file is an error, never a fall-through to the gcloud login.
function adcLocation(env) {
  const explicit = text(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) return { path: explicit, source: 'GOOGLE_APPLICATION_CREDENTIALS' };
  return { path: join(gcloudConfigDir(env), ADC_FILE), source: 'gcloud' };
}

function adcFileError({ path, source }, error) {
  if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
    return adcError(`Vertex AI could not read ${path}: ${error?.code || error?.message || 'read failed'}.`, 'invalid');
  }
  if (source === 'gcloud') return adcError(`No gcloud login found. ${ADC_LOGIN_HINT}`, 'missing');
  return adcError(`GOOGLE_APPLICATION_CREDENTIALS points to ${path}, which does not exist.`, 'invalid');
}

function readAdcFile(location) {
  try {
    return readFileSync(location.path, 'utf8');
  } catch (error) {
    throw adcFileError(location, error);
  }
}

function requireFields(value, type, names, path) {
  const missing = names.filter((name) => !text(value[name]));
  if (missing.length)
    throw adcError(`The ${type} credentials in ${path} are missing ${missing.join(', ')}.`, 'invalid');
}

// One grant of an ADC file. `nested`: an impersonation's source, which cannot impersonate again.
function adcGrant(value, path, nested = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw adcError(`The credentials in ${path} are invalid.`, 'invalid');
  }
  const type = text(value.type);
  if (type === 'service_account') {
    requireFields(value, type, ['client_email', 'private_key'], path);
    const clientEmail = text(value.client_email);
    const privateKey = text(value.private_key);
    return {
      kind: type,
      account: clientEmail,
      clientEmail,
      privateKey,
      privateKeyId: text(value.private_key_id),
      projectId: text(value.project_id),
      tokenUri: VERTEX_TOKEN_URI,
      fingerprint: fingerprint([type, clientEmail, privateKey]),
    };
  }
  if (type === 'authorized_user') {
    requireFields(value, type, ['client_id', 'client_secret', 'refresh_token'], path);
    const clientId = text(value.client_id);
    const clientSecret = text(value.client_secret);
    const refreshToken = text(value.refresh_token);
    return {
      kind: type,
      account: text(value.account),
      clientId,
      clientSecret,
      refreshToken,
      projectId: '',
      fingerprint: fingerprint([type, clientId, clientSecret, refreshToken]),
    };
  }
  if (type === 'impersonated_service_account' && !nested) {
    const url = text(value.service_account_impersonation_url);
    const target = /\/serviceAccounts\/([^/\s:?#]+):generateAccessToken$/.exec(url)?.[1];
    if (!target)
      throw adcError(`The ${type} credentials in ${path} have no valid service_account_impersonation_url.`, 'invalid');
    const sourceGrant = adcGrant(value.source_credentials, path, true);
    const delegates = (Array.isArray(value.delegates) ? value.delegates : [])
      .map(text)
      .filter(Boolean)
      .map((delegate) => (delegate.startsWith('projects/') ? delegate : `projects/-/serviceAccounts/${delegate}`));
    return {
      kind: type,
      account: target,
      target,
      delegates,
      sourceGrant,
      projectId: '',
      fingerprint: fingerprint([type, target, delegates, sourceGrant.fingerprint]),
    };
  }
  throw adcError(
    `Vertex AI does not support "${type || 'unknown'}" credentials${nested ? ' as an impersonation source' : ''} (${path}). ` +
      'Use a service-account key, or sign in with `gcloud auth application-default login`.',
    'unsupported',
    { credentialType: type || 'unknown' }
  );
}

/**
 * One ADC file: its grant, the identity every token it mints is bound to (the
 * path and a fingerprint of the credential, never the secret itself), and its
 * project hints.
 */
export function parseVertexAdc(raw, { path, source }) {
  let value;
  try {
    value = JSON.parse(String(raw || ''));
  } catch {
    throw adcError(`The credentials file ${path} is not valid JSON.`, 'invalid');
  }
  const grant = adcGrant(value, path);
  const quotaProjectId = text(value.quota_project_id);
  const identity = JSON.stringify([
    'adc',
    path,
    grant.kind,
    grant.account,
    grant.projectId,
    quotaProjectId,
    grant.fingerprint,
  ]);
  return { ...grant, path, source, quotaProjectId, identity };
}

/** The current ADC file, read and parsed. */
export function readVertexAdc(env = process.env) {
  const location = adcLocation(env);
  return parseVertexAdc(readAdcFile(location), location);
}

// fetch function -> { promise, found }: one probe each, its outcome (null when absent) kept.
const metadataProbes = new WeakMap();

/**
 * Whether a metadata server answers, and its project ({ projectId } or null).
 * Probed once per fetch function; a negative outcome is kept too.
 */
export function probeVertexMetadata(fetchFn = fetch) {
  let probe = metadataProbes.get(fetchFn);
  if (!probe) {
    probe = { found: undefined };
    probe.promise = (async () => {
      try {
        const response = await fetchFn(`${METADATA_URL}/project/project-id`, {
          headers: METADATA_HEADERS,
          signal: AbortSignal.timeout(METADATA_PROBE_MS),
        });
        // Only the metadata server itself answers with this header.
        if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') return null;
        const projectId = text(await response.text());
        return projectId ? { projectId } : null;
      } catch {
        return null;
      }
    })().then((found) => {
      probe.found = found;
      return found;
    });
    metadataProbes.set(fetchFn, probe);
  }
  return probe.promise;
}

// The metadata server's default service account, once a probe found one.
function metadataCredential(fetchFn) {
  const found = metadataProbes.get(fetchFn)?.found;
  if (!found) return null;
  return {
    kind: 'metadata',
    account: '',
    projectId: found.projectId,
    quotaProjectId: '',
    path: METADATA_URL,
    source: 'metadata',
    identity: JSON.stringify(['adc', 'metadata', found.projectId]),
  };
}

// The `project =` of the [core] section of gcloud's active configuration.
function gcloudConfigProject(env) {
  const dir = gcloudConfigDir(env);
  let name = text(env.CLOUDSDK_ACTIVE_CONFIG_NAME);
  try {
    name ||= readFileSync(join(dir, 'active_config'), 'utf8').trim();
  } catch {}
  if (!/^[\w.-]+$/.test(name)) name = 'default';
  let lines;
  try {
    lines = readFileSync(join(dir, 'configurations', `config_${name}`), 'utf8').split(/\r?\n/);
  } catch {
    return '';
  }
  let section = '';
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) section = header[1].trim().toLowerCase();
    const entry = section === 'core' && /^\s*project\s*=\s*(.*?)\s*$/.exec(line);
    if (entry) return entry[1];
  }
  return '';
}

/**
 * The project an ADC request targets when no explicit one is set: the
 * environment, the file's quota project, a service account's own project,
 * then gcloud's configured project; '' when none names one.
 */
export function vertexAdcProject(credential, env = process.env) {
  for (const name of PROJECT_ENV) {
    const value = text(env[name]);
    if (value) return value;
  }
  return credential.quotaProjectId || credential.projectId || gcloudConfigProject(env);
}

/**
 * The gcloud login the settings show: its type, account and project, or why it
 * cannot be used. Without a login file, a metadata server a probe has found.
 * Never carries a token or key.
 */
export function describeVertexAdc({ env = process.env, projectId = '', fetchFn = fetch } = {}) {
  try {
    const credential = readVertexAdc(env);
    return {
      state: 'ready',
      type: credential.kind,
      account: credential.account || null,
      projectId: text(projectId) || vertexAdcProject(credential, env) || null,
    };
  } catch (error) {
    const metadata = error?.reason === 'missing' ? metadataCredential(fetchFn) : null;
    if (metadata) {
      return {
        state: 'ready',
        type: metadata.kind,
        account: null,
        projectId: text(projectId) || vertexAdcProject(metadata, env),
      };
    }
    return {
      state: error?.reason || 'invalid',
      ...(error?.credentialType ? { type: error.credentialType } : {}),
      message: String(error?.message || error),
    };
  }
}

function principalOf(credential) {
  if (credential.kind === 'metadata') return "The metadata server's service account";
  if (credential.kind !== 'authorized_user') return `The service account ${credential.account}`;
  return credential.account ? `The gcloud account ${credential.account}` : 'The gcloud account';
}

export class VertexAccessTokenManager {
  constructor({
    credentialResolver,
    authMode,
    env = process.env,
    fetchFn = fetch,
    now = () => Date.now(),
    refreshSkewMs = TOKEN_REFRESH_SKEW_MS,
  } = {}) {
    this.credentialResolver = credentialResolver;
    // VERTEX_ADC_MODE reads the gcloud login; anything else the stored service-account key.
    this.authMode = typeof authMode === 'function' ? authMode : () => authMode;
    this.env = env;
    this.fetchFn = fetchFn;
    this.now = now;
    this.refreshSkewMs = refreshSkewMs;
    // What the current credential was read from (the stored key, or the ADC
    // file's path, size and mtime) and its parse.
    this.credentialKey = '';
    this.credential = null;
    // { identity, token, expiresAt }: served only to the credential that minted it.
    this.cached = null;
    // identity -> the one token request in flight for it.
    this.minting = new Map();
  }

  _adc() {
    return this.authMode() === VERTEX_ADC_MODE;
  }

  _credential() {
    if (this._adc()) {
      const location = adcLocation(this.env);
      let stat;
      try {
        stat = statSync(location.path);
      } catch (error) {
        // No gcloud login: the metadata server's account, once ready() found one.
        const failure = adcFileError(location, error);
        const metadata = failure.reason === 'missing' ? metadataCredential(this.fetchFn) : null;
        if (!metadata) throw failure;
        return this._remember(`metadata\0${metadata.identity}`, () => metadata);
      }
      // A rewritten file (another `gcloud auth application-default login`) is read again.
      return this._remember(`adc\0${location.path}\0${stat.size}\0${stat.mtimeMs}`, () =>
        parseVertexAdc(readAdcFile(location), location)
      );
    }
    const raw = String(this.credentialResolver?.() || '').trim();
    if (!raw) throw new Error('Vertex AI service-account JSON is not configured.');
    return this._remember(`key\0${raw}`, () => parseVertexServiceAccount(raw));
  }

  // Parse first: a malformed credential must leave the previous state untouched
  // and keep failing, never be remembered as the current credential.
  _remember(key, parse) {
    if (key !== this.credentialKey) {
      this.credential = parse();
      this.credentialKey = key;
    }
    return this.credential;
  }

  /** Probes the metadata server (once) when ADC has no credentials file, so the synchronous reads can use it. */
  async ready() {
    if (!this._adc()) return;
    try {
      this._credential();
    } catch (error) {
      if (error?.reason === 'missing') await probeVertexMetadata(this.fetchFn);
    }
  }

  projectId() {
    const credential = this._credential();
    if (!credential.source) return credential.projectId;
    const project = vertexAdcProject(credential, this.env);
    if (!project) {
      throw new Error(
        'Vertex AI could not find a Google Cloud project for the gcloud login. Enter a project ID in Settings, ' +
          'set GOOGLE_CLOUD_PROJECT, or run `gcloud config set project PROJECT_ID`.'
      );
    }
    return project;
  }

  identity() {
    return this._credential().identity;
  }

  // A request built for one credential must not run under another's.
  assertIdentity(identity) {
    const credential = this._credential();
    if (credential.identity !== identity) {
      const kind = credential.source ? 'gcloud' : 'service-account';
      throw Object.assign(
        new Error(`Vertex AI authentication failed: the ${kind} credential changed during the request.`),
        { code: 'EVERTEXAUTH' }
      );
    }
  }

  // Drops only the token the server rejected; a fresher one stays cached.
  invalidate(rejectedToken) {
    if (rejectedToken && this.cached?.token === rejectedToken) this.cached = null;
  }

  async getAccessToken({ identity } = {}) {
    if (identity !== undefined) this.assertIdentity(identity);
    const credential = this._credential();
    const now = this.now();
    const cached = this.cached;
    if (cached?.identity === credential.identity && now + this.refreshSkewMs < cached.expiresAt) {
      return cached.token;
    }
    let minting = this.minting.get(credential.identity);
    if (!minting) {
      minting = this._mint(credential, now).finally(() => {
        if (this.minting.get(credential.identity) === minting) this.minting.delete(credential.identity);
      });
      this.minting.set(credential.identity, minting);
    }
    return await minting;
  }

  async _mint(credential, now) {
    const minted =
      credential.kind === 'impersonated_service_account'
        ? await this._impersonate(credential, now)
        : await this._grant(credential, now);
    this.cached = { identity: credential.identity, ...minted };
    return minted.token;
  }

  // A token from Google's OAuth endpoint (a signed service-account JWT, or a
  // gcloud user login's refresh token), or the metadata server's.
  async _grant(credential, now) {
    let url = VERTEX_TOKEN_URI;
    let init;
    if (credential.kind === 'metadata') {
      url = `${METADATA_URL}/instance/service-accounts/default/token`;
      init = { method: 'GET', headers: METADATA_HEADERS };
    } else {
      let form;
      if (credential.kind === 'authorized_user') {
        form = {
          grant_type: 'refresh_token',
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
          refresh_token: credential.refreshToken,
        };
      } else {
        try {
          form = { grant_type: JWT_BEARER_GRANT, assertion: createVertexJwtAssertion(credential, now) };
        } catch (error) {
          throw authError('could not sign the service-account JWT.', { cause: error });
        }
      }
      init = {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      };
    }
    const { response, payload } = await this._post(url, init);
    if (!response.ok || !payload?.access_token) {
      const detail = errorDetail(payload, response);
      const message =
        credential.kind === 'authorized_user' && payload?.error === 'invalid_grant'
          ? `the gcloud login has expired or was revoked (${detail}). Run \`gcloud auth application-default login\` again.`
          : detail;
      throw authError(message, { status: response.status, httpStatus: response.status });
    }
    const expiresIn = Math.max(1, Number(payload.expires_in) || 3600);
    return { token: String(payload.access_token), expiresAt: now + expiresIn * 1000 };
  }

  // A short-lived token of the target service account, minted with the source credential's token.
  async _impersonate(credential, now) {
    const source = await this._grant(credential.sourceGrant, now);
    const { response, payload } = await this._post(
      `${IAM_CREDENTIALS_URI}/projects/-/serviceAccounts/${credential.target}:generateAccessToken`,
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${source.token}` },
        body: JSON.stringify({ delegates: credential.delegates, scope: [VERTEX_SCOPE], lifetime: '3600s' }),
      }
    );
    if (!response.ok || !payload?.accessToken) {
      const hint =
        response.status === 403
          ? ' The signed-in account needs the Service Account Token Creator role (roles/iam.serviceAccountTokenCreator) on it.'
          : '';
      throw authError(`impersonating ${credential.target} failed (${errorDetail(payload, response)}).${hint}`, {
        status: response.status,
        httpStatus: response.status,
      });
    }
    const expiresAt = Date.parse(String(payload.expireTime || ''));
    return { token: String(payload.accessToken), expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 3600_000 };
  }

  // A POST unless `init` names another method.
  async _post(url, init) {
    let response;
    try {
      response = await this.fetchFn(url, { method: 'POST', ...init });
    } catch (error) {
      throw authError(error?.message || 'token request failed', { cause: error });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    return { response, payload };
  }

  /**
   * A gcloud login's 403 that names a missing quota project or IAM permission,
   * reworded to say what to do. Status, code and the other classification
   * fields stay as they were; any other error is returned unchanged.
   */
  accessError(error, { project = '' } = {}) {
    if (!error || typeof error !== 'object' || error.vertexAccess || !this._adc()) return error;
    const status = [error.status, error.httpStatus, error.response?.status]
      .map(Number)
      .find((value) => Number.isFinite(value) && value > 0);
    if (status !== 403 || error.code === 'VERTEX_MODEL_NOT_ENABLED') return error;
    const detail = String(error.message || '');
    const evidence = `${error.code || ''} ${detail}`;
    const where = project ? ` in project ${project}` : '';
    if (QUOTA_PROJECT_ERROR.test(evidence)) {
      error.vertexAccess = 'quota-project';
      error.message =
        `[vertex-ai] Vertex AI requires a quota project for gcloud user credentials${where}. Use a service-account key, ` +
        'or sign in as a service account: gcloud auth application-default login --impersonate-service-account=SERVICE_ACCOUNT_EMAIL ' +
        `(HTTP 403: ${detail.slice(0, 200)})`;
    } else if (PERMISSION_ERROR.test(evidence)) {
      let principal = 'The gcloud login';
      try {
        principal = principalOf(this._credential());
      } catch {}
      error.vertexAccess = 'permission';
      error.message =
        `[vertex-ai] ${principal} does not have permission to use Vertex AI${where}. ` +
        `Grant it the Vertex AI User role (roles/aiplatform.user), then try again. (HTTP 403: ${detail.slice(0, 200)})`;
    }
    return error;
  }
}
