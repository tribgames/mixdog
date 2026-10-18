import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import {
  noteVisualizeCards,
  rememberVisualizeTabTitles,
  subscribeVisualizeCards,
  visualizeCallTabTitle,
  visualizeCardCalls,
  visualizeCardNewest,
  visualizeCardTab,
  visualizeCardVersion,
} from './visualize-card-model.ts';

const openCall = (id, input, result, at) => ({
  id,
  kind: 'tool',
  name: 'visualize',
  args: { action: 'open', input },
  result,
  startedAt: at,
  completedAt: at + 1,
});

test('one card per tab: a group keeps its latest open, and a later group folds the earlier card', () => {
  const first = visualizeCardCalls([
    openCall(
      'a',
      { targets: ['site/a.html'], label: 'Alpha' },
      'Showing site/a.html (html) in the side panel as tab v1.',
      10
    ),
    openCall(
      'b',
      { targets: ['https://example.com'] },
      'Opened https://example.com in the browser panel (tab v2).',
      11
    ),
    openCall('c', { targets: ['site/a.html'], label: 'Alpha' }, 'Opened site/a.html (html) as tab v1, but …', 12),
  ]);
  assert.deepEqual(
    first.map((call) => [call.id, call.tabId]),
    [['c', 'v1']],
    'web URLs get no card; the same tab keeps its latest open'
  );
  const later = visualizeCardCalls([
    openCall(
      'd',
      { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } },
      'Showing inline mermaid "Flow" in the side panel as tab v3.',
      30
    ),
    openCall('e', { targets: ['site/a.html'] }, 'Showing site/a.html (html) in the side panel as tab v1.', 31),
  ]);
  let notified = 0;
  const stop = subscribeVisualizeCards(() => {
    notified += 1;
  });
  noteVisualizeCards('cards', first);
  noteVisualizeCards('cards', later);
  // A re-render of the earlier group must not take the tab back.
  noteVisualizeCards('cards', first);
  stop();
  assert.equal(notified, 2);
  assert.equal(visualizeCardNewest('cards', first[0]), false, 'the earlier v1 card folds');
  assert.equal(visualizeCardNewest('cards', later[1]), true);
  assert.equal(visualizeCardNewest('cards', later[0]), true);
  assert.equal(visualizeCardNewest('other', first[0]), true, 'per session');

  const tab = {
    id: 'v1',
    label: 'Alpha',
    revision: 2,
    panes: [{ kind: 'html', label: 'a.html', target: 'site/a.html', url: '' }],
    versions: [
      { n: 1, at: 1 },
      { n: 2, at: 2 },
      { n: 3, at: 3 },
    ],
  };
  const state = { sessionId: 'cards', tabs: [tab], active: 'v1' };
  assert.equal(visualizeCardTab(state, later[1]), tab);
  assert.equal(visualizeCardTab({ ...state, tabs: [] }, later[1]), null, 'a closed tab');
  assert.equal(visualizeCardVersion(tab), 3, 'live shows the newest version');
  assert.equal(visualizeCardVersion({ ...tab, version: 2 }), 2);
  assert.equal(visualizeCardVersion(null), 0);
});

test('visualize rows name the tab by the title it opened with, never its bare id', () => {
  const session = 'sess-rows';
  const opened = {
    id: 'o',
    kind: 'tool',
    name: 'visualize',
    args: { action: 'open', input: { targets: ['design/mockups/pricing.html'], label: '요금제 배치 시안 (3가지)' } },
    result: 'Showing design/mockups/pricing.html (html) in the side panel as tab v1.',
    completedAt: 1,
  };
  const call = (action, input) => ({
    id: action,
    kind: 'tool',
    name: 'visualize',
    args: { action, input },
    result: 'ok',
    completedAt: 2,
  });
  rememberVisualizeTabTitles(session, [opened]);
  const row = (item) =>
    desktopToolActivityItemPresentation(item, undefined, { visualizeTabTitle: visualizeCallTabTitle(session, item) })
      .subject;
  assert.equal(row(opened), 'Showed tab · 요금제 배치 시안 (3가지)');
  assert.equal(row(call('check', { tab: 'v1' })), 'Checked tab · 요금제 배치 시안 (3가지)');
  assert.equal(row(call('capture', { tab: 'v1' })), 'Captured tab · 요금제 배치 시안 (3가지)');
  assert.equal(row(call('close', { tab: 'v1' })), 'Closed tab · 요금제 배치 시안 (3가지)');
  assert.equal(row(call('inspect', { tab: 'v1' })), 'Inspected tab · 요금제 배치 시안 (3가지)');
  // Another session's v1, or an unknown tab, shows the verb alone.
  assert.equal(
    desktopToolActivityItemPresentation(call('check', { tab: 'v9' }), undefined, {
      visualizeTabTitle: visualizeCallTabTitle(session, call('check', { tab: 'v9' })),
    }).subject,
    'Checked tab'
  );
  assert.equal(visualizeCallTabTitle('other', call('check', { tab: 'v1' })), '');
});
