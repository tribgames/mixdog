#!/usr/bin/env node
// Writes the scenario files of the `legs` suite (tests/twin/scenarios/legs/<id>.json) and the ledger of
// nr-relay-twin-legs (tests/ledger/nr-relay-twin-legs.json). The scenarios are data: this script only spells the long
// strings (frames of 64 KiB and more, the pre-masked bytes of a half-sent frame, a pre-registered device store) so the
// files are reproducible. Run it with `node generate.mjs` from any directory; it writes beside itself and into the
// ledger directory two levels up. Nothing here starts a relay.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, '..', '..', '..', 'ledger', 'nr-relay-twin-legs.json');
const MASK = [0x37, 0xfa, 0x21, 0x3d];
const sha = (text) => createHash('sha256').update(text).digest('hex');

// ---- fixtures ----

const SECRET = '0123456789abcdef';
const DEVICE = '7c1f3a52-9b0e-4d6a-8e21-3f4c5d6e7a80';
const DEVICE_2 = '2e9d4b17-6a3c-4f58-9c04-b1d7e8a35f62';
const DEVICE_WIDE_TOKEN = '0123456789abcdef0123456789abcdef';
const token = (name) => sha(`twin-legs-token-${name}`);
// Placed before the relay starts; the relay never reads the clock of these two numbers (more than 400 days old).
const OLD = 1_700_000_000_000;

const clientRow = (name) => ({ tokenHash: sha(token(name)), createdAt: OLD, lastSeenAt: OLD });
const deviceRow = (clients, deviceWideToken = '') => ({
  secretHash: sha(SECRET),
  clientTokenHash: deviceWideToken ? sha(deviceWideToken) : '',
  clients,
});
const store = (devices) => ({ data: { 'devices.json': JSON.stringify(devices, null, 2) } });
const oneDevice = (...names) => store({ [DEVICE]: deviceRow(Object.fromEntries(names.map((n) => [n, clientRow(n)]))) });

// ---- step builders ----

const ORIGIN = ['Origin', '${origin}'];
const open = (conn, path, role, extra = {}) => ({ do: 'ws_open', conn, path, role, ...extra });
const desktop = (conn = 'd', device = DEVICE) => open(conn, '/desktop', 'desktop', { basic: [device, SECRET] });
const phone = (conn, name) => open(conn, `/ws?token=${token(name)}`, 'phone', { headers: [ORIGIN] });
const expect = (conn, frames, extra = {}) => ({ do: 'expect', conn, frames, ...extra });
const text = (conn, value) => ({ do: 'send', conn, frame: { kind: 'text', text: value } });
const binary = (conn, value) => ({ do: 'send', conn, frame: { kind: 'binary', data: value } });
const raw = (conn, bytes) => ({ do: 'send', conn, frame: { kind: 'raw', data: { base64: Buffer.from(bytes).toString('base64') } } });
const frame = (conn, spec) => ({ do: 'send', conn, frame: spec });
const wait = (ms) => ({ do: 'wait', ms });
const closeWith = (conn, code = 1000) => frame(conn, { kind: 'close', code });
const capture = (variable, path = 'clientId', index) => ({ var: variable, from: 'frame_json', path, ...(index === undefined ? {} : { index }) });
const json = (value) => JSON.stringify(value);

/** A desktop opens: the capabilities frame and the Web Push subscriptions the relay answers with. */
const desktopUp = (conn = 'd', device = DEVICE) => [desktop(conn, device), expect(conn, 2)];
/** A phone joins and the desktop reads the client-open that announces it, naming the relay's id for it. */
const phoneJoins = (conn, name, variable, desktopConn = 'd') => [
  phone(conn, name),
  expect(desktopConn, 1, { capture: [capture(variable)] }),
];
/** The desktop declares what its receiver takes; the relay answers with the capabilities it enforces. */
const lanes = (conn, declaration) => [text(conn, json({ type: 'desktop-lanes', media: false, ...declaration })), expect(conn, 1)];
/** A phone leaves in order, so the lines the relay prints for it come in a fixed order. */
const phoneLeaves = (conn, desktopConn = 'd', code = 1000) => [
  closeWith(conn, code),
  expect(conn, 0, { close: true }),
  expect(desktopConn, 1),
  wait(60),
];
/** A desktop frame to one phone: the JSON routing envelope. */
const toPhone = (conn, variable, data) => text(conn, `{"type":"frame","clientId":"\${${variable}}","data":${json(data)}}`);
/** The binary routing envelope for a phone: magic, flags, id length, id, payload (ASCII, so the transcript shows it). */
const envelope = (variable, payload, flags = 0) => `MXR\u0001${String.fromCharCode(flags)}$\${${variable}}${payload}`;

const maskedBody = (length, from = 0, byte = 0x61) => Array.from({ length }, (_, i) => byte ^ MASK[(i + from) % 4]);
const maskedHeader = (length, opcode = 1, fin = true) => {
  const first = (fin ? 0x80 : 0) | opcode;
  if (length < 126) return [first, 0x80 | length, ...MASK];
  if (length <= 0xffff) return [first, 0x80 | 126, length >> 8, length & 255, ...MASK];
  const eight = Array.from({ length: 8 }, (_, i) => Number((BigInt(length) >> BigInt(8 * (7 - i))) & 0xffn));
  return [first, 0x80 | 127, ...eight, ...MASK];
};

// ---- the scenarios ----

const scenarios = new Map();
const scenario = (id, description, extra, steps) => scenarios.set(id, { id, description, ...extra, steps: steps.flat(Infinity) });

scenario(
  'capabilities_and_republication',
  'relay-capabilities answers a new desktop leg and is published again only when a declaration moves the numbers',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    text('d', json({ type: 'desktop-lanes', media: false, maxPayloadBytes: 131072 })),
    expect('d', 1),
    // The same declaration again changes nothing, so nothing is published: the next frame is the answer to this request.
    text('d', json({ type: 'desktop-lanes', media: false, maxPayloadBytes: 131072 })),
    text('d', json({ type: 'list-clients', requestId: 'r1' })),
    expect('d', 1),
    // A text-envelope declaration is acknowledged on this connection.
    text('d', json({ type: 'desktop-lanes', media: false, maxPayloadBytes: 131072, textFrames: 1 })),
    expect('d', 1),
    // An unusable capacity is normalised, never carried.
    text('d', json({ type: 'desktop-lanes', media: false, maxPayloadBytes: -4, textFrames: 0 })),
    expect('d', 1),
  ]
);

scenario(
  'text_envelope_acknowledged_per_connection',
  'a leg that declares nothing is told so by silence and its text is held to the JSON worst case; a leg that declares the text envelope is acknowledged on its own connection',
  { knobs: { maxFrameBytes: 1048576, uplinkCapacityBytes: 4400 }, files: store({
    [DEVICE]: deviceRow({ bbbbbbbb: clientRow('bbbbbbbb') }),
    [DEVICE_2]: deviceRow({ bbbbbbbb: clientRow('declared') }),
  }) },
  [
    desktopUp('undeclared', DEVICE),
    // Nothing declared: one capabilities frame (no acknowledgement) and nothing more to read.
    phoneJoins('pl', 'bbbbbbbb', 'cl', 'undeclared'),
    text('pl', 't'.repeat(3050)),
    expect('pl', 1),
    text('pl', '{"ping":1}'),
    expect('pl', 1),
    desktopUp('declared', DEVICE_2),
    text('declared', json({ type: 'desktop-lanes', media: false, textFrames: 1, maxPayloadBytes: 4400 })),
    expect('declared', 1),
    phone('pm', 'declared'),
    expect('declared', 1, { capture: [capture('cm')] }),
    text('pm', 't'.repeat(3050)),
    expect('declared', 1),
    text('pm', 't'.repeat(4400)),
    expect('pm', 1),
    text('pm', '{"ping":1}'),
    expect('pm', 1),
    phoneLeaves('pm', 'declared'),
    phoneLeaves('pl', 'undeclared'),
  ]
);

scenario(
  'routing_both_ways_and_ping_answered_locally',
  'text and binary routed phone to desktop and desktop to phone, broadcasts, unknown ids ignored, and a ping answered by the relay itself',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    // Phone to desktop: text rides the JSON envelope, binary the binary one.
    text('p', 'hello from the phone'),
    binary('p', 'bin-from-phone'),
    expect('d', 2),
    // Desktop to phone, both forms, and a frame for an id nobody holds.
    toPhone('d', 'cid', 'hello from the desktop'),
    text('d', '{"type":"frame","clientId":"00000000-0000-4000-8000-0000000000aa","data":"nobody"}'),
    binary('d', envelope('cid', 'bin-from-desktop')),
    binary('d', envelope('cid', 'bin-droppable', 1)),
    text('d', json({ type: 'broadcast', data: 'to everyone' })),
    text('d', json({ type: 'broadcast', critical: true, data: 'snapshot' })),
    expect('p', 5),
    // Malformed frames of known types are ignored like unknown ones.
    text('d', '{"type":"frame","clientId":"x","data":5}'),
    text('d', 'not json'),
    text('d', '{"type":"mystery"}'),
    // A ping is answered at the relay: text, then a protocol ping.
    text('p', '{"ping":1}'),
    text('p', '{"ping":2,"extra":"field"}'),
    frame('p', { kind: 'ping', data: 'pp' }),
    expect('p', 2),
    text('p', 'after the ping'),
    expect('d', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'rejected_phone_is_closed_with_4004',
  'the desktop closes one phone with a reason: the phone gets 4004 and the reason, and nothing more is routed for it',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    text('d', `{"type":"close-client","clientId":"\${cid}","reason":"not trusted here"}`),
    expect('p', 0, { close: true, close_code: 4004 }),
    expect('d', 1),
    wait(60),
  ]
);

scenario(
  'desktop_redial_keeps_phones_and_replays_client_open',
  'the phone socket survives its desktop leg: it is told desktop-gone once, the replacement leg gets client-open again for the same id, and the challenge it sends re-arms the phone',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp('d1'),
    phoneJoins('p', 'bbbbbbbb', 'cid', 'd1'),
    toPhone('d1', 'cid', '{"challenge":"one"}'),
    expect('p', 1),
    closeWith('d1'),
    expect('d1', 0, { close: true }),
    // Parked: told once that the PC is gone, and still answered locally.
    expect('p', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    // The replacement leg: capabilities, subscriptions, then the replay of the phone it must serve.
    desktop('d2'),
    expect('d2', 3),
    toPhone('d2', 'cid', '{"challenge":"two"}'),
    expect('p', 1),
    text('p', '{"hello":2}'),
    expect('d2', 1),
    toPhone('d2', 'cid', '{"ready":2}'),
    expect('p', 1),
    phoneLeaves('p', 'd2'),
  ]
);

scenario(
  'desktop_replaced_by_a_second_leg',
  'a second desktop leg for the same device supersedes the first with 4000; the phone is not told the PC is gone',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp('d1'),
    phoneJoins('p', 'bbbbbbbb', 'cid', 'd1'),
    desktop('d2'),
    expect('d2', 3),
    expect('d1', 0, { close: true, close_code: 4000 }),
    // The phone heard nothing about the first leg leaving.
    text('p', '{"ping":1}'),
    expect('p', 1),
    text('p', 'to the new leg'),
    expect('d2', 1),
    phoneLeaves('p', 'd2'),
  ]
);

scenario(
  'parked_phone_notices_are_throttled',
  'with the desktop leg gone a phone is told once when it closes and then at most once a second while its calls go nowhere; ping stays answered',
  { files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    closeWith('d'),
    expect('d', 0, { close: true }),
    expect('p', 1),
    // Inside the second: no notice.
    text('p', 'x'),
    binary('p', 'y'),
    text('p', '{"ping":1}'),
    expect('p', 1),
    frame('p', { kind: 'ping' }),
    wait(1150),
    // A second later the next call is told again, once.
    text('p', 'z'),
    expect('p', 1),
    text('p', 'w'),
    text('p', '{"ping":2}'),
    expect('p', 1),
    closeWith('p'),
    expect('p', 0, { close: true }),
  ]
);

scenario(
  'handshake_turn_missed_closes_the_desktop_leg_with_4010',
  'a desktop leg silent through the challenge turn and the probe is closed 4010 and the phone keeps its socket; the replacement answers the handshake and keeps its leg',
  {
    knobs: { handshakeStallMs: 400, livenessProbeMs: 400 },
    files: oneDevice('bbbbbbbb'),
  },
  [
    desktopUp('d1'),
    phoneJoins('p', 'bbbbbbbb', 'cid', 'd1'),
    // d1 reads nothing and says nothing: the relay waits the turn, pings, waits the probe, closes the leg.
    wait(1500),
    expect('d1', 0, { close: true, close_code: 4010 }),
    expect('p', 1),
    desktop('d2'),
    expect('d2', 3),
    toPhone('d2', 'cid', '{"challenge":"c"}'),
    expect('p', 1),
    text('p', '{"hello":1}'),
    expect('d2', 1),
    toPhone('d2', 'cid', '{"ready":1}'),
    expect('p', 1),
    wait(1500),
    // An answered handshake leaves the leg alone: it still answers.
    text('d2', json({ type: 'list-clients', requestId: 'alive' })),
    expect('d2', 1),
    phoneLeaves('p', 'd2'),
  ]
);

scenario(
  'handshake_hello_unanswered_closes_the_desktop_leg',
  'the clock for the ready turn starts at the hello: a desktop that sent the challenge and never answers the hello is cut 4010, the phone is not',
  {
    knobs: { handshakeStallMs: 400, livenessProbeMs: 400 },
    files: oneDevice('bbbbbbbb'),
  },
  [
    desktopUp('d'),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    toPhone('d', 'cid', '{"challenge":"d"}'),
    expect('p', 1),
    wait(150),
    text('p', '{"hello":2}'),
    expect('d', 1),
    wait(1500),
    expect('d', 0, { close: true, close_code: 4010 }),
    expect('p', 1),
    closeWith('p'),
    expect('p', 0, { close: true }),
  ]
);

scenario(
  'slow_but_live_desktop_keeps_its_shared_leg',
  'a desktop that misses the challenge turn but answers the probe is a live PC: its leg is left up',
  {
    knobs: { handshakeStallMs: 400, livenessProbeMs: 800 },
    files: oneDevice('bbbbbbbb'),
  },
  [
    desktopUp('d'),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    // The relay pings this leg at 400 ms; reading answers the ping and the request is heard inside the probe window.
    wait(600),
    text('d', json({ type: 'list-clients', requestId: 'slow' })),
    expect('d', 1),
    wait(1200),
    text('d', json({ type: 'list-clients', requestId: 'still' })),
    expect('d', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'phone_upgrade_without_a_desktop_or_a_credential',
  'a device-wide or unknown token closes 4005 (rescan); a real credential with the desktop offline closes 4002 (retry); neither is a refused upgrade',
  { files: store({ [DEVICE]: deviceRow({ bbbbbbbb: clientRow('bbbbbbbb') }, DEVICE_WIDE_TOKEN) }) },
  [
    open('device_wide', `/ws?token=${DEVICE_WIDE_TOKEN}`, 'phone', { headers: [ORIGIN] }),
    expect('device_wide', 0, { close: true, close_code: 4005 }),
    open('unknown', `/ws?token=${'f'.repeat(64)}`, 'phone', { headers: [ORIGIN] }),
    expect('unknown', 0, { close: true, close_code: 4005 }),
    open('none', '/ws', 'phone', { headers: [ORIGIN] }),
    expect('none', 0, { close: true, close_code: 4005 }),
    phone('offline', 'bbbbbbbb'),
    expect('offline', 0, { close: true, close_code: 4002 }),
    open('foreign', `/ws?token=${token('bbbbbbbb')}`, 'phone', { headers: [['Origin', 'http://evil.example']] }),
  ]
);

scenario(
  'pc_offline_answers_are_rate_limited',
  'the PC-offline answer is charged to the per-device connect limit: 120 are answered 4002 and the next is refused 429',
  { files: oneDevice('bbbbbbbb') },
  [
    Array.from({ length: 120 }, (_, i) => [
      phone(`o${i}`, 'bbbbbbbb'),
      expect(`o${i}`, 0, { close: true, close_code: 4002 }),
    ]),
    { ...phone('over', 'bbbbbbbb'), expect_status: 429 },
  ].flat()
);

scenario(
  'pc_offline_closing_sockets_are_bounded',
  'peers that never acknowledge the PC-offline close hold a slot each up to the per-device phone capacity; past it the upgrade is refused 429',
  { files: oneDevice('bbbbbbbb') },
  [
    Array.from({ length: 32 }, (_, i) => ({ ...phone(`s${i}`, 'bbbbbbbb'), expect_status: 101 })),
    { ...phone('over', 'bbbbbbbb'), expect_status: 429 },
  ].flat()
);

scenario(
  'malformed_frame_on_a_closing_socket_frees_its_slot',
  'a peer that answers the relay close with an unmasked frame is cut at once and gives its PC-offline slot back; the relay keeps serving',
  { files: oneDevice('bbbbbbbb') },
  [
    Array.from({ length: 32 }, (_, i) => [phone(`m${i}`, 'bbbbbbbb'), raw(`m${i}`, [0x81, 0x01, 0x41])]).flat(),
    open('unpaired', `/ws?token=${'f'.repeat(32)}`, 'phone', { headers: [ORIGIN] }),
    raw('unpaired', [0x81, 0x01, 0x41]),
    wait(300),
    { do: 'http', path: '/readyz' },
    { ...phone('again', 'bbbbbbbb'), expect_status: 101 },
    expect('again', 0, { close: true, close_code: 4002 }),
  ]
);

// -- oversize and framing --

const quotes = (n) => '"'.repeat(n);

scenario(
  'oversize_phone_frame_is_a_payload_error_not_a_close',
  'a phone frame past the ceiling is answered with the refusal riding the resync key, once, in both wire forms; the leg survives and the next frame is delivered',
  { knobs: { maxFrameBytes: 1024 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    text('p', json({ big: 'x'.repeat(4096) })),
    expect('p', 1),
    frame('p', { kind: 'oversize', op: 'binary', declared: 2000, send: 2000 }),
    expect('p', 1),
    text('p', json({ small: 1 })),
    expect('d', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'oversize_desktop_frame_is_answered_on_that_leg_and_names_the_client',
  'an oversize frame from the desktop is answered on its own leg naming the client, text and binary, and nothing reaches the phone',
  { knobs: { maxFrameBytes: 4096 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    toPhone('d', 'cid', 'y'.repeat(8192)),
    expect('d', 1),
    binary('d', envelope('cid', 'y'.repeat(8192))),
    expect('d', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

const decoy = '5d1b8f40-27c3-4e96-a0b2-93f1c7d6e854';
const pad = (n) => 'p'.repeat(n);
const attributionFrames = [
  // envelope field first: the top-level id routes and is named
  (c) => `{"type":"frame","clientId":"${c}","data":"{\\"clientId\\":\\"aaaaaaaa\\"}${'y'.repeat(8192)}"}`,
  // payload first, the id behind it
  (c) => `{"type":"frame","data":"{\\"clientId\\":\\"aaaaaaaa\\"}${'y'.repeat(8192)}","clientId":"${c}"}`,
  // two top-level keys: the last one routes
  (c) => `{"type":"frame","clientId":"${decoy}","clientId":"${c}","data":"${'y'.repeat(8192)}"}`,
  ...[0, 600, 4096, 65536].map(
    (n) => (c) => `{"type":"frame","clientId":"${decoy}","pad":"${pad(n)}","clientId":"${c}","data":"${'y'.repeat(8192)}"}`
  ),
  (c) => `{"type":"frame","data":"${'y'.repeat(262144)}","clientId":"${c}"}`,
  // a last key the router cannot use names nobody
  (c) => `{"type":"frame","clientId":"${c}","clientId":42,"data":"${'y'.repeat(8192)}"}`,
  // escapes JSON does not define reject the whole frame
  (c) => `{"type":"frame","pad":"\\q","clientId":"${c}","data":"${'y'.repeat(8192)}"}`,
  (c) => `{"type":"frame","pad":"\\u01","clientId":"${c}","data":"${'y'.repeat(8192)}"}`,
  // a legal escape is walked through
  (c) => `{"type":"frame","pad":"\\u0041\\n\\"","clientId":"${c}","data":"${'y'.repeat(8192)}"}`,
  // not one whole object
  (c) => `{"type":"frame","clientId":"${c}","data":"${'y'.repeat(8192)}`,
];
scenario(
  'oversize_notice_names_only_the_client_the_router_would_use',
  'the refusal names the client the JSON router itself would have delivered to, whatever the key order, padding or escapes, and names nobody when the frame routes nowhere',
  { knobs: { maxFrameBytes: 4096 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    attributionFrames.flatMap((make, index) => [text('d', make('${cid}')), expect('d', 1)]),
    // The same envelope, small enough to deliver, routes to that very client.
    text('d', `{"type":"frame","clientId":"${decoy}","clientId":"\${cid}","data":"ok"}`),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'oversize_refused_while_still_arriving_once',
  'a message the transport can never carry is refused from its declared size while it is still arriving, once, before the transport closes the leg with 1009',
  {
    knobs: { maxFrameBytes: 65536, maxPayloadBytes: 262144, ingressWindowBytes: 8192 },
    files: oneDevice('bbbbbbbb'),
  },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    ...lanes('d', { maxPayloadBytes: 1048576 }),
    // 4 MiB declared, the first 64 KiB sent.
    frame('p', { kind: 'oversize', op: 'text', declared: 4 * 1024 * 1024, send: 65536 }),
    expect('p', 1, { close: true, close_code: 1009 }),
    expect('d', 1),
  ]
);

scenario(
  'frame_at_exactly_the_ceiling_is_forwarded_unwarned',
  'a frame of exactly the ceiling is forwarded and never refused; one byte over is refused once and nothing more is forwarded',
  { knobs: { maxFrameBytes: 65536 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    ...lanes('d', { maxPayloadBytes: 1048576 }),
    frame('p', { kind: 'oversize', op: 'text', declared: 65536, send: 65536 }),
    expect('d', 1),
    frame('p', { kind: 'oversize', op: 'text', declared: 65537, send: 65537 }),
    expect('p', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'control_frame_burst_pins_nothing',
  'a burst of protocol pings is answered with pongs in order and does not hold the leg back: the message sent after it is forwarded',
  {
    knobs: { ingressWindowBytes: 4096, ingressReservationBytes: 1048576, maxIngressBytes: 2097152 },
    files: oneDevice('bbbbbbbb'),
  },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    raw('p', Array.from({ length: 1000 }, () => [0x89, 0x80, ...MASK]).flat()),
    text('p', 'after-the-burst'),
    expect('d', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'message_that_cannot_be_enveloped_is_refused_not_delivered',
  'a message that fits the ceiling but not the desktop receiver once the routing envelope is added is refused with the limit that would have fitted; text is held to its JSON worst case',
  { knobs: { maxFrameBytes: 65536, uplinkCapacityBytes: 65536 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    frame('p', { kind: 'oversize', op: 'binary', declared: 32768, send: 32768 }),
    expect('d', 1),
    frame('p', { kind: 'oversize', op: 'binary', declared: 65536, send: 65536 }),
    expect('p', 1),
    text('p', quotes(48 * 1024)),
    expect('p', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

const oversizeJson = (c) => `{"type":"frame","clientId":"${c}","data":"${'y'.repeat(5000)}"}`;
const ordinaryJson = (c) => `{"type":"frame","clientId":"${c}","data":"ok"}`;
scenario(
  'coalesced_messages_are_refused_at_most_once_each',
  'two messages written together are handled each on its own: the oversize one is refused once at its own size, the ordinary one is delivered',
  { knobs: { maxFrameBytes: 4096 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    frame('d', {
      kind: 'coalesced',
      frames: [
        { kind: 'text', text: oversizeJson('${cid}') },
        { kind: 'text', text: ordinaryJson('${cid}') },
      ],
    }),
    expect('p', 1),
    expect('d', 1),
    wait(150),
    phoneLeaves('p'),
  ]
);

{
  const fragment = 200 * 1024;
  scenario(
    'fragmented_message_past_the_transport_is_refused_before_the_close',
    'a message split across frames that overruns the transport only on a later fragment is refused before the leg is closed 1009, naming nobody',
    { knobs: { maxFrameBytes: 65536, maxPayloadBytes: 262144 }, files: oneDevice('bbbbbbbb') },
    [
      desktopUp(),
      phoneJoins('p', 'bbbbbbbb', 'cid'),
      // The first fragment (a text frame without FIN) is within capacity: nothing to say yet. Its bytes name no client,
      // so the refusal that follows names nobody.
      raw('d', [...maskedHeader(fragment, 1, false), ...maskedBody(fragment)]),
      wait(250),
      raw('d', [...maskedHeader(fragment, 0, true), ...maskedBody(fragment)]),
      expect('d', 1, { close: true, close_code: 1009 }),
      expect('p', 1),
    ]
  );
}

scenario(
  'declared_frame_that_never_completes_is_not_a_message',
  'a frame that promises 5000 bytes and delivers 512 is not refused, and the leg stays up; completing it makes the message real and it is refused once at the size that arrived',
  { knobs: { maxFrameBytes: 4096 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    raw('p', [...maskedHeader(5000, 1, true), ...maskedBody(512)]),
    wait(400),
    raw('p', maskedBody(5000 - 512, 512)),
    expect('p', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'desktop_declared_capacity_binds_the_phone_path',
  'the phone ceiling is what the leg declared for this connection less the routing header, never configuration: a frame past it is refused with that number and a frame inside it crosses',
  { knobs: { maxFrameBytes: 131072, uplinkCapacityBytes: 131072 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    ...lanes('d', { maxPayloadBytes: 98304 }),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    frame('p', { kind: 'oversize', op: 'binary', declared: 98304, send: 98304 }),
    expect('p', 1),
    frame('p', { kind: 'oversize', op: 'binary', declared: 90112, send: 90112 }),
    expect('d', 1),
    phoneLeaves('p'),
  ]
);

{
  // The limit a refusal quotes belongs to the path: quotes and plain text of one size are told the same number, the
  // worst content at exactly that number crosses and one byte more does not.
  const limit = Math.floor((98304 - Buffer.byteLength(JSON.stringify({ type: 'frame', clientId: '00000000-0000-4000-8000-000000000000', data: '' }))) / 6);
  scenario(
    'refused_limit_is_a_stable_property_of_the_path',
    'a refusal quotes one number per wire form whatever the payload; the worst content at exactly that size crosses and one byte more is refused',
    { knobs: { maxFrameBytes: 1048576, uplinkCapacityBytes: 98304 }, files: oneDevice('bbbbbbbb') },
    [
      desktopUp(),
      ...lanes('d', { maxPayloadBytes: 98304 }),
      phoneJoins('p', 'bbbbbbbb', 'cid'),
      text('p', quotes(48 * 1024)),
      expect('p', 1),
      text('p', 'a'.repeat(48 * 1024)),
      expect('p', 1),
      text('p', quotes(limit)),
      expect('d', 1),
      text('p', 'a'.repeat(limit + 1)),
      expect('p', 1),
      text('p', '{"ping":1}'),
      expect('p', 1),
      phoneLeaves('p'),
    ]
  );
}

scenario(
  'text_frame_leg_carries_text_in_the_envelope_that_cannot_inflate',
  'a leg that declared the text envelope receives phone text inside the binary envelope, whole, and is held to the binary ceiling for text',
  { knobs: { maxFrameBytes: 1048576, uplinkCapacityBytes: 262144 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    ...lanes('d', { maxPayloadBytes: 262144, textFrames: 1 }),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    text('p', quotes(100 * 1024)),
    expect('d', 1),
    frame('p', { kind: 'oversize', op: 'text', declared: 262144, send: 262144 }),
    expect('p', 1),
    text('p', '{"ping":1}'),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'enveloped_uplink_measures_the_same_fragmented_or_whole',
  'a 5000-byte message crosses as the same bytes whether the phone sends it whole or in fragments, as text and as binary',
  { knobs: { maxFrameBytes: 1048576 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    ...lanes('d', { maxPayloadBytes: 131072 }),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    text('p', 'y'.repeat(5000)),
    expect('d', 1),
    frame('p', { kind: 'fragmented', op: 'text', parts: ['y'.repeat(2500), 'y'.repeat(2500)] }),
    expect('d', 1),
    binary('p', 'y'.repeat(5000)),
    expect('d', 1),
    frame('p', { kind: 'fragmented', op: 'binary', parts: ['y'.repeat(2500), 'y'.repeat(2500)] }),
    expect('d', 1),
    phoneLeaves('p'),
  ]
);

scenario(
  'redialed_leg_is_held_to_the_floor_until_it_declares',
  'no capacity outlives its connection: a redialed leg that has declared nothing is held to the floor, an honest declaration is believed at once, and an unrelated 1009 close is charged to nobody',
  {
    knobs: { maxFrameBytes: 1048576 },
    files: oneDevice('aa000001', 'aa000002'),
  },
  [
    desktopUp('d1'),
    ...lanes('d1', { maxPayloadBytes: 131072 }),
    phoneJoins('p1', 'aa000001', 'c1', 'd1'),
    phoneJoins('p2', 'aa000002', 'c2', 'd1'),
    frame('p1', { kind: 'oversize', op: 'binary', declared: 102400, send: 102400 }),
    expect('d1', 1),
    // This connection closes with 1009 for a reason of its own.
    closeWith('d1', 1009),
    expect('d1', 0, { close: true }),
    expect('p1', 1),
    expect('p2', 1),
    // The replacement declares nothing yet: held to the floor, whatever the last leg said.
    desktop('d2'),
    expect('d2', 4),
    frame('p1', { kind: 'oversize', op: 'binary', declared: 102400, send: 102400 }),
    expect('p1', 1),
    // An honest declaration is believed on the spot, for the phone beside it too.
    ...lanes('d2', { maxPayloadBytes: 131072 }),
    frame('p2', { kind: 'oversize', op: 'binary', declared: 102400, send: 102400 }),
    expect('d2', 1),
    frame('p1', { kind: 'oversize', op: 'binary', declared: 61440, send: 61440 }),
    expect('d2', 1),
    phoneLeaves('p1', 'd2'),
    phoneLeaves('p2', 'd2'),
  ]
);

scenario(
  'a_close_the_relay_cannot_attribute_accuses_no_client',
  'when the desktop leg closes 1009 after large frames from two phones, neither phone is accused and both are told only that the PC is gone',
  { knobs: { maxFrameBytes: 1048576 }, files: oneDevice('aa000001', 'aa000002') },
  [
    desktopUp(),
    ...lanes('d', { maxPayloadBytes: 131072 }),
    phoneJoins('p1', 'aa000001', 'c1'),
    phoneJoins('p2', 'aa000002', 'c2'),
    frame('p1', { kind: 'oversize', op: 'binary', declared: 71680, send: 71680 }),
    wait(150),
    frame('p2', { kind: 'oversize', op: 'binary', declared: 102400, send: 102400 }),
    expect('d', 2),
    closeWith('d', 1009),
    expect('d', 0, { close: true }),
    expect('p1', 1),
    expect('p2', 1),
    text('p1', '{"ping":1}'),
    text('p2', '{"ping":1}'),
    expect('p1', 1),
    expect('p2', 1),
    closeWith('p1'),
    expect('p1', 0, { close: true }),
    wait(60),
    closeWith('p2'),
    expect('p2', 0, { close: true }),
  ]
);

scenario(
  'nonsense_configured_capacity_is_normalised_and_published_equals_enforced',
  'a nonsense configured capacity is normalised where it enters; the published ceiling is the one enforced to the byte',
  { knobs: { maxFrameBytes: 1048576, uplinkCapacityBytes: 0 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    ...lanes('d', { maxPayloadBytes: 131072 }),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    frame('p', { kind: 'oversize', op: 'binary', declared: 131072 - 42, send: 131072 - 42 }),
    expect('d', 1),
    frame('p', { kind: 'oversize', op: 'binary', declared: 131072 - 41, send: 131072 - 41 }),
    expect('p', 1),
    phoneLeaves('p'),
  ]
);

{
  const phones = Array.from({ length: 32 }, (_, i) => `aa${i.toString(16).padStart(6, '0')}`);
  scenario(
    'critical_fan_out_defers_what_the_box_cannot_carry_and_closes_no_healthy_leg',
    'a critical broadcast that the box budget cannot carry for every leg reaches the first two legs and tells the others to resync; no healthy leg is closed',
    { knobs: { maxInflightBytes: 262144 }, files: oneDevice(...phones) },
    [
      desktopUp(),
      phones.flatMap((name, i) => [phone(`p${i}`, name)]),
      expect('d', 32),
      text('d', json({ type: 'broadcast', critical: true, data: 'x'.repeat(120 * 1024) })),
      phones.map((_, i) => expect(`p${i}`, 1)),
      wait(150),
      text('d', json({ type: 'list-clients', requestId: 'after' })),
      expect('d', 1),
      phones.flatMap((_, i) => [closeWith(`p${i}`), expect(`p${i}`, 0, { close: true }), wait(30)]),
    ]
  );
}

{
  const payload = 300_000;
  const phones = ['aa000001', 'aa000002'];
  scenario(
    'ingress_parked_leg_waits_and_loses_nothing',
    'with the whole receive pool held by a half-sent frame a second leg is parked, not cut and not dropped; when the first completes both messages arrive whole',
    {
      knobs: { maxIngressBytes: 262144, ingressReservationBytes: 262144, ingressWindowBytes: 16384 },
      files: oneDevice(...phones),
    },
    [
      desktopUp(),
      ...lanes('d', { maxPayloadBytes: 8 * 1024 * 1024 }),
      phoneJoins('stalled', phones[0], 'c1'),
      phoneJoins('parked', phones[1], 'c2'),
      raw('stalled', [...maskedHeader(payload, 1, true), ...maskedBody(32768)]),
      wait(200),
      frame('parked', { kind: 'oversize', op: 'text', declared: payload, send: payload }),
      wait(300),
      raw('stalled', maskedBody(payload - 32768, 32768)),
      expect('d', 2),
      text('stalled', '{"ping":1}'),
      text('parked', '{"ping":1}'),
      expect('stalled', 1),
      expect('parked', 1),
      phoneLeaves('stalled'),
      phoneLeaves('parked'),
    ]
  );
}

{
  const names = Array.from({ length: 4 }, (_, i) => `aa00000${i}`);
  scenario(
    'ingress_admission_bounds_the_box_not_the_leg_count',
    'legs that all push a supported frame at once are admitted by the box budget and every frame arrives whole',
    {
      knobs: { maxIngressBytes: 524288, ingressReservationBytes: 262144, ingressWindowBytes: 16384 },
      files: oneDevice(...names),
    },
    [
      desktopUp(),
      names.flatMap((name, i) => phoneJoins(`p${i}`, name, `c${i}`)),
      ...lanes('d', { maxPayloadBytes: 8 * 1024 * 1024 }),
      names.map((_, i) => [frame(`p${i}`, { kind: 'oversize', op: 'text', declared: 1048576 / 4, send: 1048576 / 4 }), wait(120)]),
      expect('d', 4),
      names.map((_, i) => [text(`p${i}`, '{"ping":1}'), expect(`p${i}`, 1)]),
      names.map((_, i) => phoneLeaves(`p${i}`)),
    ]
  );
}

scenario(
  'slow_silent_desktop_swept_then_offline_window_closes_phones',
  'a desktop leg that never answers its ping is terminated by the sweep and its phone is told; the phone, kept alive, is closed 4002 once the 45 s offline window passes',
  // The handshake watchdog is set far out so that the sweep, not the watchdog, is what ends the silent leg.
  { knobs: { handshakeStallMs: 3_600_000 }, files: oneDevice('bbbbbbbb') },
  [
    desktopUp(),
    phoneJoins('p', 'bbbbbbbb', 'cid'),
    // Unsolicited pongs keep the phone leg alive without reading anything; the desktop leg says nothing at all.
    Array.from({ length: 8 }, () => [wait(7000), frame('p', { kind: 'pong' })]),
    expect('d', 0, { close: true }),
    expect('p', 1, { close: true, close_code: 4002, timeout_ms: 20000 }),
  ]
);

// ---- the ledger ----

const covered = (scenarioId) => `twin::legs/${scenarioId}`;
const NODE = 'apps/relay/security.test.mjs';
const LEGS = 'apps/relay/lib/relay-legs.test.mjs';
const SWEEP = 'apps/relay/lib/relay-sweep.test.mjs';
const rows = [
  [NODE, 'phone /ws accepts only per-browser credentials; others close 4005', 'phone_upgrade_without_a_desktop_or_a_credential'],
  [NODE, 'phone websocket survives a desktop leg redial and is re-announced', 'desktop_redial_keeps_phones_and_replays_client_open'],
  [NODE, 'a desktop leg that misses a joining phone handshake turn is closed so the PC redials', 'handshake_turn_missed_closes_the_desktop_leg_with_4010'],
  [NODE, 'a desktop leg that misses a joining phone handshake turn is closed so the PC redials', 'handshake_hello_unanswered_closes_the_desktop_leg'],
  [NODE, 'a desktop leg that misses a joining phone handshake turn is closed so the PC redials', 'slow_but_live_desktop_keeps_its_shared_leg'],
  [NODE, 'PC-offline answers are rate-limited and their closing sockets are bounded', 'pc_offline_answers_are_rate_limited'],
  [NODE, 'PC-offline answers are rate-limited and their closing sockets are bounded', 'pc_offline_closing_sockets_are_bounded'],
  [NODE, 'a malformed frame on an answered-and-closing socket cannot crash the relay, and frees its slot', 'malformed_frame_on_a_closing_socket_frees_its_slot'],
  [NODE, 'an oversize frame is a payload error both phone kinds surface', 'oversize_phone_frame_is_a_payload_error_not_a_close'],
  [NODE, 'an oversize desktop frame is answered on that leg and names the client', 'oversize_desktop_frame_is_answered_on_that_leg_and_names_the_client'],
  [NODE, 'a frame past the ceiling is refused while it is still arriving, once', 'oversize_refused_while_still_arriving_once'],
  [NODE, 'a frame at exactly the ceiling is forwarded, never warned about', 'frame_at_exactly_the_ceiling_is_forwarded_unwarned'],
  [NODE, 'a nested clientId in the payload never attributes a refusal', 'oversize_notice_names_only_the_client_the_router_would_use'],
  [NODE, 'a refusal names the client the router itself would have used', 'oversize_notice_names_only_the_client_the_router_would_use'],
  [NODE, 'no padding length lets a decoy id outrank the id that routes', 'oversize_notice_names_only_the_client_the_router_would_use'],
  [NODE, 'a burst of control frames pins no ingress reservation', 'control_frame_burst_pins_nothing'],
  [NODE, 'a message that cannot be enveloped for the desktop is refused, not delivered', 'message_that_cannot_be_enveloped_is_refused_not_delivered'],
  [NODE, 'messages coalesced into one read are refused at most once each', 'coalesced_messages_are_refused_at_most_once_each'],
  [NODE, 'a fragmented message past transport capacity is refused before the close', 'fragmented_message_past_the_transport_is_refused_before_the_close'],
  [NODE, 'a declared frame that never completes is not described as a message', 'declared_frame_that_never_completes_is_not_a_message'],
  [NODE, 'a desktop leg is held to the capacity it declares, not to configuration', 'desktop_declared_capacity_binds_the_phone_path'],
  [NODE, 'the refused limit is a stable property of the path, and is honoured', 'refused_limit_is_a_stable_property_of_the_path'],
  [NODE, 'a declared text-frame leg carries text in the envelope that cannot inflate', 'text_frame_leg_carries_text_in_the_envelope_that_cannot_inflate'],
  [NODE, 'a claim is trusted on the connection that made it, and on no other', 'redialed_leg_is_held_to_the_floor_until_it_declares'],
  [NODE, 'the text envelope is acknowledged per connection, never inferred', 'text_envelope_acknowledged_per_connection'],
  [NODE, 'the text envelope is acknowledged per connection, never inferred', 'capabilities_and_republication'],
  [NODE, 'a close the relay cannot attribute accuses no client', 'a_close_the_relay_cannot_attribute_accuses_no_client'],
  [NODE, 'a critical fan-out defers what the box cannot carry and closes no healthy leg', 'critical_fan_out_defers_what_the_box_cannot_carry_and_closes_no_healthy_leg'],
  [NODE, 'ingress admission bounds arriving frames to the box, not to leg count', 'ingress_admission_bounds_the_box_not_the_leg_count'],
  [NODE, 'a leg parked for ingress admission waits instead of losing its frame', 'ingress_parked_leg_waits_and_loses_nothing'],
  [NODE, 'a redialed leg carries nothing it has not declared on that connection', 'redialed_leg_is_held_to_the_floor_until_it_declares'],
  [NODE, 'an unrelated 1009 leaves the next leg its full declared capacity', 'redialed_leg_is_held_to_the_floor_until_it_declares'],
  [NODE, 'one phone cannot shrink the path of the phone beside it', 'redialed_leg_is_held_to_the_floor_until_it_declares'],
  [NODE, 'a nonsense configured capacity is normalised once, and published equals enforced', 'nonsense_configured_capacity_is_normalised_and_published_equals_enforced'],
  [NODE, 'an enveloped uplink message measures the same fragmented or whole', 'enveloped_uplink_measures_the_same_fragmented_or_whole'],
  [LEGS, 'runClientLeg announces client-open and removes the socket on close', 'routing_both_ways_and_ping_answered_locally'],
  [LEGS, 'runDesktopLeg publishes capabilities and replays live phone ids', 'desktop_redial_keeps_phones_and_replays_client_open'],
  [LEGS, 'a phone the PC rejected never holds the PC to a handshake turn, even if it withholds its close', 'rejected_phone_is_closed_with_4004'],
  [LEGS, 'a missed handshake turn closes the PC leg only when the leg is also silent through a probe', 'handshake_turn_missed_closes_the_desktop_leg_with_4010'],
  [LEGS, 'parked phones are told once when the PC leg closes, then once a second per phone while calls go nowhere', 'parked_phone_notices_are_throttled'],
  [LEGS, 'a superseded PC leg closing does not tell phones the PC is gone', 'desktop_replaced_by_a_second_leg'],
  [SWEEP, 'a leg that never answers its ping is terminated on the next sweep', 'slow_silent_desktop_swept_then_offline_window_closes_phones'],
];
// Cases with no end-to-end shape (a queue pressed by a socket stand-in, or the arithmetic of a number): the Rust unit
// tests recorded by the tasks that port them are their cover, and the twin scenarios above exercise the same paths
// from the wire.
const unit = (file, title, rust) => ({ node: `${file}::${title}`, rust });
const unitRows = [
  unit(LEGS, 'isTransportFrame recognises MXT\\x01 in clear and nothing else', 'legs_core::a_transport_frame_is_recognised_by_its_magic_in_clear_and_nothing_else'),
  unit(LEGS, 'a transport frame marked droppable is still delivered to a phone past the push-skip mark', 'legs_core::a_transport_frame_marked_droppable_is_still_delivered_to_a_phone_past_the_push_skip_mark'),
  unit(LEGS, 'a full phone queue cuts the leg for a transport frame instead of silently dropping it', 'legs_core::a_full_phone_queue_cuts_the_leg_for_a_transport_frame_instead_of_silently_dropping_it'),
  unit(LEGS, 'a box that cannot carry a transport frame cuts the leg, never defers or drops it', 'legs_core::a_box_that_cannot_carry_a_transport_frame_cuts_the_leg_never_defers_or_drops_it'),
  unit(LEGS, 'legacy droppable frames keep dropping: skipped past 1 MiB, dropped at a full queue, with a resync hint', 'legs_core::legacy_droppable_frames_keep_dropping_skipped_past_1_mib_dropped_at_a_full_queue_with_a_resync_hint'),
  unit(LEGS, 'legacy non-droppable frames keep their behavior: delivered when queued, cut at a full queue', 'legs_core::legacy_non_droppable_frames_keep_their_behavior_delivered_when_queued_cut_at_a_full_queue'),
  unit(LEGS, 'legacy text frames and broadcasts keep their droppable behavior', 'legs_core::legacy_text_frames_and_broadcasts_keep_their_droppable_behavior'),
  unit(LEGS, 'downstream: transport frames reach a pressured phone in the order the PC sent them, flush by flush', 'legs_core::downstream_transport_frames_reach_a_pressured_phone_in_the_order_the_pc_sent_them_flush_by_flush'),
  unit(LEGS, 'upstream: transport frames reach the PC in the order the phone sent them, flush by flush', 'legs_core::upstream_transport_frames_reach_the_pc_in_the_order_the_phone_sent_them_flush_by_flush'),
  unit(LEGS, 'upstream: an exhausted queue cuts the phone leg after a contiguous prefix, never a silent loss', 'legs_core::upstream_an_exhausted_queue_cuts_the_phone_leg_after_a_contiguous_prefix_never_a_silent_loss'),
  unit(LEGS, 'client-open omits the credential when the leg has none (older desktops)', 'legs_core::client_open_omits_the_credential_when_the_leg_has_none_older_desktops'),
  unit(SWEEP, 'a leg draining a queue, or paused by backpressure, gets extra windows before it is cut', 'legs_phone::a_leg_draining_a_queue_or_paused_by_backpressure_gets_extra_windows_before_it_is_cut'),
  unit(SWEEP, 'answering a ping restores the full grace for the next stall', 'legs_phone::answering_a_ping_restores_the_full_grace_for_the_next_stall'),
  unit(NODE, 'the PC-offline close is its own code and never a pairing-revoking one', 'core_units::the_pc_offline_close_is_its_own_code_and_never_a_pairing_revoking_one'),
];
const ledger = [
  ...rows.map(([file, title, id]) => ({ node: `${file}::${title}`, rust: covered(id) })),
  ...unitRows,
];

const outDir = HERE;
mkdirSync(outDir, { recursive: true });
for (const [id, body] of scenarios) writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
mkdirSync(dirname(LEDGER), { recursive: true });
writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`${scenarios.size} scenarios, ${ledger.length} ledger rows`);
