import assert from 'node:assert/strict';
import test from 'node:test';

import { beginEdit, browserDocumentId, BrowserGuestStateStore } from './host-state.ts';
import { unreportedDownloads } from './reply.ts';

const guest = () => ({ id: Math.random() });

test('page ids are stable per guest and snapshot ids advance from them', () => {
  const store = new BrowserGuestStateStore();
  const first = guest();
  const second = guest();
  assert.equal(store.pageId(first), 'p1');
  assert.equal(store.pageId(second), 'p2');
  assert.equal(store.pageId(first), 'p1');
  const number = (id) => Number(id.split('-s')[1]);
  const a = store.nextSnapshotId(first);
  const b = store.nextSnapshotId(first);
  const c = store.nextSnapshotId(second);
  assert.ok(a.startsWith('p1-s') && c.startsWith('p2-s'));
  assert.ok(number(a) < number(b) && number(b) < number(c), 'greater is newer');
});

test('document ids name one page generation and retire when the document changes', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const other = guest();
  assert.match(browserDocumentId(store, page), /^p1:\d+$/);
  assert.notEqual(browserDocumentId(store, other), browserDocumentId(store, page));
  const before = browserDocumentId(store, page);
  store.beginDocument(page);
  assert.notEqual(browserDocumentId(store, page), before);
  const number = (id) => Number(id.split(':')[1]);
  assert.ok(number(browserDocumentId(store, page)) > number(before), 'greater is newer');
});

test('a new document reports only its own network failures and console errors', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  record.networkFailures.push('GET https://previous.test/ad — net::ERR_ABORTED');
  record.console.recordError('error: the previous page failed to load a resource');

  store.beginDocument(page, true);
  assert.equal(record.networkFailures.length, 1, 'an in-document navigation reloads nothing');
  assert.equal(record.console.errorCount(), 1, 'and keeps what the same document logged');

  store.beginDocument(page);
  assert.deepEqual(record.networkFailures, [], 'the previous page must not explain the current one');
  assert.equal(record.console.errorCount(), 0);
  assert.deepEqual(record.console.newErrors(10), [], 'a cleared log has nothing left to report');
});

test('prompts and typed-in state end with the document, the renderer or the frame that owned them', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  const dialog = (sessionId) => ({ type: 'alert', message: 'x', defaultPrompt: '', openedAt: 0, sessionId });

  record.pendingDialog = dialog(undefined);
  record.userInput = true;
  record.actor = 'person';
  record.personDialogAnswerAt = 1;
  record.windowOpens.push({ url: 'https://pay.example/', userGesture: true, at: 1 });
  store.beginDocument(page, true);
  store.beginDocument(page);
  assert.ok(record.pendingDialog, 'a started navigation may still end as a download or be cancelled');
  assert.equal(record.userInput, true);
  assert.equal(record.actor, 'person');
  store.commitDocument(page);
  assert.equal(record.pendingDialog, null, 'the committed document has no dialog');
  assert.equal(record.userInput, false, 'nor anything typed into the old one');
  assert.equal(record.actor, undefined, "nobody has acted on the new document: the old one's gesture is gone");
  assert.equal(record.personDialogAnswerAt, undefined);
  assert.deepEqual(record.windowOpens, [], "nor the old document's window-open gestures");

  record.pendingDialog = dialog('frame-1');
  record.pendingFileChooser = { mode: 'selectSingle', sessionId: 'frame-1', openedAt: 0 };
  record.cdpSessions.set('frame-1', {});
  store.endTargetSession(page, 'frame-2');
  assert.ok(record.pendingDialog, "another frame's detach leaves it");
  store.endTargetSession(page, 'frame-1');
  assert.equal(record.pendingDialog, null, 'the detached frame took its dialog');
  assert.equal(record.pendingFileChooser, null);
  assert.equal(record.cdpSessions.has('frame-1'), false);

  record.pendingDialog = dialog(undefined);
  store.markCrashed(page, 'renderer crashed');
  assert.equal(record.pendingDialog, null, 'the dead renderer took its dialog');
});

test('a debugger gone ends every session under it and settles every prompt it held', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  record.cdpSessions.set('frame-1', {});
  record.pendingDialog = { type: 'confirm', message: 'x', openedAt: 0, sessionId: 'frame-1', bridgeRequestId: 'r1' };
  record.pendingFileChooser = { mode: 'selectSingle', openedAt: 0 };
  store.endTargetSession(page);
  assert.equal(record.cdpSessions.size, 0);
  assert.equal(record.pendingDialog, null, 'a held bridge request no controller can answer is not left pending');
  assert.equal(record.pendingFileChooser, null);
});

test("a page waits on its own dialog first, else on a renderer peer's, and on nothing else", () => {
  const page = guest();
  const peer = guest();
  const stranger = guest();
  const store = new BrowserGuestStateStore((of) => (of === page ? [peer] : of === peer ? [page] : []));
  const open = (owner, type) => {
    const dialog = { type, message: type, openedAt: 0 };
    store.for(owner).pendingDialog = dialog;
    return dialog;
  };
  assert.equal(store.blockingDialog(page), null);
  const peers = open(peer, 'alert');
  assert.deepEqual(store.blockingDialog(page), { owner: peer, dialog: peers });
  assert.equal(store.dialogOwner(page), peer);
  assert.deepEqual(store.blockingDialog(peer), { owner: peer, dialog: peers }, 'the dialog page itself');
  assert.equal(store.dialogOwner(peer), null, 'the dialog page has no other owner');
  open(stranger, 'confirm');
  assert.deepEqual(store.blockingDialog(page), { owner: peer, dialog: peers }, 'another process blocks nothing here');
  const own = open(page, 'prompt');
  assert.deepEqual(store.blockingDialog(page), { owner: page, dialog: own });
});

test('a native dialog closing unanswered is kept as a dismissed notice; an answered or bridged one is not', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  const open = (extra = {}) => {
    record.pendingDialog = { type: 'alert', message: 'early', openedAt: 0, ...extra };
    return record.pendingDialog;
  };

  open({ sessionId: 'frame-1' });
  store.nativeDialogClosed(page, undefined);
  assert.ok(record.pendingDialog, "another session's close leaves it");
  store.nativeDialogClosed(page, 'frame-1');
  assert.equal(record.pendingDialog, null);
  assert.deepEqual(record.dismissedDialog, { type: 'alert', message: 'early', reason: 'early' });

  record.dismissedDialog = null;
  open({ answering: true });
  store.nativeDialogClosed(page, undefined);
  assert.equal(record.pendingDialog, null);
  assert.equal(record.dismissedDialog, null, 'that close was the answer landing');

  const bridged = open({ bridgeRequestId: 'r1' });
  store.nativeDialogClosed(page, undefined);
  assert.equal(record.pendingDialog, bridged, 'a bridged dialog is answered through its request only');

  open({ type: 'beforeunload' });
  store.nativeDialogClosed(page, undefined);
  assert.equal(record.dismissedDialog, null, 'a leave confirmation is not a dialog the bridge carries');

  store.noteDismissedDialog(page, { type: 'confirm', message: 'csp' }, 'unreachable');
  store.beginDocument(page);
  assert.ok(record.dismissedDialog, 'a navigation that only started keeps it');
  store.commitDocument(page);
  assert.equal(record.dismissedDialog, null, 'the committed document has none');
});

test('a page opened after a download does not announce it as news', () => {
  const store = new BrowserGuestStateStore();
  const older = { id: 'older', startedAt: Date.now() - 5_000, completedAt: Date.now() - 4_000 };
  const record = store.for(guest());
  // Downloads belong to the session, not to one page; a page that never saw
  // this file saved must not open by reporting it.
  assert.deepEqual(unreportedDownloads([older], record.downloadsReportedAt), []);

  const saved = { id: 'later', startedAt: Date.now() + 1_000 };
  assert.deepEqual(
    unreportedDownloads([older, saved], record.downloadsReportedAt),
    [saved],
    'a file saved while this page is open still reaches it'
  );
});

test('invalidating interaction forgets document-bound state only', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  record.refSet = { snapshotId: 'p1-s1' };
  record.accessibilityRefs = { refs: [] };
  record.visualGrounding = { snapshotId: 'p1-s1' };
  record.fault = 'kept';
  record.performanceTrace = { trace: [] };
  store.invalidateInteraction(page);
  assert.equal(record.refSet, undefined);
  assert.equal(record.accessibilityRefs, undefined);
  assert.equal(record.visualGrounding, undefined);
  assert.equal(record.fault, 'kept');
  assert.ok(record.performanceTrace);
});

test('crash marking records the fault once and clears on take', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  store.for(page).refSet = { snapshotId: 'p1-s1' };
  assert.equal(store.takeCrashed(page), false);
  store.markCrashed(page, 'renderer crashed');
  assert.equal(store.for(page).fault, 'renderer crashed');
  assert.equal(store.for(page).refSet, undefined);
  assert.equal(store.takeCrashed(page), true);
  assert.equal(store.takeCrashed(page), false);
});

test('slots read and write one field of the guest record', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const refSets = store.slot('refSet');
  assert.equal(refSets.has(page), false);
  assert.equal(refSets.delete(page), false);
  refSets.set(page, { snapshotId: 'p1-s1' });
  assert.equal(refSets.has(page), true);
  assert.equal(store.for(page).refSet.snapshotId, 'p1-s1');
  assert.equal(refSets.get(page).snapshotId, 'p1-s1');
  assert.equal(refSets.delete(page), true);
  assert.equal(store.for(page).refSet, undefined);
});

test('remembered secrets are redacted from guest text until forgotten', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const other = guest();
  store.rememberSecret(page, 'hunter2-secret');
  assert.doesNotMatch(store.redactText(page, 'password is hunter2-secret ok'), /hunter2-secret/);
  assert.match(store.redactText(other, 'password is hunter2-secret ok'), /hunter2-secret/);
  store.forgetSecret(page, 'hunter2-secret');
  assert.match(store.redactText(page, 'password is hunter2-secret ok'), /hunter2-secret/);
  assert.equal(store.for(page).sensitiveValues, undefined, 'forgetting the last secret releases the set');
});

test('document, load and snapshot numbers come from one counter and are never issued twice', () => {
  const store = new BrowserGuestStateStore();
  const used = new Set();
  const issue = (id) => {
    assert.equal(used.has(id), false, `${id} reissued`);
    used.add(id);
  };
  const first = guest();
  issue(browserDocumentId(store, first));
  store.beginDocument(first);
  issue(browserDocumentId(store, first));
  issue(store.nextSnapshotId(first));
  // Guests for the same tab id, made and destroyed in any order, never repeat a number.
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = guest();
    store.adoptPage(next, 'p1');
    assert.equal(store.pageId(next), 'p1');
    issue(browserDocumentId(store, next));
    store.beginDocument(next);
    issue(browserDocumentId(store, next));
    issue(store.nextSnapshotId(next));
    // A stale guest's late allocation cannot roll anything back.
    issue(store.nextSnapshotId(first));
  }
});
test("a person's edit holds its document once taken, and only that document, turn or no turn", () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const held = () => store.holdsUnfinishedWork(page, false);
  store.for(page).userInput = true;
  assert.equal(held(), false, 'a click or scroll is not work');

  const sent = beginEdit(store.for(page), 'userEdits');
  assert.equal(held(), false, 'not before the page took it');
  sent();
  assert.equal(held(), true);
  store.beginDocument(page, true);
  assert.equal(held(), true, 'an in-document move keeps it');
  store.beginDocument(page);
  assert.equal(held(), true, 'a navigation that only started keeps it');
  store.commitDocument(page);
  assert.equal(held(), false, 'a full navigation ends it');
  assert.equal(store.for(page).userInput, false);

  const late = beginEdit(store.for(page), 'userEdits');
  store.commitDocument(page);
  late();
  assert.equal(held(), false, 'an edit that left with the old document holds nothing');
});

test("the agent's own edits hold its page only while its session's turn is live, and are never the person's", () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  beginEdit(store.for(page), 'agentEdits')();
  assert.equal(store.holdsUnfinishedWork(page, true), true, 'running or waiting on the user');
  assert.equal(store.holdsUnfinishedWork(page, false), false, 'the turn ended');
  assert.equal(store.for(page).userEdits, false);
  store.commitDocument(page);
  assert.equal(store.holdsUnfinishedWork(page, true), false, 'a full navigation ends it');
});

test("a renderer crash ends the dead document's edits as a navigation does, an edit in flight included", () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  beginEdit(store.for(page), 'userEdits')();
  beginEdit(store.for(page), 'agentEdits')();
  const inFlight = beginEdit(store.for(page), 'agentEdits');
  store.markCrashed(page, 'renderer crashed');
  assert.equal(store.holdsUnfinishedWork(page, true), false);
  inFlight();
  assert.equal(store.holdsUnfinishedWork(page, true), false, 'the edit went with the dead renderer');
  assert.equal(store.takeCrashed(page), true, 'the crash is still reported');
});

test('a dialog, a file chooser or a sign-in secret holds the page; a person pressing in it does not', () => {
  const store = new BrowserGuestStateStore();
  const holds = (apply) => {
    const page = guest();
    apply(store.for(page), page);
    return store.holdsUnfinishedWork(page, false);
  };
  assert.equal(
    holds((record) => (record.userInput = true)),
    false
  );
  assert.equal(
    holds((record) => (record.pendingDialog = { type: 'alert', message: '', openedAt: 0 })),
    true
  );
  assert.equal(
    holds((record) => (record.pendingFileChooser = { mode: 'selectSingle', openedAt: 0 })),
    true
  );
  assert.equal(
    holds((_record, page) => store.rememberSecret(page, 'hunter2')),
    true
  );
  assert.equal(store.holdsUnfinishedWork(guest(), true), false, 'a page with no record holds nothing');
});

test('a detached target session forgets its console replay marks', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const { consoleReplay } = store.for(page);
  for (const key of ['f1|runtime', 'f1|log', 'f2|runtime', '|runtime']) {
    consoleReplay.seen.set(key, 3);
    consoleReplay.floor.set(key, 2);
  }
  store.endTargetSession(page, 'f1');
  assert.deepEqual([...consoleReplay.seen.keys()].sort(), ['f2|runtime', '|runtime'].sort());
  assert.deepEqual([...consoleReplay.floor.keys()].sort(), ['f2|runtime', '|runtime'].sort());
  store.endTargetSession(page);
  assert.equal(consoleReplay.seen.size + consoleReplay.floor.size, 0);
});
