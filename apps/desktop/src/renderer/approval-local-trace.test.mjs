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

test('a result already published before the answer does not retire the answer\'s trace', async () => {
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
