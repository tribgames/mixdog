import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><section class="conversation"><div id="root"></div></section>', {
  url: 'https://mixdog.test/',
});
dom.window.Element.prototype.scrollIntoView = () => {};
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
const { QuestionCard } = await import('./QuestionCard.tsx');

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

async function mount(element) {
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById('root'));
  await act(async () => root.render(element));
  const buttons = () => [...doc.querySelectorAll('.approval-prompt .approval-buttons .approval-button')];
  return {
    doc,
    /** The decision buttons' labels, left to right. */
    rows: () => buttons().map((button) => button.querySelector('.approval-button-label').textContent),
    row: (index) => buttons()[index],
    button: (label) => buttons().find((button) => button.querySelector('.approval-button-label').textContent === label),
    title: () => doc.querySelector('.approval-title')?.textContent,
    requester: () => doc.querySelector('.approval-chip-name')?.textContent,
    // A pointer click (detail 1); keyboard activation clicks with detail 0.
    click: (node, detail = 1) =>
      act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail }))),
    key: (key, options = {}, target = doc.activeElement || doc.body) =>
      act(async () =>
        target.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        )
      ),
    type: (field, value) =>
      act(async () => {
        const proto = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(field, value);
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }),
    done: () => act(async () => root.unmount()),
  };
}

const comment = {
  id: 'a1',
  name: 'github',
  kind: 'outbound',
  agentId: 'github-watcher',
  remember: ['once', 'agent'],
  outbound: {
    category: 'comment',
    target: '22nsuk/mixdog#120',
    account: 'github.com',
    payload: 'LGTM',
    editable: ['body'],
    details: {},
  },
};

function card(approval, extra = {}) {
  const decisions = [];
  const element = React.createElement(ApprovalCard, {
    approval,
    resolve: async (decision) => {
      decisions.push(decision);
      return true;
    },
    ...extra,
  });
  return { element, decisions };
}

test('an outbound post: a centred question, the target, the editable text and 거절 · 항상 허용 · 한 번만 허용', async () => {
  const c = card(comment);
  const ui = await mount(c.element);
  try {
    const prompt = ui.doc.querySelector('.approval-prompt');
    assert.equal(prompt.getAttribute('role'), 'alertdialog');
    assert.equal(ui.doc.getElementById(prompt.getAttribute('aria-labelledby')).textContent, 'Post this comment?');
    assert.equal(ui.doc.querySelector('.approval-preview-main').textContent, '22nsuk/mixdog#120');
    assert.deepEqual(ui.rows(), ['Deny', 'Always allow', 'Allow just once']);
    assert.equal(ui.row(2).dataset.tone, 'primary');
    assert.equal(ui.doc.activeElement, ui.row(2), 'the allow takes focus when nothing holds it');
    assert.deepEqual(
      [...ui.doc.querySelectorAll('.approval-kbd')].map((chip) => chip.textContent),
      ['Esc', 'Enter']
    );
    // No text lines under the card (reason, note, scope): what "Always allow"
    // changes is that button's tooltip; the others keep their label.
    assert.equal(ui.doc.querySelector('.approval-reason, .approval-note, .approval-scope'), null);
    assert.equal(ui.button('Always allow').title, "With Always allow, github-watcher's Post a comment won't ask again");
    assert.equal(ui.button('Allow just once').title, 'Allow just once');
    const box = ui.doc.querySelector('.approval-edit textarea');
    await ui.type(box, 'Edited text');
    assert.match(ui.doc.querySelector('.approval-edit-row').textContent, /Edited.*Back to original/);
    await ui.click(ui.doc.querySelector('.approval-edit-row button'));
    assert.equal(box.value, 'LGTM');
    await ui.type(box, 'Final');
    await ui.click(ui.button('Allow just once'));
    assert.deepEqual(c.decisions, [{ approved: true, response: 'edit-and-approve', editedArgs: { body: 'Final' } }]);
  } finally {
    await ui.done();
  }
});

test('a coding session shows only the LEAD mark; a bot chat shows the bot', async () => {
  const lead = { ...comment, id: 'l1', agentId: 'lead' };
  let ui = await mount(card(lead).element);
  try {
    assert.ok(ui.doc.querySelector('.approval-face .approval-lead-mark'));
    assert.equal(ui.requester(), undefined);
    assert.equal(ui.button('Always allow').title, "With Always allow, Lead's Post a comment won't ask again");
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...lead, id: 'l2' }, { agentMode: true }).element);
  try {
    assert.equal(ui.requester(), 'Mixy');
    assert.equal(ui.doc.querySelector('.approval-face .approval-lead-mark'), null, "the bot's own face");
  } finally {
    await ui.done();
  }
});

test('a bot connector-tool ask offers 항상 허용 naming that tool; without remember it is once-only', async () => {
  const ask = { id: 't1', name: 'mcp__notion__create_page', kind: 'approval', agentId: 'github-watcher', args: {} };
  const c = card({ ...ask, remember: ['once', 'agent'] });
  let ui = await mount(c.element);
  try {
    assert.deepEqual(ui.rows(), ['Deny', 'Always allow', 'Allow just once']);
    assert.match(ui.button('Always allow').title, /github-watcher's create_page \(notion\)/);
    assert.equal(ui.doc.querySelector('.approval-service').textContent, 'Notion');
    await ui.click(ui.button('Always allow'));
    assert.deepEqual(c.decisions, [{ approved: true, remember: 'agent' }]);
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...ask, id: 't2' }).element);
  try {
    assert.deepEqual(ui.rows(), ['Deny', 'Allow just once']);
    assert.equal(ui.doc.querySelector('.approval-scope'), null);
  } finally {
    await ui.done();
  }
});

test('항상 허용 resolves with the agent scope and shows no toast', async () => {
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail);
  dom.window.addEventListener('mixdog:desktop-toast', onToast);
  const c = card({ ...comment, id: 'a2' });
  const ui = await mount(c.element);
  try {
    await ui.click(ui.button('Always allow'));
    assert.deepEqual(c.decisions, [{ approved: true, remember: 'agent' }]);
    assert.deepEqual(toasts, []);
  } finally {
    dom.window.removeEventListener('mixdog:desktop-toast', onToast);
    await ui.done();
  }
});

test('email shows account, to, cc, subject and the body; payment and delete are danger cards without 항상 허용', async () => {
  const mail = card({
    ...comment,
    id: 'm1',
    outbound: {
      category: 'email',
      target: 'kim@example.com',
      account: 'me@example.com',
      payload: 'Hello',
      editable: ['body', 'subject'],
      details: { to: 'kim@example.com', cc: 'park@example.com', subject: 'Release' },
    },
  });
  let ui = await mount(mail.element);
  try {
    assert.equal(ui.title(), 'Send this email?');
    assert.match(ui.doc.querySelector('.approval-preview').textContent, /Sent as me@example\.com/);
    assert.equal(
      ui.doc.querySelector('.approval-fields').textContent,
      'Tokim@example.comCcpark@example.comSubjectRelease'
    );
    assert.equal(ui.doc.querySelector('.approval-edit textarea').value, 'Hello');
  } finally {
    await ui.done();
  }
  const pay = card({
    ...comment,
    id: 'p1',
    remember: ['once'],
    outbound: {
      category: 'payment',
      target: 'Notion Labs',
      account: 'stripe',
      payload: '',
      editable: [],
      details: { merchant: 'Notion Labs', amount: '12900', currency: 'KRW', recurrence: 'monthly' },
    },
  });
  ui = await mount(pay.element);
  try {
    const prompt = ui.doc.querySelector('.approval-prompt');
    assert.equal(prompt.dataset.tone, 'danger');
    assert.match(ui.doc.querySelector('.approval-amount b').textContent, /12,900/);
    assert.match(ui.doc.querySelector('.approval-amount').textContent, /KRW · monthly/);
    assert.deepEqual(ui.rows(), ['Deny', 'Allow payment']);
    assert.equal(ui.row(1).dataset.tone, 'danger');
    assert.equal(ui.doc.activeElement, ui.row(0), 'focus starts on 거절');
    assert.equal(ui.row(1).querySelector('.approval-kbd'), null, 'no Enter chip on a danger allow');
    assert.equal(ui.button('Always allow'), undefined, 'no 항상 허용 button');
    // No danger note or click note under the buttons: the click-only note is
    // the allow's tooltip and its visually hidden accessible description.
    assert.equal(ui.doc.querySelector('.approval-reason, .approval-note, .approval-scope'), null);
    assert.equal(ui.row(1).title, 'Allowing takes a click; Enter does not allow.');
    const described = ui.doc.getElementById(ui.row(1).getAttribute('aria-describedby'));
    assert.equal(described.textContent, 'Allowing takes a click; Enter does not allow.');
    assert.ok(described.hidden || described.classList.contains('sr-only'), 'visually hidden');
    assert.equal(ui.row(0).getAttribute('aria-describedby'), null, '거절 needs no description');
    await settle();
    ui.doc.activeElement.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(pay.decisions, [], 'Enter never allows a payment');
    // Enter and Space on the focused allow are cancelled, so the browser never
    // makes the click they would activate.
    const allow = ui.button('Allow payment');
    allow.focus();
    const sent = (type, key, target = allow) => {
      let kept = true;
      act(() => {
        kept = target.dispatchEvent(new dom.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      });
      return kept;
    };
    assert.equal(sent('keydown', 'Enter'), false, 'Enter on the focused allow is cancelled');
    assert.equal(sent('keydown', ' '), false, 'Space down on it is cancelled');
    assert.equal(sent('keyup', ' '), false, 'Space up on it is cancelled');
    assert.equal(sent('keydown', 'Tab'), true, 'other keys pass');
    assert.equal(sent('keydown', ' ', ui.button('Deny')), true, 'Deny keeps its keys');
    assert.deepEqual(pay.decisions, [], 'nor Enter or Space on the focused button');
    // A pointer or assistive-tech activation is a plain click.
    await act(async () => allow.click());
    assert.deepEqual(pay.decisions, [{ approved: true }]);
  } finally {
    await ui.done();
  }
  const del = card({
    ...comment,
    id: 'd1',
    remember: ['once'],
    outbound: {
      category: 'delete',
      target: '2025 정산',
      payload: '',
      editable: [],
      details: { count: '48', size: '1288490188' },
    },
  });
  ui = await mount(del.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-amount b').textContent, '48 items · 1.2GB');
    assert.deepEqual(ui.rows(), ['Deny', 'Delete 48 permanently']);
    await ui.click(ui.button('Deny'));
    assert.deepEqual(del.decisions, [{ approved: false }]);
  } finally {
    await ui.done();
  }
});

test('a trash card lists sender and subject, "외 N통" for the rest, and never says "Sent as"', async () => {
  const trash = card({
    ...comment,
    id: 'tr1',
    outbound: {
      category: 'trash',
      target: '1, 2, 3, 4',
      account: 'me@gmail.com',
      payload: '',
      editable: [],
      details: { count: '4', messages: 'Kim · Hello · 2026-01-02\nPark · Re: Plan · 2026-01-03', more: '2' },
    },
  });
  const ui = await mount(trash.element);
  try {
    const text = ui.doc.querySelector('.approval-preview').textContent;
    assert.match(text, /Kim · Hello · 2026-01-02/);
    assert.match(text, /Park · Re: Plan/);
    assert.match(text, /and 2 more/);
    assert.match(text, /Mail in me@gmail\.com/);
    assert.doesNotMatch(text, /Sent as|^1, 2/);
  } finally {
    await ui.done();
  }
});

test('one click on Deny ends the request: a single denial with no reason, and no reason screen', async () => {
  const c = card({ id: 'g1', name: 'shell', kind: 'approval', args: { command: 'npm ci' }, reason: 'Hook asks' });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-detail').textContent, 'npm ci');
    assert.deepEqual(ui.rows(), ['Deny', 'Allow just once']);
    await ui.click(ui.button('Deny'));
    assert.equal(ui.doc.querySelector('.approval-deny'), null);
    assert.equal(ui.doc.querySelector('textarea[aria-label="What to do instead"]'), null);
    assert.deepEqual(c.decisions, [{ approved: false }], 'one denial, no reason');
  } finally {
    await ui.done();
  }
});

test('takeover: Done answers done in one step', async () => {
  const c = card({
    id: 't1',
    name: 'ask_user',
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'Sign in' },
  });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-text').textContent, 'Sign in');
    assert.deepEqual(ui.rows(), ['Cancel', 'Done']);
    await ui.click(ui.button('Done'));
    assert.deepEqual(c.decisions, [{ approved: true, response: 'done' }]);
  } finally {
    await ui.done();
  }
});

test('a settled takeover says Done / Cancelled on the device, not Allowed / Denied; other cards keep Allowed / Denied', async () => {
  const takeover = {
    id: 't-settled',
    name: 'ask_user',
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'Sign in' },
  };
  for (const [approved, expected] of [
    [true, 'Done on Pixel 9'],
    [false, 'Cancelled on Pixel 9'],
  ]) {
    const ui = await mount(card(takeover, { settled: { approved, device: 'Pixel 9' } }).element);
    try {
      assert.equal(ui.doc.querySelector('.approval-status').textContent, expected);
    } finally {
      await ui.done();
    }
  }
  const ui = await mount(card(comment, { settled: { approved: true, device: 'Pixel 9' } }).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-status').textContent, 'Allowed from Pixel 9');
  } finally {
    await ui.done();
  }
});

const permissionRequest = (scopes) => ({
  id: 'pm-kind',
  kind: 'permission',
  reason: 'Needs access.',
  permission: { scopes },
});

test('a permission request has three short buttons mapped by option KIND, not label: Always allow · Allow once · Cancel', async () => {
  const ui = await mount(
    card(
      permissionRequest([
        { id: 'o1', kind: 'allow_once', label: 'Allow Always' },
        { id: 'o2', kind: 'allow_always', label: 'Only once please' },
        { id: 'o3', kind: 'reject', label: 'Whatever' },
      ])
    ).element
  );
  try {
    assert.deepEqual(ui.rows(), ['Always allow', 'Allow once', 'Cancel']);
    assert.equal(ui.row(0).dataset.tone, 'primary');
    assert.match(ui.doc.querySelector('.approval-preview').textContent, /Always allow · Only once please/);
  } finally {
    await ui.done();
  }
});

test('a permission request: the narrowest once option wins, ties go to the first listed, and a missing always option leaves two buttons', async () => {
  const c = card(
    permissionRequest([
      { id: 's1', kind: 'allow_session', label: 'This session' },
      { id: 'n1', kind: 'allow_once', label: 'Once A' },
      { id: 'n2', kind: 'allow_once', label: 'Once B' },
    ])
  );
  const ui = await mount(c.element);
  try {
    assert.deepEqual(ui.rows(), ['Allow once', 'Cancel']);
    await ui.click(ui.button('Allow once'));
    assert.deepEqual(c.decisions, [{ approved: true, scope: 'n1' }]);
  } finally {
    await ui.done();
  }
});
test('a takeover waits for "human control ready": "Stopping the agent…" cannot be chosen until this PC reports it', async () => {
  const previous = dom.window.mixdogDesktop;
  let markReady;
  const asked = [];
  dom.window.mixdogDesktop = {
    takeoverReady: (sessionId, id) => {
      asked.push([sessionId, id]);
      return new Promise((resolve) => {
        markReady = resolve;
      });
    },
  };
  const c = card({
    id: 't-ready',
    name: 'ask_user',
    kind: 'takeover',
    sessionId: 'sess-r',
    takeover: { surface: 'browser', instructions: 'Sign in', target: 'shop login', tab: 'p2' },
  });
  const ui = await mount(c.element);
  try {
    assert.deepEqual(asked, [['sess-r', 't-ready']]);
    assert.equal(ui.rows()[1], 'Stopping the agent…');
    assert.equal(ui.row(1).disabled, true);
    await settle();
    ui.doc.activeElement?.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.equal(ui.rows()[1], 'Stopping the agent…', 'the key cannot start it either');
    await act(async () => markReady(true));
    assert.equal(ui.rows()[1], 'Done');
    assert.deepEqual(c.decisions, [], 'done never comes from readiness alone');
    await ui.click(ui.row(1));
    assert.deepEqual(c.decisions, [{ approved: true, response: 'done' }]);
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('the takeover target identity reaches the card model', async () => {
  const { approvalCardModel } = await import('./ApprovalCard.tsx');
  const browser = approvalCardModel({
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'x', target: 'shop login', tab: 'p2' },
  });
  assert.deepEqual(browser.takeoverTarget, { label: 'shop login', tab: 'p2', windowId: '', app: '' });
  const computer = approvalCardModel({
    kind: 'takeover',
    takeover: { surface: 'computer', instructions: 'x', windowId: 'hwnd:0x1', app: 'Bank' },
  });
  assert.deepEqual(computer.takeoverTarget, { label: '', tab: '', windowId: 'hwnd:0x1', app: 'Bank' });
  assert.equal(approvalCardModel({ kind: 'approval' }).takeoverTarget, null);
});

test('a browser takeover offers "Import again from Chrome" as its own button, which keeps the card open', async () => {
  const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
  const { onBrowserImportRequested } = await import('./browser-page-request.ts');
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = { browserProfileImportSources: async () => [] };
  const imports = [];
  const stop = onBrowserImportRequested('sess-t', () => imports.push('sess-t'));
  const c = card({
    id: 't2',
    name: 'ask_user',
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'Sign in' },
  });
  const ui = await mount(React.createElement(MarkdownSessionContext.Provider, { value: 'sess-t' }, c.element));
  try {
    assert.deepEqual(ui.rows(), ['Cancel', 'Import again from Chrome', 'Done']);
    await ui.click(ui.button('Import again from Chrome'));
    assert.deepEqual(imports, ['sess-t']);
    assert.deepEqual(c.decisions, []);
    assert.equal(ui.rows().length, 3);
  } finally {
    stop();
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

const loginTakeover = (id, extra = {}) => ({
  id,
  name: 'ask_user',
  kind: 'takeover',
  sessionId: 'sess-login',
  takeover: {
    surface: 'browser',
    instructions: 'Sign in',
    purpose: 'login',
    url: 'https://accounts.example.com/login',
    origin: 'https://accounts.example.com',
  },
  ...extra,
});

/** A desktop whose sign-in window ends however the test says. */
function loginDesktop() {
  const calls = [];
  const ends = [];
  return {
    calls,
    end: (status) => act(async () => ends.shift()(status)),
    api: {
      takeoverReady: async () => true,
      browserLoginStatus: async () => ({ state: 'idle' }),
      browserLoginOpen: (sessionId, id) => {
        calls.push([sessionId, id]);
        return new Promise((resolve) => ends.push(resolve));
      },
      browserProfileImportSources: async () => [],
    },
  };
}

test('a login takeover asks with 취소 / 로그인하기, and its window decides what the card says next', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  dom.window.mixdogDesktop = desktop.api;
  const c = card(loginTakeover('l1'));
  const ui = await mount(c.element);
  const prompt = () => ui.doc.querySelector('.approval-prompt');
  try {
    assert.equal(ui.title(), 'example.com sign-in required');
    assert.equal(ui.requester(), undefined, 'the LEAD mark already identifies a coding session');
    assert.equal(ui.doc.querySelector('.approval-note'), null);
    assert.deepEqual(ui.rows(), ['Cancel', 'Sign in…']);
    await ui.click(ui.button('Sign in…'));
    assert.deepEqual(desktop.calls, [['sess-login', 'l1']], 'bound to this takeover of this session');
    assert.equal(prompt().dataset.login, 'open');
    assert.deepEqual(ui.rows(), [], 'while the window is open the card has no buttons');
    // 닫기 or the OS close: still pending, offered again; never a decision.
    await desktop.end({ state: 'closed' });
    assert.equal(ui.title(), 'Not signed in');
    assert.deepEqual(ui.rows(), ['Cancel', 'Sign in again…']);
    assert.deepEqual(c.decisions, []);
    // Google-style refusal of an embedded sign-in: the Chrome import instead.
    await ui.click(ui.button('Sign in again…'));
    await desktop.end({ state: 'refused', provider: 'Google' });
    assert.equal(ui.title(), 'Google does not allow sign-in in this window');
    assert.equal(ui.doc.querySelector('.approval-note'), null, 'no note line; the button says it');
    assert.deepEqual(ui.rows(), ['Cancel', 'Import again from Chrome']);
    assert.deepEqual(c.decisions, []);
    await ui.click(ui.button('Cancel'));
    assert.deepEqual(c.decisions, [{ approved: false }], '취소 denies the takeover');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('완료 in the window: the card reads 로그인됨 with the site while the agent continues', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  dom.window.mixdogDesktop = desktop.api;
  const c = card(loginTakeover('l2'), { agentMode: true });
  const ui = await mount(c.element);
  try {
    assert.notEqual(ui.requester(), 'Lead', 'agent mode names the agent');
    await ui.click(ui.button('Sign in…'));
    await desktop.end({ state: 'done' });
    const prompt = ui.doc.querySelector('.approval-prompt');
    assert.equal(prompt.dataset.settled, 'true');
    assert.equal(prompt.dataset.tone, 'done');
    assert.equal(ui.title(), 'Signed in');
    assert.equal(ui.doc.querySelector('.approval-status').textContent, 'example.com');
    assert.deepEqual(ui.rows(), []);
    assert.deepEqual(c.decisions, [], 'the main process settled it, not the card');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('a login card waits for the agent to stop before 로그인하기 can open anything; ✕ and Esc decide later', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  let markReady;
  desktop.api.takeoverReady = () =>
    new Promise((resolve) => {
      markReady = resolve;
    });
  dom.window.mixdogDesktop = desktop.api;
  const c = card(loginTakeover('l3'));
  const ui = await mount(c.element);
  try {
    assert.equal(ui.rows()[1], 'Stopping the agent…');
    assert.equal(ui.row(1).disabled, true);
    await settle();
    ui.doc.activeElement?.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(desktop.calls, []);
    await act(async () => markReady(true));
    assert.equal(ui.rows()[1], 'Sign in…');
    const inCard = ui.doc.querySelector('.approval-prompt');
    inCard.focus();
    await ui.key('Escape', {}, inCard);
    assert.equal(ui.doc.querySelector('.approval-prompt'), null);
    const chip = ui.doc.querySelector('.question-chip');
    assert.match(chip.textContent, /Approval pending · example\.com sign-in required.*Open/);
    assert.deepEqual(c.decisions, [], 'later keeps the request pending');
    await ui.click(chip);
    assert.ok(ui.doc.querySelector('.approval-prompt'));
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('the phone shows the pending "PC에서 로그인하세요" state only', async () => {
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = {};
  const c = card(loginTakeover('l4'));
  const ui = await mount(c.element);
  try {
    assert.equal(ui.title(), 'Sign in on your PC');
    assert.equal(ui.doc.querySelector('.approval-note'), null, 'no note line under the title');
    assert.ok(ui.doc.querySelector('.progress-spinner'));
    assert.deepEqual(ui.rows(), []);
    assert.equal(ui.doc.querySelector('.approval-close'), null);
    assert.equal(ui.doc.querySelector('.approval-prompt').dataset.login, 'remote');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('keys: Enter allows once and Esc denies, never while typing, never a held or immediate key', async () => {
  const c = card({ ...comment, id: 'k1' });
  const ui = await mount(c.element);
  try {
    const allow = ui.button('Allow just once');
    assert.equal(ui.doc.activeElement, allow);
    await ui.key('Enter', {}, allow);
    assert.deepEqual(c.decisions, [], 'a key right after the card appears does nothing');
    await settle();
    allow.blur();
    await ui.key('Enter', { repeat: true }, ui.doc.body);
    assert.deepEqual(c.decisions, [], 'a held (repeating) key does nothing');
    const box = ui.doc.querySelector('.approval-edit textarea');
    box.focus();
    await ui.key('Enter', {}, box);
    await ui.key('Escape', {}, box);
    assert.deepEqual(c.decisions, [], 'shortcuts are off while typing');
    assert.equal(ui.doc.querySelector('.approval-deny'), null);
    box.blur();
    await ui.key('Escape', {}, ui.doc.body);
    assert.equal(ui.doc.querySelector('.approval-deny'), null, 'Esc with focus outside the card does nothing');
    assert.deepEqual(c.decisions, [], 'Esc with focus outside the card does nothing');
    ui.doc.activeElement?.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(c.decisions, [], 'Enter with focus outside the card does nothing');
    ui.doc.querySelector('.approval-prompt').focus();
    await ui.key('Enter', {}, ui.doc.querySelector('.approval-prompt'));
    assert.deepEqual(c.decisions, [{ approved: true }], 'Enter inside the card allows once');
  } finally {
    await ui.done();
  }
});

test('Esc with focus inside the card denies at once with no reason, once', async () => {
  const c = card({ ...comment, id: 'k2' });
  const ui = await mount(c.element);
  try {
    await settle();
    const section = ui.doc.querySelector('.approval-prompt');
    section.focus();
    await ui.key('Escape', {}, section);
    assert.deepEqual(c.decisions, [{ approved: false }]);
    assert.equal(ui.doc.querySelector('.approval-deny'), null, 'no reason screen');
    await ui.key('Escape', {}, section);
    assert.equal(c.decisions.length, 1, 'a second Esc does not deny again');
  } finally {
    await ui.done();
  }
});

test('the composer caret is never taken: a card that appears while typing leaves focus there', async () => {
  const input = dom.window.document.createElement('textarea');
  dom.window.document.querySelector('.conversation').append(input);
  input.focus();
  const c = card({ ...comment, id: 'f1' });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.activeElement, input);
    await settle();
    await ui.key('Enter', {}, input);
    await ui.key('Escape', {}, input);
    assert.deepEqual(c.decisions, []);
    assert.equal(ui.doc.querySelector('.approval-deny'), null);
  } finally {
    await ui.done();
    input.remove();
  }
});

test('phone: a card arriving while the composer holds no draft closes the keyboard (also right after Send); unsent text keeps the caret', async () => {
  const doc = dom.window.document;
  doc.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  const row = doc.createElement('div');
  row.className = 'composer-input-row';
  const input = doc.createElement('textarea');
  row.append(input);
  doc.querySelector('.conversation').append(row);
  try {
    input.focus();
    let ui = await mount(card({ ...comment, id: 'kb1' }).element);
    try {
      assert.notEqual(doc.activeElement, input, 'the idle composer gave up focus');
      assert.equal(doc.activeElement, ui.button('Allow just once'));
    } finally {
      await ui.done();
    }
    // Just sent: a keystroke a moment ago, the draft now empty.
    input.focus();
    input.value = 'hi';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    ui = await mount(card({ ...comment, id: 'kb2' }).element);
    try {
      assert.notEqual(doc.activeElement, input, 'right after Send the keyboard closes');
    } finally {
      await ui.done();
    }
    input.focus();
    input.value = 'half a thought';
    ui = await mount(card({ ...comment, id: 'kb3' }).element);
    try {
      assert.equal(doc.activeElement, input, 'unsent text keeps the caret');
    } finally {
      await ui.done();
    }
    input.value = '';
  } finally {
    doc.documentElement.removeAttribute('data-mixdog-mobile-tabs');
    row.remove();
  }
});

test('the requester chip names the connector, not the raw tool id (kept as the tooltip)', async () => {
  let ui = await mount(card({ ...comment, id: 'cn1', name: 'mcp__gmail__send_email' }).element);
  try {
    const service = ui.doc.querySelector('.approval-service');
    assert.equal(service.textContent, 'Gmail');
    assert.equal(service.title, 'mcp__gmail__send_email');
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...comment, id: 'cn2', name: 'mcp__gmail-2__send_email' }).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-service').textContent, 'Gmail');
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...comment, id: 'cn3', name: 'mcp__shop__checkout' }).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-service').textContent, 'shop');
  } finally {
    await ui.done();
  }
});

test("the runtime's known reasons read in the UI language; an agent's own reason stays as written; an outbound card shows neither", async () => {
  const { approvalReasonText } = await import('./ApprovalCard.tsx');
  const { readFileSync, readdirSync } = await import('node:fs');
  const known = [
    'This sends or posts outside Mixdog; it needs your approval.',
    "This agent's permission blocks this action.",
    'This connector tool is set to ask before it runs for this agent.',
  ];
  {
    const { CONNECTOR_APPROVAL_REASON } = await import(
      '../../../../src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs'
    );
    assert.deepEqual([CONNECTOR_APPROVAL_REASON], known.slice(2), 'the runtime texts mapped');
    const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
    for (const key of known.slice(2)) assert.ok(/[가-힣]/.test(ko[key] ?? ''), `ko: ${key}`);
  }
  const removed = [
    'This always asks, so there is no “Always allow”.',
    'This always asks, so there is no “Don’t ask again”.',
    'Reason: {{reason}}',
    "This action always asks; it can't be allowed in advance.",
    "Always allow is only offered in a bot's own chat.",
    'The agent continues once you finish signing in.',
    'You can import the account signed in to Chrome.',
  ];
  const locales = new URL('./locales/', import.meta.url);
  for (const file of readdirSync(locales).filter((name) => name.endsWith('.json'))) {
    const catalog = JSON.parse(readFileSync(new URL(file, locales), 'utf8'));
    for (const key of known) assert.ok(catalog[key], `${file}: ${key}`);
    for (const key of removed) assert.equal(catalog[key], undefined, `${file}: dead key ${key}`);
  }
  assert.equal(approvalReasonText(known[0]), known[0]);
  assert.equal(approvalReasonText('The review team asked for it.'), 'The review team asked for it.');
  // An outbound request's reason is not shown on the card.
  const reasoned = await mount(card({ ...comment, id: 'pr1', reason: known[0] }).element);
  try {
    assert.equal(reasoned.doc.querySelector('.approval-reason'), null);
    assert.doesNotMatch(reasoned.doc.querySelector('.approval-prompt').textContent, /needs your approval/);
  } finally {
    await reasoned.done();
  }
  const pay = card({
    ...comment,
    id: 'pn1',
    remember: ['once'],
    outbound: {
      category: 'payment',
      target: 'Shop',
      payload: '',
      editable: [],
      details: { amount: '1', currency: 'KRW' },
    },
  });
  const ui = await mount(pay.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-note'), null, 'no danger note');
    assert.doesNotMatch(ui.doc.querySelector('.approval-prompt').textContent, /always asks/);
  } finally {
    await ui.done();
  }
});

test('answered on another device: no buttons, saying who answered', async () => {
  const c = card({ ...comment, id: 's1' }, { settled: { approved: true, device: 'Pixel' } });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-status').textContent, 'Allowed from Pixel');
    assert.deepEqual(ui.rows(), []);
  } finally {
    await ui.done();
  }
});

test("a sub-agent's request shown in the top-level chat names its chain, links its session; always-allow names the root bot", async () => {
  // As the runtime copies it into the bot's home chat: the bot's identity, the chain to the asking agent.
  const delegated = {
    ...comment,
    id: 'd1',
    chain: ['사무관', 'Worker'],
    sessionId: 'sess_sub',
    surfaceSessionId: 'sess_home_github-watcher',
  };
  const { ApprovalOpenSessionContext } = await import('./approval-prompt.tsx');
  const opened = [];
  const c = card(delegated, { agentMode: true });
  let ui = await mount(
    React.createElement(ApprovalOpenSessionContext.Provider, { value: (id) => opened.push(id) }, c.element)
  );
  try {
    assert.match(ui.requester(), /^사무관 › Worker/);
    assert.equal(ui.doc.querySelector('.approval-chip').title, '사무관 › Worker');
    await ui.click(ui.doc.querySelector('.approval-who .approval-link'));
    assert.deepEqual(opened, ['sess_sub']);
    assert.match(ui.button('Always allow').title, /github-watcher's Post a comment/);
    await ui.click(ui.button('Always allow'));
    assert.deepEqual(c.decisions, [{ approved: true, remember: 'agent' }]);
  } finally {
    await ui.done();
  }
  // The same request in the sub-agent's own chat: no link to the chat it is already in.
  ui = await mount(card({ ...delegated, id: 'd1b' }, { agentMode: true, hostSessionId: 'sess_sub' }).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-who .approval-link'), null);
  } finally {
    await ui.done();
  }
  // A coding Lead's reviewer: "Lead › Reviewer", and the Lead stays the remember scope's name.
  ui = await mount(card({ ...comment, id: 'd2', agentId: 'lead', chain: ['Lead', 'Reviewer'] }).element);
  try {
    assert.match(ui.requester(), /^Lead › Reviewer/);
    assert.equal(ui.doc.querySelector('.approval-who .approval-link'), null, 'no copy, no link');
  } finally {
    await ui.done();
  }
});

test("a delegated request's chain label: tokens in this UI's language, nothing for a lone requester", async () => {
  const { approvalChainLabel } = await import('./ApprovalCard.tsx');
  assert.equal(approvalChainLabel(['사무관', 'Worker']), '사무관 › Worker');
  assert.equal(approvalChainLabel(['Lead', 'Reviewer']), 'Lead › Reviewer');
  assert.equal(approvalChainLabel(['사무관', 'Task session', 'Worker']), '사무관 › Task session › Worker');
  assert.equal(approvalChainLabel(['사무관']), '');
  assert.equal(approvalChainLabel(undefined), '');
  // A bot's task session is named in every UI language.
  const { readFileSync, readdirSync } = await import('node:fs');
  const locales = new URL('./locales/', import.meta.url);
  for (const file of readdirSync(locales).filter((name) => name.endsWith('.json'))) {
    const catalog = JSON.parse(readFileSync(new URL(file, locales), 'utf8'));
    assert.ok(catalog['Task session'], `${file} names a task session`);
  }
  assert.equal(JSON.parse(readFileSync(new URL('ko.json', locales), 'utf8'))['Task session'], '작업 세션');
  // The card's once button, as the maintainer words it.
  assert.equal(JSON.parse(readFileSync(new URL('ko.json', locales), 'utf8'))['Allow just once'], '한 번만 허용');
});

test('agent mode marks the question card and the approval card the same way', async () => {
  const c = card({ ...comment, id: 'w1' }, { agentMode: true });
  let ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-prompt').dataset.agentMode, 'true');
  } finally {
    await ui.done();
  }
  ui = await mount(
    React.createElement(QuestionCard, {
      questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A', description: '' }] }],
      resolve: async () => true,
      agentMode: true,
    })
  );
  try {
    assert.equal(ui.doc.querySelector('.question-card').dataset.agentMode, 'true');
  } finally {
    await ui.done();
  }
});
