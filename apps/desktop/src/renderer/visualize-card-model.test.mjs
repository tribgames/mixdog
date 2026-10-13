import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import {
  rememberVisualizeTabTitles,
  visualizeCallTabTitle,
  visualizeCardCalls,
  visualizeCardKind,
  visualizeCardTab,
  visualizeCardVersion,
  visualizeResultTabId,
} from './visualize-card-model.ts';

const open = (id, targets, result, extra = {}) => ({
  id,
  kind: 'tool',
  name: 'visualize',
  args: { action: 'open', input: { targets, ...extra } },
  ...(result === undefined ? {} : { result, completedAt: 1 }),
});

test('cards come from file opens: pending ones shimmer, URLs and failures get none, one card per tab', () => {
  const items = [
    open(
      'a',
      ['site/index.html'],
      'Showing site/index.html (html) in the side panel as tab v1. The tab reloads when the file changes.\nv1 html index.html → site/index.html'
    ),
    open('b', ['http://localhost:3000/'], "Opened http://localhost:3000/ in the session's browser panel (tab v2)."),
    { ...open('c', ['missing.png'], 'Error: target not found: missing.png'), isError: true },
    {
      id: 'd',
      kind: 'tool',
      name: 'visualize',
      args: { action: 'capture', input: { tab: 'v1', output: 'a.png' } },
      result: 'Captured',
      completedAt: 1,
    },
    open('e', ['site/index.html'], 'Showing site/index.html (html) in the side panel as tab v1.', { label: 'Home' }),
    open('f', ['a.png', 'b.pdf']),
  ];
  const calls = visualizeCardCalls(items);
  assert.deepEqual(
    calls.map((call) => [call.id, call.pending, call.tabId, call.label, call.targets]),
    [
      ['e', false, 'v1', 'Home', ['site/index.html']],
      ['f', true, '', '', ['a.png', 'b.pdf']],
    ]
  );
  // Stored calls may carry their arguments as JSON text and their result as content parts.
  const stored = {
    id: 'g',
    name: 'visualize',
    args: JSON.stringify({ action: 'open', input: { targets: ['chart.png'] } }),
    result: { content: [{ type: 'text', text: 'Showing chart.png (image) in the side panel as tab v4.' }] },
    completedAt: 1,
  };
  assert.equal(visualizeResultTabId(stored), 'v4');
  assert.deepEqual(
    visualizeCardCalls([stored]).map((call) => call.tabId),
    ['v4']
  );
});

test('a card stands for its live tab only while that tab shows the same files', () => {
  const call = { id: 'a', pending: false, targets: ['C:\\work\\site\\index.html'], label: '', tabId: 'v1' };
  const tab = (id, target, extra = {}) => ({
    id,
    label: 'index.html',
    revision: 1,
    panes: [{ kind: 'html', label: 'index.html', target, url: '' }],
    ...extra,
  });
  const state = (tabs) => ({ sessionId: 's1', active: null, tabs });
  assert.equal(visualizeCardTab(state([]), call), null, 'closed');
  assert.equal(visualizeCardTab(state([tab('v1', 'other.html')]), call), null, 'the id now names other files');
  // A remote client sees the cwd-relative target of an absolute-path open.
  assert.equal(visualizeCardTab(state([tab('v1', 'site/index.html')]), call)?.id, 'v1');
  assert.equal(visualizeCardTab(state([tab('v1', 'C:\\work\\site\\index.html')]), call)?.id, 'v1');
  // A kept version on screen beside live still counts by its live panes.
  const comparing = tab('v1', 'site/index.html', {
    panes: [
      { kind: 'html', label: 'index.html', target: 'site/index.html', url: '', version: 1 },
      { kind: 'html', label: 'index.html', target: 'site/index.html', url: '' },
    ],
    versions: [
      { n: 1, at: 1 },
      { n: 2, at: 2 },
    ],
    version: 1,
  });
  const live = visualizeCardTab(state([comparing]), call);
  assert.equal(live?.id, 'v1');
  assert.equal(visualizeCardVersion(live), 'v1');
  assert.equal(visualizeCardVersion({ ...comparing, version: null }), 'v2');
  assert.equal(visualizeCardVersion(tab('v1', 'a.html', { versions: [{ n: 1, at: 1 }] })), '', 'one version: no badge');
});

test('the card icon follows the live pane kind, else the target extension', () => {
  const call = (targets) => ({ id: 'a', pending: false, targets, label: '', tabId: '' });
  assert.equal(visualizeCardKind(call(['a.png']), null), 'image');
  assert.equal(visualizeCardKind(call(['clip.MP4']), null), 'video');
  assert.equal(visualizeCardKind(call(['deck.pptx']), null), 'document');
  assert.equal(visualizeCardKind(call(['a.png', 'b.pdf']), null), 'split');
  assert.equal(
    visualizeCardKind(call(['page']), {
      id: 'v1',
      label: '',
      revision: 0,
      panes: [{ kind: 'html', label: '', target: 'page', url: '' }],
    }),
    'html'
  );
});

test('inline content opens get a card: kind icon, title, tab match by title, reopen from the stored content', () => {
  const inline = (id, content, result) => ({
    id,
    kind: 'tool',
    name: 'visualize',
    args: { action: 'open', input: { content } },
    ...(result === undefined ? {} : { result, completedAt: 1 }),
  });
  const done =
    'Showing inline chart "Sales" in the side panel as tab v3. Open again with the same title to add a version.';
  const calls = visualizeCardCalls([
    inline('a', { kind: 'chart', source: '{}', title: 'Sales' }, done),
    inline('b', { kind: 'mermaid', source: 'graph TD;A-->B' }),
    inline('c', { kind: 'nope', source: 'x' }, done),
    inline('d', { kind: 'svg', source: '   ' }, done),
  ]);
  assert.deepEqual(
    calls.map((call) => [call.id, call.pending, call.tabId, call.targets, call.content?.kind, call.content?.title]),
    [
      ['a', false, 'v3', [], 'chart', 'Sales'],
      ['b', true, '', [], 'mermaid', undefined],
    ]
  );
  assert.equal(visualizeCardKind(calls[0], null), 'chart');
  assert.equal(visualizeCardKind(calls[1], null), 'mermaid');

  // The live tab is the one with the same inline title and kind; later opens (new versions) still match.
  const pane = (title, kind = 'chart', version) => ({
    kind: 'html',
    label: title,
    target: title,
    url: 'x',
    inline: { kind, source: '{"n":2}', title },
    ...(version ? { version } : {}),
  });
  const tab = {
    id: 'v3',
    label: 'Sales',
    revision: 1,
    panes: [pane('Sales')],
    versions: [
      { n: 1, at: 1 },
      { n: 2, at: 2 },
    ],
    version: null,
  };
  const state = { sessionId: 's1', active: 'v3', tabs: [tab] };
  assert.equal(visualizeCardTab(state, calls[0]), tab);
  assert.equal(visualizeCardVersion(tab), 'v2');
  assert.equal(visualizeCardTab({ ...state, tabs: [{ ...tab, panes: [pane('Other')] }] }, calls[0]), null);
  assert.equal(visualizeCardTab({ ...state, tabs: [{ ...tab, panes: [pane('Sales', 'html')] }] }, calls[0]), null);
  assert.equal(visualizeCardTab({ ...state, tabs: [] }, calls[0]), null, 'closed once the tab is gone');
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
