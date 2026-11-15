// Writes the scenario files of the `services` suite (the services that ride on the relay's legs: the webhook tunnel,
// the media lane, POST /feedback, Web Push, native push and ICE credentials) next to this file.
//
//   node generate.mjs            rewrites every <id>.json here
//
// The scenario format is tests/twin/scenario.rs; the Node relay these scenarios are recorded against is the tree's
// apps/relay. A scenario is generated, not hand written, so the long ones (a rate limit walked to its ceiling, a
// request body one byte past its cap) and the pairing walk-through every service needs stay one line each.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- fixed identities ------------------------------------------------------------------------------------------

const DEVICE = 'dddddddd-1111-4111-8111-000000000001';
const DEVICE_B = 'dddddddd-2222-4222-8222-000000000002';
const SECRET = '0123456789abcdef';
const CLIENT = 'cccccccc-1111-4111-8111-000000000001';
const CLIENT_B = 'cccccccc-2222-4222-8222-000000000002';
const PUBLIC_KEY = 'A'.repeat(86);
const SESSION = 'A'.repeat(43);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/subscription-1';
const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = `${'f'.repeat(40)}:APA91b-token_x`;
const WEB_PUSH_PUBLIC =
  'BPxBd1ahXCTe-q001mNPhEU8JcDwByuASgyDRlPeGD5Czy9B3-OCgRyM8qqfFmm7DESpc87614NOR1pRVEVxEmY';
// The relay's own Web Push identity, placed in the data directory so the signatures its pushes carry can be verified.
const WEB_PUSH_IDENTITY = JSON.stringify(
  {
    version: 1,
    publicKey: WEB_PUSH_PUBLIC,
    privateKeyJwk: {
      kty: 'EC',
      x: '_EF3VqFcJN76rTTWY0-ERTwlwPAHK4BKDINGU94YPkI',
      y: 'zy9B3-OCgRyM8qqfFmm7DESpc87614NOR1pRVEVxEmY',
      crv: 'P-256',
      d: '2QZwDAiit22CA2-vF9GmfcwkMpQMfisVKdk_ujisRgc',
    },
  },
  null,
  2
);
const TURN_ENV = {
  TURN_AUTH_SECRET: 'c'.repeat(64),
  TURN_HOST: 'relay.example.com',
  TURN_TLS_PORT: '5349',
  TURN_ISSUE_LIMIT: '3',
};

// ---- step builders ---------------------------------------------------------------------------------------------

const PROBE = 100;
const json = (value) => JSON.stringify(value);

function http(method, path, options = {}) {
  const { headers, body, status, label, capture, timeout, raw, probe } = options;
  const step = { do: 'http' };
  if (label) step.label = label;
  if (method !== 'GET') step.method = method;
  if (path !== undefined) step.path = path;
  if (headers) step.headers = Object.entries(headers);
  if (body !== undefined) step.body = typeof body === 'string' || body?.base64 !== undefined ? body : json(body);
  if (raw !== undefined) step.raw = raw;
  if (status !== undefined) step.expect_status = status;
  if (capture) step.capture = capture;
  step.close_probe_ms = probe ?? PROBE;
  if (timeout) step.timeout_ms = timeout;
  return step;
}
const get = (path, options) => http('GET', path, options);
const post = (path, options) => http('POST', path, options);
const postJson = (path, body, options = {}) =>
  post(path, { ...options, body, headers: { 'Content-Type': 'application/json', ...options.headers } });

const wsOpen = (conn, path, options = {}) => {
  const { role, basic, status, headers } = options;
  const step = { do: 'ws_open', conn, path };
  if (role) step.role = role;
  if (headers) step.headers = Object.entries(headers);
  if (basic) step.basic = basic;
  if (status !== undefined) step.expect_status = status;
  step.close_probe_ms = PROBE;
  return step;
};
const sendText = (conn, text) => ({ do: 'send', conn, frame: { kind: 'text', text } });
const sendJson = (conn, value) => sendText(conn, json(value));
const sendMany = (conn, values) => ({
  do: 'send',
  conn,
  frame: { kind: 'coalesced', frames: values.map((value) => ({ kind: 'text', text: json(value) })) },
});
const sendClose = (conn, code = 1000) => ({ do: 'send', conn, frame: { kind: 'close', code } });
const expectFrames = (conn, frames, { label: _label, ...extra } = {}) => ({ do: 'expect', conn, frames, ...extra });
const expectClose = (conn, code) => ({ do: 'expect', conn, close: true, ...(code ? { close_code: code } : {}) });
const wait = (ms) => ({ do: 'wait', ms });
const restart = () => ({ do: 'restart' });

const origin = { Origin: '${origin}' };
const bearer = (variable) => ({ Authorization: `Bearer \${${variable}}`, ...origin });

/** A desktop leg and a paired phone: the desktop opens /desktop, the phone claims, the desktop approves and the phone
 *  reads its credential into `${token<suffix>}`. `frames` is how many frames the relay sends on opening a leg
 *  (capabilities, then the Web Push subscriptions of a relay that owns an identity). */
function pair({ conn = 'd', device = DEVICE, client = CLIENT, suffix = '', frames = 2, ready = false } = {}) {
  const claim = `claimId${suffix}`;
  return [
    wsOpen(conn, '/desktop', { role: 'desktop', basic: [device, SECRET], status: 101 }),
    expectFrames(conn, frames),
    postJson('/claim', { deviceId: device, clientId: client, publicKey: PUBLIC_KEY }, {
      headers: origin,
      status: 202,
      capture: [{ var: claim, from: 'body_json', path: 'claimId' }],
    }),
    expectFrames(conn, 1),
    sendJson(conn, { type: 'claim-approve', claimId: `\${${claim}}` }),
    wait(200),
    get(`/claim/\${${claim}}`, {
      status: 200,
      capture: [{ var: `token${suffix}`, from: 'body_json', path: 'token' }],
    }),
    ...(ready ? [sendJson(conn, { type: 'webpush-ready' }), wait(150)] : []),
  ];
}

const scenarios = [];
function scenario(id, description, parts, steps) {
  scenarios.push({ id, description, ...parts, steps });
}

const png = (size = 64) => {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes.toString('base64');
};
const attachment = (name = 'shot.png', size = 64) => ({ name, mimeType: 'image/png', data: png(size) });
const WITH_IDENTITY = { data: { 'webpush-vapid.json': WEB_PUSH_IDENTITY } };
const VAPID_KEYS = { vapid_public: [WEB_PUSH_PUBLIC] };

// ---- the webhook tunnel (relay-hook.test.mjs, security.test.mjs) -----------------------------------------------

scenario(
  'hook_unknown_route',
  'a /hook path that names no routing id is 404 before any leg or limiter is consulted',
  {},
  [
    get('/hook/nope', { status: 404 }),
    get('/hook/', { status: 404 }),
    get('/hook/ABCDEF12-0000-4000-8000-000000000000/x', { status: 404 }),
    get('/hook/aaaaaaaa/', { status: 503, label: 'a short hexadecimal id is a routing id' }),
  ]
);

scenario(
  'hook_agent_offline_every_method',
  'webhook requests of every method answer 503 agent offline while no hook leg is open',
  {},
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) =>
    http(method, `/hook/${DEVICE}/events/${method.toLowerCase()}?run=1`, {
      status: 503,
      label: method,
      ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
        ? { body: '{"a":1}', headers: { 'Content-Type': 'application/json' } }
        : {}),
    })
  )
);

scenario(
  'hook_target_is_not_a_url',
  'a request target that is not a URL is answered by the relay, which keeps serving',
  {},
  [
    http('GET', undefined, { raw: 'GET http://[ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n' }),
    get('/healthz', { status: 200 }),
  ]
);

scenario(
  'hook_rate_limit_per_device_and_caller',
  'the 121st webhook in a window is 429 with Retry-After 60 and the connection destroyed',
  {},
  [
    ...Array.from({ length: 120 }, () => get(`/hook/${DEVICE}/x`, { status: 503, probe: 20 })),
    get(`/hook/${DEVICE}/x`, { status: 429, label: 'the 121st' }),
    get(`/hook/${DEVICE_B}/x`, { status: 429, label: 'the caller bucket also refuses another device' }),
  ]
);

scenario(
  'hook_leg_authentication',
  'the hook leg authenticates like the desktop leg: routing id, a secret of 16 characters, the secret on later dials',
  {},
  [
    wsOpen('a', '/hookleg', { role: 'hook', status: 401 }),
    wsOpen('a', '/hookleg', { role: 'hook', basic: [DEVICE, 'short'], status: 401 }),
    wsOpen('a', '/hookleg', { role: 'hook', basic: ['not a routing id', SECRET], status: 401 }),
    wsOpen('a', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    sendClose('a'),
    expectClose('a'),
    wsOpen('b', '/hookleg', { role: 'hook', basic: [DEVICE, 'fedcba9876543210'], status: 401 }),
    wsOpen('b', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
  ]
);

scenario(
  'hook_leg_superseded',
  'a second hook leg for the same device closes the first with 4000 superseded and serves the webhooks',
  {},
  [
    wsOpen('a', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    wsOpen('b', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    expectClose('a', 4000),
  ]
);

scenario(
  'hook_agent_busy_refused_before_the_body',
  'a leg that holds as many webhooks as the relay allows is answered 503 agent busy with Retry-After 1, the body unread',
  { knobs: { maxHookPending: 0 } },
  [
    wsOpen('h', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    post(`/hook/${DEVICE}/x`, { body: '{}', headers: { 'Content-Type': 'application/json' }, status: 503 }),
    expectFrames('h', 0),
  ]
);

scenario(
  'hook_forwarded_frame_and_agent_timeout',
  'a webhook is replayed to the agent as one http frame (method, path and query, headers minus the hop-by-hop ones, base64 body) and an agent that never answers is 504 after 30 s',
  {},
  [
    wsOpen('h', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    post(`/hook/${DEVICE}/github/push?delivery=1&x=%20y`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=0123abcd',
        'X-Custom': 'kept',
        'Keep-Alive': 'timeout=5',
        TE: 'trailers',
      },
      body: '{"zen":"Keep it logically awesome.","bytes":"é"}',
      status: 504,
      timeout: 40000,
    }),
    expectFrames('h', 1),
  ]
);

scenario(
  'hook_body_over_one_mebibyte',
  'a webhook body past 1 MiB is 413 payload too large and is never forwarded',
  {},
  [
    wsOpen('h', '/hookleg', { role: 'hook', basic: [DEVICE, SECRET], status: 101 }),
    post(`/hook/${DEVICE}/big`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: { base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') },
      status: 413,
      timeout: 20000,
    }),
    expectFrames('h', 0),
  ]
);

// ---- the media lane (relay-media-proxy.test.mjs, security.test.mjs) --------------------------------------------

/** A paired phone whose desktop leg declares the media lane (or not). */
function mediaSetup({ lane }) {
  return [
    ...pair(),
    ...(lane ? [sendJson('d', { type: 'desktop-lanes', media: true }), wait(150)] : []),
  ];
}
const media = (path, options = {}) => get(`${path}${path.includes('?') ? '&' : '?'}token=\${token}`, options);

scenario(
  'media_refusals_before_the_desktop_is_asked',
  'a media request is refused by the relay itself: method, malformed path, unknown variant, malformed session label or scheme marker, no credential',
  {},
  [
    ...mediaSetup({ lane: true }),
    http('POST', '/media/0123456789abcdef', { status: 405 }),
    http('PUT', '/media/0123456789abcdef', { status: 405 }),
    get('/media/%', { status: 400, label: 'percent decoding fails' }),
    get('/media/0123456789abcdef?variant=display', { status: 401, label: 'no credential' }),
    get('/media/0123456789abcdef?variant=display&token=ffffffffffffffffffffffffffffffff', {
      status: 401,
      label: 'unknown credential',
    }),
    media('/media/0123456789abcdef?variant=bogus', { status: 404 }),
    media('/media/nothex?variant=display', { status: 404 }),
    media('/media/0123456789abcdef?variant=display&sid=short', { status: 400 }),
    media('/media/0123456789abcdef?variant=display&enc=%20%20', { status: 400 }),
    media(`/media/0123456789abcdef?variant=display&sid=${SESSION}&enc=toolongenoughtobeinvalid`, { status: 400 }),
    expectFrames('d', 0),
  ]
);

scenario(
  'media_health_follows_the_desktop_lane',
  '/media/healthz answers for the desktop that would produce the bytes: ok with the lane, unsupported without it',
  {},
  [
    ...mediaSetup({ lane: false }),
    media('/media/healthz', { status: 503, label: 'a desktop that never declared the lane' }),
    sendJson('d', { type: 'desktop-lanes', media: true }),
    wait(150),
    media('/media/healthz', { status: 200, label: 'the lane declared' }),
    sendClose('d'),
    expectClose('d'),
    media('/media/healthz', { status: 503, label: 'the desktop gone' }),
  ]
);

scenario(
  'media_desktop_without_the_lane_is_503',
  'an older desktop that announced no media lane is answered 503 without a request to it',
  {},
  [
    ...mediaSetup({ lane: false }),
    media(`/media/0123456789abcdef?variant=display&sid=${SESSION}`, { status: 503 }),
    expectFrames('d', 0),
  ]
);

scenario(
  'media_desktop_offline_is_503',
  'a media request while the desktop leg is closed is 503 Desktop offline.',
  {},
  [
    ...mediaSetup({ lane: true }),
    sendClose('d'),
    expectClose('d'),
    media(`/media/0123456789abcdef?variant=display&sid=${SESSION}`, { status: 503 }),
    http('HEAD', `/media/0123456789abcdef?variant=thumb&token=\${token}`, { status: 503 }),
  ]
);

scenario(
  'media_request_frame_and_head_timeout',
  'a media request reaches the desktop as one media-request frame (range, if-none-match, session label, scheme marker); a desktop that never answers is 504 after 30 s and is told to abort',
  {},
  [
    ...mediaSetup({ lane: true }),
    media(`/media/0123456789abcdef?variant=download&sid=${SESSION}&enc=e2ee1`, {
      headers: { Range: 'bytes=65536-131071', 'If-None-Match': '"etag-1"' },
      status: 504,
      timeout: 40000,
    }),
    expectFrames('d', 2),
  ]
);

scenario(
  'media_plaintext_era_request_is_forwarded_unmarked',
  'a request with no session label and no scheme marker is forwarded with empty ones so the desktop can refuse it',
  {},
  [
    ...mediaSetup({ lane: true }),
    http('HEAD', `/media/0123456789abcdef?variant=thumb&token=\${token}`, { status: 504, timeout: 40000 }),
    expectFrames('d', 2),
  ]
);

// ---- POST /feedback (feedback.test.mjs) ------------------------------------------------------------------------

const FEEDBACK = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'bug',
  message: '  it broke  ',
};
const feedback = (extra = {}, id = FEEDBACK.id) => ({ ...FEEDBACK, id, ...extra });
const sendFeedback = (body, options = {}) => postJson('/feedback', body, options);
const feedbackId = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const mailer = (answers = []) => ({ feedbackSender: { answers } });
const QUICK_RETRY = { feedbackOptions: { baseDelayMs: 40, maxDelayMs: 80 } };

scenario(
  'feedback_accepted_mailed_once_and_recorded',
  'a feedback is on disk before 202, is mailed once through the sender with the trimmed text and the reply address, and the record then keeps no payload',
  { fakes: mailer() },
  [
    sendFeedback(feedback({ replyTo: 'User@Example.com' }), { status: 202 }),
    wait(300),
    sendFeedback(feedback({ replyTo: 'User@Example.com' }), { status: 202, label: 'a repeat is the same answer' }),
    wait(200),
  ]
);

scenario(
  'feedback_idempotent_and_conflicting_resubmissions',
  'the same id with the same payload is 202 again, a different message or kind is 409 conflict, nothing is mailed twice',
  { fakes: mailer() },
  [
    sendFeedback(feedback(), { status: 202 }),
    wait(250),
    sendFeedback(feedback({ message: 'it broke' }), { status: 202, label: 'the text is trimmed before it is compared' }),
    sendFeedback(feedback({ message: 'other' }), { status: 409 }),
    sendFeedback(feedback({ kind: 'other' }), { status: 409 }),
    sendFeedback(feedback({ replyTo: 'a@b.co' }), { status: 409 }),
    wait(150),
  ]
);

scenario(
  'feedback_validation_refusals',
  'bodies that are not valid feedback are 400 invalid_feedback and store nothing; other methods are 405 and other content types 415',
  { fakes: mailer(), knobs: { feedbackOptions: { ipLimit: 100 } } },
  [
    ...[
      'not json',
      '[]',
      'null',
      json(feedback({ id: 'nope' })),
      json(feedback({ kind: 'x' })),
      json(feedback({ message: '   ' })),
      json(feedback({ message: 5 })),
      json(feedback({ message: 'a'.repeat(8001) })),
      json(feedback({ replyTo: 'not-an-email' })),
      json(feedback({ replyTo: `${'a'.repeat(250)}@b.co` })),
      json(feedback({ replyTo: 5 })),
      json(feedback({ replyTo: null })),
    ].map((body) => post('/feedback', { body, headers: { 'Content-Type': 'application/json' }, status: 400 })),
    sendFeedback(feedback({ message: 'a'.repeat(8000) }), { status: 202, label: '8000 characters is the ceiling' }),
    get('/feedback', { status: 405 }),
    http('PUT', '/feedback', { body: '{}', headers: { 'Content-Type': 'application/json' }, status: 405 }),
    http('DELETE', '/feedback', { status: 405 }),
    post('/feedback', { body: json(feedback()), headers: { 'Content-Type': 'text/plain' }, status: 415 }),
    post('/feedback', { body: json(feedback()), status: 415, label: 'no content type' }),
    post('/feedback', {
      body: json(feedback({}, feedbackId(2))),
      headers: { 'Content-Type': 'Application/JSON ; charset=utf-8' },
      status: 202,
      label: 'the media type is matched without case and with parameters',
    }),
    wait(150),
  ]
);

scenario(
  'feedback_declared_size_over_the_cap',
  'a body declared larger than the cap is 413 payload_too_large before it is read and the connection closes',
  { fakes: mailer() },
  [
    post('/feedback', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' },
      status: 413,
    }),
    get('/healthz', { status: 200 }),
  ]
);

scenario(
  'feedback_rate_limit_per_address',
  'the address that has used its allowance is 429 rate_limited, valid or not',
  { fakes: mailer(), knobs: { feedbackOptions: { ipLimit: 3, globalLimit: 1000 } } },
  [
    ...[1, 2, 3].map((n) => sendFeedback(feedback({}, feedbackId(n)), { status: 202 })),
    sendFeedback(feedback({}, feedbackId(4)), { status: 429 }),
    post('/feedback', { body: 'not json', headers: { 'Content-Type': 'application/json' }, status: 429 }),
    wait(150),
  ]
);

scenario(
  'feedback_rate_limit_global',
  'the global allowance applies across clients',
  { fakes: mailer(), knobs: { feedbackOptions: { ipLimit: 100, globalLimit: 2 } } },
  [
    ...[1, 2].map((n) => sendFeedback(feedback({}, feedbackId(n)), { status: 202 })),
    sendFeedback(feedback({}, feedbackId(3)), { status: 429 }),
    wait(150),
  ]
);

scenario(
  'feedback_unconfigured_mail_is_503_and_stores_nothing',
  'without a sender or SMTP settings every POST is 503 feedback_unavailable before its body is read and nothing is stored',
  { knobs: { feedbackEnv: {} } },
  [
    sendFeedback(feedback(), { status: 503 }),
    post('/feedback', { headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' }, status: 503 }),
    get('/feedback', { status: 405 }),
  ]
);

scenario(
  'feedback_blank_reply_address_is_absent',
  'a blank replyTo is treated as absent: no reply address on the mail',
  { fakes: mailer() },
  [sendFeedback(feedback({ replyTo: '   ' }), { status: 202 }), wait(250)]
);

scenario(
  'feedback_failed_send_retries_with_backoff',
  'a failed send is retried after the backoff and the record keeps its attempt count until it is mailed',
  { fakes: mailer([{ throw: 'smtp down', code: 'ECONNREFUSED' }, { throw: 'smtp down' }, {}]), knobs: QUICK_RETRY },
  [sendFeedback(feedback(), { status: 202 }), wait(900)]
);

scenario(
  'feedback_attachment_mail_retries_across_a_restart',
  'a record whose send failed is on disk with its attachment and attempt count; the relay that starts next sends it with identical bytes once it is due',
  {
    fakes: mailer([{ throw: 'smtp down' }, {}]),
    knobs: { feedbackOptions: { baseDelayMs: 150, maxDelayMs: 300 } },
  },
  [
    sendFeedback(feedback({ attachments: [attachment()] }), { status: 202 }),
    wait(60),
    restart(),
    wait(1200),
    sendFeedback(feedback({ attachments: [attachment()] }), { status: 202, label: 'the id is still known' }),
  ]
);

scenario(
  'feedback_attachments_are_mailed_and_removed',
  'attachments are validated, stored, mailed as MIME attachments (name, type, bytes and digest recorded) and dropped from the record once sent',
  { fakes: mailer() },
  [
    sendFeedback(feedback({ attachments: [attachment('a.png', 64), attachment('b.png', 200)] }), { status: 202 }),
    wait(300),
    sendFeedback(feedback({ attachments: [attachment('a.png', 64), attachment('b.png', 200)] }), {
      status: 202,
      label: 'the same attachments are idempotent',
    }),
    sendFeedback(feedback({ attachments: [attachment('a.png', 64), attachment('c.png', 200)] }), {
      status: 409,
      label: 'different attachment content conflicts',
    }),
    wait(150),
  ]
);

scenario(
  'feedback_invalid_attachments_are_400',
  'malformed, unsafe, unsupported and too many attachments are 400 invalid_feedback and nothing is stored',
  { fakes: mailer() },
  [
    ...[
      [{ name: 'x.png', mimeType: 'image/png', data: 'not base64!' }],
      [{ name: '../x.png', mimeType: 'image/png', data: png() }],
      [{ name: '.hidden.png', mimeType: 'image/png', data: png() }],
      [{ name: 'x.png', mimeType: 'image/gif', data: png() }],
      [{ name: 'x.png', mimeType: 'image/jpeg', data: png() }],
      [{ name: 'x.png', mimeType: 'image/png', data: Buffer.from('plain text, not a png').toString('base64') }],
      [attachment('1.png'), attachment('2.png'), attachment('3.png'), attachment('4.png')],
      'nope',
      [null],
    ].map((attachments, index) =>
      sendFeedback(feedback({ attachments }, feedbackId(index + 1)), { status: 400 })
    ),
    sendFeedback(feedback({ attachments: [{ ...attachment(), extra: 'dropped' }] }, feedbackId(9)), {
      status: 202,
      label: 'unknown fields of an attachment are dropped',
    }),
    wait(250),
  ]
);

scenario(
  'feedback_pending_count_is_capped',
  'a relay holding as many undelivered records as it allows answers 503 feedback_busy, and a known id is still 202',
  {
    fakes: mailer([{ throw: 'smtp down' }]),
    knobs: { feedbackOptions: { maxPending: 2, baseDelayMs: 600000, maxDelayMs: 600000 } },
  },
  [
    sendFeedback(feedback({}, feedbackId(1)), { status: 202 }),
    sendFeedback(feedback({}, feedbackId(2)), { status: 202 }),
    wait(200),
    sendFeedback(feedback({}, feedbackId(3)), { status: 503 }),
    sendFeedback(feedback({}, feedbackId(1)), { status: 202, label: 'a known id is not a new record' }),
  ]
);

scenario(
  'feedback_record_cap_prunes_only_delivered_records',
  'at the record cap the oldest delivered record is removed to admit a new one; with none delivered the answer is 503 feedback_busy',
  { fakes: mailer(), knobs: { feedbackOptions: { maxRecords: 2 } } },
  [
    sendFeedback(feedback({}, feedbackId(1)), { status: 202 }),
    wait(250),
    sendFeedback(feedback({}, feedbackId(2)), { status: 202 }),
    wait(250),
    sendFeedback(feedback({}, feedbackId(3)), { status: 202 }),
    wait(250),
  ]
);

scenario(
  'feedback_record_cap_without_a_delivered_record_is_busy',
  'at the record cap with every record undelivered nothing can be pruned: 503 feedback_busy',
  {
    fakes: mailer([{ throw: 'smtp down' }]),
    knobs: { feedbackOptions: { maxRecords: 1, baseDelayMs: 600000, maxDelayMs: 600000 } },
  },
  [
    sendFeedback(feedback({}, feedbackId(1)), { status: 202 }),
    wait(200),
    sendFeedback(feedback({}, feedbackId(2)), { status: 503 }),
  ]
);

scenario(
  'feedback_pending_attachment_bytes_are_capped',
  'undelivered attachment bytes are bounded: a submission that would exceed the bound is 503 feedback_busy, one without attachments is not',
  {
    fakes: mailer([{ throw: 'smtp down' }]),
    knobs: { feedbackOptions: { maxPendingAttachmentBytes: 100, baseDelayMs: 600000, maxDelayMs: 600000 } },
  },
  [
    sendFeedback(feedback({ attachments: [attachment('a.png', 64)] }, feedbackId(1)), { status: 202 }),
    wait(200),
    sendFeedback(feedback({ attachments: [attachment('b.png', 64)] }, feedbackId(2)), { status: 503 }),
    sendFeedback(feedback({}, feedbackId(3)), { status: 202 }),
  ]
);

const storedRecord = (id, extra = {}) => {
  const payload = { kind: 'bug', message: 'left behind', replyTo: '' };
  const hash = createHash('sha256').update(JSON.stringify([payload.kind, payload.message, payload.replyTo])).digest('hex');
  return json({ id, hash, payload, createdAt: 4_000_000_000_000, attempts: 0, nextAttemptAt: 4_000_000_000_000, sentAt: 0, ...extra });
};

scenario(
  'feedback_records_of_an_earlier_run_are_mailed_on_start',
  'a stored record without attachments (the shape older relays wrote) loads and is mailed, and a delivered one stays recorded',
  {
    fakes: mailer(),
    files: {
      data: {
        [`feedback/${feedbackId(1)}.json`]: storedRecord(feedbackId(1), { nextAttemptAt: 1 }),
        [`feedback/${feedbackId(2)}.json`]: json({
          id: feedbackId(2),
          hash: 'x',
          createdAt: 4_000_000_000_000,
          attempts: 0,
          nextAttemptAt: 0,
          sentAt: 4_000_000_000_001,
        }),
      },
    },
  },
  [wait(300), sendFeedback(feedback({ message: 'left behind' }, feedbackId(1)), { status: 202, label: 'the stored id is known' })]
);

scenario(
  'feedback_corrupt_records_fail_closed',
  'an unreadable or invalid stored record is reported with its file name and an error code only, and the service then refuses every submission with 503',
  {
    fakes: mailer(),
    files: {
      data: {
        [`feedback/${feedbackId(1)}.json`]: '{ not json',
        [`feedback/${feedbackId(2)}.json`]: json({ id: feedbackId(3), hash: 'x' }),
        'feedback/notes.txt': 'ignored: not a record file',
      },
    },
  },
  [sendFeedback(feedback(), { status: 503 })]
);

scenario(
  'feedback_storage_unavailable_is_503',
  'a feedback directory that cannot be created leaves the relay serving and every submission 503',
  { fakes: mailer(), files: { data: { feedback: 'a file where the directory belongs' } } },
  [sendFeedback(feedback(), { status: 503 }), get('/healthz', { status: 200 })]
);

// ---- Web Push (web-push.test.mjs) ------------------------------------------------------------------------------

const sealed = (tag = 'a') => ({
  version: 1,
  ephemeralPublicKey: `B${tag.repeat(86)}`.slice(0, 87),
  nonce: 'n'.repeat(16),
  ciphertext: `${tag}`.repeat(40),
});
const registerWith = (variable, endpoint = ENDPOINT, tag = 'a', options = {}) =>
  postJson('/webpush/register', { endpoint, sealed: sealed(tag) }, { headers: bearer(variable), ...options });
const webPushSend = (conn, extra = {}) =>
  sendJson(conn, {
    type: 'webpush-send',
    endpoint: ENDPOINT,
    clientId: CLIENT,
    payload: Buffer.from('ciphertext-from-a').toString('base64url'),
    ...extra,
  });
function webPush(id, description, parts, steps) {
  scenario(id, description, { keys: VAPID_KEYS, ...parts, files: { data: { ...WITH_IDENTITY.data, ...parts.files?.data } } }, steps);
}

webPush(
  'webpush_key_and_routes',
  'GET /webpush/key answers the relay key with no-store, the same one after a restart; other paths and methods are refused',
  {},
  [
    get('/webpush/key', { status: 200 }),
    http('HEAD', '/webpush/key', { status: 200 }),
    post('/webpush/key', { status: 405 }),
    get('/webpush/nope', { status: 404 }),
    get('/webpush/register', { status: 405 }),
    get('/webpush', { status: 404 }),
    restart(),
    get('/webpush/key', { status: 200 }),
  ]
);

scenario(
  'webpush_without_an_identity_is_off',
  'a relay whose identity file cannot be used disables Web Push: /webpush answers 404 and the desktop is told nothing about it',
  { files: { data: { 'webpush-vapid.json': '{ not json' } } },
  [
    get('/webpush/key', { status: 404 }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, { status: 404 }),
    wsOpen('d', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }),
    expectFrames('d', 1),
    webPushSend('d'),
    sendJson('d', { type: 'list-clients', requestId: 'barrier' }),
    expectFrames('d', 1),
  ]
);

webPush(
  'webpush_register_refusals',
  'register needs a per-browser credential from the relay origin and a valid body: 401, 403, 400, and 409 for a PC that never said it delivers through the relay',
  {},
  [
    ...pair(),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, { headers: origin, status: 401, label: 'no credential' }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, {
      headers: { Authorization: `Bearer ${'f'.repeat(64)}`, ...origin },
      status: 401,
      label: 'unknown credential',
    }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, {
      headers: { Authorization: 'Bearer ${token}', Origin: 'https://evil.example' },
      status: 403,
      label: 'a cross-site page',
    }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, {
      headers: { Authorization: 'Bearer ${token}' },
      status: 403,
      label: 'no Origin',
    }),
    post('/webpush/register', { headers: bearer('token'), body: 'not json', status: 400 }),
    postJson('/webpush/register', { sealed: sealed() }, { headers: bearer('token'), status: 400, label: 'no endpoint' }),
    postJson('/webpush/register', { endpoint: 'https://push.example.com/a', sealed: sealed() }, {
      headers: bearer('token'),
      status: 400,
      label: 'an endpoint outside the known push services',
    }),
    postJson('/webpush/register', { endpoint: 'https://fcm.googleapis.com:8443/a', sealed: sealed() }, {
      headers: bearer('token'),
      status: 400,
      label: 'a port',
    }),
    postJson('/webpush/register', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 400, label: 'no sealed keys' }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: { ...sealed(), version: 2 } }, {
      headers: bearer('token'),
      status: 400,
      label: 'sealed keys of another version',
    }),
    postJson('/webpush/register', { endpoint: ENDPOINT, sealed: sealed() }, {
      headers: bearer('token'),
      status: 409,
      label: 'a PC that never said webpush-ready',
    }),
    postJson('/webpush/unregister', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200, label: 'nothing to remove' }),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200 }),
    postJson('/webpush/status', {}, { headers: bearer('token'), status: 200, label: 'status before any subscription' }),
    postJson('/webpush/status', { endpoint: 'nope' }, { headers: bearer('token'), status: 400 }),
    expectFrames('d', 0),
  ]
);

webPush(
  'webpush_register_send_unregister',
  'a browser registers with its PC, the PC is told the set and sends through it: the relay signs with its VAPID key and forwards the ciphertext; a send for a binding the PC does not hold is refused',
  { fakes: { webPushFetch: { answers: [{ status: 201 }] } } },
  [
    ...pair({ ready: true }),
    postJson('/webpush/status', {}, { headers: bearer('token'), status: 200, label: 'a PC that delivers through the relay' }),
    registerWith('token', ENDPOINT, 'a', { status: 200 }),
    expectFrames('d', 1),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200 }),
    registerWith('token', ENDPOINT, 'a', { status: 200, label: 'an unchanged registration announces nothing' }),
    webPushSend('d', { ttl: 60, urgency: 'low', topic: 'turn-1' }),
    expectFrames('d', 1),
    webPushSend('d', { clientId: CLIENT_B }),
    expectFrames('d', 1),
    webPushSend('d', { endpoint: 'https://fcm.googleapis.com/fcm/send/other' }),
    expectFrames('d', 1),
    postJson('/webpush/unregister', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200 }),
    expectFrames('d', 1),
    webPushSend('d'),
    expectFrames('d', 1),
    postJson('/webpush/unregister', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200, label: 'already removed' }),
  ]
);

webPush(
  'webpush_send_validation',
  'a webpush-send frame without an endpoint, a client or a usable payload is answered invalid-message; ttl, urgency and topic outside their ranges fall back to the defaults',
  { fakes: { webPushFetch: { answers: [{ status: 201 }] } } },
  [
    ...pair({ ready: true }),
    registerWith('token', ENDPOINT, 'a', { status: 200 }),
    expectFrames('d', 1),
    webPushSend('d', { payload: '' }),
    webPushSend('d', { payload: 'not base64url!' }),
    webPushSend('d', { payload: Buffer.alloc(4097, 1).toString('base64url') }),
    webPushSend('d', { endpoint: '' }),
    webPushSend('d', { clientId: '' }),
    expectFrames('d', 5),
    webPushSend('d', { ttl: 99999999, urgency: 'urgent', topic: 'bad topic!' }),
    webPushSend('d', { ttl: 0, urgency: 'very-low', topic: 'ok_topic-1' }),
    webPushSend('d', { ttl: 1.5, urgency: 'normal' }),
    expectFrames('d', 3),
  ]
);

webPush(
  'webpush_push_service_answers',
  'a 404 or 410 retires the subscription for every PC; other statuses and a network error report the failure and keep it',
  { fakes: { webPushFetch: { answers: [{ status: 500 }, { throw: 'connection reset' }, { status: 429 }, { status: 404 }] } } },
  [
    ...pair({ ready: true }),
    registerWith('token', ENDPOINT, 'a', { status: 200 }),
    expectFrames('d', 1),
    webPushSend('d'),
    expectFrames('d', 1),
    webPushSend('d'),
    expectFrames('d', 1),
    webPushSend('d'),
    expectFrames('d', 1),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200, label: 'still registered' }),
    webPushSend('d'),
    expectFrames('d', 2, { label: 'the 404 result and the emptied set' }),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200, label: 'retired' }),
  ]
);

webPush(
  'webpush_gone_subscription_is_dropped_for_every_pc',
  'one browser registered with two PCs: a 410 from the push service drops it for both and each is told its new set; revoking the browser on one PC removes only that PC association',
  { fakes: { webPushFetch: { answers: [{ status: 201 }, { status: 410 }] } } },
  [
    ...pair({ conn: 'a', device: DEVICE, client: CLIENT, suffix: 'A', ready: true }),
    ...pair({ conn: 'b', device: DEVICE_B, client: CLIENT_B, suffix: 'B', ready: true }),
    registerWith('tokenA', ENDPOINT, 'a', { status: 200 }),
    registerWith('tokenB', ENDPOINT, 'b', { status: 200 }),
    expectFrames('a', 1),
    expectFrames('b', 1),
    webPushSend('a', { clientId: CLIENT }),
    expectFrames('a', 1),
    webPushSend('a', { clientId: CLIENT_B }),
    expectFrames('a', 1, { label: 'a PC cannot borrow another PC association' }),
    sendJson('a', { type: 'revoke-client', requestId: 'r1', clientId: CLIENT }),
    expectFrames('a', 2),
    registerWith('tokenA', ENDPOINT, 'a', { status: 401, label: 'the revoked credential cannot bind again' }),
    webPushSend('b', { clientId: CLIENT_B }),
    expectFrames('b', 2, { label: 'the 410 result and the emptied set' }),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('tokenB'), status: 200 }),
  ]
);

webPush(
  'webpush_registration_survives_a_restart',
  'registrations and the PC readiness are on disk: after a restart the browser is still registered and a send goes through',
  { fakes: { webPushFetch: { answers: [{ status: 201 }] } } },
  [
    ...pair({ ready: true }),
    registerWith('token', ENDPOINT, 'a', { status: 200 }),
    expectFrames('d', 1),
    restart(),
    wsOpen('d2', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }),
    expectFrames('d2', 2),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200 }),
    webPushSend('d2'),
    expectFrames('d2', 1),
  ]
);

webPush(
  'webpush_send_past_the_sender_timeout',
  'a push service that does not answer within 10 s is aborted and reported as a failed send; the subscription stays',
  { fakes: { webPushFetch: { answers: [{ status: 201, delayMs: 11000 }, {}] } } },
  [
    ...pair({ ready: true }),
    registerWith('token', ENDPOINT, 'a', { status: 200 }),
    expectFrames('d', 1),
    webPushSend('d'),
    expectFrames('d', 1, { timeout_ms: 20000 }),
    webPushSend('d'),
    expectFrames('d', 1),
  ]
);

webPush(
  'webpush_endpoints_are_registered_in_one_canonical_spelling',
  'an endpoint registered with an upper-case host and a trailing root dot is stored in its canonical spelling, and a send names the binding by that spelling',
  { fakes: { webPushFetch: { answers: [{ status: 201 }] } } },
  [
    ...pair({ ready: true }),
    registerWith('token', 'https://FCM.GoogleAPIs.com./fcm/send/Sub-2', 'a', { status: 200 }),
    expectFrames('d', 1),
    postJson('/webpush/status', { endpoint: 'https://fcm.googleapis.com/fcm/send/Sub-2' }, { headers: bearer('token'), status: 200 }),
    postJson('/webpush/status', { endpoint: 'https://FCM.GoogleAPIs.com./fcm/send/Sub-2' }, { headers: bearer('token'), status: 200 }),
    webPushSend('d', { endpoint: 'https://fcm.googleapis.com/fcm/send/Sub-2' }),
    expectFrames('d', 1),
  ]
);

webPush(
  'webpush_registry_file_is_loaded_defensively',
  'a stored registry keeps what is valid (a canonical endpoint, sealed keys, a device that delivers through the relay) and drops rows outside the push services or with bad keys; a PC is told only the clients its store still knows',
  {
    files: {
      data: {
        'webpush-subscriptions.json': json({
          version: 1,
          devices: [DEVICE, 'not a device id!'],
          subscriptions: [
            {
              endpoint: ENDPOINT,
              associations: [
                { deviceId: DEVICE, clientId: CLIENT, sealed: sealed('a'), createdAt: 4_000_000_000_000 },
                { deviceId: DEVICE, clientId: CLIENT_B, sealed: sealed('b'), createdAt: 4_000_000_000_000 },
                { deviceId: DEVICE, clientId: 'bad-keys', sealed: { version: 1 }, createdAt: 4_000_000_000_000 },
              ],
            },
            { endpoint: 'https://push.example.com/a', associations: [{ deviceId: DEVICE, clientId: CLIENT, sealed: sealed('a') }] },
            { endpoint: 'https://fcm.googleapis.com/fcm/send/no-associations', associations: [] },
            { endpoint: 'https://fcm.googleapis.com/fcm/send/not-a-list', associations: 5 },
          ],
        }),
      },
    },
  },
  [
    ...pair(),
    postJson('/webpush/status', {}, { headers: bearer('token'), status: 200, label: 'readiness came from the file' }),
    restart(),
    wsOpen('d2', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }),
    expectFrames('d2', 2),
  ]
);

webPush(
  'webpush_corrupt_registry_file_costs_a_gap_not_a_crash',
  'an unusable registry file is reported once and the relay starts with an empty registry',
  { files: { data: { 'webpush-subscriptions.json': '{ not json' } } },
  [...pair({ ready: true }), registerWith('token', ENDPOINT, 'a', { status: 200 }), expectFrames('d', 1)]
);

webPush(
  'webpush_mutations_are_rate_limited',
  'register and unregister count against one allowance per credential, an unchanged one included: the 21st is 429 with Retry-After 60',
  {},
  [
    ...pair({ ready: true }),
    ...Array.from({ length: 20 }, () => registerWith('token', ENDPOINT, 'a', { status: 200 })),
    registerWith('token', ENDPOINT, 'a', { status: 429 }),
    postJson('/webpush/unregister', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 429 }),
    postJson('/webpush/status', { endpoint: ENDPOINT }, { headers: bearer('token'), status: 200, label: 'status is not a mutation' }),
  ]
);

webPush(
  'webpush_store_failure_is_503',
  'a registry that cannot be written refuses the registration with 503 and Retry-After 30 instead of reporting a state a restart would lose',
  { files: { data: { 'webpush-subscriptions.json/blocked': 'a directory where the registry file belongs' } } },
  [
    ...pair(),
    registerWith('token', ENDPOINT, 'a', { status: 409, label: 'readiness could not be stored either' }),
  ]
);

// ---- native push (native-push.test.mjs) ------------------------------------------------------------------------

const nativeFake = (answers = [], platforms = ['apns', 'fcm']) => ({ nativePush: { platforms, answers } });
const nativeBind = (extra = {}) => ({
  type: 'native-push-bind',
  clientId: CLIENT,
  platform: 'apns',
  token: APNS_TOKEN,
  ...extra,
});
const nativeSend = (extra = {}) => ({
  type: 'native-push',
  platform: 'apns',
  token: APNS_TOKEN,
  mx: 'bXg',
  reason: 'turn-finished',
  collapseKey: 'c1',
  sandbox: false,
  ...extra,
});

scenario(
  'nativepush_capabilities_follow_the_service',
  'the capabilities frame announces native push and its platforms only when the relay can deliver',
  { fakes: nativeFake([], ['apns']) },
  [wsOpen('d', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }), expectFrames('d', 2)]
);

scenario(
  'nativepush_without_credentials_advertises_nothing',
  'a relay with no APNs or FCM credentials advertises no native push and ignores its frames without an answer',
  { knobs: { nativePushEnv: {} } },
  [
    ...pair(),
    sendMany('d', [nativeBind(), nativeSend()]),
    sendJson('d', { type: 'list-clients', requestId: 'barrier' }),
    expectFrames('d', 1),
  ]
);

scenario(
  'nativepush_bind_send_unbind',
  'a desktop binds a token to its own paired client and sends through it: the service gets the message and the desktop its result; after an unbind the token is unbound',
  { fakes: nativeFake([{ ok: true, status: 200 }]) },
  [
    ...pair(),
    sendJson('d', nativeBind()),
    sendJson('d', nativeSend({ sandbox: true })),
    expectFrames('d', 1),
    sendJson('d', nativeBind({ platform: 'fcm', token: FCM_TOKEN })),
    sendJson('d', nativeSend({ platform: 'fcm', token: FCM_TOKEN, reason: 'approval-pending', collapseKey: 'c2', sandbox: undefined })),
    expectFrames('d', 1),
    sendJson('d', { type: 'native-push-unbind', token: APNS_TOKEN, clientId: CLIENT }),
    sendJson('d', nativeSend()),
    expectFrames('d', 1),
    sendJson('d', nativeSend({ platform: 'fcm', token: FCM_TOKEN, collapseKey: 'c3' })),
    expectFrames('d', 1),
    sendJson('d', { type: 'native-push-unbind', token: FCM_TOKEN }),
    sendJson('d', nativeSend({ platform: 'fcm', token: FCM_TOKEN })),
    expectFrames('d', 1),
  ]
);

scenario(
  'nativepush_only_an_owned_client_binds',
  'a bind for a client the desktop did not pair, for a platform the relay lacks, or with a token of the wrong shape binds nothing',
  { fakes: nativeFake([], ['apns']) },
  [
    ...pair(),
    sendJson('d', nativeBind({ clientId: CLIENT_B })),
    sendJson('d', nativeBind({ platform: 'fcm', token: FCM_TOKEN })),
    sendJson('d', nativeBind({ token: 'xyz' })),
    sendJson('d', nativeBind({ clientId: 5 })),
    sendMany('d', [
      nativeSend(),
      nativeSend({ platform: 'fcm', token: FCM_TOKEN }),
      nativeSend({ token: 'xyz' }),
    ]),
    expectFrames('d', 3),
  ]
);

scenario(
  'nativepush_send_validation',
  'a send with an oversized or empty message, an unknown reason or a bad collapse key is answered invalid-message and reaches no platform',
  { fakes: nativeFake() },
  [
    ...pair(),
    sendJson('d', nativeBind()),
    sendMany('d', [
      nativeSend({ mx: 'x'.repeat(3501) }),
      nativeSend({ mx: '' }),
      nativeSend({ mx: 5 }),
      nativeSend({ reason: 'weird' }),
      nativeSend({ collapseKey: 'bad key!' }),
      nativeSend({ collapseKey: 'k'.repeat(65) }),
      nativeSend({ collapseKey: 5 }),
    ]),
    expectFrames('d', 7),
    sendJson('d', nativeSend({ mx: 'x'.repeat(3500), collapseKey: 'k'.repeat(64) })),
    expectFrames('d', 1),
  ]
);

scenario(
  'nativepush_sends_are_rate_limited_per_device',
  'the 121st native push of a minute from one desktop is answered rate-limited and does not reach the service',
  { fakes: nativeFake([{ ok: true, status: 200 }]) },
  [
    ...pair(),
    sendJson('d', nativeBind()),
    sendMany('d', Array.from({ length: 121 }, () => nativeSend())),
    expectFrames('d', 121, { timeout_ms: 15000 }),
  ]
);

scenario(
  'nativepush_invalid_token_is_dropped',
  'a token the platform reports dead is dropped from the desktop bindings and the desktop is told invalid; the failure is reported with its status and error',
  {
    fakes: nativeFake([
      { ok: false, status: 410, invalid: true, error: 'Unregistered' },
      { ok: false, status: 500, error: 'x'.repeat(120) },
    ]),
  },
  [
    ...pair(),
    sendJson('d', nativeBind()),
    sendJson('d', nativeSend()),
    expectFrames('d', 1),
    sendJson('d', nativeSend({ collapseKey: 'c2' })),
    expectFrames('d', 1, { label: 'unbound after the token was dropped' }),
    sendJson('d', nativeBind()),
    sendJson('d', nativeSend({ collapseKey: 'c3' })),
    expectFrames('d', 1),
  ]
);

scenario(
  'nativepush_revoked_client_drops_its_bindings',
  'revoking a paired client forgets the tokens bound for it: a later send is unbound-token',
  { fakes: nativeFake() },
  [
    ...pair(),
    sendJson('d', nativeBind()),
    sendJson('d', { type: 'revoke-client', requestId: 'r1', clientId: CLIENT }),
    expectFrames('d', 1),
    sendJson('d', nativeSend()),
    expectFrames('d', 1),
  ]
);

scenario(
  'nativepush_a_desktop_sends_only_through_its_own_binding',
  'one token bound by two desktops for their own clients: each delivers; the binding of one desktop cannot be used by the other, and revoking one leaves the other',
  { fakes: nativeFake() },
  [
    ...pair({ conn: 'a', device: DEVICE, client: CLIENT, suffix: 'A' }),
    ...pair({ conn: 'b', device: DEVICE_B, client: CLIENT_B, suffix: 'B' }),
    sendJson('a', nativeBind()),
    sendJson('a', nativeSend()),
    expectFrames('a', 1),
    sendJson('b', nativeSend({ collapseKey: 'cb' })),
    expectFrames('b', 1, { label: 'b holds no binding' }),
    sendJson('b', nativeBind({ clientId: CLIENT_B })),
    sendJson('b', nativeSend({ collapseKey: 'cb2' })),
    expectFrames('b', 1),
    sendJson('a', { type: 'native-push-unbind', token: APNS_TOKEN }),
    sendJson('a', nativeSend({ collapseKey: 'ca2' })),
    expectFrames('a', 1),
    sendJson('b', nativeSend({ collapseKey: 'cb3' })),
    expectFrames('b', 1),
  ]
);

// ---- ICE credentials (ice-legs.test.mjs) -----------------------------------------------------------------------

const iceRequest = (n) => ({ type: 'ice-servers-request', requestId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });

scenario(
  'ice_unpaired_device_is_refused',
  'a desktop with no paired phone is refused not-paired with only the public STUN list and no credential; the relay advertises ice',
  { knobs: { turnEnv: TURN_ENV } },
  [
    wsOpen('d', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }),
    expectFrames('d', 2),
    sendJson('d', iceRequest(1)),
    expectFrames('d', 1),
    sendJson('d', iceRequest(2)),
    expectFrames('d', 1, { label: 'refusals are not rate limited' }),
  ]
);

scenario(
  'ice_request_id_that_is_not_a_routing_id_is_dropped',
  'a request whose id is not a routing id, or is absent, gets no answer and is never truncated or echoed',
  { knobs: { turnEnv: TURN_ENV } },
  [
    wsOpen('d', '/desktop', { role: 'desktop', basic: [DEVICE, SECRET], status: 101 }),
    expectFrames('d', 2),
    sendMany('d', [
      { type: 'ice-servers-request', requestId: 'X'.repeat(300) },
      { type: 'ice-servers-request', requestId: 'not a routing id' },
      { type: 'ice-servers-request', requestId: 5 },
      { type: 'ice-servers-request' },
      { type: 'list-clients', requestId: 'barrier' },
    ]),
    expectFrames('d', 1),
  ]
);

for (const [id, description, turnEnv] of [
  ['ice_without_turn_settings_advertises_nothing', 'a relay with no TURN settings advertises no ice and answers no request', {}],
  [
    'ice_with_an_unusable_secret_advertises_nothing',
    'a TURN secret shorter than the minimum disables issuance: no ice capability, no answer',
    { ...TURN_ENV, TURN_AUTH_SECRET: 'short' },
  ],
  [
    'ice_without_an_issue_limit_advertises_nothing',
    'TURN settings without the per-device issue limit disable issuance',
    (({ TURN_ISSUE_LIMIT: _limit, ...rest }) => rest)(TURN_ENV),
  ],
]) {
  scenario(id, description, { knobs: { turnEnv } }, [
    ...pair(),
    sendJson('d', iceRequest(1)),
    sendJson('d', { type: 'list-clients', requestId: 'barrier' }),
    expectFrames('d', 1),
  ]);
}

// ---- write -----------------------------------------------------------------------------------------------------

mkdirSync(HERE, { recursive: true });
const seen = new Set();
for (const entry of scenarios) {
  if (seen.has(entry.id)) throw new Error(`duplicate scenario ${entry.id}`);
  seen.add(entry.id);
  const out = { id: entry.id, description: entry.description };
  if (entry.knobs) out.knobs = entry.knobs;
  if (entry.files) out.files = entry.files;
  if (entry.fakes) out.fakes = entry.fakes;
  if (entry.keys) out.keys = entry.keys;
  out.steps = entry.steps;
  writeFileSync(join(HERE, `${entry.id}.json`), `${JSON.stringify(out, null, 2)}\n`);
}
process.stdout.write(`${scenarios.length} scenarios written\n`);
