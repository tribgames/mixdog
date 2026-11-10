import assert from 'node:assert/strict';
import test from 'node:test';

import { createSectionStore, sectionsSourceFromFoldStore } from './section-store.ts';

const entry = (section, key, revision, value) => ({ section, key, revision, value });

/** A whole-store replace as the relay sends it: begin, chunks of two, commit. */
function replaceWith(source, entries, epoch) {
  source.push({ kind: 'replace', stage: 'begin' });
  for (let at = 0; at < entries.length; at += 2) source.push({ kind: 'replace', stage: 'chunk', entries: entries.slice(at, at + 2) });
  source.push({ kind: 'replace', stage: 'commit', epoch });
}

function bridge(initial) {
  let listener = () => {};
  return {
    snapshot: async () => initial,
    subscribe: (l) => {
      listener = l;
      return () => {};
    },
    push: (p) => listener(p),
  };
}

test('a snapshot older than a pushed entry never moves a section backwards', async () => {
  const source = bridge({ status: 'ready', entries: [entry('usage', 'day', 1, 'old')] });
  const store = createSectionStore(source);
  source.push({ kind: 'sections', changes: [{ section: 'usage', key: 'day', entry: entry('usage', 'day', 3, 'new') }] });
  await store.ready();
  assert.equal(store.get('usage', 'day').value, 'new');
});

/** A source whose snapshot answer is released by the test, after pushes have already arrived. */
function lateSnapshot() {
  let listener = () => {};
  let answer = () => {};
  return {
    snapshot: () => new Promise((resolve) => (answer = resolve)),
    subscribe: (l) => ((listener = l), () => {}),
    push: (p) => listener(p),
    answer: (snapshot) => answer(snapshot),
  };
}

test('a snapshot answered after newer pushes neither resurrects a deleted entry nor moves the status back', async () => {
  const source = lateSnapshot();
  const store = createSectionStore(source);
  source.push({ kind: 'sections', changes: [{ section: 'notice', key: 'a', entry: null }] });
  source.push({ kind: 'sections', changes: [{ section: 'config', key: null, entry: entry('config', null, 9, 'pushed') }] });
  source.push({ kind: 'status', status: 'reconnecting' });
  source.answer({
    status: 'ready',
    entries: [entry('notice', 'a', 1, 'deleted since'), entry('config', null, 4, 'older'), entry('usage', 'day', 1, 'only here')],
  });
  await store.ready();
  assert.equal(store.get('notice', 'a'), undefined, 'the pushed deletion stands');
  assert.equal(store.get('config').value, 'pushed');
  assert.equal(store.get('usage', 'day').value, 'only here', 'entries no push touched come from the snapshot');
  assert.equal(store.status(), 'reconnecting');
});

test('a snapshot answered after a pushed whole store adds nothing the whole store lacks', async () => {
  const source = lateSnapshot();
  const store = createSectionStore(source);
  replaceWith(source, [entry('config', null, 5, 'now')]);
  source.answer({ status: 'ready', entries: [entry('notice', 'gone', 1, 'stale'), entry('config', null, 2, 'old')] });
  await store.ready();
  assert.equal(store.get('notice', 'gone'), undefined);
  assert.equal(store.get('config').value, 'now');
  assert.equal(store.status(), 'ready');
});

test('listeners fire once per flush for the sections that changed, and the list is stable between changes', async () => {
  const source = bridge({ status: 'ready', entries: [] });
  const store = createSectionStore(source);
  await store.ready();
  let pool = 0;
  let usage = 0;
  store.subscribe('agentPool', () => pool++);
  store.subscribe('usage', () => usage++);
  source.push({
    kind: 'sections',
    changes: [
      { section: 'agentPool', key: null, entry: entry('agentPool', null, 1, []) },
      { section: 'agentPool', key: 'x', entry: entry('agentPool', 'x', 1, 1) },
    ],
  });
  assert.deepEqual([pool, usage], [1, 0]);
  const first = store.list('agentPool');
  assert.equal(store.list('agentPool'), first);
  source.push({ kind: 'sections', changes: [{ section: 'agentPool', key: 'x', entry: null }] });
  assert.notEqual(store.list('agentPool'), first);
  assert.equal(store.list('agentPool').length, 1);
});

test('a replace drops sections the new snapshot no longer has and tells their listeners', async () => {
  const source = bridge({ status: 'ready', entries: [entry('notice', 'a', 1, 'stale')] });
  const store = createSectionStore(source);
  await store.ready();
  let notices = 0;
  store.subscribe('notice', () => notices++);
  replaceWith(source, [entry('config', null, 1, {})]);
  assert.equal(store.get('notice', 'a'), undefined);
  assert.equal(notices, 1);
  assert.equal(store.get('config').revision, 1);
});

test('a client-library fold store feeds the same store (the phone)', async () => {
  const sections = new Map([['usage', [entry('usage', null, 2, 'v')]]]);
  let fold = () => {};
  const foldStore = {
    sections: (s) => sections.get(s) ?? [],
    section: (s) => sections.get(s)?.[0],
    subscribe: (l) => ((fold = l), () => {}),
  };
  const store = createSectionStore(sectionsSourceFromFoldStore(foldStore, ['usage'], () => 'ready'));
  await store.ready();
  assert.equal(store.get('usage').value, 'v');
  sections.set('usage', [entry('usage', null, 3, 'w')]);
  fold({ type: 'section', section: 'usage', key: null });
  assert.equal(store.get('usage').value, 'w');
});

test('a replace is swapped in only at its commit, in one notification, with the held store intact until then', async () => {
  const source = bridge({ status: 'ready', entries: [entry('notice', 'a', 1, 'held'), entry('config', null, 1, 'old')] });
  const store = createSectionStore(source);
  await store.ready();
  let notified = 0;
  store.subscribe('*', () => notified++);
  source.push({ kind: 'replace', stage: 'begin' });
  source.push({ kind: 'replace', stage: 'chunk', entries: [entry('config', null, 2, 'new'), entry('usage', 'day', 1, 'u')] });
  assert.equal(store.get('config').value, 'old');
  assert.equal(store.get('notice', 'a').value, 'held');
  assert.equal(notified, 0);
  source.push({ kind: 'replace', stage: 'chunk', entries: [entry('agentPool', null, 1, [])] });
  source.push({ kind: 'replace', stage: 'commit' });
  assert.equal(notified, 1);
  assert.equal(store.get('config').value, 'new');
  assert.equal(store.get('notice', 'a'), undefined);
  assert.deepEqual(store.list('usage').map((e) => e.key), ['day']);
  assert.equal(store.get('agentPool').revision, 1);
});

test('a tell (reviewDiff) is heard when it happens, never from a snapshot or a first attach', async () => {
  const source = bridge({ status: 'ready', epoch: 'core-1', entries: [entry('reviewDiff', null, 5, {}), entry('usage', 'day', 1, 'u')] });
  const store = createSectionStore(source);
  const heard = [];
  store.subscribe('reviewDiff', () => heard.push('reviewDiff'));
  store.subscribe('usage', () => heard.push('usage'));
  await store.ready();
  assert.deepEqual(heard, ['usage'], 'a snapshot that holds the last tell does not make a late listener act on it');
  source.push({ kind: 'sections', changes: [{ section: 'reviewDiff', key: null, entry: entry('reviewDiff', null, 6, {}) }] });
  assert.deepEqual(heard, ['usage', 'reviewDiff'], 'a tell pushed live is heard');
});

test('a whole store of the same core tells what was told while the link was down, once, and nothing else', async () => {
  const source = bridge({ status: 'ready', epoch: 'core-1', entries: [entry('reviewDiff', null, 5, {}), entry('usage', 'day', 1, 'u')] });
  const store = createSectionStore(source);
  const heard = [];
  store.subscribe('reviewDiff', () => heard.push('reviewDiff'));
  await store.ready();
  replaceWith(source, [entry('reviewDiff', null, 5, {})], 'core-1');
  assert.deepEqual(heard, [], 'the tell the store already holds tells nobody');
  replaceWith(source, [entry('reviewDiff', null, 6, {})], 'core-1');
  assert.deepEqual(heard, ['reviewDiff'], 'a newer tell was made while the link was down');
  replaceWith(source, [], 'core-1');
  assert.deepEqual(heard, ['reviewDiff'], 'a core that holds no tell tells nobody (it never drops one: a clear is a tell too)');
  replaceWith(source, [entry('reviewDiff', null, 1, {})], 'core-1');
  assert.deepEqual(heard, ['reviewDiff', 'reviewDiff'], 'a tell the store does not hold');
});

test('a store that held no tell is told the first one made while its link was down', async () => {
  const source = bridge({ status: 'ready', epoch: 'core-1', entries: [entry('usage', 'day', 1, 'u')] });
  const store = createSectionStore(source);
  const heard = [];
  store.subscribe('reviewDiff', () => heard.push('reviewDiff'));
  await store.ready();
  replaceWith(source, [entry('reviewDiff', null, 1, {})], 'core-1');
  assert.deepEqual(heard, ['reviewDiff']);
});

test('a whole store of a restarted core tells its tell whatever its revision, and one without a tell tells nobody', async () => {
  const source = bridge({ status: 'ready', epoch: 'core-1', entries: [entry('reviewDiff', null, 1, {})] });
  const store = createSectionStore(source);
  const heard = [];
  store.subscribe('reviewDiff', () => heard.push('reviewDiff'));
  await store.ready();
  replaceWith(source, [entry('reviewDiff', null, 1, {})], 'core-2');
  assert.deepEqual(heard, ['reviewDiff'], 'an equal revision of another core is another tell');
  replaceWith(source, [entry('reviewDiff', null, 1, {})], 'core-2');
  assert.deepEqual(heard, ['reviewDiff'], 'the same core again');
  replaceWith(source, [], 'core-3');
  assert.deepEqual(heard, ['reviewDiff'], 'a restarted core that has told nothing');
  replaceWith(source, [entry('reviewDiff', null, 1, {})], 'core-4');
  assert.deepEqual(heard, ['reviewDiff', 'reviewDiff']);
});

test('a store whose first whole store arrives before any snapshot knew no core: that is a first attach, not a reconnect', async () => {
  const source = lateSnapshot();
  const store = createSectionStore(source);
  const heard = [];
  store.subscribe('reviewDiff', () => heard.push('reviewDiff'));
  replaceWith(source, [entry('reviewDiff', null, 2, {})], 'core-1');
  source.answer({ status: 'ready', entries: [] });
  await store.ready();
  assert.deepEqual(heard, []);
});