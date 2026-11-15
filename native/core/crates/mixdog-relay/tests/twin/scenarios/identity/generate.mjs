// Writes the scenario files of this suite (device and browser identity, registration, claims, pairing codes, the /ws
// gate) next to this script: `node generate.mjs`. The scenarios are plain data for the twin runner; this script only
// saves repeating the long, regular ones (rate-limit floods, capacity fills). It reads and runs nothing else.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

const DEV_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const DEV_B = 'b1b2c3d4-0000-4000-8000-00000000000b';
const DEV_HEX = '0123456789abcdef0123456789abcdef';
const SECRET = '0123456789abcdef';
const TOKEN_A = 'fedcba9876543210';
const TOKEN_B = '0123456789fedcba';
const PUBLIC_KEY = 'k'.repeat(87);
const OTHER_KEY = 'm'.repeat(87);
// A phone that joins is announced to a desktop that never answers; the relay would close that desktop leg after its
// stall budget, so scenarios that join phones raise it far past the scenario's length.
const NO_STALL = { handshakeStallMs: 600000, livenessProbeMs: 600000 };
const ORIGIN = ['Origin', '${origin}'];
const JSON_ORIGIN = [['Content-Type', 'application/json'], ORIGIN];
const FOREIGN_JSON = [['Content-Type', 'application/json'], ['Origin', 'https://evil.example']];
const NO_ORIGIN_JSON = [['Content-Type', 'application/json']];
const bearer = (variable) => [...JSON_ORIGIN, ['Authorization', `Bearer \${${variable}}`]];

const json = (value) => JSON.stringify(value);
const basicHeader = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const http = (path, { method = 'GET', headers = [], body, status, capture, label } = {}) => ({
  do: 'http',
  ...(label ? { label } : {}),
  method,
  path,
  ...(headers.length ? { headers } : {}),
  ...(body !== undefined ? { body } : {}),
  ...(status !== undefined ? { expect_status: status } : {}),
  ...(capture ? { capture } : {}),
  close_probe_ms: 100,
});
const post = (path, body, options = {}) =>
  http(path, { method: 'POST', headers: JSON_ORIGIN, body: typeof body === 'string' ? body : json(body), ...options });
const fromBody = (variable, path) => [{ var: variable, from: 'body_json', path }];
const fromFrame = (variable, path) => [{ var: variable, from: 'frame_json', path }];

const wsOpen = (conn, path, { role = 'plain', headers = [], basic, status = 101 } = {}) => ({
  do: 'ws_open',
  conn,
  path,
  role,
  ...(headers.length ? { headers } : {}),
  ...(basic ? { basic } : {}),
  expect_status: status,
});
/** A desktop leg, read up to the two frames the relay announces on every leg (its capabilities and the push set). */
const desktop = (conn, device = DEV_A, secret = SECRET) => [
  wsOpen(conn, '/desktop', { role: 'desktop', basic: [device, secret] }),
  { do: 'expect', conn, frames: 2 },
];
/** A desktop leg that is only opened (registered); its frames are read at the end of the scenario. */
const desktopOnly = (conn, device, secret = SECRET, status = 101) =>
  wsOpen(conn, '/desktop', { role: 'desktop', basic: [device, secret], status });
const phone = (conn, token, status = 101, origin = ORIGIN) =>
  wsOpen(conn, `/ws?token=${token}`, { role: 'phone', headers: [origin], status });
const sendJson = (conn, message) => ({ do: 'send', conn, frame: { kind: 'text', text: json(message) } });
const expectFrames = (conn, frames, capture) => ({ do: 'expect', conn, frames, ...(capture ? { capture } : {}) });
const expectClose = (conn, code) => ({ do: 'expect', conn, close: true, ...(code ? { close_code: code } : {}) });
const hangUp = (conn) => [{ do: 'send', conn, frame: { kind: 'close', code: 1000 } }, expectClose(conn)];
const wait = (ms) => ({ do: 'wait', ms });
const setToken = (conn, token) => [sendJson(conn, { type: 'set-client-token', token }), wait(150)];
const registerBrowser = (token, clientId, variable) =>
  post(`/client/register?token=${token}`, { clientId, name: 'Android · Chrome', platform: 'Android', browser: 'Chrome' }, {
    status: 200,
    ...(variable ? { capture: fromBody(variable, 'token') } : {}),
  });
const claim = (deviceId, clientId, publicKey = PUBLIC_KEY, extra = {}, options = {}) =>
  post('/claim', { deviceId, clientId, publicKey, ...extra }, options);
const idOf = (n) => n.toString(16).padStart(8, '0');

const scenarios = [];
const add = (id, description, steps, extra = {}) => scenarios.push({ id, description, ...extra, steps: steps.flat() });

// ---- device registration and authentication ----

add(
  'tofu_registration_and_restart',
  'a UUID id and a 32-hex id register on first use, and the registration is on disk before it authenticates: after a restart the same secret still opens and another secret is refused',
  [
    wsOpen('uuid', '/desktop', { role: 'desktop', basic: [DEV_A, SECRET] }),
    wsOpen('hex', '/desktop', { role: 'desktop', basic: [DEV_HEX, SECRET] }),
    { do: 'restart' },
    wsOpen('again', '/desktop', { role: 'desktop', basic: [DEV_A, SECRET] }),
    wsOpen('wrong', '/desktop', { role: 'desktop', basic: [DEV_HEX, 'not-the-same-secret'], status: 401 }),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
    http(`/pair-code/support?deviceId=${DEV_B}`, { status: 404 }),
  ],
);

add(
  'guessable_ids_refused',
  'trust-on-first-use binds only unguessable ids: a short hex id, a non-id, an upper-case id and a short secret are refused and leave no row; a UUID with a 16-character secret registers',
  [
    wsOpen('short', '/desktop', { role: 'desktop', basic: ['00000001', SECRET], status: 401 }),
    wsOpen('label', '/desktop', { role: 'desktop', basic: ['my-desktop', SECRET], status: 401 }),
    wsOpen('upper', '/desktop', { role: 'desktop', basic: [DEV_A.toUpperCase(), SECRET], status: 401 }),
    wsOpen('secret15', '/desktop', { role: 'desktop', basic: [DEV_A, SECRET.slice(1)], status: 401 }),
    http('/pair-code/support?deviceId=00000001', { status: 404 }),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 404 }),
    wsOpen('uuid', '/desktop', { role: 'desktop', basic: [DEV_A, SECRET] }),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
  ],
);

add(
  'desktop_registration_rate_limit',
  'only five new ids are minted per source in the window; a known device redialing is free',
  [
    ...[1, 2, 3, 4, 5].map((n) => desktopOnly(`n${n}`, `a1b2c3d4-0000-4000-8000-0000000000${n}1`)),
    desktopOnly('sixth', 'a1b2c3d4-0000-4000-8000-000000000061', SECRET, 429),
    desktopOnly('known', 'a1b2c3d4-0000-4000-8000-000000000011'),
  ],
);

add(
  'wrong_secret_charged_then_refused',
  'a wrong secret for a known id is refused 401 and every attempt is charged: after the budget the answer is 429, and the right secret still opens',
  [
    desktopOnly('first', DEV_A),
    ...Array.from({ length: 62 }, (_, i) => desktopOnly(`w${i}`, DEV_A, 'wrong-secret-value', i < 60 ? 401 : 429)),
    desktopOnly('right', DEV_A),
  ],
);

add(
  'headers_only_credentials',
  'device credentials are read only from a Basic Authorization header: the query string, a Bearer header, a header without a colon and an empty secret all fail; a lower-case scheme and a hook leg open',
  [
    desktopOnly('first', DEV_A),
    wsOpen('query', `/desktop?device=${DEV_A}&deviceId=${DEV_A}&secret=${SECRET}`, { role: 'desktop', status: 401 }),
    wsOpen('bearer', '/desktop', { role: 'desktop', headers: [['Authorization', `Bearer ${SECRET}`]], status: 401 }),
    wsOpen('nocolon', '/desktop', {
      role: 'desktop',
      headers: [['Authorization', `Basic ${Buffer.from(DEV_A).toString('base64')}`]],
      status: 401,
    }),
    wsOpen('emptysecret', '/desktop', { role: 'desktop', basic: [DEV_A, ''], status: 401 }),
    wsOpen('lower', '/desktop', {
      role: 'desktop',
      headers: [['Authorization', basicHeader(DEV_A, SECRET).replace('Basic', 'basic')]],
    }),
    wsOpen('hook', '/hookleg', { role: 'hook', basic: [DEV_B, SECRET] }),
    wsOpen('hookwrong', '/hookleg', { role: 'hook', basic: [DEV_B, 'wrong-secret-value'], status: 401 }),
    wsOpen('hookquery', `/hookleg?device=${DEV_B}&secret=${SECRET}`, { role: 'hook', status: 401 }),
  ],
);

// ---- browser registration ----

add(
  'browser_registration_exchanges_pairing_token',
  "a browser trades the desktop's pairing token for its own credential; refreshing needs that credential and the same client id; method, origin, body and credential refusals; the pairing token and the credential survive a restart",
  [
    desktop('d'),
    setToken('d', TOKEN_A),
    registerBrowser(TOKEN_A, 'bbbbbbbb', 'browser'),
    post('/client/register', { clientId: 'bbbbbbbb' }, { headers: bearer('browser'), status: 200 }),
    post('/client/register', { clientId: 'cccccccc' }, { headers: bearer('browser'), status: 401 }),
    post('/client/register', { clientId: 'bbbbbbbb' }, { status: 401 }),
    post('/client/register?token=ffffffffffffffff', { clientId: 'bbbbbbbb' }, { status: 401 }),
    post(`/client/register?token=${TOKEN_A}`, { clientId: 'nope' }, { status: 401 }),
    http('/client/register', { status: 405 }),
    http('/client/register', { method: 'PUT', headers: JSON_ORIGIN, body: '{}', status: 405 }),
    post(`/client/register?token=${TOKEN_A}`, { clientId: 'dddddddd' }, { headers: FOREIGN_JSON, status: 403 }),
    post(`/client/register?token=${TOKEN_A}`, { clientId: 'dddddddd' }, { headers: NO_ORIGIN_JSON, status: 403 }),
    post(`/client/register?token=${TOKEN_A}`, '{', { status: 400 }),
    { do: 'restart' },
    post('/client/register', { clientId: 'bbbbbbbb' }, { headers: bearer('browser'), status: 200 }),
    registerBrowser(TOKEN_A, 'cccccccc'),
  ],
);

{
  const steps = [desktop('d'), setToken('d', TOKEN_A)];
  for (let n = 1; n <= 256; n += 1) steps.push(registerBrowser(TOKEN_A, idOf(n)));
  steps.push(post(`/client/register?token=${TOKEN_A}`, { clientId: idOf(257) }, { status: 409 }));
  steps.push(registerBrowser(TOKEN_A, idOf(1)));
  add(
    'browser_registration_capacity',
    'a desktop holds at most 256 browser credentials: the 257th is refused 409 while an existing browser can still register again',
    steps,
  );
}

add(
  'browser_credentials_isolated_and_revocable',
  'browser credentials are per desktop and individually revocable: each desktop lists and revokes only its own browsers, a revoked credential is refused at /ws and /client/register, the others and a restart keep the rest',
  [
    desktop('dA', DEV_A),
    desktop('dB', DEV_B),
    setToken('dA', TOKEN_A),
    setToken('dB', TOKEN_B),
    registerBrowser(TOKEN_A, 'bbbbbbbb', 'a1'),
    registerBrowser(TOKEN_A, 'cccccccc', 'a2'),
    registerBrowser(TOKEN_B, 'dddddddd', 'b1'),
    phone('pA1', '${a1}'),
    expectFrames('dA', 1),
    wait(50),
    phone('pA2', '${a2}'),
    expectFrames('dA', 1),
    phone('pB1', '${b1}'),
    expectFrames('dB', 1),
    sendJson('dA', { type: 'list-clients', requestId: 'list-a' }),
    expectFrames('dA', 1),
    sendJson('dB', { type: 'list-clients', requestId: 'list-b' }),
    expectFrames('dB', 1),
    sendJson('dB', { type: 'revoke-client', requestId: 'foreign', clientId: 'bbbbbbbb' }),
    expectFrames('dB', 1),
    sendJson('dA', { type: 'revoke-client', requestId: 'own', clientId: 'bbbbbbbb' }),
    expectFrames('dA', 1),
    expectClose('pA1', 4003),
    expectFrames('dA', 1),
    phone('pA3', '${a1}'),
    expectClose('pA3', 4005),
    post('/client/register', { clientId: 'bbbbbbbb' }, { headers: bearer('a1'), status: 401 }),
    sendJson('dA', { type: 'list-clients', requestId: 'list-a2' }),
    expectFrames('dA', 1),
    sendJson('dA', { type: 'revoke-client', requestId: 'none', clientId: 'eeeeeeee' }),
    expectFrames('dA', 1),
    sendJson('dA', { type: 'revoke-client', clientId: 'cccccccc' }),
    sendJson('dA', { type: 'revoke-client', requestId: 7, clientId: 'cccccccc' }),
    wait(150),
    { do: 'restart' },
    post('/client/register', { clientId: 'cccccccc' }, { headers: bearer('a2'), status: 200 }),
    post('/client/register', { clientId: 'dddddddd' }, { headers: bearer('b1'), status: 200 }),
    post('/client/register', { clientId: 'bbbbbbbb' }, { headers: bearer('a1'), status: 401 }),
  ],
  { knobs: NO_STALL },
);

add(
  'device_revocation',
  'a desktop that revokes its device is told so, its leg and its browsers are closed 4003, the device and its credentials are gone for good (after a restart too) and the id registers afresh',
  [
    desktop('dA'),
    setToken('dA', TOKEN_A),
    registerBrowser(TOKEN_A, 'bbbbbbbb', 'browser'),
    phone('p', '${browser}'),
    expectFrames('dA', 1),
    sendJson('dA', { type: 'revoke-device' }),
    { do: 'expect', conn: 'dA', frames: 1, close: true, close_code: 4003 },
    expectClose('p', 4003),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 404 }),
    phone('p2', '${browser}'),
    expectClose('p2', 4005),
    post(`/client/register?token=${TOKEN_A}`, { clientId: 'bbbbbbbb' }, { status: 401 }),
    { do: 'restart' },
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 404 }),
    desktop('dA2', DEV_A, 'a-completely-new-secret'),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
  ],
  { knobs: NO_STALL },
);

// ---- claims ----

add(
  'claim_approval_mints_credential',
  'a claim is routed to the desktop it names, stays pending until that desktop (and no other) approves, then the sealed answer and the new credential can be read again until the browser registers with it',
  [
    desktop('dA', DEV_A),
    desktop('dB', DEV_B),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, { name: 'iPhone · Web app' }, { status: 202, capture: fromBody('claim', 'claimId') }),
    expectFrames('dA', 1),
    http('/claim/${claim}', { status: 200 }),
    sendJson('dB', { type: 'claim-approve', claimId: '${claim}', sealed: { box: 'foreign' } }),
    sendJson('dA', { type: 'claim-approve', sealed: { box: 'no id' } }),
    sendJson('dA', { type: 'claim-approve', claimId: 'not-this-claim', sealed: { box: 'other' } }),
    wait(150),
    http('/claim/${claim}', { status: 200 }),
    sendJson('dA', { type: 'claim-approve', claimId: '${claim}', sealed: { box: 'opaque' } }),
    wait(150),
    http('/claim/${claim}', { status: 200, capture: fromBody('minted', 'token') }),
    http('/claim/${claim}', { status: 200 }),
    http('/claim/a1b2c3d4-9999-4999-8999-999999999999', { status: 200 }),
    phone('p', '${minted}'),
    expectFrames('dA', 1),
    post('/client/register', { clientId: 'bbbbbbbb' }, { headers: bearer('minted'), status: 200 }),
    http('/claim/${claim}', { status: 200 }),
    sendJson('dA', { type: 'list-clients', requestId: 'after' }),
    expectFrames('dA', 1),
  ],
  { knobs: NO_STALL },
);

add(
  'claim_reopened_request_resumes',
  'a phone that re-sends the same request resumes it without a second prompt; another key is another request; a denied claim stays denied and cannot be approved later',
  [
    desktop('dA'),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { status: 202, capture: fromBody('first', 'claimId') }),
    expectFrames('dA', 1),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { status: 202 }),
    claim(DEV_A, 'bbbbbbbb', OTHER_KEY, {}, { status: 202, capture: fromBody('other', 'claimId') }),
    expectFrames('dA', 1),
    sendJson('dA', { type: 'claim-deny', claimId: '${first}' }),
    wait(150),
    http('/claim/${first}', { status: 200 }),
    sendJson('dA', { type: 'claim-approve', claimId: '${first}', sealed: { box: 'late' } }),
    wait(150),
    http('/claim/${first}', { status: 200 }),
    http('/claim/${other}', { status: 200 }),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { status: 202 }),
    expectFrames('dA', 1),
  ],
);

add(
  'claim_refusals',
  'claims are refused before any desktop hears of them: malformed fields and unknown desktops 404, foreign or missing Origin 403, bad JSON 400, wrong method 405, an offline desktop 503; polling an unknown id is `unknown`',
  [
    desktop('dA'),
    claim('nope', 'nope', 'x', {}, { status: 404 }),
    claim('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'bbbbbbbb', 'A'.repeat(86), {}, { status: 404 }),
    claim('dddddddd', 'bbbbbbbb', PUBLIC_KEY, {}, { status: 404 }),
    claim(DEV_A, 'bbbbbbbb', 'A'.repeat(85), {}, { status: 404 }),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { headers: FOREIGN_JSON, status: 403 }),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { headers: NO_ORIGIN_JSON, status: 403 }),
    post('/claim', '{', { status: 400 }),
    http('/claim', { method: 'PUT', headers: JSON_ORIGIN, body: '{}', status: 405 }),
    http('/claim', { status: 405 }),
    http('/claim/', { status: 200 }),
    http('/claim/%E0%A4%A', { status: 400 }),
    http('/claim/missing', { status: 200 }),
    ...hangUp('dA'),
    wait(150),
    claim(DEV_A, 'bbbbbbbb', PUBLIC_KEY, {}, { status: 503 }),
  ],
);

{
  const steps = [desktop('dA')];
  for (let n = 1; n <= 8; n += 1) steps.push(claim(DEV_A, idOf(n), PUBLIC_KEY, {}, { status: 202 }));
  steps.push(expectFrames('dA', 8));
  steps.push(claim(DEV_A, idOf(9), PUBLIC_KEY, {}, { status: 503 }));
  steps.push(claim(DEV_A, idOf(3), PUBLIC_KEY, {}, { status: 202 }));
  steps.push(claim(DEV_B, idOf(10), PUBLIC_KEY, {}, { status: 404 }));
  add(
    'claim_quotas',
    'pending claims are bounded to eight per desktop (and per source): the ninth is `busy` 503, a repeat of a pending one is still answered with its id and prompts nobody',
    steps,
  );
}

// ---- pairing codes ----

add(
  'pair_code_request_over_websocket',
  'only the relay picks codes: a lease is required and malformed ones answer ok:false, another desktop cannot register or probe the code of a desktop, and the code still resolves',
  [
    desktop('victim', DEV_A),
    desktop('attacker', DEV_B),
    sendJson('victim', { type: 'desktop-lanes', media: true, e2ee: 1, pairV2: 1 }),
    sendJson('victim', { type: 'pair-code-request', lease: 'victim-lease-1', name: '' }),
    expectFrames('victim', 1, fromFrame('vcode', 'code')),
    sendJson('attacker', { type: 'pair-code', code: '${vcode}', name: 'x' }),
    sendJson('attacker', { type: 'pair-code-request', lease: 'attacker-1', code: '${vcode}' }),
    expectFrames('attacker', 1, fromFrame('acode', 'code')),
    sendJson('attacker', { type: 'pair-code-request', lease: 'short' }),
    expectFrames('attacker', 1),
    sendJson('attacker', { type: 'pair-code-request', lease: 'has spaces in it' }),
    sendJson('attacker', { type: 'pair-code-request' }),
    expectFrames('attacker', 2),
    wait(150),
    post('/pair-code/resolve', { code: '${vcode}' }, { status: 200 }),
    expectFrames('victim', 1),
  ],
);

add(
  'pair_code_redial',
  'a code lives only as long as the leg that asked for it: it dies with its socket, a new lease replaces the old code, a withdrawn code resolves nowhere, and a redial gets a fresh one',
  [
    desktop('first', DEV_A),
    sendJson('first', { type: 'pair-code-request', lease: 'lease-first-1', name: 'Home' }),
    expectFrames('first', 1, fromFrame('c1', 'code')),
    ...hangUp('first'),
    wait(150),
    post('/pair-code/resolve', { code: '${c1}' }, { status: 404 }),
    desktop('second', DEV_A),
    sendJson('second', { type: 'pair-code-request', lease: 'lease-second-1', name: 'Home' }),
    expectFrames('second', 1, fromFrame('c2', 'code')),
    sendJson('second', { type: 'pair-code-request', lease: 'lease-second-2', name: 'Home' }),
    expectFrames('second', 1, fromFrame('c3', 'code')),
    post('/pair-code/resolve', { code: '${c2}' }, { status: 404 }),
    sendJson('second', { type: 'pair-code-clear' }),
    wait(150),
    post('/pair-code/resolve', { code: '${c3}' }, { status: 404 }),
  ],
);

{
  const steps = [
    desktop('dA'),
    sendJson('dA', { type: 'desktop-name', name: 'Secret Host' }),
    sendJson('dA', { type: 'pair-code-request', lease: 'lease-name-01', name: 'Secret Host' }),
    expectFrames('dA', 1, fromFrame('code', 'code')),
  ];
  for (let n = 0; n < 62; n += 1) steps.push(http(`/pair-code/support?deviceId=${DEV_A}`, { status: n < 60 ? 200 : 429 }));
  add(
    'pair_code_support_throttled',
    '/pair-code/support never names the host and is throttled per source: after sixty answers it is 429 with Retry-After',
    steps,
  );
}

add(
  'pair_code_resolve_and_claim',
  'a published code redeems once into the device, its name (control characters dropped, trimmed) and a one-time ticket; the desktop hears pair-code-used; the ticket marks the first following claim a code claim and every other claim a qr claim or a retry',
  [
    desktop('dA'),
    sendJson('dA', { type: 'desktop-lanes', media: true, e2ee: 1, pairV2: 1 }),
    sendJson('dA', { type: 'pair-code-request', lease: 'lease-main-01', name: '  Home\tPC  ' }),
    expectFrames('dA', 1, fromFrame('code', 'code')),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
    post('/pair-code/resolve', { code: '${code}' }, { status: 200, capture: fromBody('ticket', 'ticket') }),
    expectFrames('dA', 1),
    post('/pair-code/resolve', { code: '${code}' }, { status: 404 }),
    claim(DEV_A, idOf(1), PUBLIC_KEY, { name: 'Phone', ticket: '${ticket}' }, { status: 202 }),
    expectFrames('dA', 1),
    claim(DEV_A, idOf(2), PUBLIC_KEY, { name: 'Phone', ticket: '${ticket}' }, { status: 202 }),
    claim(DEV_A, idOf(3), PUBLIC_KEY, { name: 'Phone', ticket: '0'.repeat(32) }, { status: 202 }),
    claim(DEV_A, idOf(4), PUBLIC_KEY, { name: 'Phone', retry: true }, { status: 202 }),
    claim(DEV_A, idOf(5), PUBLIC_KEY, { name: 'Phone', retry: 'yes' }, { status: 202 }),
    expectFrames('dA', 4),
  ],
);

add(
  'pair_code_resolve_rate_limit',
  'wrong guesses are limited per source: after five the source is locked out, even for the right code, with a Retry-After and an answer that never echoes the code',
  [
    desktop('dA'),
    sendJson('dA', { type: 'pair-code-request', lease: 'lease-limit-1' }),
    expectFrames('dA', 1, fromFrame('code', 'code')),
    ...Array.from({ length: 5 }, () => post('/pair-code/resolve', { code: 'abcdef' }, { status: 404 })),
    post('/pair-code/resolve', { code: '${code}' }, { status: 429 }),
    post('/pair-code/resolve', { code: 'abcdef' }, { status: 429 }),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
  ],
);

add(
  'pair_code_resolve_bad_requests',
  'oversize bodies are 400, a malformed code 404, a foreign Origin 403; the phone app origins (https://localhost, capacitor://localhost) get their CORS headers and nobody else; /connect is the pairing page with its CSP',
  [
    post('/pair-code/resolve', { code: 'x'.repeat(5000) }, { status: 400 }),
    post('/pair-code/resolve', '{', { status: 400 }),
    post('/pair-code/resolve', { code: 'abc' }, { status: 404 }),
    post('/pair-code/resolve', {}, { status: 404 }),
    post('/pair-code/resolve', { code: '123456' }, { headers: FOREIGN_JSON, status: 403 }),
    post('/pair-code/resolve', { code: '123456' }, {
      headers: [['Content-Type', 'application/json'], ['Origin', 'capacitor://localhost']],
      status: 404,
    }),
    post('/pair-code/resolve', { code: '123456' }, {
      headers: [['Content-Type', 'application/json'], ['Origin', 'https://localhost']],
      status: 404,
    }),
    http('/pair-code/resolve', { method: 'OPTIONS', headers: [['Origin', 'https://localhost']], status: 204 }),
    http('/pair-code/resolve', { method: 'OPTIONS', headers: [['Origin', 'capacitor://localhost']], status: 204 }),
    http('/pair-code/resolve', { method: 'OPTIONS', headers: [['Origin', 'https://evil.example']], status: 204 }),
    http('/pair-code/resolve', { method: 'OPTIONS', status: 204 }),
    http('/pair-code/resolve', { status: 404 }),
    http('/pair-code/unknown', { method: 'POST', headers: JSON_ORIGIN, body: '{}', status: 404 }),
    http('/connect', { status: 200 }),
  ],
);

add(
  'app_install_page',
  '/app is the same parameterless install page whatever it is asked with, and only GET reads it',
  [
    http('/app', { status: 200 }),
    http(`/app?d=${DEV_A}&x=1`, { status: 200 }),
    http('/app', { method: 'POST', status: 405 }),
  ],
);

add(
  'pair_code_support_and_presence',
  'support says whether a desktop is online and whether it declared pairing v2; presence answers per id for known routes only (first sixteen ids, valid ids), and goes offline when the leg closes',
  [
    desktop('old', DEV_A),
    sendJson('old', { type: 'desktop-lanes', media: true, e2ee: 1 }),
    wait(100),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
    post('/pair-code/presence', { ids: [DEV_A, DEV_B, 'nope', 7, null] }, { status: 200 }),
    desktop('new', DEV_B),
    sendJson('new', { type: 'desktop-lanes', media: true, e2ee: 1, pairV2: 1 }),
    wait(100),
    http(`/pair-code/support?deviceId=${DEV_B}`, { status: 200 }),
    post('/pair-code/presence', { ids: [DEV_A, DEV_B] }, { status: 200 }),
    post('/pair-code/presence', { ids: 'not a list' }, { status: 200 }),
    post('/pair-code/presence', '{', { status: 400 }),
    http('/pair-code/support?deviceId=nope', { status: 404 }),
    http('/pair-code/support', { status: 404 }),
    ...hangUp('old'),
    wait(150),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 200 }),
    post('/pair-code/presence', { ids: [DEV_A, DEV_B] }, { status: 200 }),
  ],
);

// ---- the /ws gate ----

add(
  'ws_gate_credentials',
  '/ws needs a same-origin upgrade and a per-browser credential: the desktop pairing token, an unknown token and no token are closed 4005, a foreign or missing Origin is 403, a real credential joins the desktop that is online and is closed 4002 when it is offline',
  [
    desktop('dA'),
    setToken('dA', TOKEN_A),
    registerBrowser(TOKEN_A, 'bbbbbbbb', 'browser'),
    phone('legacy', TOKEN_A),
    expectClose('legacy', 4005),
    phone('unknown', '0123456789abcdef0123456789abcdef'),
    expectClose('unknown', 4005),
    wsOpen('none', '/ws', { role: 'phone', headers: [ORIGIN] }),
    expectClose('none', 4005),
    phone('foreign', '${browser}', 403, ['Origin', 'https://deployment-probe.invalid']),
    phone('deep', '${browser}', 403, ['Origin', '${origin}/x']),
    wsOpen('noorigin', '/ws?token=${browser}', { role: 'phone', status: 403 }),
    phone('joined', '${browser}'),
    expectFrames('dA', 1),
    hangUp('dA'),
    wait(150),
    phone('offline', '${browser}'),
    expectClose('offline', 4002),
  ],
  { knobs: NO_STALL },
);

add(
  'ws_gate_unauthorized_rate_limit',
  'probing for credentials is bounded per source: after sixty refusals /client/register and /ws answer 429, while an upgrade with a foreign Origin is still plainly refused',
  [
    ...Array.from({ length: 60 }, () => post('/client/register', { clientId: 'bbbbbbbb' }, { status: 401 })),
    post('/client/register', { clientId: 'bbbbbbbb' }, { status: 429 }),
    phone('probe', '0123456789abcdef0123456789abcdef', 429),
    phone('foreign', '0123456789abcdef0123456789abcdef', 403, ['Origin', 'https://deployment-probe.invalid']),
    http(`/pair-code/support?deviceId=${DEV_A}`, { status: 404 }),
  ],
);

{
  const steps = [desktop('dA'), setToken('dA', TOKEN_A), registerBrowser(TOKEN_A, 'bbbbbbbb', 'browser')];
  for (let n = 0; n < 32; n += 1) steps.push(phone(`p${n}`, '${browser}'));
  steps.push(phone('over', '${browser}', 429));
  steps.push(hangUp('p0'));
  steps.push(wait(150));
  steps.push(phone('again', '${browser}'));
  steps.push(phone('over2', '${browser}', 429));
  add(
    'ws_gate_client_capacity',
    'a desktop serves at most 32 live browser legs: the 33rd is refused 429 until one leaves',
    steps,
    { knobs: NO_STALL },
  );
}

{
  const steps = [desktop('dA'), setToken('dA', TOKEN_A), registerBrowser(TOKEN_A, 'bbbbbbbb', 'browser')];
  for (let n = 0; n < 120; n += 1) steps.push(phone(`p${n}`, '${browser}'), hangUp(`p${n}`));
  steps.push(phone('over', '${browser}', 429));
  add(
    'ws_gate_connect_rate',
    'a device accepts 120 browser upgrades a minute, however briefly each one lives: the 121st is refused 429',
    steps,
    { knobs: NO_STALL },
  );
}

for (const scenario of scenarios) {
  writeFileSync(join(here, `${scenario.id}.json`), `${JSON.stringify(scenario, null, 2)}\n`);
}
console.log(`${scenarios.length} scenarios`);
