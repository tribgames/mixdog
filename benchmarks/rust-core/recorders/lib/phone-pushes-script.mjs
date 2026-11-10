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
/** The id a stale step names: no session shows it. */
export const STALE_APPROVAL_ID = '999999';
/** The answering phone's device name (Node's `client.deviceName()`; the core's connection names it). */
export const APPROVAL_DEVICE = 'desktop-7';

/** Desktop notices: phone a connected from the start, b joins after a notice was raised. */
export const NOTICE_STEPS = [
  { op: 'raise', key: 'provider-sign-in:anthropic', code: 'provider-sign-in-expired', params: { name: 'Anthropic API' } },
  { op: 'raise', key: 'conversation-save', code: 'conversation-save-failed', params: {} },
  { op: 'connect', phone: 'b' },
  { op: 'clear', key: 'provider-sign-in:anthropic' },
  { op: 'raise', key: 'provider-sign-in:anthropic', code: 'provider-sign-in-expired', params: { name: 'Anthropic API' } },
  { op: 'raise', key: 'conversation-save', code: 'conversation-save-failed', params: {} },
];
