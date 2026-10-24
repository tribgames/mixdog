import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM(
  '<!doctype html><section class="conversation"><div id="host"></div><div id="chat"></div></section>',
  {
    url: 'https://mixdog.test/',
  }
);
dom.window.Element.prototype.scrollIntoView = () => {};
// jsdom's hasFocus() is false with nothing focused; a real focused window is true.
dom.window.document.hasFocus = () => true;
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'navigator',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BrowserApprovalHost, BrowserApprovalCard, useBrowserApprovals } = await import('./BrowserApprovalHost.tsx');
const { useConversationApprovals } = await import('./use-conversation-approvals.tsx');
const { browserApprovalSessionIds } = await import('./browser-approval-marks.ts');
const { sessionAttentionIndex, sessionAttentionOf } = await import('./session-attention-index.ts');

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));
const doc = dom.window.document;
// A pointer click (detail 1); keyboard activation clicks with detail 0.
const click = (node, detail = 1) =>
  act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail })));
const key = (name, target = doc.activeElement || doc.body) =>
  act(async () =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  );
const labels = (root) =>
  [...root.querySelectorAll('.approval-buttons .approval-button-label')].map((label) => label.textContent);
const button = (root, text) =>
  [...root.querySelectorAll('.approval-prompt button')].find((node) => node.textContent.startsWith(text));

function desktop() {
  let listener = null;
  const decisions = [];
  dom.window.mixdogDesktop = {
    onBrowserApproval: (next) => {
      listener = next;
      return () => {};
    },
    browserApprovalDecide: async (...args) => {
      decisions.push(args);
    },
  };
  return { send: (prompt) => act(async () => listener(prompt)), decisions };
}

const prompt = (extra = {}) => ({
  id: 'b1',
  action: 'click',
  url: 'https://staging.example/signup',
  sessionId: 'sess_sub',
  surfaceSessionId: 'sess_home_marketer',
  agentId: 'marketer',
  requester: 'Marketer › Worker',
  target: 'button "Create account"',
  paths: [],
  remember: { kinds: ['submit'] },
  ...extra,
});

/** The docked card of one chat, as use-conversation-approvals mounts it. */
function Dock({ sessionId }) {
  const prompts = useBrowserApprovals(sessionId);
  return prompts[0]
    ? React.createElement(BrowserApprovalCard, {
        prompt: prompts[0],
        queueLabel: prompts.length > 1 ? `1/${prompts.length}` : undefined,
      })
    : null;
}

test('a browser approval docks in its top-level chat; with no such chat open it floats nowhere and marks its session', async () => {
  const api = desktop();
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () => chat.render(React.createElement(Dock, { sessionId: 'sess_home_marketer' })));
  try {
    await api.send(prompt());
    const docked = doc.getElementById('chat');
    assert.equal(doc.querySelector('#host .approval-prompt'), null, 'claimed: nothing floats');
    assert.equal(docked.querySelector('.approval-title').textContent, 'Submit this form?');
    assert.equal(docked.querySelector('.approval-chip-name').textContent, 'Marketer › Worker');
    assert.ok(docked.querySelector('.approval-link'), 'the asking session is one click away');
    assert.deepEqual(labels(docked), ['Deny', 'Always allow', 'Allow just once']);
    // No text lines under the card: what "Always allow" changes is its tooltip.
    assert.equal(docked.querySelector('.approval-note, .approval-scope, .approval-reason'), null);
    assert.equal(
      button(docked, 'Always allow').title,
      "With Always allow, Marketer › Worker's Submit a form in the browser won't ask again"
    );
    assert.equal(button(docked, 'Allow just once').title, 'Allow just once');
    await api.send(prompt({ id: 'b2' }));
    assert.equal(docked.querySelector('.approval-queue').textContent, '1/2');
    await api.send({ id: 'b1', closed: true });
    assert.equal(docked.querySelector('.approval-queue').textContent, '');
    // Another chat's approval: no open chat docks it, and nothing floats.
    await api.send(prompt({ id: 'b3', surfaceSessionId: 'sess_other', sessionId: 'sess_other' }));
    assert.equal(doc.getElementById('host').querySelector('*'), null, 'nothing floats');
    assert.equal(doc.querySelectorAll('#chat .approval-prompt').length, 1, 'the open chat docks only its own card');
    // It only marks its session, until that chat opens and docks it.
    assert.ok(browserApprovalSessionIds().has('sess_other'));
    const index = sessionAttentionIndex([], new Set(), browserApprovalSessionIds());
    assert.equal(sessionAttentionOf(index, 'sess_other'), 'needs-you', 'the session list marks it');
    assert.equal(sessionAttentionOf(index, 'sess_unrelated'), '');
    // Closing the open chat releases its card: still nothing floats.
    await act(async () => chat.unmount());
    assert.equal(doc.querySelector('.approval-prompt'), null, 'released, not floated');
    assert.ok(browserApprovalSessionIds().has('sess_home_marketer'), 'both sessions stay marked');
    await api.send({ id: 'b2', closed: true });
    await api.send({ id: 'b3', closed: true });
    assert.equal(browserApprovalSessionIds().size, 0, 'answered prompts clear the marks');
  } finally {
    await act(async () => host.unmount());
  }
});

test('a prompt waits for the person: no timer drops it, no countdown', async (t) => {
  const api = desktop();
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () => chat.render(React.createElement(Dock, { sessionId: 'nowhere' })));
  try {
    await api.send(prompt({ id: 'n1', surfaceSessionId: 'nowhere' }));
    const root = doc.getElementById('chat');
    assert.ok(root.querySelector('.approval-prompt'), 'the card shows');
    await act(async () => t.mock.timers.tick(31_000));
    await act(async () => t.mock.timers.tick(5 * 60_000));
    assert.ok(root.querySelector('.approval-prompt'), 'still waiting after the old 30 s window');
    assert.equal(root.querySelector('.approval-corner').textContent, '', 'no countdown');
    assert.deepEqual(api.decisions, []);
    await api.send({ id: 'n1', closed: true });
    assert.equal(root.querySelector('.approval-prompt'), null);
  } finally {
    t.mock.timers.reset();
    await act(async () => chat.unmount());
    await act(async () => host.unmount());
  }
});

test('one click on deny sends the denial with no reason; Enter allows once', async () => {
  const api = desktop();
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () => chat.render(React.createElement(Dock, { sessionId: 'nowhere' })));
  try {
    await api.send(prompt({ id: 'c1', surfaceSessionId: 'nowhere' }));
    const root = doc.getElementById('chat');
    await click(button(root, 'Deny'));
    assert.equal(root.querySelector('.approval-deny'), null, 'no reason screen');
    assert.deepEqual(api.decisions, [['c1', 'deny', undefined]]);
    await api.send(prompt({ id: 'c2', surfaceSessionId: 'nowhere' }));
    await settle();
    const outside = doc.createElement('button');
    doc.body.append(outside);
    outside.focus();
    await key('Enter', outside);
    outside.remove();
    assert.deepEqual(api.decisions.at(-1), ['c1', 'deny', undefined], 'Enter with focus outside the conversation does nothing');
    const section = root.querySelector('.approval-prompt');
    section.focus();
    await key('Enter', section);
    assert.deepEqual(api.decisions.at(-1), ['c2', 'once', undefined]);
  } finally {
    await act(async () => chat.unmount());
    await act(async () => host.unmount());
  }
});

test('a pane Enter that answers one browser card restarts the settle of another mounted card', async () => {
  const api = desktop();
  const second = doc.createElement('section');
  second.className = 'conversation';
  second.innerHTML = '<div id="chat2" class="pane-leaf"></div>';
  doc.body.append(second);
  // Each card sits in its own pane (a pane owns its own Enter).
  doc.getElementById('chat').classList.add('pane-leaf');
  const host = createRoot(doc.getElementById('host'));
  const chatA = createRoot(doc.getElementById('chat'));
  const chatB = createRoot(doc.getElementById('chat2'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () => chatA.render(React.createElement(Dock, { sessionId: 'paneA' })));
  await act(async () => chatB.render(React.createElement(Dock, { sessionId: 'paneB' })));
  try {
    await api.send(prompt({ id: 'pa', surfaceSessionId: 'paneA' }));
    await api.send(prompt({ id: 'pb', surfaceSessionId: 'paneB' }));
    await settle();
    const cardA = doc.querySelector('#chat .approval-prompt');
    const cardB = doc.querySelector('#chat2 .approval-prompt');
    cardA.focus();
    await key('Enter', cardA);
    assert.deepEqual(api.decisions, [['pa', 'once', undefined]], 'Enter answers the first card');
    cardB.focus();
    await key('Enter', cardB);
    assert.deepEqual(api.decisions, [['pa', 'once', undefined]], 'the other card is still settling');
    assert.equal(cardB.dataset.keys, undefined, 'and shows no key chip');
    await settle();
    cardB.focus();
    await key('Enter', cardB);
    assert.deepEqual(api.decisions.at(-1), ['pb', 'once', undefined], 'it answers once it has settled');
  } finally {
    await act(async () => chatB.unmount());
    await act(async () => chatA.unmount());
    await act(async () => host.unmount());
    doc.getElementById('chat').classList.remove('pane-leaf');
    second.remove();
  }
});

test('an unconfirmed receiver or an outside file: focus on 거절, Enter never allows; the allow says why in its tooltip', async () => {
  const api = desktop();
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () => chat.render(React.createElement(Dock, { sessionId: 'nowhere' })));
  try {
    await api.send(
      prompt({
        id: 'r1',
        surfaceSessionId: 'nowhere',
        action: 'upload',
        origin: 'https://forms.example',
        receiverOrigin: '',
        files: [{ name: 'tax.pdf', path: 'C:\\Users\\me\\tax.pdf', size: 860 * 1024, outside: true }],
        remember: null,
      })
    );
    const root = doc.getElementById('chat');
    assert.equal(root.querySelector('.approval-title').textContent, 'Upload these files?');
    assert.deepEqual(labels(root), ['Deny', 'Allow just once']);
    assert.equal(doc.activeElement, button(root, 'Deny'));
    assert.equal(button(root, 'Allow just once').querySelector('.approval-kbd'), null, 'no Enter chip');
    // The click-only note is the allow's tooltip and its (visually hidden)
    // accessible description; no note line, and the once-only reason is gone.
    const risk = 'This is not confirmed, so allowing takes a click; Enter does not allow.';
    const allowOnce = button(root, 'Allow just once');
    assert.equal(allowOnce.title, risk);
    const described = doc.getElementById(allowOnce.getAttribute('aria-describedby'));
    assert.equal(described.textContent, risk);
    assert.ok(described.hidden || described.classList.contains('sr-only'), 'visually hidden');
    assert.equal(root.querySelector('.approval-note, .approval-scope, .approval-reason'), null);
    assert.doesNotMatch(root.querySelector('.approval-prompt').textContent, /bot's own chat/);
    assert.ok(root.querySelector('.approval-preview-row[data-warn]'));
    assert.match(root.querySelector('.approval-tag').textContent, /Outside the project/);
    await settle();
    doc.activeElement?.blur();
    await key('Enter', doc.body);
    assert.deepEqual(api.decisions, [], 'Enter does not allow');
    const allow = button(root, 'Allow just once');
    allow.focus();
    // Enter and Space on the focused allow are cancelled: no click is made.
    for (const [type, name] of [
      ['keydown', 'Enter'],
      ['keydown', ' '],
      ['keyup', ' '],
    ]) {
      let kept = true;
      act(() => {
        kept = allow.dispatchEvent(new dom.window.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
      });
      assert.equal(kept, false, `${type} ${JSON.stringify(name)} on the focused allow is cancelled`);
    }
    assert.deepEqual(api.decisions, [], 'Space on the focused allow does not allow');
    await act(async () => allow.click());
    assert.deepEqual(api.decisions, [['r1', 'once', undefined]], 'a click with no key before it does');
  } finally {
    await act(async () => chat.unmount());
    await act(async () => host.unmount());
  }
});

test('a failed "always allow" save is told as a toast', async () => {
  const api = desktop();
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail);
  dom.window.addEventListener('mixdog:desktop-toast', onToast);
  const host = createRoot(doc.getElementById('host'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  try {
    await api.send({ id: 'x', saveFailed: true });
    assert.equal(toasts.length, 1);
  } finally {
    dom.window.removeEventListener('mixdog:desktop-toast', onToast);
    await act(async () => host.unmount());
  }
});

/** A conversation as Conversation.tsx calls the hook; a read-only view docks nothing. */
function ConversationApprovals({ sessionId, docked }) {
  const route = React.useRef(sessionId);
  const approvals = useConversationApprovals({ sessionId, items: [] }, route, { docked });
  return docked ? approvals.approvalDock : null;
}

test('a read-only (deleted bot) or parked chat docks no browser approval and nothing floats; the session is marked', async () => {
  const api = desktop();
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  await act(async () =>
    chat.render(React.createElement(ConversationApprovals, { sessionId: 'sess_home_marketer', docked: false }))
  );
  try {
    await api.send(prompt({ id: 'ro1' }));
    assert.equal(doc.querySelector('.approval-prompt'), null, 'not shown anywhere');
    assert.ok(browserApprovalSessionIds().has('sess_home_marketer'), 'marked in the session list');
    // The same chat with its dock: the card docks there instead.
    await act(async () =>
      chat.render(React.createElement(ConversationApprovals, { sessionId: 'sess_home_marketer', docked: true }))
    );
    assert.equal(doc.querySelector('#host .approval-prompt'), null);
    assert.ok(doc.querySelector('#chat .approval-prompt'));
    // Parked again (behind a file tab): released, nothing floats.
    await act(async () =>
      chat.render(React.createElement(ConversationApprovals, { sessionId: 'sess_home_marketer', docked: false }))
    );
    assert.equal(doc.querySelector('.approval-prompt'), null, 'released when hidden');
    await api.send({ id: 'ro1', closed: true });
  } finally {
    await act(async () => chat.unmount());
    await act(async () => host.unmount());
  }
});

test('on a paired device the PC list marks its sessions, with no card and no answer; a chat claim or unmount does not wipe it', async () => {
  let listener = null;
  let stopped = 0;
  // The remote API: marks only, never onBrowserApproval or browserApprovalDecide.
  dom.window.mixdogDesktop = {
    onBrowserApprovalSessions: (next) => {
      listener = next;
      next(['sess_home_marketer']);
      return () => {
        stopped += 1;
      };
    },
  };
  const host = createRoot(doc.getElementById('host'));
  const chat = createRoot(doc.getElementById('chat'));
  await act(async () => host.render(React.createElement(BrowserApprovalHost)));
  try {
    assert.ok(browserApprovalSessionIds().has('sess_home_marketer'), 'the baseline marks it');
    const index = sessionAttentionIndex([], new Set(), browserApprovalSessionIds());
    assert.equal(sessionAttentionOf(index, 'sess_home_marketer'), 'needs-you');
    // Opening that chat claims no card (none exists here) and keeps the mark.
    await act(async () => chat.render(React.createElement(Dock, { sessionId: 'sess_home_marketer' })));
    assert.equal(doc.querySelector('.approval-prompt'), null, 'no card on the phone');
    await act(async () => chat.unmount());
    assert.ok(browserApprovalSessionIds().has('sess_home_marketer'));
    await act(async () => listener(['sess_other']));
    assert.deepEqual([...browserApprovalSessionIds()], ['sess_other']);
    await act(async () => listener([]));
    assert.equal(browserApprovalSessionIds().size, 0, 'cleared when the PC has none');
    await act(async () => listener(['sess_other']));
  } finally {
    await act(async () => host.unmount());
  }
  assert.equal(stopped, 1);
  assert.equal(browserApprovalSessionIds().size, 0, 'the host leaving drops the PC marks');
});

test('an approval answered on another device flashes "<action> · Allowed from <device>" above the composer, both ways', async () => {
  const { conversationIslandFlash } = await import('./use-conversation-approvals.tsx');
  const email = { id: 'm1', kind: 'outbound', outbound: { category: 'email' } };
  const fromDesktop = conversationIslandFlash(
    { approval: email, outcome: { approved: true, device: 'DESKTOP-7' } },
    null,
    'Pixel 9'
  );
  assert.match(fromDesktop.key, /^retired:/);
  assert.equal(fromDesktop.text, 'Send an email · Allowed from DESKTOP-7');
  const fromPhone = conversationIslandFlash(
    { approval: email, outcome: { approved: false, device: 'Pixel 9' } },
    null,
    'DESKTOP-7'
  );
  assert.equal(fromPhone.text, 'Send an email · Denied from Pixel 9');
  // This device's own answer is never announced back to it.
  assert.equal(
    conversationIslandFlash({ approval: email, outcome: { approved: true, device: 'Pixel 9' } }, null, 'Pixel 9'),
    null
  );
});
