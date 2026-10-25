// One rule for "a bare Enter allows this once": the approval card presses its
// 한 번만 허용 on Enter exactly where shared/approval-enter-rule.ts says so, and
// that same rule decides whether a phone notification may offer Allow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><section class="conversation"><div id="root"></div></section>', {
  url: 'https://mixdog.test/',
});
dom.window.Element.prototype.scrollIntoView = () => {};
dom.window.document.hasFocus = () => true;
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'navigator',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ApprovalCard } = await import('./ApprovalCard.tsx');
const { approvalEnterAllowsOnce, approvalAllowIsPointerOnly } = await import('../shared/approval-enter-rule.ts');
const { createPushNotifier } = await import('../main/push-notifier.ts');
const { createRemoteMethods } = await import('../main/remote-methods.ts');
const { generateWebPushKeys } = await import('../main/web-push.ts');

// The card's keys wait out its settle window after it appears.
const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

/** What a bare Enter on the card sends, with nothing focused. */
async function enterOn(approval) {
  const doc = dom.window.document;
  const decisions = [];
  const root = createRoot(doc.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(ApprovalCard, {
        approval,
        resolve: async (decision) => {
          decisions.push(decision);
          return true;
        },
      })
    )
  );
  try {
    await settle();
    doc.activeElement?.blur();
    await act(async () =>
      doc.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    );
    return decisions;
  } finally {
    await act(async () => root.unmount());
  }
}

const cards = {
  shell: { id: 'c1', kind: 'approval', name: 'shell', args: { command: 'npm test' } },
  comment: {
    id: 'c2',
    kind: 'outbound',
    remember: ['once', 'agent'],
    outbound: { category: 'comment', target: 'repo#1', payload: 'LGTM', editable: [], details: {} },
  },
  'Office commit': { id: 'c3', kind: 'approval', name: 'office', args: { action: 'commit' } },
  'permission with a once option': {
    id: 'c4',
    kind: 'permission',
    permission: {
      scopes: [
        { id: 'once', kind: 'allow_once', label: 'Once' },
        { id: 'always', kind: 'allow_always', label: 'Always' },
      ],
    },
  },
  payment: {
    id: 'c5',
    kind: 'outbound',
    outbound: { category: 'payment', target: 'Notion Labs', payload: '', editable: [], details: { amount: '1' } },
  },
  'permanent delete': {
    id: 'c6',
    kind: 'outbound',
    outbound: { category: 'delete', target: 'Drive', payload: '', editable: [], details: { count: '2' } },
  },
  'Office rollback': { id: 'c7', kind: 'approval', name: 'office', args: { action: 'rollback' } },
  'Office recovery discard': { id: 'c8', kind: 'approval', name: 'office', args: { action: 'discard' } },
  'always-only permission': {
    id: 'c9',
    kind: 'permission',
    permission: { scopes: [{ id: 'always', kind: 'allow_always', label: 'Always' }] },
  },
};

for (const [name, approval] of Object.entries(cards)) {
  test(`${name}: the card’s Enter allows it once exactly where the shared rule says`, async () => {
    const decisions = await enterOn(approval);
    const allowedOnce =
      decisions.length === 1 &&
      decisions[0].approved === true &&
      !decisions[0].remember &&
      (decisions[0].scope === undefined || decisions[0].scope === 'once');
    assert.equal(allowedOnce, approvalEnterAllowsOnce(approval));
    if (!allowedOnce) assert.deepEqual(decisions, [], 'Enter sent nothing at all');
  });
}

// A phone notification's Allow records the decision the card's 한 번만 허용 sends:
// the same scope value and payload shape, per request kind.
const SESSION = `sess_desktop_${'a'.repeat(64)}`;
for (const name of ['shell', 'comment', 'Office commit', 'permission with a once option']) {
  test(`${name}: a notification’s Allow records the very decision the card’s Allow just once sends`, async (t) => {
    const approval = cards[name];
    const [cardDecision, ...rest] = await enterOn(approval);
    assert.deepEqual(rest, []);
    const resolved = [];
    const notifier = createPushNotifier({
      store: { keys: async () => generateWebPushKeys(), list: async () => [], remove: async () => true },
      isEnabled: () => true,
      readFinalAnswer: async () => null,
      isClientForeground: () => false,
    });
    t.after(() => notifier.dispose());
    const methods = createRemoteMethods(
      {
        host: {
          resolveToolApprovalForSession: async (...args) => {
            resolved.push(args);
            return true;
          },
          invokeDesktopOperation: async () => null,
        },
        approvalNotifications: notifier,
      },
      { deviceName: async () => 'Pixel 9' }
    );
    notifier.onSessionState({ sessionId: SESSION, frameSource: 'live', snapshot: { toolApproval: approval } });
    assert.equal(await methods.answerApprovalNotification([SESSION, approval.id, 'allow']), 'answered');
    assert.deepEqual(resolved, [[SESSION, approval.id, { ...cardDecision, device: 'Pixel 9' }]]);
  });
}

test('the rule: once-allowable only for a tool, outbound or Office commit approval, or a permission with a once option', () => {
  const allowed = ['shell', 'comment', 'Office commit', 'permission with a once option'];
  for (const [name, approval] of Object.entries(cards)) {
    assert.equal(approvalEnterAllowsOnce(approval), allowed.includes(name), name);
  }
  // Pointer-only allows: payment, permanent delete, an Office rollback or recovery discard.
  assert.deepEqual(
    Object.entries(cards)
      .filter(([, approval]) => approvalAllowIsPointerOnly(approval))
      .map(([name]) => name),
    ['payment', 'permanent delete', 'Office rollback', 'Office recovery discard']
  );
  // Enter does a step there, it allows nothing: a sign-in, a takeover, a secret, a question.
  for (const approval of [
    { kind: 'takeover', takeover: { purpose: 'login', url: 'https://github.com/login' } },
    { kind: 'takeover', takeover: { surface: 'browser' } },
    { kind: 'secret', secret: { requestId: 'r1' } },
    { kind: 'question', questions: [] },
    { kind: 'something-new' },
    null,
  ]) {
    assert.equal(approvalEnterAllowsOnce(approval), false, JSON.stringify(approval));
  }
});
