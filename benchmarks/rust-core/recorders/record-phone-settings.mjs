#!/usr/bin/env node
// What Node's host (b6f10295a) answers the paired phone for the settings, updater, notification and feedback calls (unit PH-2,
// list 1 unit B), recorded from an exact export: the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`,
// remote-methods.ts) with the real settings store over the real config module (`createDesktopOperations`, config.mjs), the real
// notification store and center (notification-preferences.ts, notification-center.ts) and the real relay push filter
// (`createRelayPushLanes`, remote-relay-push-lanes.ts). Per call the recording holds the params the phone sent, the frame the relay
// sent back, what the PC's window was asked to do, what each of three recipients received (the calling phone and a second paired
// phone: their relay frames; the desktop's window: what Node's DesktopStateBridge sent it) (the agent-settings and orchestration
// watches run on the forced change pass Node's in-process write starts, config.mjs notifyConfigChanged), the feedback the relay's
// endpoint received, and the whole state after it: `mixdog-config.json` and `notification-preferences.json`.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-settings.mjs --tree <git archive of b6f10295a with node_modules> [--only <group>]
//
// With `--replay <mixdogd.exe>` the same cases run through the phone's router and adapter (renderer/remote-protocol-settings.ts) on a
// phone paired behind a scripted relay with a built `mixdogd`, a stand-in PC window claiming the host role, and everything is compared
// with the recording, case by case: the frame, the window's requests, what the calling phone's page, a second phone's page (each
// under its own router and adapter) and the desktop's windows (its protocol connection, `watchAnnouncements` and the
// DesktopStateBridge) received, the feedback posts and the
// whole state (the core keeps the notification document as its config's `notifications` subtree, Node's file without `version`).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { startRelay } from './lib/phone-relay-core.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-settings');
const WORK = process.env.PHONE_SETTINGS_WORK ?? join('D:\\mixdog-build\\tmp', `${REPO_ROOT.split(/[\\/]/).pop()}-phone-settings`);
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
const RECORDER_FILES = ['record-phone-settings.mjs', 'lib/common.mjs', 'lib/phone-relay-core.mjs'].map((file) => `benchmarks/rust-core/recorders/${file}`);
const recorderFiles = () =>
  RECORDER_FILES.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

// ── the world, the same for both products ──
/** The paired phone that calls (its relay credential) and another paired device. */
const PHONE_ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
/** When the notification store was first written: the phone was paired after it, the browser before. */
const MIGRATED_AT = Date.UTC(2026, 0, 1);
const PAIRED = [
  { id: PHONE_ID, name: 'Pixel 9 · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: Date.UTC(2026, 1, 2), lastSeenAt: Date.UTC(2026, 1, 3), online: true },
  { id: OTHER_ID, name: 'Windows · Chrome', platform: 'Windows', browser: 'Chrome', createdAt: Date.UTC(2025, 11, 1), lastSeenAt: Date.UTC(2025, 11, 2), online: false },
];
const PC_NAME = 'Fixture PC';
/** `mixdog-config.json` before the first case: a control already on (the install marker is kept when it goes off), the one-time
 *  defaults separation done and the shipped roles greeted, so neither product's startup rewrites the file before the first case. */
const SEED_CONFIG = {
  defaultsVersion: 2,
  desktop: { computerControl: true, keepAwake: false, defaultsSeparationVersion: 1 },
  agent: { autoClear: { minContextPercent: 10 } },
  agents: { greeted: ['advisor', 'front-worker', 'heavy-worker', 'reviewer', 'security', 'worker', 'writer'] },
};
const SEED_NOTIFICATIONS = { version: 1, migratedAt: MIGRATED_AT, devices: {}, overrides: [] };
/** What the PC's window answers (Electron's updater, theme and notifications), for Node's window requests and the core's host requests. */
const WINDOW = {
  displayPreferences: { theme: '  dark  ', language: 'ko', extra: true },
  updaterState: { status: 'ready', version: '9.9.9' },
  check: { status: 'up-to-date' },
  install: (confirmed) => (confirmed ? { status: 'installing', version: '9.9.9' } : { status: 'ready', version: '9.9.9', busy: true }),
  notificationStatus: { supported: true, idleSeconds: null },
  notificationTest: { ok: true },
};
const FEEDBACK = { id: '0F1E2D3C-4B5A-4978-8695-a4b3c2d1e0f9', kind: 'bug', message: '  The toggle did not stick.  ', replyTo: ' user@example.com ' };
/** A PNG feedback attachment: the 8-byte signature and an IHDR start, 16 bytes in all (contract-feedback.ts requires 12). */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const BASE64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = BASE64(PNG_BYTES);
const ATTACHMENT = { name: 'screen.png', mimeType: 'image/png', data: PNG };
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** `data` with the base64 digit before its `pad` padding characters one higher: the bits padding drops are no longer zero. */
const DIRTY_PADDING = (data, pad) => {
  const at = data.length - pad - 1;
  return `${data.slice(0, at)}${ALPHABET[ALPHABET.indexOf(data[at]) + 1]}${data.slice(at + 1)}`;
};
/** 17 bytes: one padding character; 18 bytes: none. */
const PNG_17 = BASE64([...PNG_BYTES, 0]);
const PNG_18 = BASE64([...PNG_BYTES, 0, 0]);
const JPEG = BASE64([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = BASE64([...Buffer.from('RIFF'), 8, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]);
/** The PNG with its second signature byte changed ('P' to 'Q'), still canonical base64. */
const PNG_BAD_SIGNATURE = BASE64([PNG_BYTES[0], 0x51, ...PNG_BYTES.slice(2)]);
/** The relay's `/feedback` answer to each posted (lowercased) id; any other id is accepted with a receipt naming it. The branches
 *  of feedback-client.ts:18-40 after the post: 429, another status, a body that is not JSON, a receipt for another id or of
 *  another status, and a connection the relay drops (the fetch fails). */
const FEEDBACK_REPLIES = {
  '11111111-2222-4333-8444-555555555555': () => [429, { error: 'rate limited' }],
  '22222222-2222-4222-8222-222222222222': () => [500, { error: 'down' }],
  '33333333-3333-4333-8333-333333333333': () => [202, 'accepted, not JSON'],
  '44444444-4444-4444-8444-444444444444': () => [202, { id: '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9', status: 'accepted' }],
  '55555555-5555-4555-8555-555555555555': (posted) => [202, { id: posted.id, status: 'queued' }],
  '66666666-6666-4666-8666-666666666666': () => null,
};
const feedbackWith = (id, fields = {}) => ({ ...FEEDBACK, id, ...fields });
const LONG = (count, char = 'a') => char.repeat(count);

const FAR = Date.UTC(2100, 0, 1);
// Each refusal names the branch it takes (b6f10295a): ipc-validation.ts `requiredDesktopSettingKey` :2195-2217,
// `requiredNotificationDeviceId` :2245-2250, `requiredNotificationPreferencesPatch` :2252-2298 with `plainRecord` :743-746,
// `onlyKeys` :2233-2237 and `optionalBoolean` :2239-2243, `requiredNotificationTarget` :2300-2310,
// `requiredConversationNotificationSetting` :2312-2325, `requiredString` :656-661; remote-methods.ts `updateSetting` :1093-1094;
// contract-feedback.ts `normalizeDesktopFeedback` :38-66 and feedback-attachments.mjs `normalizeFeedbackAttachments` :56-87.
const GROUPS = {
  settings: [
    ['readSettings', []],
    ['updateSetting', ['keepAwake', true]],
    // Unchanged: Node announced `desktop` after every successful write (remote-methods.ts:1098).
    ['updateSetting', ['keepAwake', true]],
    ['updateSetting', ['usagePinned', false]],
    ['updateSetting', ['autoClear', false]],
    // Unchanged in the agent section: `desktop` only, the agent-settings watch sees no change.
    ['updateSetting', ['autoClear', false]],
    ['updateSetting', ['autoCompact', false]],
    ['updateSetting', ['computerControl', false]],
    // requiredDesktopSettingKey :2216, the keys of the desktop settings the app names that Node's relay refused to write.
    ['updateSetting', ['notificationVolume', true]],
    ['updateSetting', ['browserPermissions', true]],
    ['updateSetting', ['sessionAutoDeleteDays', true]],
    ['updateSetting', ['zoom', true]],
    // remote-methods.ts:1094, `enabled` not a boolean, checked before the key; null is the value the page left out.
    ['updateSetting', ['keepAwake', 'yes']],
    ['updateSetting', ['keepAwake', null]],
    ['updateSetting', ['zoom', 1]],
    ['readSettings', []],
  ],
  window: [
    ['readHostDisplayPreferences', []],
    ['getUpdaterState', []],
    ['checkForDesktopUpdate', []],
    ['showDesktopUpdate', [false]],
    ['showDesktopUpdate', [true]],
    ['showDesktopUpdate', [null]],
    // feedback-client.ts after the post: accepted, 429, another status, a body not JSON, another id, another status, no answer.
    ['submitFeedback', [FEEDBACK]],
    ['submitFeedback', [feedbackWith('11111111-2222-4333-8444-555555555555')]],
    ['submitFeedback', [feedbackWith('22222222-2222-4222-8222-222222222222')]],
    ['submitFeedback', [feedbackWith('33333333-3333-4333-8333-333333333333')]],
    ['submitFeedback', [feedbackWith('44444444-4444-4444-8444-444444444444')]],
    ['submitFeedback', [feedbackWith('55555555-5555-4555-8555-555555555555')]],
    ['submitFeedback', [feedbackWith('66666666-6666-4666-8666-666666666666')]],
    ['submitFeedback', [feedbackWith('77777777-7777-4777-8777-777777777777', { attachments: [ATTACHMENT] })]],
    // normalizeDesktopFeedback :47 the other two kinds, :65 an empty attachment list (no `attachments` field posted), unknown
    // fields of the feedback and of an attachment dropped; normalizeFeedbackAttachments :40-41 one padding character and none,
    // :34-35 a JPEG and a WebP signature.
    ['submitFeedback', [feedbackWith('88888888-8888-4888-8888-888888888881', { kind: 'suggestion', attachments: [] })]],
    ['submitFeedback', [feedbackWith('88888888-8888-4888-8888-888888888882', { kind: 'other', extra: 1 })]],
    [
      'submitFeedback',
      [
        feedbackWith('88888888-8888-4888-8888-888888888883', {
          attachments: [
            { ...ATTACHMENT, name: 'one.png', data: PNG_17, extra: 1 },
            { ...ATTACHMENT, name: 'two.png', data: PNG_18 },
            { name: 'photo.jpg', mimeType: 'image/jpeg', data: JPEG },
          ],
        }),
      ],
    ],
    ['submitFeedback', [feedbackWith('88888888-8888-4888-8888-888888888884', { attachments: [{ name: 'shot.webp', mimeType: 'image/webp', data: WEBP }] })]],
    // normalizeDesktopFeedback :39-41 not an object; :43-52 id, kind, message; :53-55 replyTo not a string; :57-59 replyTo.
    ['submitFeedback', [null]],
    ['submitFeedback', [[FEEDBACK]]],
    ['submitFeedback', ['feedback']],
    ['submitFeedback', [feedbackWith(7)]],
    ['submitFeedback', [feedbackWith('not-a-uuid')]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { kind: 'praise' })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { message: 5 })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { message: '   ' })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { message: ` ${LONG(8_001)} ` })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { replyTo: null })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { replyTo: '   ' })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { replyTo: `${LONG(250)}@a.io` })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { replyTo: 'user at example.com' })]],
    // normalizeFeedbackAttachments :58 not an array, :59 more than three, :63 an entry not an object, :65 a field not a string,
    // :66 a type not allowed, :67-75 the name (empty, over 100, untrimmed, leading or trailing dot, unsafe character), :76 not
    // canonical base64, :79 under 12 bytes, :82 no image signature.
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: ATTACHMENT })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [ATTACHMENT, ATTACHMENT, ATTACHMENT, ATTACHMENT] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [null] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: 5 }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, mimeType: 'image/gif' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: '' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: `${LONG(97)}.png` }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: ' screen.png' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: '.screen.png' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: 'screen.' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: 'a/b.png' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: `${PNG}=` }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: PNG.slice(0, 12) }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, mimeType: 'image/jpeg' }] })]],
    // :63 an entry that is a string or an array; :65 a name or type not a string; :41 empty data, a character outside the
    // alphabet at a valid length, padding bits not zero after `==` (Ug== as Uh==) and after `=`; :82 the PNG sent as WebP, and
    // its signature corrupted in canonical base64.
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: ['screen.png'] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [[ATTACHMENT]] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, name: 5 }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, mimeType: null }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: '' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: `*${PNG.slice(1)}` }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: DIRTY_PADDING(PNG, 2) }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: DIRTY_PADDING(PNG_17, 1) }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, mimeType: 'image/webp' }] })]],
    ['submitFeedback', [feedbackWith(FEEDBACK.id, { attachments: [{ ...ATTACHMENT, data: PNG_BAD_SIGNATURE }] })]],
    // requiredString :657 not a string, :659 blank and over 128 after the trim; 128 exactly is taken.
    ['notifyProviderModelsChanged', [' 7c9e6679-7425-40de-944b-e07fc1f90ae7 ']],
    ['notifyProviderModelsChanged', [` ${LONG(128, 'o')} `]],
    ['notifyProviderModelsChanged', [null]],
    ['notifyProviderModelsChanged', [42]],
    ['notifyProviderModelsChanged', ['   ']],
    ['notifyProviderModelsChanged', [LONG(129, 'o')]],
  ],
  notifications: [
    ['getNotificationPreferences', []],
    ['setNotificationPreferences', [PHONE_ID, { scope: 'all' }]],
    // Unchanged: Node's store wrote it and announced `notifications` (notification-preferences.ts:236-242).
    ['setNotificationPreferences', [PHONE_ID, { scope: 'all' }]],
    ['setNotificationPreferences', ['pc', { quietHours: { enabled: true, start: '22:30' } }]],
    ['setNotificationPreferences', [OTHER_ID, { events: { finished: false }, taskbarFlash: true }]],
    // notification-center.ts setPreferences: the device is not paired.
    ['setNotificationPreferences', ['someone-else', { scope: 'off' }]],
    // requiredNotificationDeviceId :2246: not a string, outside the pattern, over 80; checked before the patch.
    ['setNotificationPreferences', [5, { scope: 'off' }]],
    ['setNotificationPreferences', ['a b', { scope: 'off' }]],
    ['setNotificationPreferences', [LONG(81), null]],
    // requiredNotificationPreferencesPatch: :2253 not an object; :2254 an unsupported field; :2257 scope; :2262 events not an
    // object, :2263 an unsupported event, :2266 an event not a boolean; :2271 quiet hours not an object, :2272 an unsupported
    // field, :2275 enabled and allowWaiting not booleans, :2280 start and end not HH:MM, :2286 days; :2291 the other booleans.
    ['setNotificationPreferences', [PHONE_ID, null]],
    ['setNotificationPreferences', [PHONE_ID, ['scope']]],
    ['setNotificationPreferences', [PHONE_ID, 'off']],
    ['setNotificationPreferences', [PHONE_ID, { volume: 3 }]],
    ['setNotificationPreferences', [PHONE_ID, { scope: 'some' }]],
    ['setNotificationPreferences', [PHONE_ID, { events: true }]],
    ['setNotificationPreferences', [PHONE_ID, { events: { finished: true, typing: true } }]],
    ['setNotificationPreferences', [PHONE_ID, { events: { error: 'yes' } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: [] }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { timezone: 'UTC' } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { enabled: 1 } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { allowWaiting: 'no' } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { start: '24:00' } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { end: 700 } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { end: '7:00' } }]],
    ['setNotificationPreferences', [PHONE_ID, { quietHours: { days: 'mondays' } }]],
    ['setNotificationPreferences', [PHONE_ID, { automaticRuns: 'on' }]],
    ['setNotificationPreferences', [PHONE_ID, { holdWhileDesktopActive: null }]],
    ['setNotificationPreferences', [PHONE_ID, { taskbarFlash: 0 }]],
    ['listConversationNotifications', []],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: FAR }]],
    ['setConversationNotification', [{ kind: 'agent', id: 'a1' }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'room', id: 'r1' }, { mode: 'muted', until: null }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'inherit' }]],
    // Unchanged: `inherit` for a conversation with no override still wrote and announced (notification-preferences.ts:318-329).
    ['setConversationNotification', [{ kind: 'session', id: 'never-set' }, { mode: 'inherit' }]],
    // requiredNotificationTarget :2301 not an object, :2302 an unsupported field, :2304 kind, :2307 id (not a string, outside
    // the pattern, over 200).
    ['setConversationNotification', [null, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1', name: 'x' }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'thread', id: 's1' }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'session', id: 7 }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'session', id: 's 1' }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'session', id: LONG(201) }, { mode: 'always' }]],
    // requiredConversationNotificationSetting :2313 not an object, :2315 inherit/always with another field, :2318 mode,
    // :2319 muted with another field, :2321 until missing, zero, fractional, a string.
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, 'always']],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'always', until: null }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'loud' }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: FAR, reason: 'x' }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted' }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: 0 }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: 1.5 }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: 'tomorrow' }]],
    ['listConversationNotifications', []],
    ['sendTestNotification', ['pc']],
    ['sendTestNotification', ['someone-else']],
    ['sendTestNotification', [null]],
    ['sendTestNotification', ['a b']],
    ['getNotificationPreferences', []],
  ],
};
if (ONLY !== null && !GROUPS[ONLY]) throw new Error(`--only takes one of ${Object.keys(GROUPS).join(', ')}, not ${ONLY}`);
const groups = ONLY ? [ONLY] : Object.keys(GROUPS);

/** The relay's feedback endpoint: what it received, in order, and the scripted answers. */
function feedbackEndpoint() {
  const posts = [];
  const handle = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const posted = JSON.parse(body);
      posts.push({ method: req.method, path: req.url, contentType: req.headers['content-type'] ?? null, body: posted });
      const reply = (FEEDBACK_REPLIES[posted.id] ?? ((value) => [202, { id: value.id, status: 'accepted' }]))(posted);
      if (!reply) return req.socket.destroy();
      res.writeHead(reply[0], { 'Content-Type': 'application/json' });
      res.end(typeof reply[1] === 'string' ? reply[1] : JSON.stringify(reply[1]));
    });
  };
  return { posts, handle };
}

/** The desktop's window as Node's `DesktopStateBridge` (ipc-state-bridge.ts) fed it: what its webContents was sent, in order. The
 *  host's desktop events come from `subscribe`; nothing else of the host is used by the cases. */
function bridgedWindow(DesktopStateBridge, subscribe) {
  const sent = [];
  const bridge = new DesktopStateBridge({
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, value) => sent.push([channel, clone(value)]) } },
    host: { getSnapshot: () => null, subscribe: () => () => {}, subscribeSessionStates: () => () => {}, subscribeDesktopEvents: subscribe },
    ipcMain: { on() {}, removeListener() {} },
    handle: () => {},
  });
  return { sent, dispose: () => bridge.dispose?.() };
}

/** What each of the three received: the caller (phone A), the other paired phone (B) and the desktop's window. */
const RECIPIENTS = ['caller', 'otherPhone', 'desktop'];

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

if (REPLAY) process.exit(await replay(REPLAY));

// ── Node's host ──
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
rmSync(WORK, { recursive: true, force: true });
const DATA = join(WORK, 'data');
const USER_DATA = join(WORK, 'userdata');
for (const dir of [DATA, USER_DATA, join(WORK, 'home')]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, { MIXDOG_HOME: join(WORK, 'home'), MIXDOG_DATA_DIR: DATA });
writeFileSync(join(DATA, 'mixdog-config.json'), JSON.stringify(SEED_CONFIG, null, 2));
const NOTIFICATION_FILE = join(USER_DATA, 'notification-preferences.json');
writeFileSync(NOTIFICATION_FILE, JSON.stringify(SEED_NOTIFICATIONS, null, 2));
const endpoint = feedbackEndpoint();
const server = createServer(endpoint.handle);
// A bind either succeeds or emits `error` at once; the error fails the recording.
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve();
  });
});
// The relay's address: the feedback client posts to its `/feedback` (remote-relay-device.ts resolveRelayUrl).
process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
const { createRemoteMethods, executeRemoteFrame } = await main('remote-methods');
const { createDesktopOperations } = await main('desktop-operations');
const { createNotificationPreferencesStore } = await main('notification-preferences');
const { createNotificationCenter } = await main('notification-center');
const { createRelayPushLanes } = await main('remote-relay-push-lanes');
const { watchAgentSettings } = await main('agent-settings-watch');
const { watchConfiguredOrchestrationMode } = await main('orchestration-mode-watch');

// Every in-process config write starts one forced change pass (config.mjs notifyConfigChanged, a trailing 100 ms debounce): the
// watches below hear it after the call answered. The pass is run here once the call settled, for every call that wrote.
let configWrites = 0;
const passListeners = new Set();
const configModule = {
  readConfig: config.readConfig,
  secretChangeTokens: config.secretChangeTokens,
  updateConfigAsync: (updater) => {
    configWrites += 1;
    return config.updateConfigAsync(updater);
  },
  subscribeConfigChange: (listener) => {
    passListeners.add(listener);
    return () => passListeners.delete(listener);
  },
};
// The desktop event bus (desktop-service.ts createDesktopEventBus): every event reaches the relay's push lanes, whose filter decides
// what each paired phone receives.
const busListeners = new Set();
const publish = (name, value) => {
  for (const listener of busListeners) listener({ name, value });
};
const subscribeBus = (listener) => {
  busListeners.add(listener);
  return () => busListeners.delete(listener);
};
// Two paired phones with their channels up: the caller and another one. Node's broadcast sends a frame to every client with a
// channel that `include` admits (remote-relay-delivery.ts:177-187).
const relayClients = new Map([
  ['caller', { channel: true, lanes: new Set() }],
  ['otherPhone', { channel: true, lanes: new Set() }],
]);
const phoneFrames = { caller: [], otherPhone: [] };
const lanes = createRelayPushLanes({
  clients: relayClients,
  broadcastEncrypted: (payload, _droppable, include) => {
    for (const [id, state] of relayClients) if (state.channel && (!include || include(state))) phoneFrames[id].push(clone(payload));
  },
  subscribeDesktopEvents: subscribeBus,
});
const { DesktopStateBridge } = await main('ipc-state-bridge');
const desktopWindow = bridgedWindow(DesktopStateBridge, subscribeBus);
watchAgentSettings(configModule, publish);
watchConfiguredOrchestrationMode(configModule, publish);
const operations = createDesktopOperations({
  userDataPath: USER_DATA,
  packaged: false,
  resourcesPath: '',
  appPath: join(tree, 'apps', 'desktop'),
  loadConfig: async () => configModule,
  emit: ({ name, value }) => publish(name, value),
});
const store = createNotificationPreferencesStore({
  filePath: NOTIFICATION_FILE,
  readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
  onChange: () => publish('settings-changed', { scope: 'notifications' }),
});
await store.ready();
// What the PC's window was asked to do (reads of its state are not requests to act).
const hostCalls = [];
const windowRequest = async (method, requestArgs) => {
  if (method === 'updaterState') return WINDOW.updaterState;
  if (method === 'displayPreferences') return WINDOW.displayPreferences;
  if (method === 'updaterCheck') {
    hostCalls.push({ method, args: clone(requestArgs) });
    return WINDOW.check;
  }
  if (method === 'updaterInstall') {
    hostCalls.push({ method, args: clone(requestArgs) });
    return WINDOW.install(requestArgs[0] === true);
  }
  throw new Error(`the window is not scripted for ${method}`);
};
const center = createNotificationCenter({
  store,
  pcName: () => PC_NAME,
  listClients: async () => clone(PAIRED),
  pushRegistrations: async () => new Set(),
  pcSupported: async () => WINDOW.notificationStatus.supported,
  sendPcTest: async () => {
    hostCalls.push({ method: 'notificationTest', args: [] });
    return WINDOW.notificationTest;
  },
  sendDeviceTest: async () => {
    throw new Error('no case tests a paired device');
  },
});
const host = {
  invokeDesktopOperation: (name, operationArgs) =>
    center.handles(name) ? center.invoke(name, operationArgs) : operations.invoke(name, operationArgs),
};
const methods = createRemoteMethods(
  {
    host,
    userDataPath: USER_DATA,
    settingsStore: operations.settingsStore,
    onDesktopSettingsChanged: () => undefined,
    hostRequest: windowRequest,
  },
  { credentialId: () => PHONE_ID, connectionId: () => 'relay-connection-1' }
);

const cases = [];
let frameId = 0;
for (const group of groups) {
  for (const [name, params] of GROUPS[group]) {
    hostCalls.length = 0;
    phoneFrames.caller.length = 0;
    phoneFrames.otherPhone.length = 0;
    desktopWindow.sent.length = 0;
    endpoint.posts.length = 0;
    const writes = configWrites;
    const { id: _id, ...frame } = clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: name, params })));
    if (configWrites !== writes) for (const listener of [...passListeners]) listener();
    cases.push({
      group,
      name,
      params: clone(params),
      frame,
      hostCalls: clone(hostCalls),
      received: { caller: clone(phoneFrames.caller), otherPhone: clone(phoneFrames.otherPhone), desktop: clone(desktopWindow.sent) },
      feedback: clone(endpoint.posts),
      state: { config: readJson(join(DATA, 'mixdog-config.json')), notifications: readJson(NOTIFICATION_FILE) },
    });
  }
}
lanes.dispose();
desktopWindow.dispose();
await operations.dispose?.();
server.close();

if (ONLY) {
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const stage = stageSet(FIXTURES);
writeJson(join(stage, 'golden.json'), {
  note: 'Node host (b6f10295a) answers to a paired phone for the settings, updater, notification and feedback calls: per call the relay frame, what the PC window was asked to do, what each recipient received (the calling phone and another paired phone: their relay frames; the desktop window: what DesktopStateBridge sent its webContents), the posts the relay feedback endpoint received, and mixdog-config.json and notification-preferences.json after it.',
  world: { phone: PHONE_ID, paired: PAIRED, pcName: PC_NAME, seedConfig: SEED_CONFIG, seedNotifications: SEED_NOTIFICATIONS, window: { ...WINDOW, install: [WINDOW.install(false), WINDOW.install(true)] } },
  cases,
});
writeSetManifest(stage, {
  set: 'phone-settings',
  recorder: 'benchmarks/rust-core/recorders/record-phone-settings.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-settings.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    node: process.version,
    cases: cases.length,
    recorderFiles: recorderFiles(),
    entry: {
      runs: 'executeRemoteFrame over createRemoteMethods (remote-methods.ts:828, :1256) with the settings store of createDesktopOperations over config.mjs, the notification store and center, and createRelayPushLanes for what each paired phone received',
      notRun:
        "the relay transport (encryption, admission), the window process (its answers are the WINDOW script), config.mjs's own debounce timer and file watch (the forced pass an in-process write starts is run when the call settled), and a paired device's push channel",
    },
    syntheticInput: {
      window: 'Electron answers (updater, theme, OS notifications), the same script answers the core replay through host requests',
      feedback: 'the relay /feedback endpoint answers by posted id (FEEDBACK_REPLIES: 429, 500, a body not JSON, a receipt for another id or status, a dropped connection); any other id is accepted with a receipt naming it',
      recipients: 'caller and otherPhone are two relay clients with their channels up behind createRelayPushLanes (Node broadcast to every channel include admits, remote-relay-delivery.ts:177-187); desktop is b6f10295a DesktopStateBridge over the same desktop event bus, its webContents.send recorded',
    },
    notRecorded: {
      coreRelayWriteRefusal:
        "A phone's config write outside Node's relay methods (remote.enabled, browser site permissions, cookie auto-import, retention, volume, initializeIfMissing, and an `announce` other than `desktop` after an updateSetting key) cannot be made through Node's relay: requiredDesktopSettingKey refuses every key outside its list before anything is written, and those cases are recorded above. The core's own refusal of such a write from a relay connection is the core test mixdog-core-config config::service::tests::a_relay_write_outside_nodes_relay_methods_changes_nothing.",
      notProducible:
        'feedback attachments over 2 MiB or 6 MiB in all, and a sparse attachment array, cannot reach the PC: the relay frame limit (maxFrameBytes 1 MiB) and JSON (no holes) stop them first; Feedback service is unavailable. (no relay URL) cannot happen to a phone that reached the PC through the relay',
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`phone-settings: ${cases.length} cases`);
process.exit(0);

// ── the replay: the phone's router and adapter over a built core ──
async function replay(exe) {
  // The client's method table is this tree's `@mixdog/protocol`, whatever a shared node_modules links that name to.
  const ownProtocol = pathToFileURL(join(REPO_ROOT, 'packages', 'protocol', 'src', 'index.ts')).href;
  register(
    `data:text/javascript,${encodeURIComponent(
      `export const resolve = (specifier, context, next) => specifier === '@mixdog/protocol' ? { url: ${JSON.stringify(ownProtocol)}, shortCircuit: true } : next(specifier, context);`
    )}`
  );
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  if (!isDeepStrictEqual(manifest.recorderFiles, recorderFiles())) throw new Error('the recording was made by another recorder than this one: record again before comparing');
  const coreRoot = join(WORK, 'core');
  rmSync(WORK, { recursive: true, force: true });
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(coreRoot, dir), { recursive: true });
  const { notifications: seedNotifications } = { notifications: SEED_NOTIFICATIONS };
  const { version: _version, ...seedDoc } = seedNotifications;
  writeFileSync(join(coreRoot, 'data', 'mixdog-config.json'), JSON.stringify({ ...SEED_CONFIG, notifications: seedDoc }, null, 2));
  writeFileSync(join(coreRoot, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  const endpoint = feedbackEndpoint();
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: clone(PAIRED), capabilities: { textFrames: 1, maxFrameBytes: 1048576 }, http: endpoint.handle });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(coreRoot, 'runtime'),
    MIXDOG_DATA_DIR: join(coreRoot, 'data'),
    MIXDOG_HOME: join(coreRoot, 'home'),
    MIXDOG_CONFIG_DIR: join(coreRoot, 'config'),
    MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
  });
  const runtimeManifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(runtimeManifest)) writeFileSync(runtimeManifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const clients = [];
  try {
    const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
    const endpointOf = await discovered(child, join(coreRoot, 'runtime'), parseDiscovery, () => stderr);
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const base = {
      target: { id: 'core' },
      connector: createWsConnector(async () => endpointOf),
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      // The client sleeps only on its reconnect ladder; the replay never drops a connection, so a drop fails it instead.
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    };
    // The PC's window: claims the host role and answers the updater and notification requests from the WINDOW script.
    const hostCalls = [];
    const window = await connect({
      ...base,
      clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
      capabilities: {
        optOutNotificationMethods: [],
        experimentalApi: false,
        host: { browser: false, visualize: false, notifications: true, systemProxy: false, power: false, media: false, updater: true, files: false },
      },
    });
    clients.push(window);
    window.on((event) => {
      if (event.type === 'notification' && event.notification?.method === 'host/notification/show') {
        const shown = event.notification.params ?? {};
        hostCalls.push(shown.title === 'Mixdog' && shown.body === 'Notifications from Mixdog appear like this.' ? { method: 'notificationTest', args: [] } : { method: 'host/notification/show', args: [clone(shown)] });
        return;
      }
      if (event.type !== 'serverRequest') return;
      const { id, method, params } = event.request;
      if (method === 'host/notification/status') return window.respond(id, { result: WINDOW.notificationStatus });
      if (method === 'host/update/command' && params?.action === 'check') {
        hostCalls.push({ method: 'updaterCheck', args: [] });
        return window.respond(id, { result: WINDOW.check });
      }
      if (method === 'host/update/command' && params?.action === 'install') {
        hostCalls.push({ method: 'updaterInstall', args: [params.confirmed === true] });
        return window.respond(id, { result: WINDOW.install(params.confirmed === true) });
      }
      window.respond(id, { error: { code: -32601, message: `${method} is not scripted` } });
    });
    await window.call('host/claim', { hostId: 'replay-window' });
    await window.call('host/state/set', { key: 'displayPreferences', value: WINDOW.displayPreferences });
    window.notify('host/update/report', { state: WINDOW.updaterState });
    await window.call('remoteAccess/setName', { name: PC_NAME });

    // The desktop: this process's protocol connection over the window's client, the core's announcements turned into its desktop
    // events (desktop-connection.ts wires `watchAnnouncements` the same way) and its windows fed by the DesktopStateBridge.
    const { createProtocolConnection } = await here('apps/desktop/src/main/protocol/connection.ts');
    const { watchAnnouncements } = await here('apps/desktop/src/main/protocol/desktop-operation-route.ts');
    const { DesktopStateBridge } = await here('apps/desktop/src/main/ipc-state-bridge.ts');
    const desktopProtocol = createProtocolConnection({ open: async () => window });
    const desktopEvents = new Set();
    watchAnnouncements(desktopProtocol, (name, value) => {
      for (const listener of [...desktopEvents]) listener({ name, value });
    });
    const desktopWindow = bridgedWindow(DesktopStateBridge, (listener) => (desktopEvents.add(listener), () => desktopEvents.delete(listener)));
    await desktopProtocol.start();

    await relay.leg();
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(coreRoot, 'data', 'relay-e2ee.json'), 'utf8')));
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-settings.ts');
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    /** A paired phone's page: its client over the relay, the settings adapter under the router, and what its listeners heard (as
     *  the relay frames Node sent it). */
    const openPage = async (clientId, credential) => {
      const phone = await connect({ ...base, connector: await relay.openPhone(clientId, credential, pairing) });
      clients.push(phone);
      // The page holds the app feed's sections (the phone shim subscribes on start); the snapshot is folded before the adapter
      // wires, so only changes after it are events.
      const snapshot = new Promise((resolve) => {
        const off = phone.store.subscribe((change) => {
          if (change.type !== 'appSnapshot') return;
          off();
          resolve();
        });
      });
      await phone.subscribeApp();
      await snapshot;
      const heard = [];
      const listening = (event) => new Set([(payload) => heard.push(clone({ event, payload }))]);
      const ctx = {
        browserId: credential,
        fanOut: (listeners, value) => {
          for (const listener of listeners) listener(value);
        },
        settingsChangedListeners: listening('settings-changed'),
        updaterListeners: listening('updater-state-changed'),
        providerModelsListeners: listening('provider-models-changed'),
        phone: { start: async () => phone },
      };
      const host = { ctx, client: () => phone, declareLane() {}, onClient: (listener) => (listener(phone), () => undefined) };
      const router = createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
      router.install();
      return { phone, heard, router };
    };
    const caller = await openPage('client-settings', PHONE_ID);
    const otherPhone = await openPage('client-other', OTHER_ID);
    const router = caller.router;
    // The state the core settled on: its config file, with the notification document as Node's file held it.
    const configFile = join(coreRoot, 'data', 'mixdog-config.json');
    const coreState = () => {
      const { notifications, ...rest } = readJson(configFile) ?? {};
      return { config: rest, notifications: notifications === undefined ? null : { version: 1, ...notifications } };
    };
    // The end of a case at each recipient: the window publishes a mark into `hostState` after the call answered; the app feed is
    // one ordered stream, so a client holding the mark has been given everything the core published for the case before it. The
    // mark is no event of any recipient (neither adapter nor the desktop turns `hostState.browserTabs` into one).
    let marks = 0;
    const holdsMark = (client, mark) => isDeepStrictEqual(client.store.section('hostState', 'browserTabs')?.value, { replayMark: mark });
    const untilMarked = (client, mark, label) =>
      new Promise((resolve, reject) => {
        if (holdsMark(client, mark)) return resolve();
        const timer = setTimeout(() => {
          off();
          reject(new Error(`${label}: the end-of-case mark ${mark} did not reach the client within 30 s`));
        }, 30_000);
        const off = client.store.subscribe(() => {
          if (!holdsMark(client, mark)) return;
          clearTimeout(timer);
          off();
          resolve();
        });
      });
    const caseEnd = async (label) => {
      const mark = ++marks;
      await window.call('host/state/set', { key: 'browserTabs', value: { replayMark: mark } });
      await Promise.all([caller.phone, otherPhone.phone, window].map((client) => untilMarked(client, mark, label)));
    };

    const wanted = golden.cases.filter((entry) => groups.includes(entry.group));
    const differences = [];
    for (const [index, expected] of wanted.entries()) {
      hostCalls.length = 0;
      caller.heard.length = 0;
      otherPhone.heard.length = 0;
      desktopWindow.sent.length = 0;
      endpoint.posts.length = 0;
      let frame;
      try {
        frame = { ok: true, value: clone(await router.call(expected.name, clone(expected.params))) };
      } catch (error) {
        frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
      }
      const label = `#${index} ${expected.name} ${JSON.stringify(expected.params).slice(0, 80)}`;
      await caseEnd(label);
      const received = { caller: clone(caller.heard), otherPhone: clone(otherPhone.heard), desktop: clone(desktopWindow.sent) };
      const got = { frame, hostCalls: clone(hostCalls), feedback: clone(endpoint.posts), state: coreState() };
      const node = { frame: expected.frame, hostCalls: expected.hostCalls, feedback: expected.feedback, state: expected.state };
      for (const recipient of RECIPIENTS) {
        got[`received.${recipient}`] = received[recipient];
        node[`received.${recipient}`] = expected.received[recipient];
      }
      for (const field of Object.keys(node)) {
        if (!isDeepStrictEqual(node[field], got[field])) differences.push({ label, field, node: node[field], core: got[field] });
      }
    }
    console.log(`phone-settings replay over ${exe}: ${wanted.length} cases compared, ${differences.length} differ`);
    for (const entry of differences) {
      console.log(`DIFF ${entry.label} ${entry.field}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 600)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 600)}`);
    }
    return differences.length ? 1 : 0;
  } finally {
    for (const client of clients) client.close?.();
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    relay.close();
  }
}

/** The core is up when it has written its discovery file: the watch wakes the wait on the directory's change or the child's exit. */
async function discovered(child, dir, parseDiscovery, stderr) {
  const file = join(dir, 'daemon.json');
  let stirred = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  const watcher = watch(dir, stir);
  child.once('exit', stir);
  const deadline = setTimeout(stir, 120_000);
  const started = Date.now();
  try {
    for (;;) {
      stirred = false;
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr()}`);
      if (Date.now() - started > 120_000) throw new Error('mixdogd did not write its discovery file within 120 s');
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        if (!stirred) await new Promise((resolve) => (wake = resolve));
      }
    }
  } finally {
    clearTimeout(deadline);
    watcher.close();
  }
}
