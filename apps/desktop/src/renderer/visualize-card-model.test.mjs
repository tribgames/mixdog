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
  visualizeCardOwnVersion,
  visualizeCardsShown,
  visualizeCardKind,
  visualizeCardKindLabel,
  visualizeCardLiveThumbnail,
  visualizeCardTab,
  visualizeCardThumbnailLine,
  visualizeCardVersion,
} from './visualize-card-model.ts';

test('a card picture is its own version: filed per version, never taken from another version', () => {
  const call = { id: 'c', pending: false, targets: ['site/a.html'], label: '', tabId: 'v1', at: 1 };
  assert.equal(visualizeCardThumbnailLine(call, 2), 'visualize|v1|v2|site/a.html');
  assert.notEqual(visualizeCardThumbnailLine(call, 1), visualizeCardThumbnailLine(call, 2));
  const picture = 'data:image/png;base64,AAAA';
  const tab = { id: 'v1', label: 'A', revision: 3, panes: [], thumbnail: picture, thumbnailVersion: 2 };
  assert.equal(visualizeCardLiveThumbnail(tab, 2), picture, 'the newest card takes the tab picture');
  assert.equal(visualizeCardLiveThumbnail(tab, 1), undefined, 'an earlier card keeps its own (saved or asked)');
  assert.equal(visualizeCardLiveThumbnail(null, 2), undefined, 'a closed tab has none live');
  assert.equal(visualizeCardLiveThumbnail({ ...tab, thumbnail: 'https://x/y.png' }, 2), undefined);

  // A window that never saw the turn end (a reload) still names the version
  // the open reported, so the earlier card finds its own picture.
  const [reported] = visualizeCardCalls([
    openCall(
      'r',
      { targets: ['site/a.html'] },
      'Prepared site/a.html (html) as tab v4 (version 2); the side panel shows it when this turn ends.',
      5
    ),
  ]);
  assert.deepEqual([reported.tabId, reported.version], ['v4', 2]);
  assert.equal(visualizeCardOwnVersion('s-reload', reported, 3, false), 2);
});

test('a card names its kind: the live panes, else what the open named', () => {
  const call = (input) => ({ id: 'c', pending: false, label: '', tabId: 'v1', at: 1, targets: [], ...input });
  const kind = (input, tab = null) => visualizeCardKindLabel(visualizeCardKind(call(input), tab));
  assert.equal(kind({ targets: ['a.html'] }), 'HTML');
  assert.equal(kind({ targets: ['shot.png'] }), 'Image');
  assert.equal(kind({ targets: ['report.pdf'] }), 'PDF');
  assert.equal(kind({ targets: ['a.html', 'b.md', 'c.png'] }), 'Split (3)');
  assert.equal(kind({ content: { kind: 'mermaid', source: 'graph TD;A-->B' } }), 'Mermaid');
  assert.equal(kind({ content: { kind: 'markdown', source: '# x' } }), 'Markdown');
  const tab = (panes) => ({ id: 'v1', label: '', revision: 1, panes });
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'pdf' }])), 'PDF');
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'inline', inline: { kind: 'svg', source: '' } }])), 'SVG');
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'html' }, { kind: 'image' }])), 'Split (2)');
  // A kept version beside live (compare) is still one artifact.
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'html', version: 1 }, { kind: 'html' }])), 'HTML');
});

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
  // Stepped back to a kept version: still the same open tab, not closed.
  const stepped = { ...tab, version: 2, panes: [{ ...tab.panes[0], version: 2 }] };
  assert.equal(visualizeCardTab({ ...state, tabs: [stepped] }, later[1]), stepped);
  assert.equal(visualizeCardVersion(tab), 3, 'live shows the newest version');
  assert.equal(visualizeCardVersion({ ...tab, version: 2 }), 2);
  assert.equal(visualizeCardVersion(null), 0);
});

test('a turn’s opens get no card while it runs and one card each at its end; older cards keep their version', () => {
  const earlier = visualizeCardCalls([
    openCall('e', { targets: ['site/a.html'] }, 'Showing site/a.html (html) in the side panel as tab v1.', 100),
  ]);
  const turn = visualizeCardCalls([
    openCall(
      'p1',
      { targets: ['site/a.html'] },
      'Prepared site/a.html (html) as tab v1; the side panel shows it when this turn ends.',
      1000
    ),
    openCall(
      'p2',
      { targets: ['site/a.html'] },
      'Prepared site/a.html (html) as tab v1; the side panel shows it when this turn ends.',
      1100
    ),
  ]);
  const running = { ...turn[0], id: 'p3', tabId: '', pending: true, at: 1200 };
  // The turn started at 900: its opens wait, the earlier turn's card stays.
  assert.deepEqual(
    visualizeCardsShown(earlier, 900).map((call) => call.id),
    ['e']
  );
  assert.deepEqual(visualizeCardsShown(turn, 900), [], 'no card, nor a changing one, mid-turn');
  // The turn ended: one card per tab it opened (the latest open of it); a still-running open is none.
  assert.deepEqual(
    visualizeCardsShown([...turn, running], null).map((call) => [call.id, call.tabId]),
    [['p2', 'v1']]
  );

  // The earlier card records its own version at its turn's end (once known as its tab's newest).
  const session = 'own-version';
  assert.equal(visualizeCardOwnVersion(session, earlier[0], 2, true), 2, 'unseen: drawn, not recorded');
  noteVisualizeCards(session, earlier);
  assert.equal(visualizeCardOwnVersion(session, earlier[0], 2, true), 2);
  // The later turn's end moves the tab on while the earlier card is still drawn as the newest.
  assert.equal(visualizeCardOwnVersion(session, earlier[0], 5, true), 5);
  noteVisualizeCards(session, visualizeCardsShown(turn, null));
  assert.equal(visualizeCardOwnVersion(session, turn.at(-1), 5, true), 5, 'the new card follows the tab');
  assert.equal(visualizeCardOwnVersion(session, earlier[0], 5, false), 2, 'the folded earlier card names v2');
  // A card that never recorded one (a reloaded renderer) names no version rather than a wrong one.
  assert.equal(visualizeCardOwnVersion(session, { ...earlier[0], id: 'other' }, 5, false), 0);
});

test('an open run through the call_tool bridge (a deferred tool) still gets its card', () => {
  const bridged = (id, input, result) => ({
    id,
    kind: 'tool',
    name: 'call_tool',
    args: { name: 'visualize', arguments: { action: 'open', input } },
    result,
    completedAt: 1,
  });
  const calls = visualizeCardCalls([
    bridged(
      'f',
      { targets: ['a.html'] },
      'Prepared a.html (html) as tab v1; the side panel shows it when this turn ends.'
    ),
    bridged(
      'm',
      { content: { kind: 'markdown', source: '# A', title: 'A notes' } },
      'Showing inline markdown "A notes" in the side panel as tab v2.'
    ),
    bridged('c', { tab: 'v1' }, 'No page problems on tab v1.'),
    // The bridge's `input` as JSON text, as models also send it.
    bridged('s', JSON.stringify({ targets: ['b.html'] }), 'Prepared b.html (html) as tab v3; the side panel shows it.'),
  ]);
  assert.deepEqual(
    calls.map((call) => [call.tabId, call.targets, call.content?.title ?? '']),
    [
      ['v1', ['a.html'], ''],
      ['v2', [], 'A notes'],
      ['v3', ['b.html'], ''],
    ]
  );
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
