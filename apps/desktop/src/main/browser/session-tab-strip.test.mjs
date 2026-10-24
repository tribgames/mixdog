import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessionTabStrip } from './session-tab-strip.ts';

test('selecting claims and retains the shown page; "+" claims without retaining', () => {
  const calls = [];
  const guest = { isDestroyed: () => false };
  const strip = createBrowserSessionTabStrip({
    tabs: {
      displayTabs: () => [{ id: 'p1' }],
      selectDisplayTab: (sessionId, tabId) => calls.push(['select', sessionId, tabId]),
      createDisplayTab: (sessionId) => calls.push(['create', sessionId]),
      closeDisplayTab: (sessionId, tabId) => calls.push(['close', sessionId, tabId]),
    },
    currentGuest: () => guest,
    lifecycle: {
      claimPage: (sessionId) => calls.push(['claim', sessionId]),
      replacementPage: () => guest,
    },
    pageId: () => 'p1',
    retainGuest: () => calls.push(['retain']),
  });
  assert.deepEqual(strip.list('s'), [{ id: 'p1' }]);
  strip.select('s', 'p1');
  strip.create('s');
  strip.close('s', 'p1');
  assert.deepEqual(calls, [
    ['select', 's', 'p1'],
    ['claim', 's'],
    ['retain'],
    ['create', 's'],
    ['claim', 's'],
    ['close', 's', 'p1'],
  ]);
  assert.equal(strip.isReplacement('s', 'p1'), true);
  assert.equal(strip.isReplacement('s', 'p2'), false);
});

test('a new tab reports its page with the request that asked; a "+" reports none', () => {
  const reported = [];
  const guest = { isDestroyed: () => false };
  const strip = createBrowserSessionTabStrip({
    tabs: { displayTabs: () => [], selectDisplayTab() {}, createDisplayTab() {}, closeDisplayTab() {} },
    currentGuest: () => guest,
    lifecycle: { claimPage() {}, replacementPage: () => null },
    pageId: () => 'p4',
    retainGuest() {},
    onCreate: (...args) => reported.push(args),
  });
  strip.create('s', 'req-1');
  strip.create('s');
  assert.deepEqual(reported, [
    ['s', 'p4', 'req-1'],
    ['s', 'p4', undefined],
  ]);
});
