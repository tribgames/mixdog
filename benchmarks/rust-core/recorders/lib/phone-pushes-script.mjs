// The inputs of the phone-pushes recording (record-phone-pushes.mjs, Node b6f10295a) and of its replays against the core
// (apps/desktop/src/renderer/remote-protocol-pushes.slow.test.mjs): the relay's declared capabilities, the paired phones, the pins each
// client writes, the native push registrations and the desktop notices raised and cleared. Both sides play the same steps; only the
// product under them differs.

/** The one clock reading either product takes (a native push row's `createdAt`). */
export const FIXED_NOW_MS = 1_760_000_000_000;

/** What the relay declares to the PC's leg: with native push (the relay holds FCM credentials) and without. */
export const RELAY_NATIVE = { textFrames: 1, maxFrameBytes: 1_048_576, nativePush: 1, nativePushPlatforms: ['fcm'] };
export const RELAY_PLAIN = { textFrames: 1, maxFrameBytes: 1_048_576 };

/** The paired phones: their relay credentials (Node's `credentialId`, the core's device credential). */
export const PHONES = {
  a: '0123456789abcdef0123456789abcdef',
  b: 'fedcba9876543210fedcba9876543210',
  c: '00112233445566778899aabbccddeeff',
};

/** A phone app's P-256 public key (shared/native-push-crypto.ts NATIVE_PUSH_TEST_VECTOR.devicePublicKey). */
const PUBLIC_KEY = 'BA3gsNuflWc_YtOOjL4UlR6XsAjDlhnotjRhlhX8bD2uYLd8QaH-VWyEfF8_Q92IyBYFsmuaJEWaMF0OYB5m71o';
const FCM_A = 'fcm-token-of-phone-a:0123456789abcdefghij';
const FCM_B = 'fcm-token-of-phone-b:0123456789abcdefghij';
const APNS_A = 'cd'.repeat(32);

/** Pins: phones a and b connected from the start, c joins later; `desktop` is the PC's own window. */
export const PINS_STEPS = [
  { by: 'a', op: 'read' },
  { by: 'desktop', op: 'update', pins: ['projects', 'sessions', 'projects'] },
  { by: 'a', op: 'read' },
  { by: 'a', op: 'update', pins: ['workflows', 'projects'] },
  { by: 'b', op: 'update', pins: ['search', 'sessions'] },
  { by: 'c', op: 'connect' },
  { by: 'desktop', op: 'update', pins: ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'] },
  { by: 'a', op: 'update', pins: ['browser'] },
  { by: 'c', op: 'read' },
];

/** Native push registration on a relay that delivers FCM only. */
export const NATIVE_STEPS = [
  { by: 'a', op: 'register', input: { platform: 'fcm', token: FCM_A, publicKey: PUBLIC_KEY } },
  { by: 'a', op: 'register', input: { platform: 'apns', token: APNS_A, publicKey: PUBLIC_KEY, sandbox: true } },
  { by: 'b', op: 'register', input: { platform: 'fcm', token: FCM_B, publicKey: PUBLIC_KEY } },
  { by: 'a', op: 'remove', token: FCM_A },
  { by: 'a', op: 'remove', token: FCM_A },
  { by: 'b', op: 'remove' },
];

/** A notification's Allow / Deny (`answerApprovalNotification`): each case is one session waiting on one approval, the hook request
 *  its caller put to the session's queue (a gate's request; `ask_user`'s for the question). Each step answers the approval the session
 *  shows (`stale`: an id it does not show) with `allow` or `deny`. */
export const APPROVAL_CASES = [
  {
    name: 'shell',
    input: { name: 'shell', kind: 'approval', args: { command: 'npm test' }, cwd: '/ws', reason: 'run the tests' },
    steps: [{ action: 'allow', stale: true }, { action: 'deny', stale: true }, { action: 'allow' }, { action: 'allow' }, { action: 'deny' }],
  },
  { name: 'office-commit', input: { name: 'office', kind: 'approval', args: { action: 'Commit', path: 'a.docx' }, reason: 'save' }, steps: [{ action: 'allow' }, { action: 'deny' }] },
  { name: 'office-rollback', input: { name: 'Office', kind: 'approval', args: { action: 'rollback' }, reason: 'undo' }, steps: [{ action: 'allow' }, { action: 'deny' }] },
  {
    name: 'outbound-send',
    input: { name: 'mail', kind: 'outbound', args: {}, outbound: { category: 'send', target: 'a@example.com', details: { to: 'a@example.com', subject: 'hi' } }, reason: 'send' },
    steps: [{ action: 'allow' }],
  },
  {
    name: 'outbound-payment',
    input: { name: 'pay', kind: 'outbound', args: {}, outbound: { category: 'payment', target: 'shop', details: { amount: '10', currency: 'USD' } }, reason: 'buy' },
    steps: [{ action: 'allow' }, { action: 'deny' }],
  },
  {
    name: 'outbound-delete',
    input: { name: 'drive', kind: 'outbound', args: {}, outbound: { category: 'delete', target: 'report.pdf' }, reason: 'delete' },
    steps: [{ action: 'allow' }, { action: 'deny' }],
  },
  {
    name: 'connector',
    input: { name: 'gmail_send', kind: 'connector', args: {}, connector: { server: 'gmail', tool: 'send', from: 'needs_approval', requested: 'auto', choices: ['auto'] }, reason: 'widen' },
    steps: [{ action: 'allow' }, { action: 'deny' }],
  },
  {
    name: 'permission-once',
    input: {
      name: 'fs',
      kind: 'permission',
      args: {},
      permission: { scopes: [{ id: 'keep', kind: 'allow_always', label: 'Always' }, { id: 'here', kind: 'allow_session', label: 'This session' }, { id: 'one', kind: 'ALLOW_ONCE', label: 'Once' }] },
      reason: 'read a file',
    },
    steps: [{ action: 'allow' }],
  },
  { name: 'permission-by-id', input: { name: 'fs', kind: 'permission', args: {}, permission: { scopes: [{ id: 'session', label: 'Session' }] }, reason: 'read' }, steps: [{ action: 'allow' }] },
  {
    name: 'permission-always-only',
    input: { name: 'fs', kind: 'permission', args: {}, permission: { scopes: [{ id: 'keep', kind: 'allow_always', label: 'Always' }] }, reason: 'read' },
    steps: [{ action: 'allow' }, { action: 'deny' }],
  },
  { name: 'no-kind', input: { name: 'shell', args: { command: 'ls' }, reason: 'list' }, steps: [{ action: 'allow' }] },
  { name: 'question', input: { name: 'ask_user', kind: 'question', args: { questions: [{ question: 'Which one?' }] }, reason: '', timeoutMs: null }, steps: [{ action: 'allow' }, { action: 'deny' }] },
];
/** Two answers to one approval (the `shell` case's request) that reach the session together: `race` lists them in the order they reach
 *  it (the first is held at the session until the second waits behind it), `then` answers one at a time after. `desktop` is the PC's own
 *  card answering `{approved: true}`; a phone answers a notification's button (`action`) or its own card (`card`: the decision it sends,
 *  `resolveToolApprovalForSession`). The answering devices are each connection's own. */
export const APPROVAL_RACES = [
  { name: 'phone a, then phone b', race: [{ by: 'a', action: 'allow' }, { by: 'b', action: 'allow' }] },
  { name: 'phone b, then phone a', race: [{ by: 'b', action: 'deny' }, { by: 'a', action: 'allow' }] },
  { name: 'phone, then the desktop', race: [{ by: 'a', action: 'allow' }, { by: 'desktop' }] },
  { name: 'the desktop, then a phone', race: [{ by: 'desktop' }, { by: 'a', action: 'deny' }] },
  { name: "phone a's card, then phone b", race: [{ by: 'a', card: { approved: false, reason: 'no' } }, { by: 'b', action: 'allow' }] },
  { name: "the desktop, then phone a's card", race: [{ by: 'desktop' }, { by: 'a', card: { approved: true } }] },
  {
    name: 'after the desktop answered',
    race: [{ by: 'desktop' }],
    then: [{ by: 'a', action: 'deny' }, { by: 'b', action: 'allow' }, { by: 'b', card: { approved: true } }],
  },
];
/** A card's own answer (`resolveToolApprovalForSession`) on an approval only a click on its card may allow: `case` names the request in
 *  APPROVAL_CASES the session waits on; each step answers with `card` (the decision sent) from phone a's page (`by: 'phone'`) or this
 *  PC's window (`by: 'desktop'`, its own IPC path), for the approval the session shows or (`stale`) an id it does not show. */
export const APPROVAL_CARD_CASES = [
  ...['outbound-payment', 'outbound-delete', 'office-rollback', 'connector'].map((name) => ({
    name,
    case: name,
    steps: [{ by: 'phone', card: { approved: true } }, { by: 'phone', card: { approved: true, response: 'approve' } }],
  })),
  { name: 'payment, a bare deny', case: 'outbound-payment', steps: [{ by: 'phone', card: { approved: false } }] },
  {
    name: 'payment, an id the session does not show',
    case: 'outbound-payment',
    steps: [{ by: 'phone', card: { approved: true }, stale: true }, { by: 'phone', card: { approved: true } }],
  },
  { name: 'payment, the desktop', case: 'outbound-payment', steps: [{ by: 'desktop', card: { approved: true } }] },
  { name: 'shell, a bare allow', case: 'shell', steps: [{ by: 'phone', card: { approved: true } }] },
];

/** Each answering connection's device: phone a, phone b and the PC's window (the core's test devices name a connection by its id). */
export const RACE_DEVICES = { a: 'desktop-7', b: 'desktop-8', desktop: 'desktop-1' };

/** The id a stale step names: no session shows it. */
export const STALE_APPROVAL_ID = '999999';
/** The answering phone's device name (Node's `client.deviceName()`; the core's connection names it). */
export const APPROVAL_DEVICE = 'desktop-7';

/** A desktop notice raised while a phone is away: phones a and b connected; a's connection drops, the keychain fails (its notice,
 *  keychain-cjs.cjs `_noticeSecretStoreFailure`: `raise('secret-storage', 'secret-storage-failed')`), a comes back. */
export const NOTICE_RECONNECT_STEPS = [{ op: 'drop', phone: 'a' }, { op: 'keychain-fails' }, { op: 'reconnect', phone: 'a' }];

/** Desktop notices: phone a connected from the start, b joins after a notice was raised. */
export const NOTICE_STEPS = [
  { op: 'raise', key: 'provider-sign-in:anthropic', code: 'provider-sign-in-expired', params: { name: 'Anthropic API' } },
  { op: 'raise', key: 'conversation-save', code: 'conversation-save-failed', params: {} },
  { op: 'connect', phone: 'b' },
  { op: 'clear', key: 'provider-sign-in:anthropic' },
  { op: 'raise', key: 'provider-sign-in:anthropic', code: 'provider-sign-in-expired', params: { name: 'Anthropic API' } },
  { op: 'raise', key: 'conversation-save', code: 'conversation-save-failed', params: {} },
];
