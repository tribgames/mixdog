import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRefSet } from './ref-recovery.ts';
import { createBrowserReply } from './reply.ts';

const revision = (dom, scrollY = 0) => `1700000000:${dom + 3}:800:600:0:${scrollY}:${dom}`;

function payload(snapshotId, elements, url = 'https://fixture.example/app') {
  return {
    snapshotId, url, title: 'Fixture', scrollY: 0, scrollHeight: 900, viewportHeight: 600, viewportWidth: 800,
    elements, totalElements: elements.length, scanned: elements.length, scanCapped: false,
    crossOriginFrames: 0, headings: [], text: 'x'.repeat(700), query: '',
  };
}

function fixture(nextRevision, nextPayload, matches = true) {
  const guest = { getURL: () => 'https://fixture.example/app' };
  const state = new BrowserGuestStateStore();
  const reply = createBrowserReply({
    state,
    settleAfterAction: async () => {},
    postconditionMatchesGuest: async () => matches,
    captureSnapshotPayload: async () => {
      state.for(guest).refSet = { ...createBrowserRefSet(nextPayload), revision: nextRevision };
      return nextPayload;
    },
    captureScreenshot: async () => { throw new Error('unused'); },
    bindVisualGrounding: () => {},
    downloadsForGuest: () => [],
  });
  return { guest, state, reply };
}

const before = payload('p1-s1', [
  { ref: 'p1-s1-e1', role: 'button', name: 'Save', tag: 'ax' },
  { ref: 'p1-s1-e2', role: 'textbox', name: 'Email', tag: 'ax', value: '' },
]);
const baseline = () => ({ ...createBrowserRefSet(before), revision: revision(4) });

test('a gesture the page ignored is reported as no observable change; scroll is judged by position', async () => {
  const same = payload('p1-s2', before.elements.map((el) => ({ ...el, ref: el.ref.replace('s1', 's2') })));
  const ignored = fixture(revision(4), same);
  const result = await ignored.reply.snapshotResult(ignored.guest, { action: 'click' }, undefined, {
    settleAction: true, baseline: baseline(),
  });
  assert.match(result.text, /^No observable change: the document, URL, and control values are the same as before this click/);
  const reacted = fixture(revision(5), same);
  const changed = await reacted.reply.snapshotResult(reacted.guest, { action: 'click' }, undefined, {
    settleAction: true, baseline: baseline(),
  });
  assert.doesNotMatch(changed.text, /No observable change/);
  const scrolled = fixture(revision(4, 400), same);
  const scroll = await scrolled.reply.snapshotResult(scrolled.guest, { action: 'scroll' }, undefined, {
    settleAction: true, baseline: baseline(),
  });
  assert.doesNotMatch(scroll.text, /No observable change/);
  const observed = fixture(revision(4), same);
  const plain = await observed.reply.snapshotResult(observed.guest, { action: 'snapshot' }, undefined, {
    settleAction: false, baseline: baseline(),
  });
  assert.doesNotMatch(plain.text, /No observable change/, 'an observation is not a gesture');
});

test('brief replies list only new or changed elements and trim the text', async () => {
  const after = payload('p1-s2', [
    { ref: 'p1-s2-e1', role: 'button', name: 'Save', tag: 'ax' },
    { ref: 'p1-s2-e2', role: 'textbox', name: 'Email', tag: 'ax', value: 'ada@example.test' },
    { ref: 'p1-s2-e3', role: 'link', name: 'Continue', tag: 'ax', href: 'https://fixture.example/next' },
  ]);
  const f = fixture(revision(6), after);
  const result = await f.reply.snapshotResult(f.guest, { action: 'fill', brief: true }, undefined, {
    settleAction: true, baseline: baseline(),
  });
  assert.match(result.text, /Brief reply: 2 changed or new element\(s\); 1 unchanged omitted/);
  assert.match(result.text, /\[p1-s2-e2\] textbox "Email" value="ada@example.test"/);
  assert.match(result.text, /\[p1-s2-e3\] link "Continue"/);
  assert.doesNotMatch(result.text, /\[p1-s2-e1\]/);
  assert.doesNotMatch(result.text, /no longer matched|; \d+ gone/);
  assert.match(result.text, /use a known target directly/);
  assert.match(result.text, /Visible text \(first 500 of 700 chars/);
  const full = await f.reply.snapshotResult(f.guest, { action: 'fill' }, undefined, {
    settleAction: true, baseline: baseline(),
  });
  assert.match(full.text, /\[p1-s2-e1\] button "Save"/);
});

test('an already-true postcondition is a warning with an inconclusive outcome, and target notes are printed', async () => {
  const after = payload('p1-s2', []);
  const f = fixture(revision(9), after);
  const result = await f.reply.snapshotResult(f.guest, { action: 'click', expect: { text: 'x' } }, undefined, {
    settleAction: true, preexistingPostcondition: true, expected: { text: 'x', textGone: '', url: '', timeoutMs: 500 },
  });
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.text, /already true before this action, so it proves nothing/);
  const recovery = f.reply.refRecoveryFor(f.guest);
  recovery.resolvedTargets.push('button "Save" -> p1-s2-e1');
  assert.match(f.reply.decorateRecovery({ text: 'body' }, recovery).text, /^Target resolved before input dispatch: button "Save" -> p1-s2-e1\n\nbody$/);
});

test('brief comparison survives a narrowed target observation without changing effect detection', async () => {
  const after = payload('p1-s3', [
    { ...before.elements[0], ref: 'p1-s3-e1', states: ['focused'] },
    { ...before.elements[1], ref: 'p1-s3-e2' },
  ]);
  const targetBaseline = createBrowserRefSet(payload('p1-s2', [before.elements[0]]));
  targetBaseline.revision = revision(6);
  const f = fixture(revision(6), after);
  const options = { settleAction: true, baseline: targetBaseline, reportBaseline: baseline() };
  const result = await f.reply.snapshotResult(f.guest, { action: 'click', brief: true }, undefined, options);
  assert.match(result.text, /1 changed or new element\(s\); 1 unchanged omitted/);
  assert.match(result.text, /No observable change/);
  assert.doesNotMatch(result.text, /\[p1-s3-e2\]/);
  const failed = fixture(revision(6), after, false);
  await assert.rejects(
    failed.reply.snapshotResult(failed.guest, { action: 'click', brief: true }, undefined, {
      ...options, expected: { text: 'missing', textGone: '', url: '', timeoutMs: 0 },
    }),
    /Postcondition failed[\s\S]*1 changed or new element\(s\); 1 unchanged omitted/,
  );
});