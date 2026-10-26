import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><section class="conversation"><div id="root"></div></section>', {
  url: 'https://mixdog.test/',
});
dom.window.Element.prototype.scrollIntoView = () => {};
// jsdom's hasFocus() is true only while an element holds focus; a window with
// the keyboard focus but nothing focused is the real browser's usual state.
let windowHasFocus = true;
dom.window.document.hasFocus = () => windowHasFocus;
const setWindowFocus = (on) =>
  act(async () => {
    windowHasFocus = on;
    dom.window.dispatchEvent(new dom.window.Event(on ? 'focus' : 'blur'));
  });
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

test("a held request row offers the scopes the gate gave it: a room seat's row can be always-allowed", async () => {
  const { HeldRequestCard } = await import('./ApprovalCard.tsx');
  const held = {
    id: 'held_1',
    status: 'pending',
    agentId: 'github-watcher',
    kind: 'outbound',
    tool: 'github',
    action: 'comment',
    target: '22nsuk/mixdog#120',
    payload: 'LGTM',
    editable: ['body'],
    remember: ['once', 'agent'],
    run: { kind: 'room', name: 'Standup', sessionId: 'sess_rmem_abc123_github-watcher' },
  };
  const answers = [];
  const rowOf = (row) => React.createElement(HeldRequestCard, { held: row, sessionId: 'sess_home_github-watcher' });
  let ui = await mount(rowOf(held));
  dom.window.mixdogDesktop = {
    resolveToolApprovalForSession: async (sessionId, id, decision) => {
      answers.push([sessionId, id, decision]);
      return true;
    },
  };
  try {
    assert.deepEqual(ui.rows(), ['Deny', 'Always allow', 'Allow just once']);
    await ui.click(ui.button('Always allow'));
    assert.deepEqual(answers, [['sess_home_github-watcher', 'held_1', { approved: true, remember: 'agent' }]]);
  } finally {
    delete dom.window.mixdogDesktop;
    await ui.done();
  }
  // An unattended schedule's row (or an older one with no scopes) asks once only.
  for (const row of [
    { ...held, remember: ['once'] },
    { ...held, remember: undefined },
  ]) {
    ui = await mount(rowOf(row));
    try {
      assert.deepEqual(ui.rows(), ['Deny', 'Allow just once']);
    } finally {
      await ui.done();
    }
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
    assert.equal(prompt.dataset.tone, 'need', 'no red: the normal amber need-dot');
    assert.match(ui.doc.querySelector('.approval-amount b').textContent, /12,900/);
    assert.match(ui.doc.querySelector('.approval-amount').textContent, /KRW · monthly/);
    assert.deepEqual(ui.rows(), ['Deny', 'Allow payment']);
    assert.equal(ui.row(1).dataset.tone, 'primary', 'the normal primary look, not danger');
    assert.equal(ui.row(1).dataset.pointerOnly, 'true');
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
    // response 'approve' marks the card's own click (remote-session-methods.ts).
    assert.deepEqual(pay.decisions, [{ approved: true, response: 'approve' }]);
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

test('a permission request reads like every card (Deny · Always allow · Allow just once), mapped by option KIND; Enter grants once, never always', async () => {
  const c = card(
    permissionRequest([
      { id: 'o1', kind: 'allow_once', label: 'Allow Always' },
      { id: 'o2', kind: 'allow_always', label: 'Only once please' },
      { id: 'o3', kind: 'reject', label: 'Whatever' },
    ])
  );
  const ui = await mount(c.element);
  try {
    assert.deepEqual(ui.rows(), ['Deny', 'Always allow', 'Allow just once']);
    assert.equal(ui.row(2).dataset.tone, 'primary');
    assert.match(ui.doc.querySelector('.approval-preview').textContent, /Always allow · Only once please/);
    assert.match(ui.doc.querySelector('.approval-preview').textContent, /Allow just once · Allow Always/);
    await settle();
    ui.doc.activeElement.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(c.decisions, [{ approved: true, scope: 'o1' }], 'Enter grants once');
  } finally {
    await ui.done();
  }
});

test('a permission request with only an always option never lets Enter grant it', async () => {
  const c = card(permissionRequest([{ id: 'o2', kind: 'allow_always', label: 'Always' }]));
  const ui = await mount(c.element);
  try {
    assert.deepEqual(ui.rows(), ['Deny', 'Always allow']);
    assert.equal(ui.row(1).querySelector('.approval-kbd'), null);
    assert.equal(ui.doc.activeElement, ui.row(0), 'initial focus is Deny, never Always allow');
    await settle();
    ui.doc.activeElement.blur();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(c.decisions, [], "the card's own Enter never grants it");
    // A deliberate Tab to it keeps the native Enter / Space activation.
    const always = ui.button('Always allow');
    always.focus();
    let kept = false;
    act(() => {
      kept = always.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    assert.equal(kept, true, 'Enter on the focused button is left to the browser');
    assert.deepEqual(c.decisions, [], 'and the card did not send it itself');
    await act(async () => always.click());
    assert.deepEqual(c.decisions, [{ approved: true, scope: 'o2' }]);
  } finally {
    await ui.done();
  }
});

test('Always allow is never the initial focus nor the default Enter; a focused one keeps its native keys', async () => {
  const permission = card(
    permissionRequest([
      { id: 'o1', kind: 'allow_once', label: 'Once' },
      { id: 'o2', kind: 'allow_always', label: 'Always' },
    ])
  );
  const remembered = card({ ...comment, id: 'r1', remember: ['once', 'agent'] });
  for (const c of [permission, remembered]) {
    const ui = await mount(c.element);
    try {
      assert.deepEqual(ui.rows(), ['Deny', 'Always allow', 'Allow just once']);
      assert.equal(ui.doc.activeElement, ui.row(2), 'initial focus is Allow just once');
      assert.notEqual(ui.doc.activeElement, ui.button('Always allow'));
      await settle();
      assert.notEqual(
        ui.doc.activeElement,
        ui.button('Always allow'),
        'nothing moves focus there after the settle window'
      );
      ui.doc.activeElement.blur();
      await ui.key('Enter', {}, ui.doc.body);
      assert.deepEqual(
        c.decisions,
        [c === permission ? { approved: true, scope: 'o1' } : { approved: true }],
        'Enter grants once, never always'
      );
    } finally {
      await ui.done();
    }
  }
  // A focused Always allow keeps the native Enter / Space activation.
  const c = card({ ...comment, id: 'r2', remember: ['once', 'agent'] });
  const ui = await mount(c.element);
  try {
    await settle();
    const always = ui.button('Always allow');
    always.focus();
    for (const [type, key] of [
      ['keydown', 'Enter'],
      ['keydown', ' '],
      ['keyup', ' '],
    ]) {
      let kept = false;
      act(() => {
        kept = always.dispatchEvent(new dom.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      });
      assert.equal(kept, true, `${type} ${JSON.stringify(key)} is not cancelled`);
    }
    assert.deepEqual(c.decisions, []);
  } finally {
    await ui.done();
  }
});

test('tool approval titles say what is approved; other tools keep the generic title', async () => {
  const { approvalCardModel } = await import('./ApprovalCard.tsx');
  const title = (name) => approvalCardModel({ id: 't', kind: 'approval', name, args: {} }).title;
  assert.equal(title('shell'), 'Approval: Run a command');
  assert.equal(title('apply_patch'), 'Approval: Edit files');
  assert.equal(title('web_fetch'), 'Approval: Network request');
  assert.equal(title('mcp__gmail__send'), 'Tool approval required');
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
    assert.deepEqual(ui.rows(), ['Deny', 'Allow just once']);
    await ui.click(ui.button('Allow just once'));
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

test('the phone says "PC에서 로그인하세요" and can cancel the takeover', async () => {
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = {};
  const c = card(loginTakeover('l4'));
  const ui = await mount(c.element);
  try {
    assert.equal(ui.title(), 'Sign in on your PC');
    assert.equal(ui.doc.querySelector('.approval-note'), null, 'no note line under the title');
    assert.ok(ui.doc.querySelector('.progress-spinner'));
    assert.deepEqual(ui.rows(), ['Cancel']);
    assert.equal(ui.doc.querySelector('.approval-close'), null);
    assert.equal(ui.doc.querySelector('.approval-prompt').dataset.login, 'remote');
    await ui.click(ui.button('Cancel'));
    assert.deepEqual(c.decisions, [{ approved: false }], 'Cancel settles the takeover from the phone');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

const secretRequest = (id, secret = {}, extra = {}) => ({
  id,
  name: 'ask_user',
  kind: 'secret',
  sessionId: 'sess-secret',
  remember: ['once'],
  secret: { requestId: `secret_${id}0123456789`, surface: 'browser', target: 'bank', field: 'Password', ...secret },
  ...extra,
});

/** A PC that takes the card's values into its one-shot slots. */
function secretDesktop(settings = {}) {
  const provided = [];
  return {
    provided,
    api: {
      provideSecretInput: async (requestId, value) => {
        provided.push([requestId, value]);
        return true;
      },
      readSettings: async () => settings,
    },
  };
}

test('the phone never takes a secret: "PC에서 입력하세요" with Cancel, no field, nothing relayed', async () => {
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = { resolveToolApprovalForSession: async () => true };
  const c = card(secretRequest('p1', { origin: 'https://bank.example.com', form: 'password' }));
  const ui = await mount(c.element);
  try {
    assert.equal(ui.title(), 'Enter it on your PC');
    assert.equal(ui.doc.querySelector('input'), null, 'no field to type into');
    assert.deepEqual(ui.rows(), ['Cancel']);
    await ui.click(ui.button('Cancel'));
    assert.deepEqual(c.decisions, [{ approved: false, response: 'skip' }], 'an explicit cancel, never a silent skip');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('a sign-in secret asks 아이디 + 비밀번호 with the save box from saveChatLogins; values go only to the PC', async () => {
  const previous = dom.window.mixdogDesktop;
  for (const [settings, saves] of [
    [{}, true],
    [{ saveChatLogins: false }, false],
  ]) {
    const desktop = secretDesktop(settings);
    dom.window.mixdogDesktop = desktop.api;
    const request = secretRequest('s1', { origin: 'https://www.dart.fss.or.kr', form: 'login' });
    const c = card(request);
    const ui = await mount(c.element);
    try {
      assert.equal(ui.title(), 'fss.or.kr sign-in details');
      assert.equal(ui.doc.querySelector('.approval-who'), null, 'its own conversation: no who line');
      assert.equal(ui.doc.querySelector('.approval-preview-row'), null, 'the site is never repeated under the title');
      assert.deepEqual(ui.rows(), ['Skip', 'Enter']);
      const box = ui.doc.querySelector('.approval-check input');
      assert.equal(box.checked, saves, 'the save default follows the setting (on when unset)');
      const [user, password] = ui.doc.querySelectorAll('.approval-secret');
      await ui.type(user, 'data-team');
      await ui.type(password, 'pw-123');
      await ui.click(ui.button('Enter'));
      const id = request.secret.requestId;
      assert.deepEqual(desktop.provided, [
        [`${id}-username`, 'data-team'],
        ...(saves ? [[`${id}-save`, '1']] : []),
        [id, 'pw-123'],
      ]);
      assert.deepEqual(c.decisions, [{ approved: true, response: 'provide-secret' }], 'the decision holds no value');
    } finally {
      await ui.done();
    }
  }
  dom.window.mixdogDesktop = previous;
});

/** Submit a sign-in on a card whose settings read is `readSettings`; resolves
 *  with what the PC took and the failures the renderer reported. */
async function submitLoginWith(readSettings, beforeSubmit = async () => {}) {
  const previous = dom.window.mixdogDesktop;
  const desktop = secretDesktop();
  const diagnostics = [];
  dom.window.mixdogDesktop = {
    ...desktop.api,
    readSettings,
    rendererDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const request = secretRequest('s10', { origin: 'https://www.dart.fss.or.kr', form: 'login' });
  const c = card(request);
  const ui = await mount(c.element);
  try {
    const [user, password] = ui.doc.querySelectorAll('.approval-secret');
    await ui.type(user, 'data-team');
    await ui.type(password, 'pw-123');
    await ui.click(ui.button('Enter'));
    await beforeSubmit();
    return { provided: desktop.provided, diagnostics, id: request.secret.requestId };
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
}

test('a sign-in submitted before saveChatLogins loads never sends the save slot', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { provided, id } = await submitLoginWith(
    () => pending,
    async () => release({ saveChatLogins: true })
  );
  assert.deepEqual(provided, [
    [`${id}-username`, 'data-team'],
    [id, 'pw-123'],
  ]);
});

test('a sign-in whose saveChatLogins loads off never sends the save slot', async () => {
  const { provided, id } = await submitLoginWith(async () => ({ saveChatLogins: false }));
  assert.deepEqual(provided, [
    [`${id}-username`, 'data-team'],
    [id, 'pw-123'],
  ]);
});

test('a sign-in whose settings read fails reports it and never sends the save slot', async () => {
  const { provided, diagnostics, id } = await submitLoginWith(async () => {
    throw new TypeError('settings unreadable');
  });
  assert.deepEqual(provided, [
    [`${id}-username`, 'data-team'],
    [id, 'pw-123'],
  ]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'unhandled-rejection');
  assert.equal(diagnostics[0].errorName, 'TypeError');
});

test('a sign-in whose saveChatLogins loads on sends the save slot', async () => {
  const { provided, id } = await submitLoginWith(async () => ({ saveChatLogins: true }));
  assert.deepEqual(provided, [
    [`${id}-username`, 'data-team'],
    [`${id}-save`, '1'],
    [id, 'pw-123'],
  ]);
});

test('a one-time code: 3-3 boxes from its length, the current box marked, a paste fills all and enters it', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = secretDesktop();
  dom.window.mixdogDesktop = desktop.api;
  const request = secretRequest('o1', { origin: 'https://accounts.example.com', form: 'otp', length: 6 });
  const c = card(request);
  const ui = await mount(c.element);
  try {
    assert.equal(ui.title(), 'example.com verification code, 6 digits');
    assert.deepEqual(ui.rows(), ['Cancel', 'Do it yourself', 'Enter']);
    const boxes = () => [...ui.doc.querySelectorAll('.approval-otp-box')];
    assert.equal(boxes().length, 6);
    const otp = ui.doc.querySelector('.approval-otp');
    assert.equal(
      [...otp.children].findIndex((node) => node.classList.contains('approval-otp-sep')),
      4,
      '3 | 3'
    );
    const input = ui.doc.querySelector('.approval-otp-input');
    assert.equal(input.getAttribute('autocomplete'), 'one-time-code');
    await ui.type(input, '48');
    assert.deepEqual(
      boxes().map((box) => Boolean(box.dataset.filled)),
      [true, true, false, false, false, false],
      'the boxes show how many are filled, never the characters'
    );
    assert.ok(boxes().every((box) => box.textContent === ''));
    assert.equal(
      boxes().findIndex((box) => box.dataset.current),
      2,
      'the next box is the current one'
    );
    assert.deepEqual(desktop.provided, [], 'not entered before it is full');
    await ui.type(input, '482-190');
    assert.deepEqual(desktop.provided, [[request.secret.requestId, '482190']], 'full: entered at once');
    assert.deepEqual(c.decisions, [{ approved: true, response: 'provide-secret' }]);
  } finally {
    await ui.done();
  }
  // 8 characters read 4-4; 직접 하기 answers a skip the agent can tell apart.
  const eight = card(secretRequest('o2', { form: 'otp', length: 8 }));
  const ui8 = await mount(eight.element);
  try {
    assert.equal(ui8.title(), 'Verification code, 8 digits');
    const otp = ui8.doc.querySelector('.approval-otp');
    assert.equal(otp.dataset.long, 'true');
    assert.equal(
      [...otp.children].findIndex((node) => node.classList.contains('approval-otp-sep')),
      5,
      '4 | 4'
    );
    await ui8.click(ui8.button('Do it yourself'));
    assert.deepEqual(eight.decisions, [{ approved: false, response: 'skip', reason: 'self' }]);
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui8.done();
  }
});

/** Every string React holds for the tree under `node`: each fiber's props and
 *  hook state (DOM nodes and fibers themselves skipped). */
function reactHeldStrings(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
  let root = node[key];
  while (root.return) root = root.return;
  const strings = [];
  const seen = new Set();
  const collect = (value, depth) => {
    if (typeof value === 'string') return void strings.push(value);
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return;
    if (value instanceof dom.window.Node || 'stateNode' in value) return;
    seen.add(value);
    for (const entry of Object.values(value)) collect(entry, depth + 1);
  };
  const visit = (fiber) => {
    for (; fiber; fiber = fiber.sibling) {
      collect(fiber.memoizedProps, 0);
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
        collect(hook.memoizedState, 0);
        if (!('next' in hook)) break;
      }
      visit(fiber.child);
    }
  };
  visit(root.child);
  return strings;
}

test('a typed secret or code is never React state, props or markup; submit reads the fields and clears them', async () => {
  const previous = dom.window.mixdogDesktop;
  const PASSWORD = 'S3NT1NEL-pw-77';
  const USER = 'S3NT1NEL-user';
  const CODE = '918273';
  for (const [secret, fill, finish] of [
    [
      { origin: 'https://bank.example', form: 'login' },
      async (ui) => {
        const [user, password] = ui.doc.querySelectorAll('.approval-secret');
        await ui.type(user, USER);
        await ui.type(password, PASSWORD);
        return [user, password];
      },
      (ui) => ui.click(ui.button('Enter')),
    ],
    [
      // Six of eight typed: still being typed when React is looked at.
      { origin: 'https://bank.example', form: 'otp', length: 8 },
      async (ui) => {
        const input = ui.doc.querySelector('.approval-otp-input');
        await ui.type(input, CODE);
        return [input];
      },
      // A paste completes it: read from the field and entered at once.
      (ui) => ui.type(ui.doc.querySelector('.approval-otp-input'), `${CODE}45`),
    ],
  ]) {
    const desktop = secretDesktop();
    dom.window.mixdogDesktop = desktop.api;
    const c = card(secretRequest(`n${secret.form}`, secret));
    const ui = await mount(c.element);
    try {
      const fields = await fill(ui);
      const held = reactHeldStrings(ui.doc.querySelector('.approval-prompt')).join('\n');
      for (const value of [PASSWORD, USER, CODE]) {
        assert.ok(!held.includes(value), `${secret.form}: React holds no typed value`);
        assert.ok(!ui.doc.documentElement.outerHTML.includes(value), `${secret.form}: no typed value in the markup`);
      }
      await finish(ui);
      const values = desktop.provided.map(([, value]) => value);
      assert.ok(values.includes(secret.form === 'otp' ? `${CODE}45` : PASSWORD), 'read from the field at submit');
      assert.deepEqual(c.decisions, [{ approved: true, response: 'provide-secret' }]);
      assert.ok(
        fields.every((field) => field.value === ''),
        'the fields are cleared once read'
      );
    } finally {
      await ui.done();
    }
  }
  dom.window.mixdogDesktop = previous;
});

test('a secret or sign-in card in the chat that delegated it names the asking session once; in its own chat, no who line', async () => {
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = { ...loginDesktop().api, ...secretDesktop().api };
  const copy = {
    sessionId: 'sess_task',
    surfaceSessionId: 'sess_home_mailer',
    chain: [],
    handoff: { title: '예측' },
    requestedAt: Date.now(),
  };
  const names = (ui) => [...ui.doc.querySelectorAll('.approval-who .approval-chip-name')].map((n) => n.textContent);
  try {
    for (const request of [
      secretRequest('w1', { origin: 'https://dart.fss.or.kr', form: 'password' }, copy),
      loginTakeover('w2', copy),
    ]) {
      let ui = await mount(card(request, { agentMode: true, hostSessionId: 'sess_home_mailer' }).element);
      try {
        assert.deepEqual(names(ui), ['예측'], `${request.kind}: only the owner chip`);
        assert.equal(ui.doc.querySelector('.approval-service'), null, 'no site under the title');
        assert.equal(ui.doc.querySelector('.approval-who .approval-link'), null);
      } finally {
        await ui.done();
      }
      ui = await mount(card({ ...request, id: `${request.id}b` }, { hostSessionId: 'sess_task' }).element);
      try {
        assert.equal(ui.doc.querySelector('.approval-who'), null, `${request.kind}: its own chat omits the line`);
      } finally {
        await ui.done();
      }
    }
  } finally {
    dom.window.mixdogDesktop = previous;
  }
});

test('the top-left says how long is left: a secret by its expiry, a takeover 15 minutes from when it was asked', async () => {
  const { deadlineText } = await import('./approval-prompt.tsx');
  assert.equal(deadlineText(15 * 60_000), 'Within 15 min');
  assert.equal(deadlineText(61_000), 'Within 2 min');
  assert.equal(deadlineText(42_000), 'Within 42 s');
  const previous = dom.window.mixdogDesktop;
  dom.window.mixdogDesktop = { ...loginDesktop().api, ...secretDesktop().api };
  let ui = await mount(card(secretRequest('t1', { form: 'password' }, { expiresAt: Date.now() + 120_000 })).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-queue').textContent, 'Within 2 min');
  } finally {
    await ui.done();
  }
  ui = await mount(card(loginTakeover('t2', { requestedAt: Date.now() })).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-queue').textContent, 'Within 15 min');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('saved logins for the page: masked radio rows, 지금 안 함 / 직접 로그인 / 이 계정으로 로그인 fills and settles', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  const fills = [];
  let fillResult = { usernameFilled: true, passwordFilled: true };
  desktop.api.browserCredentialFill = async (sessionId, id, fillId) => {
    fills.push([sessionId, id, fillId]);
    if (fillResult instanceof Error) throw fillResult;
    return fillResult;
  };
  dom.window.mixdogDesktop = desktop.api;
  const accounts = [
    { id: 'c1', label: 'd•••m' },
    { id: 'c2', label: 'o•••s@example.com' },
  ];
  const fillId = 'secret_login-0123456789';
  // Saved logins without the page they may go into are not offered.
  const unbound = card(loginTakeover('a0', { takeover: { ...loginTakeover('a0').takeover, accounts } }));
  const ui0 = await mount(unbound.element);
  try {
    assert.equal(ui0.doc.querySelectorAll('.approval-account').length, 0);
    assert.ok(!ui0.rows().includes('Sign in with this account'));
  } finally {
    await ui0.done();
  }
  const c = card(loginTakeover('a1', { takeover: { ...loginTakeover('a1').takeover, accounts, fillId } }));
  const ui = await mount(c.element);
  try {
    assert.deepEqual(
      [...ui.doc.querySelectorAll('.approval-account-label')].map((n) => n.textContent),
      ['d•••m', 'o•••s@example.com', 'Use another account']
    );
    assert.equal(ui.doc.querySelector('.approval-lock-line').textContent, 'The agent never sees the password.');
    assert.deepEqual(ui.rows(), ['Not now', 'Sign in yourself', 'Sign in with this account']);
    assert.equal(ui.button('Sign in with this account').dataset.tone, 'primary');
    assert.equal(ui.button('Sign in yourself').dataset.tone, undefined);
    // A refused fill (the page is elsewhere) says so and keeps the card.
    fillResult = { usernameFilled: false, passwordFilled: false, reason: 'no-password-field' };
    await ui.click(ui.button('Sign in with this account'));
    assert.deepEqual(c.decisions, []);
    const notice = () => ui.doc.querySelector('.error-notice, [role="alert"]')?.textContent || '';
    assert.match(notice(), /The saved login could not be filled on this page\./);
    // The bound page moved off the takeover's page or origin: worded as such.
    fillResult = { usernameFilled: false, passwordFilled: false, reason: 'page-changed' };
    await ui.click(ui.button('Sign in with this account'));
    assert.match(notice(), /The sign-in page changed, so the saved login was not filled\./);
    // Any other failure is the card's own message, never the raw IPC error.
    const raw =
      "Error invoking remote method 'mixdog:browser-credential-fill': Error: savedAccount is not a stored login for https://bank.example";
    fillResult = new Error(raw);
    await ui.click(ui.button('Sign in with this account'));
    assert.match(notice(), /The saved login could not be filled on this page\./);
    assert.ok(!ui.doc.documentElement.textContent.includes('Error invoking remote method'), 'no raw IPC text');
    assert.deepEqual(c.decisions, [], 'every refusal keeps the card');
    fillResult = { usernameFilled: true, passwordFilled: true };
    const second = ui.doc.querySelectorAll('.approval-account input')[1];
    await act(async () => second.click());
    await ui.click(ui.button('Sign in with this account'));
    assert.deepEqual(fills, [
      ['sess-login', 'c1', fillId],
      ['sess-login', 'c1', fillId],
      ['sess-login', 'c1', fillId],
      ['sess-login', 'c2', fillId],
    ]);
    assert.deepEqual(c.decisions, [{ approved: true, response: 'done', reason: 'saved_login' }]);
  } finally {
    await ui.done();
  }
  // "다른 계정 입력": the sign-in window, as today.
  const other = card(loginTakeover('a2', { takeover: { ...loginTakeover('a2').takeover, accounts, fillId } }));
  const ui2 = await mount(other.element);
  try {
    await act(async () => [...ui2.doc.querySelectorAll('.approval-account input')].at(-1).click());
    assert.deepEqual(ui2.rows(), ['Not now', 'Sign in yourself']);
    await ui2.click(ui2.button('Sign in yourself'));
    assert.deepEqual(desktop.calls, [['sess-login', 'a2']]);
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui2.done();
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

// Focus on a stray, non-editable element of the card's own conversation (a
// transcript row), or of another pane; `act` flushes the card's chip state.
function strayElement(parent) {
  const node = dom.window.document.createElement('div');
  node.tabIndex = 0;
  parent.append(node);
  return node;
}
const focusOn = (node) => act(async () => node.focus());
const blurAll = () => act(async () => dom.window.document.activeElement?.blur());

test('keys answer, and the chips show, while focus is on a non-editable element of the same conversation; Esc denies', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  const c = card({ ...comment, id: 'sk1' });
  const ui = await mount(c.element);
  try {
    await settle();
    const section = doc.querySelector('.approval-prompt');
    await focusOn(stray);
    assert.ok(section.dataset.keys, 'the chips show with focus on a transcript element');
    await setWindowFocus(false);
    assert.ok(!section.dataset.keys, 'a window that lost focus shows no chips');
    await ui.key('Enter', {}, stray);
    await ui.key('Escape', {}, stray);
    assert.deepEqual(c.decisions, [], 'and answers no key: a dispatched Enter / Esc does nothing');
    await setWindowFocus(true);
    assert.ok(section.dataset.keys, 'and again when it is back');
    await ui.key('Escape', {}, stray);
    assert.deepEqual(c.decisions, [{ approved: false }], 'Esc denies once');
  } finally {
    await ui.done();
    stray.remove();
  }
});

test('Enter allows from a non-editable element of the same conversation, and when nothing holds focus', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  try {
    for (const focusFirst of [true, false]) {
      const c = card({ ...comment, id: `se${focusFirst}` });
      const ui = await mount(c.element);
      try {
        await settle();
        if (focusFirst) await focusOn(stray);
        else await blurAll();
        assert.ok(doc.querySelector('.approval-prompt').dataset.keys, 'chips on');
        await ui.key('Enter', {}, focusFirst ? stray : doc.body);
        assert.deepEqual(c.decisions, [{ approved: true }]);
      } finally {
        await ui.done();
      }
    }
  } finally {
    stray.remove();
  }
});

test('a focused button, link or widget elsewhere in the pane keeps its own Enter: no approval, its click runs, no chips', async () => {
  const doc = dom.window.document;
  const pane = doc.querySelector('.conversation');
  const make = (tag, attrs = {}) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    pane.append(node);
    return node;
  };
  const controls = [
    make('button', { type: 'button' }),
    make('a', { href: '#row' }),
    make('div', { role: 'button', tabindex: '0' }),
    make('div', { role: 'menuitem', tabindex: '0' }),
    make('span', { role: 'tab', tabindex: '0' }),
  ];
  const plain = [make('div', { role: 'log', tabindex: '0' }), make('div', { tabindex: '0' })];
  const c = card({ ...comment, id: 'ctl1' });
  const ui = await mount(c.element);
  try {
    await settle();
    const section = doc.querySelector('.approval-prompt');
    for (const control of controls) {
      let clicks = 0;
      control.addEventListener('click', () => clicks++);
      control.addEventListener('keydown', (event) => {
        // What the browser does for Enter on a button or link, unless the keydown was cancelled.
        if (!event.defaultPrevented && event.key === 'Enter') control.click();
      });
      await focusOn(control);
      assert.ok(!section.dataset.keys, `no chips on a focused ${control.outerHTML}`);
      await ui.key('Enter', {}, control);
      assert.deepEqual(c.decisions, [], 'Enter does not approve');
      assert.equal(clicks, 1, 'the control still gets its Enter');
    }
    await focusOn(controls[0]);
    await ui.key('Escape', {}, controls[0]);
    assert.deepEqual(c.decisions, [], 'nor does Esc deny');
    for (const element of plain) {
      await focusOn(element);
      assert.ok(section.dataset.keys, `chips on a focused ${element.outerHTML}`);
    }
    await ui.key('Enter', {}, plain[0]);
    assert.deepEqual(c.decisions, [{ approved: true }], 'a non-interactive element still hands Enter to the card');
  } finally {
    await ui.done();
    for (const node of [...controls, ...plain]) node.remove();
  }
});

test('a focused keyboard-owning composite widget or embedded surface keeps its keys: no approval, no chips', async () => {
  const doc = dom.window.document;
  const pane = doc.querySelector('.conversation');
  const make = (tag, attrs = {}, parent = pane) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    parent.append(node);
    return node;
  };
  const inner = (host) => make('span', { tabindex: '0' }, host);
  const widgets = [
    make('div', { role: 'listbox', tabindex: '0' }),
    make('div', { role: 'menu', tabindex: '0' }),
    make('div', { role: 'menubar', tabindex: '0' }),
    make('div', { role: 'tablist', tabindex: '0' }),
    make('div', { role: 'tree', tabindex: '0' }),
    make('div', { role: 'treegrid', tabindex: '0' }),
    make('div', { role: 'grid', tabindex: '0' }),
    make('div', { role: 'radiogroup', tabindex: '0' }),
    make('div', { role: 'toolbar', tabindex: '0' }),
    make('div', { role: 'spinbutton', tabindex: '0' }),
    make('div', { role: 'slider', tabindex: '0' }),
    make('div', { role: 'textbox', tabindex: '0' }),
    make('div', { role: 'searchbox', tabindex: '0' }),
    make('div', { role: 'someFutureWidget', tabindex: '0' }),
    make('div', { 'aria-activedescendant': 'x', tabindex: '0' }),
    make('div', { contenteditable: 'true', tabindex: '0' }),
    make('iframe', { tabindex: '0' }),
    inner(make('div', { class: 'monaco-editor' })),
    inner(make('div', { class: 'xterm' })),
    inner(make('div', { role: 'listbox' })),
    // A role-less focusable child of a keyboard-owning role the list does not name.
    inner(make('div', { role: 'application' })),
    inner(make('div', { role: 'someFutureWidget' })),
  ];
  const c = card({ ...comment, id: 'cw1' });
  const ui = await mount(c.element);
  try {
    await settle();
    const section = doc.querySelector('.approval-prompt');
    for (const widget of widgets) {
      await focusOn(widget);
      assert.equal(doc.activeElement, widget, `${widget.outerHTML} takes focus`);
      assert.ok(!section.dataset.keys, `no chips on ${widget.outerHTML}`);
      await ui.key('Enter', {}, widget);
      await ui.key('Escape', {}, widget);
      assert.deepEqual(c.decisions, [], `no decision from ${widget.outerHTML}`);
    }
  } finally {
    await ui.done();
    for (const node of pane.querySelectorAll(
      '[role], [aria-activedescendant], [contenteditable], iframe, .monaco-editor, .xterm'
    )) {
      if (!node.closest('.approval-prompt')) node.remove();
    }
  }
});

test('the conversation scope itself with an unknown role closes the keys; a passive descendant keeps them', async () => {
  const doc = dom.window.document;
  const pane = doc.querySelector('.conversation');
  const child = doc.createElement('div');
  child.setAttribute('tabindex', '0');
  pane.append(child);
  const c = card({ ...comment, id: 'sr1' });
  const ui = await mount(c.element);
  try {
    await settle();
    await focusOn(child);
    await ui.key('Enter', {}, child);
    assert.deepEqual(c.decisions, [{ approved: true }], 'no role on the scope: Enter answers');
  } finally {
    await ui.done();
  }
  const c2 = card({ ...comment, id: 'sr2' });
  const ui2 = await mount(c2.element);
  pane.setAttribute('role', 'application');
  try {
    await settle();
    await focusOn(child);
    assert.ok(!doc.querySelector('.approval-prompt').dataset.keys, 'no chips');
    await ui2.key('Enter', {}, child);
    await ui2.key('Escape', {}, child);
    assert.deepEqual(c2.decisions, [], 'an unknown role on the scope closes the keys');
  } finally {
    pane.removeAttribute('role');
    await ui2.done();
    child.remove();
  }
});

test('a modal inserted or removed in a nested portal, with no focus change, moves the chips', async () => {
  const doc = dom.window.document;
  const c = card({ ...comment, id: 'np1' });
  const ui = await mount(c.element);
  const pause = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const host = doc.createElement('div');
  const layer = doc.createElement('div');
  const dialog = doc.createElement('section');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  doc.body.append(host);
  try {
    await act(async () => settle());
    const section = doc.querySelector('.approval-prompt');
    assert.ok(section.dataset.keys);
    // Unrelated streaming inserts under the body's subtree change nothing.
    host.append(doc.createElement('p'));
    await pause();
    assert.ok(section.dataset.keys);
    // A dialog three levels down, inside a wrapper that is itself inserted.
    layer.append(doc.createElement('div'));
    layer.firstChild.append(dialog);
    host.append(layer);
    await pause();
    assert.ok(!section.dataset.keys, 'a nested modal arrived: chips off');
    await ui.key('Escape', {}, doc.activeElement);
    assert.deepEqual(c.decisions, []);
    layer.remove();
    await pause();
    assert.ok(section.dataset.keys, 'the nested modal is gone: chips back');
    // A dialog node nested directly under an existing element.
    host.append(dialog);
    await pause();
    assert.ok(!section.dataset.keys);
    dialog.remove();
    await pause();
    assert.ok(section.dataset.keys);
  } finally {
    host.remove();
    await ui.done();
  }
});

test('the chips follow focus when the focused element is removed from the pane', async () => {
  const doc = dom.window.document;
  const control = doc.createElement('button');
  doc.querySelector('.conversation').append(control);
  const ui = await mount(card({ ...comment, id: 'rm1' }).element);
  try {
    await settle();
    await focusOn(control);
    const section = doc.querySelector('.approval-prompt');
    assert.ok(!section.dataset.keys);
    await act(async () => {
      control.remove();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(doc.activeElement, doc.body);
    // jsdom fires no focusout for a removed element; a browser's arrives with no relatedTarget.
    await act(async () => doc.body.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.ok(section.dataset.keys, 'nothing holds focus any more, so the keys are back');
  } finally {
    await ui.done();
  }
});

test('Shift+Enter and Shift+Esc are not Enter and Esc: no approval from the body or a plain pane element', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  const c = card({ ...comment, id: 'sh1' });
  const ui = await mount(c.element);
  try {
    await settle();
    await focusOn(stray);
    await ui.key('Enter', { shiftKey: true }, stray);
    await ui.key('Escape', { shiftKey: true }, stray);
    await blurAll();
    await ui.key('Enter', { shiftKey: true }, doc.body);
    await ui.key('Escape', { shiftKey: true }, doc.body);
    assert.deepEqual(c.decisions, []);
    await ui.key('Enter', {}, doc.body);
    assert.deepEqual(c.decisions, [{ approved: true }], 'plain Enter still allows');
  } finally {
    await ui.done();
    stray.remove();
  }
});

test('the chips wait out the settle window after mount and after any decision, then show', async () => {
  const { noteApprovalDecision } = await import('./approval-prompt.tsx');
  const doc = dom.window.document;
  const ui = await mount(card({ ...comment, id: 'st1' }).element);
  try {
    const section = doc.querySelector('.approval-prompt');
    assert.equal(doc.activeElement, ui.row(2), 'focus is in the card');
    assert.ok(!section.dataset.keys, 'no chips right after mount');
    await act(async () => settle());
    assert.ok(section.dataset.keys, 'chips once settled');
    await act(async () => noteApprovalDecision());
    assert.ok(!section.dataset.keys, 'another card was decided: settling again');
    await ui.key('Escape', {}, doc.activeElement);
    assert.ok(doc.querySelector('.approval-prompt'), 'and Esc is not answered either');
    await act(async () => settle());
    assert.ok(section.dataset.keys, 'chips again once it ends');
  } finally {
    await ui.done();
  }
});

test('an open modal dialog takes the keys and the chips away; a parked one does not', async () => {
  const doc = dom.window.document;
  const c = card({ ...comment, id: 'md1' });
  const ui = await mount(c.element);
  const pause = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const dialog = doc.createElement('section');
  dialog.setAttribute('role', 'dialog');
  try {
    await act(async () => settle());
    const section = doc.querySelector('.approval-prompt');
    assert.ok(section.dataset.keys);
    // Parked (static aria-modal inside an inert / hidden layer): no effect.
    const parked = doc.createElement('div');
    parked.setAttribute('aria-hidden', 'true');
    dialog.setAttribute('aria-modal', 'true');
    parked.append(dialog);
    doc.body.append(parked);
    await pause();
    assert.ok(section.dataset.keys, 'a parked dialog does not count');
    // It opens without any focus change.
    parked.removeAttribute('aria-hidden');
    await pause();
    assert.ok(!section.dataset.keys, 'a presented modal: no chips');
    await ui.key('Escape', {}, doc.activeElement);
    assert.deepEqual(c.decisions, []);
    dialog.setAttribute('aria-modal', 'false');
    await pause();
    assert.ok(section.dataset.keys, 'closed again: chips back');
    // A modal layer mounted and removed with no attribute change or focus move.
    const portal = doc.createElement('div');
    const modal = doc.createElement('section');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    portal.append(modal);
    doc.body.append(portal);
    await pause();
    assert.ok(!section.dataset.keys, 'a mounted modal layer: no chips');
    portal.remove();
    await pause();
    assert.ok(section.dataset.keys, 'the layer removed: chips back');
  } finally {
    dialog.parentElement?.remove();
    await ui.done();
  }
});

test('a card mounting while the window is blurred shows no chips until the window has focus', async () => {
  const doc = dom.window.document;
  windowHasFocus = false;
  const ui = await mount(card({ ...comment, id: 'wb1' }).element);
  try {
    await act(async () => settle());
    const section = doc.querySelector('.approval-prompt');
    assert.ok(!section.dataset.keys);
    await setWindowFocus(true);
    assert.ok(section.dataset.keys);
  } finally {
    windowHasFocus = true;
    await ui.done();
  }
});

test('a settling card takes no Enter from the pane either', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  const c = card({ ...comment, id: 'ss1' });
  const ui = await mount(c.element);
  try {
    await focusOn(stray);
    await ui.key('Enter', {}, stray);
    assert.deepEqual(c.decisions, [], 'right after the card appears');
  } finally {
    await ui.done();
    stray.remove();
  }
});

test('the composer keeps Enter: a draft there turns the keys and chips off', async () => {
  const doc = dom.window.document;
  const { row, input } = composerRow(doc);
  const stray = strayElement(doc.querySelector('.conversation'));
  const c = card({ ...comment, id: 'sc1' });
  const ui = await mount(c.element);
  try {
    await settle();
    const section = doc.querySelector('.approval-prompt');
    await focusOn(stray);
    assert.ok(section.dataset.keys);
    input.value = 'half a thought';
    await focusOn(input);
    assert.ok(!section.dataset.keys, 'no chips in the composer');
    await ui.key('Enter', {}, input);
    await ui.key('Escape', {}, input);
    assert.deepEqual(c.decisions, []);
  } finally {
    await ui.done();
    row.remove();
    stray.remove();
  }
});

test('focus in another pane gives this pane no key and no chips', async () => {
  const doc = dom.window.document;
  const paneA = doc.createElement('section');
  paneA.className = 'pane-leaf conversation';
  const elsewhere = strayElement(paneA);
  doc.body.append(paneA);
  const c = card({ ...comment, id: 'sp1' });
  const ui = await mount(c.element);
  try {
    await settle();
    await focusOn(elsewhere);
    assert.ok(!doc.querySelector('.approval-prompt').dataset.keys);
    await ui.key('Enter', {}, elsewhere);
    await ui.key('Escape', {}, elsewhere);
    assert.deepEqual(c.decisions, []);
    const sidebar = strayElement(doc.body);
    await focusOn(sidebar);
    assert.ok(!doc.querySelector('.approval-prompt').dataset.keys, 'nor with focus outside every pane');
    await ui.key('Escape', {}, sidebar);
    assert.deepEqual(c.decisions, []);
    sidebar.remove();
  } finally {
    await ui.done();
    paneA.remove();
  }
});

test('Enter never allows a payment from the pane; Esc still denies it', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  const pay = card({
    ...comment,
    id: 'sy1',
    remember: ['once'],
    outbound: {
      category: 'payment',
      target: 'Notion Labs',
      payload: '',
      editable: [],
      details: { merchant: 'Notion Labs', amount: '12900', currency: 'KRW' },
    },
  });
  const ui = await mount(pay.element);
  try {
    await settle();
    await focusOn(stray);
    await ui.key('Enter', {}, stray);
    assert.deepEqual(pay.decisions, []);
    await ui.key('Escape', {}, stray);
    assert.deepEqual(pay.decisions, [{ approved: false }]);
  } finally {
    await ui.done();
    stray.remove();
  }
});

test('two undecided cards in one pane: one key makes one decision, by the newest card, and only it shows chips', async () => {
  const doc = dom.window.document;
  const stray = strayElement(doc.querySelector('.conversation'));
  const first = card({ ...comment, id: 'tw1' });
  const second = card({ ...comment, id: 'tw2' });
  const ui = await mount(React.createElement(React.Fragment, null, first.element, second.element));
  try {
    await settle();
    await focusOn(stray);
    const [one, two] = doc.querySelectorAll('.approval-prompt');
    assert.ok(!one.dataset.keys, 'the older card shows no chips');
    assert.ok(two.dataset.keys, 'the newest card shows them');
    await ui.key('Enter', {}, stray);
    assert.equal(first.decisions.length + second.decisions.length, 1, 'one decision from one key');
    assert.deepEqual(second.decisions, [{ approved: true }]);
  } finally {
    await ui.done();
    stray.remove();
  }
  const a = card({ ...comment, id: 'tw3' });
  const b = card({ ...comment, id: 'tw4' });
  const both = await mount(React.createElement(React.Fragment, null, a.element, b.element));
  const stray2 = strayElement(doc.querySelector('.conversation'));
  try {
    await settle();
    await focusOn(stray2);
    await both.key('Escape', {}, stray2);
    assert.equal(a.decisions.length + b.decisions.length, 1, 'Esc decides once as well');
  } finally {
    await both.done();
    stray2.remove();
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

function composerRow(doc) {
  const row = doc.createElement('div');
  row.className = 'composer-input-row';
  const input = doc.createElement('textarea');
  row.append(input);
  doc.querySelector('.conversation').append(row);
  return { row, input };
}

test('desktop: a card arriving while the composer is empty takes focus (chips show, keys answer) and gives it back once decided', async () => {
  const doc = dom.window.document;
  const { row, input } = composerRow(doc);
  try {
    input.focus();
    const c = card({ ...comment, id: 'df1' });
    const ui = await mount(c.element);
    try {
      const section = doc.querySelector('.approval-prompt');
      assert.equal(doc.activeElement, ui.button('Allow just once'), 'the empty composer let go; the allow has focus');
      assert.ok(!section.dataset.keys, 'still settling: no chips yet');
      assert.ok(ui.row(0).querySelector('.approval-kbd'), 'the Esc chip is there');
      await act(async () => settle());
      assert.ok(section.dataset.keys, 'focus is inside the card, so the Enter / Esc chips are shown');
      await ui.key('Escape');
      assert.deepEqual(c.decisions, [{ approved: false }], 'Esc answers the card');
    } finally {
      await ui.done();
    }
    assert.equal(doc.activeElement, input, 'the composer has focus again for typing');
    const again = card({ ...comment, id: 'df2' });
    const ui2 = await mount(again.element);
    await settle();
    await ui2.click(ui2.button('Allow just once'));
    assert.deepEqual(again.decisions, [{ approved: true }]);
    // The host drops the answered card.
    await ui2.done();
    assert.equal(doc.activeElement, input, 'after a click decision the composer has focus again');
  } finally {
    row.remove();
  }
});

test('desktop: a card arriving mid-IME-composition on an empty composer does not steal focus', async () => {
  const { useComposerIme } = await import('./use-composer-ime.ts');
  const doc = dom.window.document;
  const row = doc.createElement('div');
  row.className = 'composer-input-row';
  doc.querySelector('.conversation').append(row);
  const host = doc.createElement('div');
  row.append(host);
  dom.window.cancelAnimationFrame ??= () => {};
  dom.window.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const composerRoot = createRoot(host);
  function Composer() {
    const textarea = React.useRef(null);
    useComposerIme({
      textarea,
      composingRef: React.useRef(false),
      suppressImeLineBreakRef: React.useRef(false),
      draftRef: React.useRef(''),
      setDraft: () => {},
      setCaretOffset: () => {},
    });
    return React.createElement('textarea', { ref: textarea });
  }
  try {
    await act(async () => composerRoot.render(React.createElement(Composer)));
    const input = host.querySelector('textarea');
    input.focus();
    await act(async () => input.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true })));
    const c = card({ ...comment, id: 'ime1' });
    const ui = await mount(c.element);
    try {
      assert.equal(doc.activeElement, input, 'the composing composer keeps focus');
    } finally {
      await ui.done();
    }
  } finally {
    await act(async () => composerRoot.unmount());
    row.remove();
  }
});

test('desktop: a composer holding a draft keeps focus and the card answers no key', async () => {
  const doc = dom.window.document;
  const { row, input } = composerRow(doc);
  try {
    input.focus();
    input.value = 'half a thought';
    const c = card({ ...comment, id: 'df3' });
    const ui = await mount(c.element);
    try {
      assert.equal(doc.activeElement, input, 'the draft keeps the caret');
      assert.ok(!doc.querySelector('.approval-prompt').dataset.keys, 'chips stay hidden');
      await settle();
      await ui.key('Escape', {}, input);
      assert.deepEqual(c.decisions, []);
    } finally {
      await ui.done();
    }
    assert.equal(doc.activeElement, input);
  } finally {
    row.remove();
  }
});

test('desktop: a card in another pane leaves the focused empty composer of the typing pane alone', async () => {
  const doc = dom.window.document;
  const paneA = doc.createElement('section');
  paneA.className = 'pane-leaf conversation';
  const row = doc.createElement('div');
  row.className = 'composer-input-row';
  const input = doc.createElement('textarea');
  row.append(input);
  paneA.append(row);
  doc.body.append(paneA);
  try {
    input.focus();
    // The card mounts in the harness root, inside pane B's .conversation.
    const c = card({ ...comment, id: 'tp1' });
    const ui = await mount(c.element);
    try {
      assert.equal(doc.activeElement, input, 'pane A keeps the caret');
      assert.ok(!doc.querySelector('.approval-prompt').dataset.keys, 'the chips stay hidden');
    } finally {
      await ui.done();
    }
    assert.equal(doc.activeElement, input);
  } finally {
    paneA.remove();
  }
});

test('a press on the card body does not pull focus to the composer (which hid the chips right after the click)', async () => {
  const { shouldFocusSurfaceInput } = await import('./surface-input-focus.ts');
  const doc = dom.window.document;
  const ui = await mount(card({ ...comment, id: 'fl1' }).element);
  try {
    const press = (target) => shouldFocusSurfaceInput({ button: 0, defaultPrevented: false, target }, '.transcript');
    assert.equal(press(doc.querySelector('.approval-title')), false, 'the title text keeps focus on the card');
    assert.equal(press(doc.querySelector('.approval-prompt')), false, 'the card itself too');
    assert.equal(press(doc.querySelector('.conversation')), true, 'the empty pane still focuses the composer');
  } finally {
    await ui.done();
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

test('a request of a session this chat handed work to: the amber target chip beside who asks, its session one click away', async () => {
  // As the runtime copies a task session's request into the bot chat that created it.
  const handed = {
    id: 'h1',
    name: 'shell',
    kind: 'approval',
    agentId: 'lead',
    args: { command: 'npm test' },
    remember: ['once'],
    chain: [],
    sessionId: 'sess_task',
    surfaceSessionId: 'sess_home_github-watcher',
    handoff: { title: 'Fix login' },
  };
  const { ApprovalOpenSessionContext } = await import('./approval-prompt.tsx');
  const docked = [];
  const opened = [];
  const onOpen = (event) => opened.push(event.detail.sessionId);
  dom.window.addEventListener('mixdog:open-task-session', onOpen);
  // The app's opener dispatches this window's event.
  const nodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = dom.window.CustomEvent;
  let ui = await mount(
    React.createElement(
      ApprovalOpenSessionContext.Provider,
      { value: (id) => docked.push(id) },
      card(handed, { agentMode: true, hostSessionId: 'sess_home_github-watcher' }).element
    )
  );
  try {
    // The task session asks as in its own pane: the Lead, not the bot of this chat.
    assert.ok(ui.doc.querySelector('.approval-face .approval-lead-mark'));
    assert.deepEqual(
      [...ui.doc.querySelectorAll('.approval-who .approval-chip-name')].map((node) => node.textContent),
      ['Lead', 'Fix login']
    );
    const chip = ui.doc.querySelector('.approval-target-chip');
    assert.equal(chip.querySelector('.approval-target-mark').textContent, '▣');
    assert.equal(chip.title, 'Fix login');
    await ui.click(ui.doc.querySelector('.approval-who .approval-link'));
    assert.deepEqual(opened, ['sess_task'], 'opened as any session');
    assert.deepEqual(docked, [], 'never as a sub-agent of this chat');
  } finally {
    await ui.done();
  }
  // In the task session's own pane: no target chip and no link to itself.
  ui = await mount(card({ ...handed, id: 'h2' }, { hostSessionId: 'sess_task' }).element);
  try {
    assert.equal(ui.doc.querySelector('.approval-target-chip'), null);
    assert.equal(ui.doc.querySelector('.approval-who .approval-link'), null);
  } finally {
    await ui.done();
  }
  // Another bot's chat is named by that bot's face and name, once.
  const botChat = {
    ...comment,
    id: 'h3',
    agentId: 'github-watcher',
    chain: [],
    sessionId: 'sess_home_github-watcher',
    surfaceSessionId: 'sess_home_mailer',
    handoff: { title: 'GitHub', agentId: 'github-watcher' },
  };
  ui = await mount(card(botChat, { agentMode: true, hostSessionId: 'sess_home_mailer' }).element);
  try {
    assert.deepEqual(
      [...ui.doc.querySelectorAll('.approval-who .approval-chip-name')].map((node) => node.textContent),
      ['github-watcher']
    );
    assert.ok(ui.doc.querySelector('.approval-target-chip .approval-chip-face'));
    assert.equal(ui.doc.querySelector('.approval-target-mark'), null);
  } finally {
    await ui.done();
    dom.window.removeEventListener('mixdog:open-task-session', onOpen);
    globalThis.CustomEvent = nodeCustomEvent;
  }
});

test("a docked hand-off copy keeps the card's risk gates: a payment is pointer-only, keys wait out the settle window", async () => {
  const pay = card(
    {
      ...comment,
      id: 'hp1',
      agentId: 'github-watcher',
      remember: ['once'],
      outbound: { category: 'payment', target: 'Notion Labs', payload: '', editable: [], details: {} },
      chain: [],
      sessionId: 'sess_home_github-watcher',
      surfaceSessionId: 'sess_home_mailer',
      handoff: { title: 'GitHub', agentId: 'github-watcher' },
    },
    { agentMode: true, hostSessionId: 'sess_home_mailer' }
  );
  const ui = await mount(pay.element);
  try {
    assert.ok(ui.doc.querySelector('.approval-target-chip'), 'docked as a hand-off');
    assert.equal(ui.doc.querySelector('.approval-prompt').dataset.tone, 'need');
    const allow = ui.button('Allow payment');
    assert.equal(allow.dataset.tone, 'primary');
    assert.equal(allow.dataset.pointerOnly, 'true');
    assert.equal(ui.doc.activeElement, ui.row(0), 'focus starts on Deny');
    ui.doc.activeElement.blur();
    await ui.key('Escape', {}, ui.doc.body);
    assert.deepEqual(pay.decisions, [], 'a key right after the card appears does nothing');
    await settle();
    await ui.key('Enter', {}, ui.doc.body);
    assert.deepEqual(pay.decisions, [], 'Enter never allows a payment');
    await ui.key('Escape', {}, ui.doc.body);
    assert.deepEqual(pay.decisions, [{ approved: false }], 'Esc denies once settled');
  } finally {
    await ui.done();
  }
});

test("a delegated request's chain label: tokens in this UI's language, nothing for a lone requester", async () => {
  const { approvalChainLabel } = await import('./ApprovalCard.tsx');
  assert.equal(approvalChainLabel(['사무관', 'Worker']), '사무관 › Worker');
  assert.equal(approvalChainLabel(['Lead', 'Reviewer']), 'Lead › Reviewer');
  assert.equal(approvalChainLabel(['Lead', 'Worker', 'Reviewer']), 'Lead › Worker › Reviewer');
  assert.equal(approvalChainLabel(['사무관']), '');
  assert.equal(approvalChainLabel(undefined), '');
  // The card's once button, as the maintainer words it.
  const { readFileSync } = await import('node:fs');
  const locales = new URL('./locales/', import.meta.url);
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
