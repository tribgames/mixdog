import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import { rememberVisualizeTabTitles, visualizeCallTabTitle } from './visualize-card-model.ts';

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
