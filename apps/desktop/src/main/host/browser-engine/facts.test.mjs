import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { BrowserGuestStateStore, browserDocumentId } from '../../browser/host-state.ts';
import { bindGuestState, createPageFacts } from './facts.ts';

const SECRET = 'hunter2hunter2hunter2';

function harness(engine = true) {
  const log = [];
  const connection = { notify: (method, params) => log.push({ method, params }) };
  const state = new BrowserGuestStateStore();
  const guest = Object.assign(new EventEmitter(), {
    url: 'https://a.example/',
    title: 'A',
    loading: false,
    isDestroyed: () => false,
    getURL() {
      return this.url;
    },
    getTitle() {
      return this.title;
    },
    isLoading() {
      return this.loading;
    },
    isLoadingMainFrame() {
      return this.loading;
    },
    getZoomFactor: () => 1,
  });
  const publisher = createPageFacts({
    connection,
    state,
    source: { background: () => false, visible: () => true },
    flushEvents: (pageId) => log.push({ flush: pageId }),
  });
  const events = { push: (pageId, event) => log.push({ push: event.method, pageId }) };
  bindGuestState(state, publisher, events, () => engine);
  return { log, state, guest, publisher };
}

test('facts describe the page and carry the current seq', () => {
  const { guest, publisher, state } = harness();
  state.for(guest).openedPopups.push('popup-1');
  const facts = publisher.facts(guest);
  assert.equal(facts.pageId, 'p1');
  assert.equal(facts.seq, 0);
  assert.equal(facts.documentId, browserDocumentId(state, guest));
  assert.equal(facts.url, 'https://a.example/');
  assert.deepEqual([facts.alive, facts.crashed, facts.visible, facts.background], [true, false, true, false]);
  assert.deepEqual(facts.openedPopups, ['popup-1']);
});

test('a document change sends facts after the queued events, with the next seq', () => {
  const { guest, state, log, publisher } = harness();
  const before = state.for(guest).documentGeneration;
  state.beginDocument(guest);
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], { flush: 'p1' });
  assert.equal(log[1].method, 'host/browser/page/facts');
  assert.equal(log[1].params.seq, 1);
  assert.equal(log[1].params.facts.seq, 1);
  assert.ok(state.for(guest).documentGeneration > before, 'issued numbers only grow');
  assert.equal(log[1].params.facts.documentId, browserDocumentId(state, guest));
});

test('an in-document navigation changes the document id and keeps the load id', () => {
  const { guest, state, log, publisher } = harness();
  publisher.facts(guest);
  const loadBefore = state.for(guest).loadGeneration;
  state.beginDocument(guest, true);
  const afterSame = state.for(guest).documentGeneration;
  state.beginDocument(guest, false);
  const sent = log.filter((entry) => entry.method).map((entry) => entry.params.facts);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((facts) => [facts.documentId, facts.loadId]),
    [
      [`p1:${afterSame}`, `p1:${loadBefore}`],
      [browserDocumentId(state, guest), `p1:${state.for(guest).loadGeneration}`],
    ]
  );
  assert.ok(state.for(guest).loadGeneration > loadBefore);
});

test('load state, dialog, chooser and crash each send facts; an unchanged page sends none', () => {
  const { guest, state, log, publisher } = harness();
  const facts = () => log.filter((entry) => entry.method).map((entry) => entry.params.facts);
  publisher.changed(guest);
  publisher.changed(guest);
  assert.equal(facts().length, 1, 'same facts are not sent twice');
  publisher.attach(guest);
  guest.loading = true;
  guest.emit('did-start-loading');
  assert.equal(facts().at(-1).loading, true);
  state.for(guest).pendingDialog = { type: 'confirm', message: 'sure?', openedAt: 3 };
  state.changed(guest, 'dialog');
  assert.equal(facts().at(-1).pendingDialog.message, 'sure?');
  assert.equal(facts().at(-1).pendingDialog.bridge, false);
  state.for(guest).pendingFileChooser = { mode: 'selectSingle', backendNodeId: 4, frameId: 'f', openedAt: 5 };
  state.changed(guest, 'chooser');
  assert.equal(facts().at(-1).pendingFileChooser.mode, 'selectSingle');
  assert.ok(facts().at(-1).pendingFileChooser.receiverKey);
  state.markCrashed(guest, 'page target crashed');
  assert.equal(facts().at(-1).crashed, true);
  assert.equal(facts().at(-1).fault, 'page target crashed');
  const seqs = log.filter((entry) => entry.method).map((entry) => entry.params.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i + 1),
    'gap-free'
  );
});

test('a host-typed secret is masked in the facts', () => {
  const { guest, state, publisher } = harness();
  state.rememberSecret(guest, SECRET);
  guest.title = `login ${SECRET}`;
  assert.ok(!JSON.stringify(publisher.facts(guest)).includes(SECRET));
});

test('host mode publishes nothing', () => {
  const { guest, state, log } = harness(false);
  state.for(guest);
  state.beginDocument(guest);
  state.for(guest).console.recordInternal('x');
  assert.deepEqual(log, []);
});

test('the host console entries and refusals join the event stream while the lane is on', () => {
  const { guest, state, log } = harness();
  state.for(guest).console.recordInternal('child frame unreachable');
  state.recordRefusedRequest(guest, 'https://x.example/', 'policy');
  assert.deepEqual(log, [
    { push: 'Mixdog.internalConsole', pageId: 'p1' },
    { push: 'Mixdog.requestRefused', pageId: 'p1' },
  ]);
});

test('a page whose facts cannot be read inside its own event keeps the event for the listeners after it, and sends at the next change', () => {
  const { guest, publisher, state, log } = harness();
  state.for(guest);
  const stop = publisher.attach(guest);
  const later = [];
  guest.on('did-stop-loading', () => later.push('the listener after the facts'));
  guest.getTitle = () => {
    throw new Error('Object has been destroyed');
  };
  // The emitter calls its listeners in turn: a throw from the facts would leave through `emit` (an uncaught exception of the
  // main process when Electron emits it) and skip every listener registered later.
  assert.doesNotThrow(() => guest.emit('did-stop-loading'));
  assert.deepEqual(later, ['the listener after the facts']);
  assert.deepEqual(
    log.filter((entry) => entry.method),
    [],
    'nothing was sent'
  );
  guest.getTitle = () => 'A';
  guest.emit('did-stop-loading');
  assert.equal(
    log.filter((entry) => entry.method === 'host/browser/page/facts').length,
    1,
    'the next change sends the facts'
  );
  stop();
});
