#!/usr/bin/env node
// Genuine 1.4.5 push of a held request: Node's own `createPushNotifier(..).onHeldRequest` (the
// desktop service's notifier behind `registerHeldRequestNotifier`, held-request-host.mjs) driven
// with real paired phones, then read the way a phone reads it: the native envelope each phone is
// handed, decrypted with its own key (`decryptNativePush`). Cases cover the wording
// (`heldRequestPushText`: the 60-unit name clip, the "Mixy" default, no Markdown handling) and who
// hears it (device scope, event toggles, quiet hours, conversation overrides, foreground, the hold
// while this PC is in use, the notifier switched off, a request without a session or an id).
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-held-request-push.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/held-push/golden.json
import { createECDH } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every user directory points at a fresh temp dir before any Mixdog module loads.
const sandbox = mkdtempSync(join(tmpdir(), 'rec-held-push-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const { createPushNotifier, heldRequestPushText } = await importFrom(tree, 'apps/desktop/src/main/push-notifier.ts');
const { decryptNativePush } = await importFrom(tree, 'apps/desktop/src/shared/native-push-crypto.ts');
const { DEFAULT_NOTIFICATION_PREFERENCES } = await importFrom(tree, 'apps/desktop/src/shared/contract-notifications.ts');

// Quiet hours and mute ends read the wall clock; a fixed instant makes the cases repeatable.
const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const HOLD_MS = 25;
const settle = () => new Promise((resolve) => setTimeout(resolve, HOLD_MS * 6));
// A lone surrogate (a name cut inside an emoji) leaves a JS string as U+FFFD on every UTF-8 wire.
const wire = (text) => text.toWellFormed();

const HOME = 'sess_home_ann';
const held = (name, over = {}) => ({ sessionId: HOME, agentId: 'ann', agentName: name, requestId: 'held_1', ...over });
const phone = (clientId, preferences = {}, over = {}) => ({
  clientId,
  preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences },
  foreground: false,
  ...over,
});
const events = (patch) => ({ ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...patch });
const quiet = (patch) => ({ ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours, ...patch });
const mute = (kind, id) => ({ target: { kind, id }, setting: { mode: 'muted', until: null } });
const always = (kind, id) => ({ target: { kind, id }, setting: { mode: 'always' } });

const NAMES = [
  '',
  'ann',
  'Mixy',
  ' ',
  '민지',
  '한'.repeat(70),
  'x'.repeat(60),
  'x'.repeat(61),
  '😀'.repeat(40),
  `${'a'.repeat(59)}😀tail`,
  '**bold** _it_ `code` [l](http://x)',
  'two\nlines',
];

const CASES = [
  { name: 'one phone, default preferences', event: held('ann'), phones: [phone('phone-a')] },
  { name: 'no agent name says Mixy', event: held(''), phones: [phone('phone-a')] },
  { name: 'a long name is clipped to 60 units', event: held('x'.repeat(70)), phones: [phone('phone-a')] },
  { name: 'a name cut inside an emoji', event: held(`${'a'.repeat(59)}😀tail`), phones: [phone('phone-a')] },
  { name: 'Markdown in the name travels as it is', event: held('**ann** _x_ `y`'), phones: [phone('phone-a')] },
  { name: 'a device with scope off hears nothing', event: held('ann'), phones: [phone('phone-off', { scope: 'off' }), phone('phone-on')] },
  { name: 'the approval toggle is the event toggle', event: held('ann'), phones: [phone('phone-no', { events: events({ approval: false }) }), phone('phone-on')] },
  { name: 'a phone showing the home thread is not pushed', event: held('ann'), phones: [phone('phone-fg', {}, { foreground: true }), phone('phone-bg')] },
  { name: 'bots scope hears a bot home chat', event: held('ann'), phones: [phone('phone-bots', { scope: 'bots' })] },
  {
    name: 'bots scope does not hear a plain session; the run agent only names an override',
    event: held('ann', { sessionId: 'sess_plain' }),
    phones: [phone('phone-bots', { scope: 'bots' }), phone('phone-all')],
  },
  {
    name: 'the run agent is muted for a session that names no bot',
    event: held('ann', { sessionId: 'sess_plain' }),
    overrides: [mute('agent', 'ann')],
    phones: [phone('phone-a')],
  },
  {
    name: 'the home thread bot, not the event agent, is the conversation agent',
    event: held('ann', { agentId: 'bob' }),
    overrides: [mute('agent', 'ann')],
    phones: [phone('phone-a')],
  },
  {
    name: 'the event agent is not used where the session has a bot',
    event: held('ann', { agentId: 'bob' }),
    overrides: [mute('agent', 'bob')],
    phones: [phone('phone-a')],
  },
  { name: 'a muted session', event: held('ann'), overrides: [mute('session', HOME)], phones: [phone('phone-a')] },
  {
    name: 'an always override beats scope off',
    event: held('ann'),
    overrides: [always('session', HOME)],
    phones: [phone('phone-off', { scope: 'off' })],
  },
  {
    name: 'a known room session is a room conversation',
    event: held('ann', { sessionId: 'sess_in_room' }),
    session: { id: 'sess_in_room', agentRoom: { id: 'room1' } },
    phones: [phone('phone-bots', { scope: 'bots' })],
  },
  {
    name: 'a known room session honors a room mute',
    event: held('ann', { sessionId: 'sess_in_room' }),
    session: { id: 'sess_in_room', agentRoom: { id: 'room1' } },
    overrides: [mute('room', 'room1')],
    phones: [phone('phone-a')],
  },
  { name: 'quiet hours silence it', event: held('ann'), phones: [phone('phone-q', { quietHours: quiet({ enabled: true, start: '00:00', end: '00:00' }) })] },
  {
    name: 'quiet hours that allow waiting let it through',
    event: held('ann'),
    phones: [phone('phone-q', { quietHours: quiet({ enabled: true, start: '00:00', end: '00:00', allowWaiting: true }) })],
  },
  { name: 'this PC in use holds it, then it is sent', event: held('ann'), desktopActive: true, phones: [phone('phone-hold'), phone('phone-now', { holdWhileDesktopActive: false })] },
  { name: 'the notifier switched off', event: held('ann'), enabled: false, phones: [phone('phone-a')] },
  { name: 'no session id', event: held('ann', { sessionId: '' }), phones: [phone('phone-a')] },
  { name: 'no request id', event: held('ann', { requestId: '' }), phones: [phone('phone-a')] },
];

const run = async (c) => {
  const phones = c.phones.map((p) => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { ...p, ecdh };
  });
  const byToken = new Map(phones.map((p) => [`token-${p.clientId}`, p]));
  const sent = [];
  const diagnostics = [];
  const notifier = createPushNotifier({
    store: { keys: async () => null, list: async () => [], remove: async () => true, removeByClient: async () => true },
    hostId: 'host-1',
    isEnabled: () => c.enabled !== false,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    holdMs: HOLD_MS,
    native: {
      list: async () =>
        phones.map((p) => ({
          clientId: p.clientId,
          platform: 'fcm',
          token: `token-${p.clientId}`,
          publicKey: p.ecdh.getPublicKey().toString('base64url'),
          sandbox: false,
          createdAt: 1,
        })),
      isClientForeground: (clientId) => phones.find((p) => p.clientId === clientId).foreground,
      send: (message) => sent.push({ message, at: diagnostics.filter((d) => d.event === 'held').length }) > 0,
      removeByClient: async () => true,
    },
    preferences: {
      device: async (clientId) => phones.find((p) => p.clientId === clientId).preferences,
      overrides: async () => c.overrides ?? [],
      desktopActive: async () => c.desktopActive === true,
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, ...details }),
  });
  if (c.session) notifier.onSessions([c.session]);
  notifier.onHeldRequest(c.event);
  await settle();
  notifier.dispose();
  const heldDevices = new Set(diagnostics.filter((d) => d.event === 'held').map((d) => d.native));
  const deliveries = sent
    .map(({ message }) => {
      const p = byToken.get(message.token);
      const content = decryptNativePush(p.ecdh.getPrivateKey(), message.mx);
      return {
        deviceId: p.clientId,
        afterHold: heldDevices.has(p.clientId.slice(0, 8)),
        content: { ...content, title: wire(content.title), body: wire(content.body) },
        relay: { platform: message.platform, reason: message.reason, sandbox: message.sandbox, collapseKey: message.collapseKey },
      };
    })
    .sort((a, b) => Number(a.afterHold) - Number(b.afterHold) || a.deviceId.localeCompare(b.deviceId));
  return {
    name: c.name,
    now: NOW,
    event: c.event,
    session: c.session ?? null,
    overrides: c.overrides ?? [],
    desktopActive: c.desktopActive === true,
    enabled: c.enabled !== false,
    devices: phones.map((p) => ({ deviceId: p.clientId, preferences: p.preferences, foreground: p.foreground })),
    deliveries,
  };
};

const text = NAMES.map((agentName) => ({ agentName, text: wire(heldRequestPushText(agentName)) }));
const cases = [];
for (const c of CASES) cases.push(await run(c));

const finalOut = join(FIXTURES_ROOT, 'held-push');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'createPushNotifier.onHeldRequest over real paired phones: heldRequestPushText and the native push each phone decrypts',
  hostId: 'host-1',
  text,
  cases,
});
writeSetManifest(out, {
  set: 'held-push',
  recorder: 'benchmarks/rust-core/recorders/record-held-request-push.mjs',
  command: 'node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-held-request-push.mjs --tree <tree>',
  extra: { text: text.length, cases: cases.length },
});
commitStage(out, finalOut);
console.log(`text=${text.length} cases=${cases.length} deliveries=${cases.reduce((n, c) => n + c.deliveries.length, 0)}`);
