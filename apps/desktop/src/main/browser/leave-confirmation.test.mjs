import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserGuestStateStore, browserDocumentId } from './guest-state.ts';
import { closePage, createBrowserLeaveConfirmation } from './leave-confirmation.ts';
import { createPageInputDispatcher, navigatePage } from './page-surface-control.ts';

test("a vetoed leave a person asked for is asked about; leaving repeats it past the page's veto", () => {
  const leave = createBrowserLeaveConfirmation();
  const page = {};
  const runs = [];
  let skipped = 0;
  leave.request(page, () => runs.push('close'));
  assert.equal(leave.pending(page), null, 'nothing to ask until the page vetoes');
  leave.vetoed(page, () => skipped++);
  const id = leave.pending(page);
  assert.match(id, /^leave_/);
  assert.equal(leave.answer(page, 'leave_0', true), false, 'only the confirmation shown can be answered');
  assert.equal(leave.answer(page, id, true), true);
  assert.deepEqual(runs, ['close', 'close'], 'leaving repeats the request');
  leave.vetoed(page, () => skipped++);
  assert.equal(skipped, 1, 'the repeated request passes the veto once');
  assert.equal(leave.pending(page), null);
});

test('staying keeps the page; an agent leave or a changed document asks nothing', () => {
  const leave = createBrowserLeaveConfirmation();
  const page = {};
  const runs = [];
  let skipped = 0;
  leave.request(page, () => runs.push('navigate'));
  leave.vetoed(page, () => skipped++);
  assert.equal(leave.answer(page, leave.pending(page), false), true);
  assert.deepEqual(runs, ['navigate'], 'staying runs nothing');
  assert.equal(leave.pending(page), null);

  leave.vetoed(page, () => skipped++);
  assert.equal(leave.pending(page), null, 'a veto of a request nobody made here (an agent) asks no one');

  leave.request(page, () => runs.push('back'));
  leave.vetoed(page, () => skipped++);
  leave.settled(page, true);
  assert.ok(leave.pending(page), 'a move within the document keeps the question');
  leave.settled(page, false);
  assert.equal(leave.pending(page), null, 'the page navigated anyway; the question is gone');
  assert.equal(skipped, 0);
});

test('an approval covers only its own repeat; a request no veto claimed never answers for a later one', () => {
  const leave = createBrowserLeaveConfirmation();
  const page = {};
  let skipped = 0;
  const skip = () => skipped++;

  // A request that started nothing (no history left) is not waiting for a veto.
  leave.request(page, () => false);
  leave.vetoed(page, skip);
  assert.equal(leave.pending(page), null);

  // A Back that moved within the document: no veto, then later an agent's.
  leave.request(page, () => true);
  leave.settled(page, true);
  leave.vetoed(page, skip);
  assert.equal(leave.pending(page), null, 'a later veto is not asked about');

  // The approved repeat started nothing (history changed meanwhile): the
  // approval goes with it and cannot let a later leave skip the page's veto.
  let starts = 0;
  leave.request(page, () => ++starts === 1);
  leave.vetoed(page, skip);
  leave.answer(page, leave.pending(page), true);
  leave.vetoed(page, skip);
  assert.equal(skipped, 0, 'the unused approval was dropped at once');

  // A person's next request replaces an approval still waiting for its veto.
  leave.request(page, () => true);
  leave.vetoed(page, skip);
  leave.answer(page, leave.pending(page), true);
  leave.request(page, () => true);
  leave.vetoed(page, skip);
  assert.equal(skipped, 0, 'the new request is asked about, not waved through');
  assert.ok(leave.pending(page));
});

test("leaving runs the request's own repeat when only part of it ran at first", () => {
  const leave = createBrowserLeaveConfirmation();
  const page = {};
  const runs = [];
  let skipped = 0;
  leave.request(
    page,
    () => runs.push('release'),
    () => runs.push('press+release')
  );
  leave.vetoed(page, () => skipped++);
  leave.answer(page, leave.pending(page), true);
  leave.vetoed(page, () => skipped++);
  assert.deepEqual(runs, ['release', 'press+release']);
  assert.equal(skipped, 1);
});

test('closing a tab closes its page through beforeunload, in any presentation', () => {
  const closes = [];
  const page = { destroyed: false, isDestroyed: () => page.destroyed, close: (options) => closes.push(options) };
  const leave = createBrowserLeaveConfirmation();
  leave.request(page, () => closePage(page));
  assert.deepEqual(closes, [{ waitForBeforeUnload: true }], 'the page itself closes, so it may veto');
  leave.vetoed(page, () => assert.fail('the first close is not waved through'));
  leave.answer(page, leave.pending(page), true);
  let skipped = 0;
  leave.vetoed(page, () => skipped++);
  assert.equal(closes.length, 2, 'leaving closes it again');
  assert.equal(skipped, 1, 'past the veto this time');

  page.destroyed = true;
  assert.equal(closePage(page), false, 'a page already gone starts nothing');
  assert.equal(closes.length, 2);
});

/** A page whose beforeunload vetoes every leave its click or key press starts. */
function guardedPage() {
  const leave = createBrowserLeaveConfirmation();
  const state = new BrowserGuestStateStore();
  const page = { isDestroyed: () => false };
  state.for(page);
  const sent = [];
  const skipped = [];
  const dispatch = createPageInputDispatcher({
    state,
    leave,
    cdp: { waitForIdle: async () => {} },
    urlPolicy: {},
    assertUrl: async () => {},
    dispatchInput: async (target, method, params, _signal, assertDispatch) => {
      assertDispatch();
      sent.push(method === 'Input.dispatchMouseEvent' ? params.type : `${params.type}:${params.key}`);
      // The page leaves on a click (a link) and on Enter (a form submit).
      if (params.type === 'mouseReleased' || (params.type === 'rawKeyDown' && params.key === 'Enter')) {
        leave.vetoed(target, () => skipped.push(params.type));
      }
    },
  });
  // Input is sent under the document guard of the document it was meant for.
  const input = (action) => {
    const documentId = browserDocumentId(state, page);
    return dispatch(page, { documentId, ...action }, () => {
      if (browserDocumentId(state, page) !== documentId) throw new Error('Browser page changed; input was not sent.');
    });
  };
  const pointer = (phase) => ({
    type: 'pointer',
    phase,
    x: 5,
    y: 6,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  return { leave, state, page, sent, skipped, input, pointer };
}

const settleReplay = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

test('a card kept across a same-document move still leaves: the replay is bound to the document shown when answered', async () => {
  const f = guardedPage();
  await f.input(f.pointer('mousePressed'));
  await f.input({ ...f.pointer('mouseReleased'), buttons: 0 });
  const id = f.leave.pending(f.page);
  assert.ok(id);

  // The page moves within its document (a hash link, pushState): a new
  // document generation, yet the card stays.
  f.state.beginDocument(f.page, true);
  f.leave.settled(f.page, true);
  assert.equal(f.leave.pending(f.page), id);

  f.sent.length = 0;
  assert.equal(f.leave.answer(f.page, id, true), true);
  await settleReplay();
  assert.deepEqual(f.sent, ['mousePressed', 'mouseReleased'], 'the click is replayed, not refused');
  assert.deepEqual(f.skipped, ['mouseReleased'], 'and passes the page’s veto');
});

test('a replay that fails takes its approval with it; a later unrelated veto is not waved through', async () => {
  const f = guardedPage();
  await f.input({ type: 'key', key: 'Enter' });
  const id = f.leave.pending(f.page);
  // A dialog now blocks the page: the replay's guard refuses to send.
  f.state.for(f.page).pendingDialog = { id: 'd1', type: 'alert', message: '' };
  f.sent.length = 0;
  assert.equal(f.leave.answer(f.page, id, true), true);
  await settleReplay();
  assert.deepEqual(f.sent, [], 'nothing reached the page');

  f.state.for(f.page).pendingDialog = null;
  f.leave.vetoed(f.page, () => f.skipped.push('unrelated'));
  assert.deepEqual(f.skipped, [], 'the failed replay left no approval behind');
  assert.equal(f.leave.pending(f.page), null);
});

test("a person's click on a link the page vetoes is asked about; leaving clicks it again past the veto", async () => {
  const f = guardedPage();
  await f.input(f.pointer('mousePressed'));
  await f.input({ ...f.pointer('mouseReleased'), buttons: 0 });
  const id = f.leave.pending(f.page);
  assert.match(id, /^leave_/, 'the vetoed click asks the person');
  assert.deepEqual(f.skipped, []);

  f.sent.length = 0;
  assert.equal(f.leave.answer(f.page, id, true), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, ['mousePressed', 'mouseReleased'], 'the whole click is repeated');
  assert.deepEqual(f.skipped, ['mouseReleased'], 'and the page lets it leave');
  assert.equal(f.leave.pending(f.page), null);
});

test('a form submitted with Enter asks the same way; staying sends nothing more', async () => {
  const f = guardedPage();
  await f.input({ type: 'key', key: 'Enter' });
  const id = f.leave.pending(f.page);
  assert.ok(id);
  const sent = f.sent.length;
  assert.equal(f.leave.answer(f.page, id, false), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, sent, 'the page stays');
  assert.deepEqual(f.skipped, []);
  assert.equal(f.leave.pending(f.page), null);

  // Hover and wheel never leave a page, so they ask nothing and clear nothing.
  await f.input({ type: 'key', key: 'Enter' });
  const again = f.leave.pending(f.page);
  await f.input({ ...f.pointer('mouseMoved'), buttons: 0 });
  await f.input({ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 5 });
  assert.equal(f.leave.pending(f.page), again);
});

test("an agent's command replaces a person's earlier attempt: its veto offers and replays nothing", async () => {
  const f = guardedPage();
  // A click that navigated nothing leaves the person's attempt standing.
  await f.input({ type: 'key', key: 'Backspace' });
  f.leave.agentActs(f.page);
  // The agent's own navigation is vetoed.
  f.leave.vetoed(f.page, () => f.skipped.push('agent'));
  assert.equal(f.leave.pending(f.page), null, 'the person is not asked about the agent');
  assert.deepEqual(f.skipped, []);

  // A card already showing is the person's own question and stays; the
  // agent's veto neither replaces nor answers it, nor rides its approval.
  await f.input({ type: 'key', key: 'Enter' });
  const id = f.leave.pending(f.page);
  f.leave.agentActs(f.page);
  f.leave.vetoed(f.page, () => f.skipped.push('agent'));
  assert.equal(f.leave.pending(f.page), id);
  f.sent.length = 0;
  f.leave.answer(f.page, id, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, ['rawKeyDown:Enter', 'char:Enter', 'keyUp:Enter'], 'leaving repeats the person’s Enter');
  assert.deepEqual(f.skipped, ['rawKeyDown'], 'only that repeat passes the veto');

  // An approval still waiting for its repeat's veto does not cover an agent.
  f.leave.request(
    f.page,
    () => true,
    () => true
  );
  f.leave.vetoed(f.page, () => {});
  f.leave.answer(f.page, f.leave.pending(f.page), true);
  f.leave.agentActs(f.page);
  f.leave.vetoed(f.page, () => f.skipped.push('agent'));
  assert.equal(f.skipped.includes('agent'), false);
});

test('a card stays while the person keeps typing; only a new veto or an answer changes it', async () => {
  const f = guardedPage();
  await f.input(f.pointer('mousePressed'));
  await f.input({ ...f.pointer('mouseReleased'), buttons: 0 });
  const id = f.leave.pending(f.page);
  assert.ok(id);

  await f.input({ type: 'text', text: 'more notes' });
  await f.input({ type: 'key', key: 'Backspace' });
  await f.input(f.pointer('mousePressed'));
  await f.input({ type: 'key', key: 'Tab' });
  assert.equal(f.leave.pending(f.page), id, 'typing and clicks that leave nothing keep the card');

  // Leaving still repeats the click the card asked about, not the typing.
  f.sent.length = 0;
  assert.equal(f.leave.answer(f.page, id, true), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, ['mousePressed', 'mouseReleased']);

  // A new veto of the person's own request is a new card.
  await f.input({ type: 'key', key: 'Enter' });
  const next = f.leave.pending(f.page);
  assert.ok(next && next !== id);
  await f.input({ type: 'key', key: 'Enter' });
  assert.notEqual(f.leave.pending(f.page), next, 'each vetoed request asks anew');
});

test('toolbar navigation is a leave request; stop is not', () => {
  const requests = [];
  const calls = [];
  const page = {
    loadURL: async (url) => calls.push(`load ${url}`),
    reload: () => calls.push('reload'),
    stop: () => calls.push('stop'),
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => calls.push('back'),
      goForward: () => calls.push('forward'),
    },
  };
  const host = {
    leave: {
      request: (_guest, run) => requests.push(run()),
    },
  };
  navigatePage(host, page, { type: 'navigate', url: 'https://a.test/' });
  navigatePage(host, page, { type: 'back' });
  navigatePage(host, page, { type: 'forward' });
  navigatePage(host, page, { type: 'reload' });
  navigatePage(host, page, { type: 'stop' });
  assert.deepEqual(calls, ['load https://a.test/', 'back', 'reload', 'stop']);
  assert.deepEqual(requests, [true, true, false, true], 'a forward with no history started nothing');
});
