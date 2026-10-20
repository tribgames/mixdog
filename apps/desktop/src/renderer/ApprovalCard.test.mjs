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
    value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
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
  return {
    doc,
    rows: () => [...doc.querySelectorAll('.question-option')].map((row) => row.textContent),
    row: (index) => doc.querySelectorAll('.question-option')[index],
    click: (node) => act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))),
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

test('an outbound post: target, editable preview with "수정됨 · 원본으로", and the three rows', async () => {
  const c = card(comment);
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.question-title strong').textContent, 'Post a comment');
    assert.equal(ui.doc.querySelector('.question-target-main').textContent, '22nsuk/mixdog#120');
    assert.deepEqual(
      ui.rows().map((text) => text.replace(/\d$/, '')),
      ['Just this once', "Don't ask againApplies only to github-watcher's Post a comment", 'Cancel']
    );
    const box = ui.doc.querySelector('.question-other textarea');
    await ui.type(box, 'Edited text');
    assert.match(ui.doc.querySelector('.question-edit-row').textContent, /Edited.*Back to original/);
    await ui.click(ui.doc.querySelector('.question-edit-row button'));
    assert.equal(box.value, 'LGTM');
    await ui.type(box, 'Final');
    await ui.click(ui.row(0));
    assert.deepEqual(c.decisions, [{ approved: true, response: 'edit-and-approve', editedArgs: { body: 'Final' } }]);
  } finally {
    await ui.done();
  }
});

test('a coding session never names the bot: the Lead goes unnamed, a bot chat names its bot', async () => {
  const lead = { ...comment, id: 'l1', agentId: 'lead' };
  const rowsOf = (ui) => ui.rows().map((text) => text.replace(/\d$/, ''));
  let ui = await mount(card(lead).element);
  try {
    assert.equal(ui.doc.querySelector('.question-meta'), null);
    assert.equal(rowsOf(ui)[1], "Don't ask againApplies only to Lead's Post a comment");
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...lead, id: 'l2' }, { agentMode: true }).element);
  try {
    assert.equal(ui.doc.querySelector('.question-meta').textContent, 'Mixy');
  } finally {
    await ui.done();
  }
});

test('"다시 묻지 않기" resolves with the agent scope and shows no toast', async () => {
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail);
  dom.window.addEventListener('mixdog:desktop-toast', onToast);
  const c = card({ ...comment, id: 'a2' });
  const ui = await mount(c.element);
  try {
    await ui.click(ui.row(1));
    assert.deepEqual(c.decisions, [{ approved: true, remember: 'agent' }]);
    assert.deepEqual(toasts, []);
  } finally {
    dom.window.removeEventListener('mixdog:desktop-toast', onToast);
    await ui.done();
  }
});

test('email shows account, to, cc, subject and the body; payment and delete have no remember row', async () => {
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
    assert.match(ui.doc.querySelector('.question-target').textContent, /Sent as me@example\.com/);
    assert.equal(
      ui.doc.querySelector('.question-fields').textContent,
      'Tokim@example.comCcpark@example.comSubjectRelease'
    );
    assert.equal(ui.doc.querySelector('.question-other textarea').value, 'Hello');
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
    const amount = ui.doc.querySelector('.question-amount b').textContent;
    assert.match(amount, /12,900/);
    assert.match(ui.doc.querySelector('.question-amount').textContent, /KRW · monthly/);
    assert.equal(ui.rows().length, 2);
    assert.equal(ui.rows()[0].replace(/\d$/, ''), `Pay ${amount}`);
    assert.doesNotMatch(ui.doc.body.textContent, /Don't ask again/);
    await ui.click(ui.row(0));
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
    assert.equal(ui.doc.querySelector('.question-amount b').textContent, '48 items · 1.2GB');
    assert.deepEqual(
      ui.rows().map((text) => text.replace(/\d$/, '')),
      ['Delete 48 permanently', 'Cancel']
    );
    await ui.click(ui.row(1));
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
    const text = ui.doc.querySelector('.question-target').textContent;
    assert.match(text, /Kim · Hello · 2026-01-02/);
    assert.match(text, /Park · Re: Plan/);
    assert.match(text, /and 2 more/);
    assert.match(text, /Mail in me@gmail\.com/);
    assert.doesNotMatch(text, /Sent as|^1, 2/);
  } finally {
    await ui.done();
  }
});

test('takeover: "I\'ll do it" turns into "I\'m done", which answers done', async () => {
  const c = card({
    id: 't1',
    name: 'ask_user',
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'Sign in' },
  });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.question-text').textContent, 'Sign in');
    await ui.click(ui.row(0));
    assert.deepEqual(c.decisions, []);
    assert.equal(ui.rows()[0].replace(/\d$/, ''), "I'm done");
    await ui.click(ui.row(0));
    assert.deepEqual(c.decisions, [{ approved: true, response: 'done' }]);
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
    assert.equal(ui.rows()[0], 'Stopping the agent…1');
    assert.equal(ui.row(0).disabled, true);
    await settle();
    await ui.key('1', {}, ui.doc.querySelector('.question-card'));
    assert.equal(ui.rows()[0], 'Stopping the agent…1', 'the key cannot start it either');
    await act(async () => markReady(true));
    assert.equal(ui.rows()[0], "I'll do it1");
    await ui.click(ui.row(0));
    assert.equal(ui.rows()[0], "I'm done1");
    assert.deepEqual(c.decisions, [], 'done never comes from readiness alone');
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

test('a browser takeover offers "Import again from Chrome" as its own numbered row, which keeps the card open', async () => {
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
    assert.deepEqual(ui.rows(), ["I'll do it1", 'Import again from Chrome2', 'Cancel3']);
    await ui.click(ui.row(1));
    assert.deepEqual(imports, ['sess-t']);
    assert.deepEqual(c.decisions, []);
    assert.equal(ui.rows().length, 3);
  } finally {
    stop();
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('the card head names the requesting agent in agent mode and nobody for a coding session', async () => {
  const takeover = {
    id: 't3',
    name: 'ask_user',
    kind: 'takeover',
    takeover: { surface: 'browser', instructions: 'x' },
  };
  let ui = await mount(card(takeover).element);
  try {
    assert.equal(ui.doc.querySelector('.question-meta')?.textContent ?? '', '');
  } finally {
    await ui.done();
  }
  ui = await mount(card(takeover, { agentMode: true }).element);
  try {
    assert.notEqual(ui.doc.querySelector('.question-meta')?.textContent ?? '', '');
  } finally {
    await ui.done();
  }
  ui = await mount(card({ ...comment, id: 'a9' }).element);
  try {
    assert.match(ui.doc.querySelector('.question-meta').textContent, /github-watcher/);
  } finally {
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

test('a login takeover is one head line with 로그인하기 / 취소, and its window decides what the card says next', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  dom.window.mixdogDesktop = desktop.api;
  const c = card(loginTakeover('l1'));
  const ui = await mount(c.element);
  const title = () => ui.doc.querySelector('.question-title strong').textContent;
  try {
    assert.equal(title(), 'example.com sign-in required');
    assert.equal(ui.doc.querySelector('.question-meta'), null, 'a coding session names no agent');
    assert.equal(ui.doc.querySelector('.question-text'), null, 'no body line: head and rows only');
    assert.deepEqual(ui.rows(), ['Sign in…1', 'Cancel2']);
    await ui.click(ui.row(0));
    assert.deepEqual(desktop.calls, [['sess-login', 'l1']], 'bound to this takeover of this session');
    assert.equal(ui.doc.querySelector('.question-card').dataset.login, 'open');
    assert.deepEqual(ui.rows(), [], 'while the window is open the card is its head alone');
    // 닫기 or the OS close: still pending, offered again; never a decision.
    await desktop.end({ state: 'closed' });
    assert.equal(title(), 'Not signed in');
    assert.deepEqual(ui.rows(), ['Sign in again…1', 'Cancel2']);
    assert.deepEqual(c.decisions, []);
    // Google-style refusal of an embedded sign-in: the Chrome import instead.
    await ui.click(ui.row(0));
    await desktop.end({ state: 'refused', provider: 'Google' });
    assert.equal(title(), 'Google does not allow sign-in in this window');
    assert.equal(ui.doc.querySelector('.question-text').textContent, 'You can import the account signed in to Chrome.');
    assert.deepEqual(ui.rows(), ['Import again from Chrome1', 'Cancel2']);
    assert.deepEqual(c.decisions, []);
    await ui.click(ui.row(1));
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
    assert.notEqual(ui.doc.querySelector('.question-meta')?.textContent ?? '', '', 'agent mode names the agent');
    await ui.click(ui.row(0));
    await desktop.end({ state: 'done' });
    const head = ui.doc.querySelector('.question-card');
    assert.equal(head.dataset.settled, 'true');
    assert.equal(ui.doc.querySelector('.question-title strong').textContent, 'Signed in');
    assert.equal(ui.doc.querySelector('.question-meta').textContent, 'example.com');
    assert.equal(ui.doc.querySelector('.question-icon').dataset.tone, 'done');
    assert.deepEqual(ui.rows(), []);
    assert.deepEqual(c.decisions, [], 'the main process settled it, not the card');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('a login card waits for the agent to stop before 로그인하기 can open anything', async () => {
  const previous = dom.window.mixdogDesktop;
  const desktop = loginDesktop();
  let markReady;
  desktop.api.takeoverReady = () =>
    new Promise((resolve) => {
      markReady = resolve;
    });
  dom.window.mixdogDesktop = desktop.api;
  const ui = await mount(card(loginTakeover('l3')).element);
  try {
    assert.equal(ui.rows()[0], 'Stopping the agent…1');
    assert.equal(ui.row(0).disabled, true);
    await settle();
    await ui.key('1', {}, ui.doc.querySelector('.question-card'));
    assert.deepEqual(desktop.calls, []);
    await act(async () => markReady(true));
    assert.equal(ui.rows()[0], 'Sign in…1');
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
    assert.equal(ui.doc.querySelector('.question-title strong').textContent, 'Sign in on your PC');
    assert.equal(ui.doc.querySelector('.question-text').textContent, 'The agent continues once you finish signing in.');
    assert.ok(ui.doc.querySelector('.progress-spinner'));
    assert.deepEqual(ui.rows(), []);
    assert.equal(ui.doc.querySelector('.question-close'), null);
    assert.equal(ui.doc.querySelector('.question-card').dataset.login, 'remote');
  } finally {
    dom.window.mixdogDesktop = previous;
    await ui.done();
  }
});

test('a plain tool approval runs once or cancels', async () => {
  const c = card({ id: 'g1', name: 'shell', kind: 'approval', args: { command: 'npm ci' }, reason: 'Hook asks' });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.approval-detail').textContent, 'npm ci');
    assert.deepEqual(
      ui.rows().map((text) => text.replace(/\d$/, '')),
      ['Just this once', 'Cancel']
    );
    await ui.click(ui.row(1));
    assert.deepEqual(c.decisions, [{ approved: false }]);
  } finally {
    await ui.done();
  }
});

test('keys follow the QuestionCard model: 1–3 act, never while typing, never a held or immediate key; Esc folds to the chip', async () => {
  const c = card({ ...comment, id: 'k1' });
  const ui = await mount(c.element);
  try {
    const cardNode = ui.doc.querySelector('.question-card');
    assert.equal(ui.doc.activeElement, cardNode, 'the card takes focus when nothing holds it');
    await ui.key('1');
    assert.deepEqual(c.decisions, [], 'a key right after the card appears does nothing');
    await settle();
    await ui.key('1', { repeat: true });
    assert.deepEqual(c.decisions, [], 'a held (repeating) key does nothing');
    const box = ui.doc.querySelector('.question-other textarea');
    box.focus();
    await ui.key('3', {}, box);
    assert.deepEqual(c.decisions, [], 'shortcuts are off while typing');
    cardNode.focus();
    await ui.key('Escape');
    assert.equal(ui.doc.querySelector('.question-card'), null);
    const chip = ui.doc.querySelector('.question-chip');
    assert.match(chip.textContent, /Approval pending · Post a comment.*Open/);
    assert.deepEqual(c.decisions, [], '✕ keeps the request pending');
    await ui.click(chip);
    assert.ok(ui.doc.querySelector('.question-card'));
    await settle();
    ui.doc.querySelector('.question-card').focus();
    await ui.key('3');
    assert.deepEqual(c.decisions, [{ approved: false }]);
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
    await ui.key('1', {}, input);
    assert.deepEqual(c.decisions, []);
  } finally {
    await ui.done();
    input.remove();
  }
});

test('answered on another device: disabled, saying who answered', async () => {
  const c = card({ ...comment, id: 's1' }, { settled: { approved: true, device: 'Pixel' } });
  const ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.question-foot').textContent, 'Allowed from Pixel');
    assert.ok([...ui.doc.querySelectorAll('.question-option')].every((row) => row.disabled));
  } finally {
    await ui.done();
  }
});

test('agent mode marks the question card and the approval card the same way', async () => {
  const c = card({ ...comment, id: 'w1' }, { agentMode: true });
  let ui = await mount(c.element);
  try {
    assert.equal(ui.doc.querySelector('.question-card').dataset.agentMode, 'true');
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
