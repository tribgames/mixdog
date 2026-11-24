import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/', pretendToBeVisual: true });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let answer = async () => true;
dom.window.mixdogDesktop = { resolveToolApprovalForSession: (...args) => answer(...args) };
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useConversationApprovals, conversationIslandFlash } = await import('./use-conversation-approvals.tsx');

const shell = { id: 'ap-1', kind: 'approval', name: 'shell', args: { command: 'ls' } };

async function mountHook(sessionId) {
  const routeSessionIdRef = { current: sessionId };
  const state = { approvals: null };
  function Harness({ snapshot }) {
    state.approvals = useConversationApprovals(snapshot, routeSessionIdRef);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const show = (snapshot) => act(async () => root.render(React.createElement(Harness, { snapshot })));
  await show({ sessionId, items: [], toolApproval: shell });
  return {
    state,
    show,
    route: (id) => {
      routeSessionIdRef.current = id;
    },
    flash: () => conversationIslandFlash(state.approvals.retiredApproval, null, 'DESKTOP-7'),
    done: () => act(async () => root.unmount()),
  };
}

test("this PC's answer is traced in its own chat only: switching chats inside the window drops it", async () => {
  answer = async () => true;
  const ui = await mountHook('s1');
  try {
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    await ui.show({ sessionId: 's1', items: [], toolApproval: null });
    assert.equal(ui.flash()?.text, 'Run a command · Allowed');
    await ui.show({ sessionId: 's2', items: [], toolApproval: null });
    assert.equal(ui.flash(), null, 'another chat shows no trace');
    await ui.show({ sessionId: 's1', items: [], toolApproval: null });
    assert.equal(ui.flash(), null, 'and coming back inside the window does not revive it');
  } finally {
    await ui.done();
  }
});

test("this PC's trace outlives its own resolved state and ends when the server resolves another approval", async () => {
  answer = async () => true;
  const ui = await mountHook('s1');
  try {
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    const own = { id: 'ap-1', approved: true, device: '' };
    await ui.show({ sessionId: 's1', items: [], toolApproval: null, toolApprovalResult: own });
    assert.equal(ui.flash()?.text, 'Run a command · Allowed', 'its own resolved state keeps the trace');
    await ui.show({ sessionId: 's1', items: [], toolApproval: null, toolApprovalResult: { ...own, id: 'ap-9' } });
    assert.equal(ui.flash(), null, "another approval's resolved state retired it");
  } finally {
    await ui.done();
  }
});

test("a result already published before the answer does not retire the answer's trace", async () => {
  answer = async () => true;
  const ui = await mountHook('s1');
  try {
    await ui.show({
      sessionId: 's1',
      items: [],
      toolApproval: shell,
      toolApprovalResult: { id: 'ap-0', approved: true, device: '' },
    });
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    await ui.show({
      sessionId: 's1',
      items: [],
      toolApproval: null,
      toolApprovalResult: { id: 'ap-0', approved: true, device: '' },
    });
    assert.equal(ui.flash()?.text, 'Run a command · Allowed');
  } finally {
    await ui.done();
  }
});

// A task session's request shown in the delegating bot chat's dock ("docked copy"):
// it names the task as its own session and the bot chat as the surface.
const dockedCopy = { ...shell, sessionId: 'task', surfaceSessionId: 'bot' };
const next = { id: 'ap-2', kind: 'approval', name: 'shell', args: { command: 'pwd' } };
const nextCopy = { ...next, sessionId: 'task', surfaceSessionId: 'bot' };

for (const [label, pane, first, second] of [
  ['own approval', 's1', shell, next],
  ['docked copy', 'bot', dockedCopy, nextCopy],
]) {
  test(`${label}: this PC's answer is traced the same whether or not another approval is queued`, async () => {
    answer = async () => true;
    const ui = await mountHook(pane);
    try {
      await ui.show({ sessionId: pane, items: [], toolApproval: first, toolApprovalsWaiting: 1 });
      await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: false }));
      // The next request takes the dock at once; the trace is still recorded for the island.
      await ui.show({ sessionId: pane, items: [], toolApproval: second });
      assert.equal(ui.state.approvals.approvalDock.props.approval.id, 'ap-2');
      assert.equal(ui.flash()?.text, 'Run a command · Denied');
      assert.equal(ui.flash()?.key, 'retired:ap-1');
      // Nothing queued any more: the trace is what the island shows.
      await ui.show({ sessionId: pane, items: [], toolApproval: null });
      assert.equal(ui.flash()?.text, 'Run a command · Denied');
    } finally {
      await ui.done();
    }
  });
}

test('a refused answer claims another device only when the core published the request as decided; otherwise the pane reads its state again', async () => {
  const resynced = [];
  dom.window.mixdogDesktop.resyncSessionState = (id) => resynced.push(id);
  answer = async () => false;
  const ui = await mountHook('s1');
  try {
    // This connection simply does not hold the request: nothing says another device decided it.
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    assert.equal(ui.state.approvals.answeredElsewhere, null);
    assert.deepEqual(resynced, ['s1']);
    assert.ok(ui.state.approvals.approvalDock, 'the card stays answerable');
    // The core reports it decided by another device: now the notice is true.
    await ui.show({
      sessionId: 's1',
      items: [],
      toolApproval: shell,
      toolApprovalResult: { id: 'ap-1', approved: true, device: 'Pixel' },
    });
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    assert.equal(ui.state.approvals.answeredElsewhere?.id, 'ap-1');
    assert.deepEqual(resynced, ['s1'], 'no further refresh once the core says it is decided');
  } finally {
    delete dom.window.mixdogDesktop.resyncSessionState;
    await ui.done();
  }
});

test('a refusal names the device the core published while the answer travelled; the notice ends with that request and that chat', async () => {
  // Every prompt came from this PC: only the approval was answered on the phone.
  const items = [{ kind: 'user', id: 'u1', text: 'from here', device: 'DESKTOP-7' }];
  let refuse;
  answer = () => new Promise((resolve) => (refuse = resolve));
  const ui = await mountHook('s1');
  const notice = () =>
    conversationIslandFlash(ui.state.approvals.retiredApproval, ui.state.approvals.answeredElsewhere, 'DESKTOP-7');
  try {
    await ui.show({ sessionId: 's1', items, toolApproval: shell });
    let pending;
    await act(async () => {
      pending = ui.state.approvals.approvalDock.props.resolve({ approved: true });
    });
    // The phone's decision is published while this device's answer is on its way.
    const decided = {
      sessionId: 's1',
      items,
      toolApproval: shell,
      toolApprovalResult: { id: 'ap-1', approved: true, device: 'Pixel' },
    };
    await ui.show(decided);
    await act(async () => {
      refuse(false);
      await pending;
    });
    assert.equal(notice()?.text, 'Resolved on another device · from Pixel');
    assert.equal(ui.state.approvals.approvalDock, null, 'the decided request is no longer offered');
    // The request leaves; a later request under the same id is offered again.
    await ui.show({ ...decided, toolApproval: null });
    await ui.show(decided);
    assert.ok(ui.state.approvals.approvalDock, 'the reissued id shows its card');
    assert.equal(ui.state.approvals.answeredElsewhere, null);
    // Refused again, then the pane moves to a chat whose own request has the same id.
    answer = async () => false;
    await act(async () => ui.state.approvals.approvalDock.props.resolve({ approved: true }));
    assert.equal(ui.state.approvals.answeredElsewhere?.id, 'ap-1');
    ui.route('s2');
    await ui.show({ sessionId: 's2', items: [], toolApproval: shell });
    assert.equal(ui.state.approvals.answeredElsewhere, null, 'another chat shows no notice');
    assert.ok(ui.state.approvals.approvalDock, 'and offers its own request');
  } finally {
    await ui.done();
  }
});

async function mountCard(sessionId) {
  const routeSessionIdRef = { current: sessionId };
  const host = document.getElementById('root');
  function Harness({ snapshot }) {
    return useConversationApprovals(snapshot, routeSessionIdRef).approvalDock;
  }
  const root = createRoot(host);
  const show = (snapshot) => act(async () => root.render(React.createElement(Harness, { snapshot })));
  await show({ sessionId, items: [], toolApproval: shell });
  const buttons = () => [...host.querySelectorAll('.approval-prompt .approval-buttons .approval-button')];
  return { show, buttons, host, done: () => act(async () => root.unmount()) };
}
const click = (node) =>
  act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 })));

test("after a refusal the core did not confirm, the card shows the client's current truth: gone when no longer held", async () => {
  answer = async () => false;
  const ui = await mountCard('s1');
  try {
    const asked = [];
    dom.window.mixdogDesktop.resyncSessionState = async (id, options) => {
      asked.push([id, options]);
      return true;
    };
    assert.ok(ui.buttons().length > 0);
    await click(ui.buttons()[0]);
    assert.deepEqual(asked, [['s1', { fresh: true }]]);
    // The fresh projection arrives without the request.
    await ui.show({ sessionId: 's1', items: [], toolApproval: null });
    assert.equal(ui.buttons().length, 0, 'the request is no longer held: the card disappears');
    assert.equal(ui.host.textContent.includes('another device'), false);
  } finally {
    delete dom.window.mixdogDesktop.resyncSessionState;
    await ui.done();
  }
});

test('after a refusal the core did not confirm, a request still held leaves the card clickable and the next answer succeeds', async () => {
  const answers = [];
  let accept = false;
  answer = async (...args) => {
    answers.push(args);
    return accept;
  };
  const ui = await mountCard('s1');
  try {
    dom.window.mixdogDesktop.resyncSessionState = async () => true;
    await click(ui.buttons()[0]);
    assert.equal(answers.length, 1);
    assert.ok(ui.buttons().length > 0, 'the card stays');
    assert.ok(
      ui.buttons().every((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true'),
      'and is answerable again'
    );
    accept = true;
    await click(ui.buttons()[0]);
    assert.equal(answers.length, 2, 'the retry reached the resolver');
  } finally {
    delete dom.window.mixdogDesktop.resyncSessionState;
    await ui.done();
  }
});

test('the card is answerable again even when the refresh never completes', async () => {
  const answers = [];
  answer = async (...args) => {
    answers.push(args);
    return answers.length > 1;
  };
  const ui = await mountCard('s1');
  try {
    dom.window.mixdogDesktop.resyncSessionState = () => new Promise(() => {});
    await click(ui.buttons()[0]);
    assert.ok(ui.buttons().every((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true'));
    await click(ui.buttons()[0]);
    assert.equal(answers.length, 2);
  } finally {
    delete dom.window.mixdogDesktop.resyncSessionState;
    await ui.done();
  }
});

test('an answer that is accepted after the pane switched chats leaves no trace anywhere', async () => {
  let accept;
  answer = () => new Promise((resolve) => (accept = resolve));
  const ui = await mountHook('s1');
  try {
    let pending;
    await act(async () => {
      pending = ui.state.approvals.approvalDock.props.resolve({ approved: true });
    });
    ui.route('s2');
    await ui.show({ sessionId: 's2', items: [], toolApproval: null });
    await act(async () => {
      accept(true);
      await pending;
    });
    assert.equal(ui.flash(), null);
    await ui.show({ sessionId: 's1', items: [], toolApproval: null });
    assert.equal(ui.flash(), null);
  } finally {
    await ui.done();
  }
});
