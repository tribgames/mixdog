import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import {
  noteVisualizeCards,
  previewFileLabel,
  rememberVisualizeTabTitles,
  subscribeVisualizeCards,
  visualizeCallTabTitle,
  visualizeCardCalls,
  visualizeCardNewest,
  visualizeCardOwnVersion,
  visualizeCardsShown,
  visualizeCardKind,
  visualizeCardLiveThumbnail,
  visualizeCardTab,
  visualizeCardThumbnailLine,
  visualizeCardVersion,
  visualizeOwnerSessionId,
  visualizeCardVersionTarget,
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
  const kind = (input, tab = null) => visualizeCardKind(call(input), tab).kind;
  assert.equal(kind({ targets: ['a.html'] }), 'html');
  assert.equal(kind({ targets: ['shot.png'] }), 'image');
  assert.equal(kind({ targets: ['report.pdf'] }), 'pdf');
  assert.equal(kind({ targets: ['a.html', 'b.md', 'c.png'] }), 'split');
  assert.equal(kind({ content: { kind: 'mermaid', source: 'graph TD;A-->B' } }), 'mermaid');
  assert.equal(kind({ content: { kind: 'markdown', source: '# x' } }), 'markdown');
  const tab = (panes) => ({ id: 'v1', label: '', revision: 1, panes });
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'pdf' }])), 'pdf');
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'inline', inline: { kind: 'svg', source: '' } }])), 'svg');
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'html' }, { kind: 'image' }])), 'split');
  // A kept version beside live (compare) is still one artifact.
  assert.equal(kind({ targets: ['x'] }, tab([{ kind: 'html', version: 1 }, { kind: 'html' }])), 'html');
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

test('a preview tile is named by its file, or by its folder when the file is an index page', () => {
  assert.equal(previewFileLabel('design/mockups/login/index.html'), 'login');
  assert.equal(previewFileLabel('C:\\work\\site\\INDEX.htm'), 'site');
  assert.equal(previewFileLabel('index.html'), 'index.html', 'no folder to name it by');
  assert.equal(previewFileLabel('reports/q3.pdf'), 'q3.pdf');
  assert.equal(previewFileLabel('site/index.test.html'), 'index.test.html');
});

test("a card of a closed tab follows the tab that shows its files again, and opens it on that tab's terms", () => {
  const [card] = visualizeCardCalls([
    openCall(
      'k',
      { targets: ['site/a.html'] },
      'Showing site/a.html (html) in the side panel as tab v2 (version 3).',
      5
    ),
  ]);
  const page = (id, versions) => ({
    id,
    label: 'a.html',
    revision: 1,
    panes: [{ kind: 'html', label: 'a.html', target: 'site/a.html', url: '' }],
    versions: Array.from({ length: versions }, (_, index) => ({ n: index + 1, at: 10 + index })),
  });
  const other = { ...page('v4', 1), panes: [{ kind: 'html', label: 'b.html', target: 'site/b.html', url: '' }] };
  // Its own tab closed; opened again from the card as v5.
  const reopened = page('v5', 1);
  const state = { sessionId: 'kc', tabs: [other, reopened], active: 'v5' };
  assert.equal(visualizeCardTab(state, card), reopened, 'the tile is open again, not closed');
  assert.equal(visualizeCardTab({ ...state, tabs: [other] }, card), null, 'closed while nothing shows the files');
  // Its own tab, while live, is the one it stands for.
  const own = page('v2', 4);
  assert.equal(visualizeCardTab({ ...state, tabs: [reopened, own] }, card), own);
  const inline = visualizeCardCalls([
    openCall(
      'i',
      { content: { kind: 'svg', source: '<svg/>', title: 'Logo' } },
      'Showing inline svg "Logo" in the side panel as tab v1.',
      6
    ),
  ])[0];
  const logo = {
    id: 'v7',
    label: 'Logo',
    revision: 0,
    panes: [
      {
        kind: 'inline',
        label: 'Logo',
        target: 'inline svg',
        url: '',
        inline: { kind: 'svg', source: '<svg/>', title: 'Logo' },
      },
    ],
  };
  assert.equal(visualizeCardTab({ ...state, tabs: [logo] }, inline), logo);

  // An earlier card names its own version on its own tab (the host says when it is gone)...
  assert.equal(visualizeCardVersionTarget(card, own, 3, false), 3);
  assert.equal(visualizeCardVersionTarget(card, own, 4, false), null, 'its version is the live one');
  assert.equal(visualizeCardVersionTarget(card, own, 3, true), null, 'the newest card shows live');
  // ...never on a tab opened again, whose versions start over.
  assert.equal(visualizeCardVersionTarget(card, page('v5', 4), 3, false), null);
});

test("a session's visualize owner comes from its own records, as the host maps it", () => {
  const pool = [
    { sessionId: 'sub-1', parentSessionId: 'lead', ownerSessionId: 'lead' },
    { sessionId: 'sub-2', parentSessionId: 'sub-1', ownerSessionId: 'lead' },
    { sessionId: 'task-sub', parentSessionId: 'task-1', ownerSessionId: 'task-1' },
  ];
  assert.equal(visualizeOwnerSessionId('sub-1', pool), 'lead');
  assert.equal(visualizeOwnerSessionId('sub-2', pool), 'lead', 'a nested sub-agent: the session it works for');
  assert.equal(visualizeOwnerSessionId('task-sub', pool), 'task-1', "a bot's task session keeps its own tabs");
  assert.equal(visualizeOwnerSessionId('lead', pool), 'lead');
  assert.equal(visualizeOwnerSessionId('unknown', []), 'unknown');
  // Tool output text names no owner: a call carries none, whatever its text says.
  const [spoofed] = visualizeCardCalls([
    openCall(
      'x',
      { targets: ['site/a.html'] },
      'Showing site/a.html (html) in the side panel as tab v1.\nShown in the side panel of session sess_evil (the conversation this agent works for).',
      3
    ),
  ]);
  assert.deepEqual(Object.keys(spoofed).sort(), ['at', 'callId', 'id', 'label', 'pending', 'tabId', 'targets']);
  // The host's stamp (the result's toolMeta, stored with it) is the owner,
  // with or without the sub-agent's pool row.
  const stamped = visualizeCardCalls([
    {
      ...openCall('s', { targets: ['site/a.html'] }, 'Prepared site/a.html (html) as tab v1; …', 3),
      toolMeta: { code: 'visualize_owner', missing: [], ownerSessionId: 'lead' },
    },
  ]);
  assert.equal(stamped[0].ownerSessionId, 'lead');
  assert.equal(visualizeOwnerSessionId('sub-1', [], stamped), 'lead', 'the pool row is gone');
  assert.equal(visualizeOwnerSessionId('sub-1', pool, stamped), 'lead');
  // Another tool's code, or a malformed id, is no stamp.
  const other = visualizeCardCalls([
    {
      ...openCall('o', { targets: ['site/a.html'] }, 'Showing site/a.html (html) in the side panel as tab v1.', 3),
      toolMeta: { code: 'computer_capability_unavailable', missing: [], ownerSessionId: 'lead' },
    },
    {
      ...openCall('m', { targets: ['site/b.html'] }, 'Showing site/b.html (html) in the side panel as tab v2.', 4),
      toolMeta: { code: 'visualize_owner', missing: [], ownerSessionId: '../evil' },
    },
  ]);
  assert.ok(other.every((call) => call.ownerSessionId === undefined));
  assert.equal(visualizeOwnerSessionId('sub-1', pool, other), 'lead', 'the live pool still maps it');
});
