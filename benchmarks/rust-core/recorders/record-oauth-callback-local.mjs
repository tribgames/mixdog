#!/usr/bin/env node
// What the loopback callback servers of the two logins that are not PKCE answer: MiMo (the platform redirects the
// browser with a sealed `u`; the answer is a redirect back to the platform) and Command Code (the Studio page POSTs
// the key as JSON, so every answer is JSON with CORS headers). The real Node `beginOAuthLogin` of each is started,
// raw requests are made to its callback server and the complete answers are recorded as in
// `record-oauth-callback-page.mjs`. Rust `MimoLogin` / `CommandCodeLogin` must answer every request the same.
//
//   node benchmarks/rust-core/recorders/record-oauth-callback-local.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
//
// Output: native/core/fixtures/oauth-callback-local/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { rawExchange } from './lib/raw-http.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit');
if (!commit) throw new Error('--commit <40-hex> is required');
const identity = commitCheckoutIdentity(tree, commit);
const finalDir = join(FIXTURES_ROOT, 'oauth-callback-local');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-callback-local.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'oauth-callback-local-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(scratch, key);
  mkdirSync(process.env[key], { recursive: true });
}
const mimo = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/mimo-oauth-login.mjs');
const commandCode = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/command-code-oauth-login.mjs');

// The platform's side of MiMo: `doc` sealed to the public key of the authorize URL.
function seal(authorizeUrl, doc) {
  const pk = new URL(authorizeUrl).searchParams.get('pk');
  const peer = createPublicKey({ key: Buffer.from(pk, 'base64url'), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const key = createHash('sha256').update(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: peer })).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  const ephemeralPublic = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  return Buffer.concat([ephemeralPublic, nonce, sealed, cipher.getAuthTag()]).toString('base64url');
}

let served = [];
const reply = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const keyRejecting = async (url, init = {}) => {
  served.push({ method: init.method ?? 'GET', url: String(url), status: 401, body: '{"error":"bad key"}' });
  return reply(401, '{"error":"bad key"}');
};
const whoami = (status, body) => async (url, init = {}) => {
  served.push({ method: init.method ?? 'GET', url: String(url), status, body });
  return reply(status, body);
};

const GOOD_DOC = { sk: 'sk-live', uid: 7 };
const TP_DOC = { sk: 'tp-abc', uid: 8 };
const MIMO_CASES = [
  ['no payload, then a sealed one', GOOD_DOC, [['GET', '/'], ['GET', '/?u='], ['GET', '/?u={sealed}']]],
  ['payload not sealed to this login, then a sealed one', GOOD_DOC, [['GET', '/?u=AAAA'], ['GET', '/?u={sealed}']]],
  ['sealed payload on another path, then on the right one', GOOD_DOC, [['GET', '/other?u={sealed}'], ['GET', '/?u={sealed}']]],
  ['POST of a sealed payload', GOOD_DOC, [['POST', '/?u={sealed}']]],
  ['HEAD and OPTIONS of a sealed payload, then a GET', GOOD_DOC, [['HEAD', '/?u={sealed}'], ['OPTIONS', '/?u={sealed}'], ['GET', '/?u={sealed}']]],
  ['OPTIONS while the login is live, then a GET', GOOD_DOC, [['OPTIONS', '/?u={sealed}'], ['OPTIONS', '/'], ['GET', '/?u={sealed}']]],
  ['an unsealed payload first and a sealed one second', GOOD_DOC, [['GET', '/?u=AAAA&u={sealed}'], ['GET', '/?u={sealed}&u=AAAA']]],
  ['sealed payload, then once more after the login ended', GOOD_DOC, [['GET', '/?u={sealed}'], ['GET', '/?u={sealed}']]],
  ['Token Plan key no region accepts', TP_DOC, [['GET', '/?u={sealed}'], ['GET', '/?u={sealed}']]],
];
const mimoCases = [];
for (const [title, doc, requests] of MIMO_CASES) {
  served = [];
  const login = await mimo.beginOAuthLogin({ openBrowser: false, addresses: ['127.0.0.1'], fetchImpl: keyRejecting });
  let settled = 'pending';
  login.waitForCallback.then(
    (value) => { settled = value == null ? 'null' : 'tokens'; },
    (error) => { settled = `error: ${error.message}`; }
  );
  const sealed = seal(login.url, doc);
  const answers = [];
  for (const [method, target] of requests) {
    const answer = await rawExchange('127.0.0.1', login.port, { method, target: target.replace('{sealed}', sealed), hostHeader: `localhost:${login.port}` });
    answers.push({ method, target, answer });
  }
  await new Promise((resolve) => setImmediate(resolve));
  mimoCases.push({ title, doc, served: [...served], settled, answers });
  login.cancel();
}

const KEY = 'ck-0123456789abcdef';
const STUDIO = 'https://commandcode.ai';
const body = (extra = {}) => JSON.stringify({ state: '{state}', apiKey: KEY, userId: 'u1', userName: 'ann', keyName: 'key-1', ...extra });
const json = { 'Content-Type': 'application/json' };
const post = (target, text, headers = [['Origin', STUDIO], ['Content-Type', 'application/json']]) => ({ method: 'POST', target, body: text, headers });
const WHOAMI_OK = [200, '{"user":{"id":"U1","userName":"ann"}}'];
const COMMAND_CASES = [
  ['preflight, then the callback', WHOAMI_OK, [{ method: 'OPTIONS', target: '/callback', headers: [['Origin', STUDIO], ['Access-Control-Request-Method', 'POST']] }, post('/callback', body())]],
  ['preflight without an origin', WHOAMI_OK, [{ method: 'OPTIONS', target: '/callback', headers: [] }, post('/callback', body())]],
  ['foreign origin, then the callback', WHOAMI_OK, [post('/callback', body(), [['Origin', 'https://evil.test'], ['Content-Type', 'application/json']]), post('/callback', body())]],
  ['callback without an origin', WHOAMI_OK, [post('/callback', body(), [['Content-Type', 'application/json']])]],
  ['GET of the callback, then the callback', WHOAMI_OK, [{ method: 'GET', target: '/callback', headers: [['Origin', STUDIO]] }, post('/callback', body())]],
  ['wrong path, then the callback', WHOAMI_OK, [post('/nope', body()), post('/callback', body())]],
  ['query on the callback path', WHOAMI_OK, [post('/callback?x=1', body())]],
  ['body not JSON, then the callback', WHOAMI_OK, [post('/callback', 'not json'), post('/callback', body())]],
  ['body not an object, then the callback', WHOAMI_OK, [post('/callback', '[1]'), post('/callback', body())]],
  ['empty body, then the callback', WHOAMI_OK, [post('/callback', ''), post('/callback', body())]],
  ['wrong state, then the callback', WHOAMI_OK, [post('/callback', body({ state: 'wrong' })), post('/callback', body())]],
  ['no state field, then the callback', WHOAMI_OK, [post('/callback', JSON.stringify({ apiKey: KEY, userId: 'u1', userName: 'ann', keyName: 'key-1' })), post('/callback', body())]],
  ['empty state, then the callback', WHOAMI_OK, [post('/callback', body({ state: '' })), post('/callback', body())]],
  ['state of another type, then the callback', WHOAMI_OK, [post('/callback', body({ state: 7 })), post('/callback', body({ state: null })), post('/callback', body())]],
  ['missing field, then the callback',WHOAMI_OK, [post('/callback', body({ userName: ' ' })), post('/callback', body())]],
  ['malformed key, then the callback', WHOAMI_OK, [post('/callback', body({ apiKey: 'has space' })), post('/callback', body())]],
  ['success, then once more after the login ended', WHOAMI_OK, [post('/callback', body()), post('/callback', body())]],
  ['whoami rejects the key', [401, '{"error":"unauthorized"}'], [post('/callback', body()), post('/callback', body())]],
  ['whoami fails', [500, 'oops'], [post('/callback', body())]],
];
const commandCases = [];
for (const [title, [status, whoamiBody], requests] of COMMAND_CASES) {
  served = [];
  const login = await commandCode.beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, fetchImpl: whoami(status, whoamiBody) });
  let settled = 'pending';
  login.waitForCallback.then(
    (value) => { settled = value == null ? 'null' : 'tokens'; },
    (error) => { settled = `error: ${error.message}`; }
  );
  const state = new URL(login.url).searchParams.get('state');
  const answers = [];
  for (const request of requests) {
    const sent = { method: request.method, target: request.target, hostHeader: `127.0.0.1:${login.port}`, extraHeaders: request.headers ?? [], body: request.body === undefined ? null : request.body.replaceAll('{state}', state) };
    const answer = await rawExchange('127.0.0.1', login.port, sent);
    answers.push({ method: request.method, target: request.target, headers: request.headers ?? [], body: request.body ?? null, answer });
  }
  await new Promise((resolve) => setImmediate(resolve));
  commandCases.push({ title, served: [...served], settled, answers });
  login.cancel();
}

writeJson(join(stage, 'golden.json'), { mimo: mimoCases, commandCode: commandCases });
writeSetManifest(stage, { set: 'oauth-callback-local', recorder, command: `node ${recorder} --tree <git checkout of ${commit}> --commit ${commit}`, identity });
commitStage(stage, finalDir);
process.exit(0);
