import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesContext } from './TurnChangesCard.tsx';
import { PreviewedTurnChangesCard, ToolVisualizeCards } from './transcript-visualize-card.tsx';
import { resetTurnChangesCache } from './turn-changes-model.ts';
import { versionProducedAt } from '../shared/visualize.ts';
import { linkedLocalPaths } from './markdown-plugins.ts';
import {
  noteVisualizeCards,
  resetVisualizeCardMemory,
  visualizeCardNewest,
  visualizeCardOwnVersion,
} from './visualize-card-model.ts';
import {
  claimTurnPreviewEnd,
  forgetTurnPreviewMarks,
  isBuildOutputPath,
  noteTurnRunning,
  resetTurnPreviews,
  runningTurnKeyOf,
  takeTurnPreviewOpen,
  turnPreviewBadge,
  turnPreviewBadgeFor,
  turnPreviewFiles,
  turnPreviewOpenOrder,
  turnPreviewOpenPending,
  turnPreviewPage,
} from './turn-preview-model.ts';
import {
  applyVisualizeEvent,
  onVisualizeRevealRequested,
  openTurnPreviews,
  resetVisualizePanelMemory,
  resyncVisualizeStates,
  suppressVisualizeReveal,
  visualizeStateFor,
} from './visualize-store.ts';

const h = React.createElement;
const ROOT = 'C:/Project/app';

const file = (path, status = 'M', extra = {}) => ({
  path,
  status,
  additions: 1,
  deletions: 0,
  state: 'applied',
  revertable: true,
  ...extra,
});

const LINKS =
  'See [report](reports/q3-sales.pdf), `site/dashboard.html`, [deck](deck/review.pptx), [clip](media/clip.webm), ' +
  '[chart](tests/chart.png), [out](deliverables/out.html), [m](design/mockups/settings/index.html), ' +
  '[ding](sound/ding.mp3), [opened](site/opened.html), [ghost](gone.svg), [dist](dist/bundle.html).';

test('collection: linked panel kinds on disk, not build output, one per file, minus the agent opens', () => {
  const files = [
    file('reports/q3-sales.pdf', 'A'),
    file('site/dashboard.html'),
    file('tests/chart.png', 'A'),
    file('src/app.ts'),
    file('dist/bundle.html', 'A'),
    file('node_modules/pkg/readme.html'),
    // Git-ignored but in the record, so a file tool of the agent wrote it: an artifact once linked.
    // (A shell command's output never enters the record, so it has no entry at all.)
    file('deliverables/out.html', 'A', { ignored: true }),
    file('gone.svg', 'D'),
    file('undone.html', 'M', { state: 'reverted' }),
    file('C:/elsewhere/page.html'),
    file('deck/review.pptx', 'A'),
    file('media/clip.webm', 'A'),
    file('sound/ding.mp3', 'A'),
    file('design/mockups/settings/index.html', 'A'),
    file('site/opened.html'),
    file('src/renderer/desktop-pet.html'),
  ];
  const previews = turnPreviewFiles(files, ROOT, [`${ROOT}/site/opened.html`], LINKS);
  assert.deepEqual(
    previews.map((preview) => [preview.path, preview.kind, preview.badge]),
    [
      ['reports/q3-sales.pdf', 'pdf', 'new'],
      ['site/dashboard.html', 'html', null],
      ['tests/chart.png', 'image', 'new'],
      ['deliverables/out.html', 'html', 'new'],
      ['deck/review.pptx', 'document', 'new'],
      ['media/clip.webm', 'video', 'new'],
      ['sound/ding.mp3', 'audio', 'new'],
      ['design/mockups/settings/index.html', 'html', 'mockup'],
    ],
    'in the order the turn lists them; the unlinked source page is left to the diff card'
  );
  assert.equal(previews[0].target, `${ROOT}/reports/q3-sales.pdf`, 'opened by its path under the root');
  assert.equal(previews[0].created, true);
  // One tile per file, however its path is spelled; the root's separators normalized.
  const twice = turnPreviewFiles([file('a.svg'), file('./a.svg')], 'C:\\Project\\app', [], '[a](a.svg)');
  assert.deepEqual(
    twice.map((preview) => preview.target),
    ['C:/Project/app/a.svg']
  );
});

test('an edited previewable file nobody linked or opened gets no card; created+linked ones do', () => {
  const page = file('src/renderer/desktop-pet.html');
  assert.deepEqual(turnPreviewFiles([page], ROOT, [], 'Changed the title.'), []);
  assert.deepEqual(
    turnPreviewFiles([page], ROOT, [], 'Changed the title in desktop-pet.html.'),
    [],
    'a bare mention is no link'
  );
  assert.deepEqual(
    turnPreviewFiles([page], ROOT, [], 'Changed `src/renderer/desktop-pet.html`.').map((p) => p.path),
    ['src/renderer/desktop-pet.html']
  );
  for (const [path, reply] of [
    ['reports/a.pdf', '[a](reports/a.pdf)'],
    ['site/new.html', 'Done: `site/new.html`'],
    ['site/new2.html', 'Done: [x](./site/new2.html "t")'],
    ['site/abs.html', `[x](${ROOT}/site/abs.html)`],
  ]) {
    assert.deepEqual(
      turnPreviewFiles([file(path, 'A')], ROOT, [], reply).map((p) => p.path),
      [path],
      reply
    );
  }
  assert.deepEqual(
    turnPreviewFiles([file('site/x.html', 'A')], ROOT, [], '```\nsite/x.html\n```'),
    [],
    'fenced code is no link'
  );
});

test('a file surfaced earlier in the conversation stays an artifact in later turns', () => {
  const report = file('out/../reports/report.html');
  assert.deepEqual(turnPreviewFiles([file('reports/report.html')], ROOT, [], 'Fixed the header.'), []);
  assert.deepEqual(
    turnPreviewFiles([file('reports/report.html')], ROOT, [], 'Fixed the header.', ['reports/report.html']).map(
      (p) => p.path
    ),
    ['reports/report.html'],
    'linked by an earlier reply'
  );
  assert.deepEqual(
    turnPreviewFiles([file('reports/report.html')], ROOT, [], '', [`${ROOT}/reports/report.html`]).map((p) => p.path),
    ['reports/report.html'],
    'opened earlier by absolute target'
  );
  assert.deepEqual(turnPreviewFiles([file('reports/other.html')], ROOT, [], '', ['reports/report.html']), []);
  assert.equal(report.status, 'M');
});

test('build output folders are any path segment but the file name', () => {
  assert.equal(isBuildOutputPath('dist/index.html'), true);
  assert.equal(isBuildOutputPath('apps/web/.next/page.html'), true);
  assert.equal(isBuildOutputPath('docs/build.html'), false);
  assert.equal(isBuildOutputPath('reports/q3.pdf'), false);
});

test('linked paths: markdown links, inline code and prose paths, never fenced code or URLs', () => {
  const linked = linkedLocalPaths(
    '[a](reports/a.pdf) ![i](img/p.png) [w](https://x.dev/a.html) `site/b.html:12` see src/c.html and\n```\nd/e.html\n```'
  );
  assert.deepEqual(linked.sort(), ['img/p.png', 'reports/a.pdf', 'site/b.html', 'src/c.html']);
});
test('badges: Mockup wins over New, New only for created files, none for modified ones', () => {
  assert.equal(turnPreviewBadge('design/mockups/a/index.html', true), 'mockup');
  assert.equal(turnPreviewBadge('design/mockups/a/index.html', false), 'mockup');
  assert.equal(turnPreviewBadge('reports/a.pdf', true), 'new');
  assert.equal(turnPreviewBadge('reports/a.pdf', false), null);
  const files = [file('site/new.html', 'A'), file('site/old.html')];
  assert.equal(turnPreviewBadgeFor(['site/new.html'], files, ROOT), 'new', 'an agent open of a created file');
  assert.equal(turnPreviewBadgeFor([`${ROOT}/site/old.html`], files, ROOT), null);
  assert.equal(turnPreviewBadgeFor(['design/mockups/m/index.html'], [], ROOT), 'mockup');
  assert.equal(turnPreviewBadgeFor(['site/new.html', 'site/old.html'], files, ROOT), null, 'a split names no one file');
});

test('open order: every confident file, the first created one last (shown)', () => {
  const previews = turnPreviewFiles(
    [file('a.html'), file('b.pdf', 'A'), file('c.pdf', 'A'), file('d.png', 'A')],
    ROOT,
    [],
    '[a](a.html) [b](b.pdf) [c](c.pdf)'
  );
  assert.deepEqual(turnPreviewOpenOrder(previews), [`${ROOT}/a.html`, `${ROOT}/c.pdf`, `${ROOT}/b.pdf`]);
  assert.deepEqual(turnPreviewOpenOrder(turnPreviewFiles([file('d.png', 'A')], ROOT, [], '')), [], 'unlinked');
});

test('pagination: six per page, clamped', () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  assert.deepEqual(turnPreviewPage(items, 0), { items: [0, 1, 2, 3, 4, 5], page: 0, pages: 2 });
  assert.deepEqual(turnPreviewPage(items, 1), { items: [6, 7], page: 1, pages: 2 });
  assert.deepEqual(turnPreviewPage(items, 5), { items: [6, 7], page: 1, pages: 2 });
  assert.deepEqual(turnPreviewPage(items.slice(0, 6), 0).pages, 1);
  assert.deepEqual(turnPreviewPage([], 0), { items: [], page: 0, pages: 1 });
});

test('the live turn end is claimed once, only by the very turn seen running', () => {
  resetTurnPreviews();
  claimTurnPreviewEnd('s', 'turn:h', 'cp-history');
  assert.equal(turnPreviewOpenPending('s', 'cp-history'), false, 'a turn never seen running opens nothing');
  noteTurnRunning('s', 'turn:x');
  claimTurnPreviewEnd('s', 'turn:y', 'cp-y');
  assert.equal(turnPreviewOpenPending('s', 'cp-y'), false, "turn X's mark never opens checkpoint Y");
  claimTurnPreviewEnd('t', 'turn:x', 'cp-x');
  assert.equal(turnPreviewOpenPending('t', 'cp-x'), false, 'nor another session’s');
  claimTurnPreviewEnd('s', 'turn:x', 'cp-x');
  assert.equal(turnPreviewOpenPending('s', 'cp-x'), true);
  claimTurnPreviewEnd('s', 'turn:x', 'cp-x2');
  assert.equal(turnPreviewOpenPending('s', 'cp-x2'), false, 'one claim per seen run');
  assert.equal(takeTurnPreviewOpen('s', 'cp-x'), true);
  assert.equal(takeTurnPreviewOpen('s', 'cp-x'), false);
  // A reconnect or the transcript replaced drops the session's marks.
  noteTurnRunning('s', 'turn:z');
  forgetTurnPreviewMarks('s');
  claimTurnPreviewEnd('s', 'turn:z', 'cp-z');
  assert.equal(turnPreviewOpenPending('s', 'cp-z'), false);
});

test('the conversation marks its running turn and drops the marks on reconnect or leaving', async (t) => {
  resetTurnPreviews();
  const { root, dom } = installTestDom(t, { rootId: 'root' });
  const { useConversationLinkSurfaces } = await import('./use-conversation-link-surfaces.ts');
  function Probe({ running, turnKey, sessionId = 's' }) {
    useConversationLinkSurfaces(
      {},
      {
        turnChangesSessionId: sessionId,
        turnChangesBusy: running,
        turnChangesRunning: running,
        runningTurnKey: running ? turnKey : '',
      }
    );
    return null;
  }
  const show = (props) => act(async () => root.render(h(Probe, props)));
  await show({ running: true, turnKey: 'turn:x' });
  await show({ running: false });
  claimTurnPreviewEnd('s', 'turn:x', 'cp-x');
  assert.equal(takeTurnPreviewOpen('s', 'cp-x'), true, 'the turn seen running ends live');

  await show({ running: true, turnKey: 'turn:y' });
  await show({ running: false });
  await act(async () => dom.window.dispatchEvent(new dom.window.Event('mixdog:remote-reconnected')));
  claimTurnPreviewEnd('s', 'turn:y', 'cp-y');
  assert.equal(turnPreviewOpenPending('s', 'cp-y'), false, 'a reconnect onto the ended turn opens nothing');

  await show({ running: true, turnKey: 'turn:z' });
  await show({ running: false, sessionId: 'other' });
  claimTurnPreviewEnd('s', 'turn:z', 'cp-z');
  assert.equal(turnPreviewOpenPending('s', 'cp-z'), false, 'leaving the session drops its marks');
});

test('turn previews open through main reopen; a panel the user closed is not revealed', async () => {
  resetVisualizePanelMemory();
  const sent = [];
  const reveals = [];
  const previous = globalThis.window;
  globalThis.window = {
    mixdogDesktop: {
      visualizeCommand: async (command) => {
        sent.push(command);
        // Main's open answers with its publish (an agent open's reveal).
        const tabs = sent.map((one, index) => ({
          id: `v${index + 1}`,
          label: 'x',
          revision: 0,
          panes: [{ target: one.targets[0] }],
        }));
        applyVisualizeEvent({
          sessionId: command.sessionId,
          state: { sessionId: command.sessionId, tabs, active: tabs.at(-1).id },
          reveal: true,
          tab: tabs.at(-1).id,
        });
      },
    },
  };
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    suppressVisualizeReveal('closed');
    await openTurnPreviews('closed', ['C:/p/a.pdf']);
    assert.deepEqual(sent, [{ sessionId: 'closed', tabId: 'preview', action: 'reopen', targets: ['C:/p/a.pdf'] }]);
    assert.deepEqual(reveals, [], 'the closed panel stays closed');
    sent.length = 0;
    await openTurnPreviews('open', ['C:/p/b.html', 'C:/p/a.pdf']);
    assert.deepEqual(
      sent.map((command) => command.targets[0]),
      ['C:/p/b.html', 'C:/p/a.pdf']
    );
    assert.deepEqual(reveals, ['open', 'open'], 'the open policy brings the panel up, the last one shown');
  } finally {
    stop();
    globalThis.window = previous;
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  }
});

test('a panel closed while turn previews are pending stays closed for every later reveal', async () => {
  resetVisualizePanelMemory();
  const sent = [];
  const reveals = [];
  const previous = globalThis.window;
  // `beforeReveal(n)` runs between the n-th request reaching main and its
  // reveal arriving here.
  let beforeReveal = () => {};
  globalThis.window = {
    mixdogDesktop: {
      visualizeCommand: async (command) => {
        sent.push(command);
        const tabs = sent
          .filter((one) => one.sessionId === command.sessionId)
          .map((one, index) => ({ id: `v${index + 1}`, label: 'x', revision: 0, panes: [{ target: one.targets[0] }] }));
        beforeReveal(tabs.length);
        applyVisualizeEvent({
          sessionId: command.sessionId,
          state: { sessionId: command.sessionId, tabs, active: tabs.at(-1).id },
          reveal: true,
          tab: tabs.at(-1).id,
        });
      },
    },
  };
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    // Open at the start; the user closes the panel after the first reveal.
    beforeReveal = (n) => {
      if (n === 2) suppressVisualizeReveal('later');
    };
    await openTurnPreviews('later', ['C:/p/a.html', 'C:/p/b.pdf', 'C:/p/c.pdf']);
    assert.equal(sent.length, 3, 'every tab is still made');
    assert.deepEqual(reveals, ['later'], 'only the open before the close revealed the panel');
    assert.equal(visualizeStateFor('later').tabs.length, 3);

    // Closed after the request was sent, before its reveal arrived.
    sent.length = 0;
    reveals.length = 0;
    beforeReveal = () => suppressVisualizeReveal('racing');
    await openTurnPreviews('racing', ['C:/p/a.pdf']);
    assert.deepEqual(reveals, [], 'a close made before the reveal holds');
  } finally {
    stop();
    globalThis.window = previous;
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  }
});

/** Mounts a turn's preview card and its changed-files card. */
async function mountTurn(t, { files, replyText = '', surfacedBefore, trailing = false, running = false, items }) {
  resetTurnChangesCache();
  resetTurnPreviews();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const commands = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async () => ({
      value: { status: 'ready', checkpointId: 'cp', revision: 1, root: ROOT, files, canUndo: true, canReapply: false },
    }),
    visualizeCommand: async (command) => {
      commands.push(command);
    },
  };
  t.after(() => resyncVisualizeStates([]));
  const turnItems = items ?? [
    { id: 't1', kind: 'tool', name: 'apply_patch', args: {}, result: 'ok', status: 'done', completedAt: 10 },
  ];
  const turnChanges = { checkpointId: 'cp', boundary: 'd1', trailing };
  const render = (turnRunning) =>
    act(async () => {
      root.render(
        h(
          TurnChangesContext.Provider,
          { value: { sessionId: 's1', busy: false, turnRunning, onOpenSessionDiff() {}, onOpenFile() {} } },
          h(ToolVisualizeCards, {
            items: turnItems,
            sessionId: 's1',
            turnChanges,
            replyText,
            surfacedBefore,
            endTurnKey: 'turn:1',
          }),
          h(PreviewedTurnChangesCard, { turnChanges, visualized: [] })
        )
      );
    });
  await render(running);
  await settle();
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const click = (node) =>
    act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  return { commands, q, qa, click, render, root };
}

const settle = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

const ALL_LINKS =
  '[a](reports/q3-sales.pdf) [b](site/dashboard.html) [c](tests/chart.png) [d](design/mockups/settings/index.html) [e](dist/bundle.html)';

const TURN_FILES = [
  file('reports/q3-sales.pdf', 'A'),
  file('site/dashboard.html'),
  file('tests/chart.png', 'A'),
  file('design/mockups/settings/index.html', 'A'),
  file('dist/bundle.html', 'A'),
  file('src/app.ts'),
];

test('a loaded turn: its previews fill the card, its changes card keeps the rest, nothing opens', async (t) => {
  const view = await mountTurn(t, { files: TURN_FILES, replyText: ALL_LINKS });
  const tiles = view.qa('.transcript-visualize-tile');
  assert.deepEqual(
    tiles.map((tile) => tile.querySelector('b').textContent),
    ['q3-sales.pdf', 'dashboard.html', 'chart.png', 'index.html']
  );
  assert.equal(view.q('.transcript-visualize-title').textContent, 'Previews 4');
  assert.deepEqual(
    tiles.map((tile) => tile.querySelector('.is-mark')?.textContent ?? ''),
    ['New', '', 'New', 'Mockup']
  );
  // No tab yet: dimmed "Not opened", which a click opens.
  assert.ok(tiles.every((tile) => tile.dataset.visualizeCard === 'unopened' && tile.classList.contains('is-closed')));
  assert.equal(tiles[2].querySelector('.transcript-visualize-status').textContent, 'Not opened');
  assert.equal(view.q('.transcript-visualize-pager'), null, 'no pager at six or fewer');
  assert.deepEqual(view.commands, [], 'a turn not seen ending here opens nothing');
  // The changed-files card lists only what is not a tile, as for agent opens.
  const changes = view.q('.turn-changes-card');
  assert.equal(changes.dataset.fileCount, '2');
  assert.equal(view.q('.transcript-visualize-turn .turn-changes-action'), null, 'Undo stays on the changes card');
  await view.click(tiles[2]);
  assert.deepEqual(view.commands, [
    { sessionId: 's1', tabId: 'preview', action: 'reopen', targets: [`${ROOT}/tests/chart.png`], label: 'chart.png' },
  ]);
});

test('every changed file a tile: no changes card, Undo on the preview card', async (t) => {
  const view = await mountTurn(t, {
    files: [file('reports/a.pdf', 'A'), file('site/b.html')],
    replyText: '[a](reports/a.pdf) [b](site/b.html)',
  });
  assert.equal(view.q('.turn-changes-card'), null);
  assert.ok(view.q('.transcript-visualize-turn .turn-changes-action'), 'the turn’s Undo sits on the preview card');
});

test('a live turn end opens its confident previews once, the first created shown last', async (t) => {
  const view = await mountTurn(t, {
    files: TURN_FILES,
    replyText: '[m](design/mockups/settings/index.html) [p](reports/q3-sales.pdf)',
    trailing: true,
    running: true,
  });
  assert.equal(view.q('.transcript-visualize-turn'), null, 'nothing appears while the turn runs');
  assert.equal(view.q('.turn-changes-card'), null);
  noteTurnRunning('s1', 'turn:other');
  await view.render(false);
  await settle();
  assert.deepEqual(view.commands, [], 'another turn’s running mark opens nothing here');
  await act(async () => view.root.render(null));
  await view.render(true);
  noteTurnRunning('s1', 'turn:1');
  await view.render(false);
  await settle();
  assert.deepEqual(
    view.commands.map((command) => command.targets[0]),
    [`${ROOT}/design/mockups/settings/index.html`, `${ROOT}/reports/q3-sales.pdf`],
    'files the reply did not link are not tiles, so not opened'
  );
  await view.render(false);
  await settle();
  assert.equal(view.commands.length, 2, 'a re-render opens nothing again');
  await act(async () => view.root.render(null));
  await view.render(false);
  await settle();
  assert.equal(view.commands.length, 2, 'nor does a remount');
});

test('a turn with recorded changes but no tool rounds still gets its previews, in both modes', async (t) => {
  for (const agentMode of [false, true]) {
    await t.test(agentMode ? 'agent mode' : 'coding mode', async (t) => {
      resetTurnChangesCache();
      resetTurnPreviews();
      const { dom, document, root } = installTestDom(t, {
        expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
        rootId: 'root',
      });
      const commands = [];
      dom.window.mixdogDesktop = {
        invokeCapability: async () => ({
          value: {
            status: 'ready',
            checkpointId: 'cp',
            revision: 1,
            root: ROOT,
            files: [file('reports/a.pdf', 'A'), file('src/x.ts')],
            canUndo: true,
            canReapply: false,
          },
        }),
        visualizeCommand: async (command) => {
          commands.push(command);
        },
      };
      t.after(() => resyncVisualizeStates([]));
      const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');
      const rows = [
        { _tag: 'UserMessage', key: 'u1', turnKey: 'turn:u1', item: { kind: 'user', id: 'u1', text: 'go', at: 1 } },
        {
          _tag: 'AssistantPart',
          key: 'a1',
          turnKey: 'turn:u1',
          item: { kind: 'assistant', id: 'a1', text: 'Wrote [it](reports/a.pdf).', at: 2 },
          turnChanges: { checkpointId: 'cp', boundary: 'd1', trailing: true },
        },
      ];
      function Rows() {
        const { renderTranscriptRow } = useConversationRowRenderer({
          snapshot: { sessionId: 's1' },
          disclosureScope: 's1',
          readOnly: false,
          transitioning: false,
          renderAssistantRow: () => 'assistant',
          onOpenSettings() {},
          settledItems: [],
          settledTurnKeys: [],
          optimisticActivityStartedAt: 0,
          submit: async () => true,
          questionCard: null,
          agentMode,
        });
        return h(
          TurnChangesContext.Provider,
          { value: { sessionId: 's1', busy: false, turnRunning: false, onOpenSessionDiff() {}, onOpenFile() {} } },
          rows.map((row, index) => h('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
        );
      }
      noteTurnRunning('s1', 'turn:u1');
      await act(async () => root.render(h(Rows)));
      await settle();
      const tiles = [...document.querySelectorAll('.transcript-visualize-tile')];
      assert.deepEqual(
        tiles.map((tile) => tile.querySelector('b').textContent),
        ['a.pdf']
      );
      assert.equal(document.querySelector('.transcript-visualize-turn').classList.contains('is-compact'), agentMode);
      assert.equal(document.querySelector('.turn-changes-card').dataset.fileCount, '1', 'the rest stays a diff');
      assert.deepEqual(
        commands.map((command) => command.targets[0]),
        [`${ROOT}/reports/a.pdf`],
        'its live end is claimed and opens its confident preview'
      );
    });
  }
});

test('a turn keeps one running key across its re-key to the checkpoint', () => {
  const items = [
    { kind: 'user', id: 'u1' },
    { kind: 'assistant', id: 'a1' },
    { kind: 'turndone', id: 'd1' },
  ];
  assert.equal(
    runningTurnKeyOf(items, ['checkpoint:cp', 'checkpoint:cp', 'checkpoint:cp'], 'checkpoint:cp'),
    'turn:u1'
  );
  assert.equal(runningTurnKeyOf(items, ['turn:u1', 'turn:u1', 'turn:u1'], 'turn:u1'), 'turn:u1');
  assert.equal(runningTurnKeyOf([], [], 'checkpoint:cp'), 'checkpoint:cp', 'an unknown turn keeps its key');
});

// The conversation's own wiring across a real turn end (C-30): the turn's rows
// are keyed `turn:<prompt>` while it runs and re-keyed `checkpoint:<cp>` once
// its turndone names the checkpoint, so the running mark and the card's claim
// must agree across that flip.
test('a live turn end claims its running mark although the turn re-keys to its checkpoint', async (t) => {
  resetTurnChangesCache();
  resetTurnPreviews();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const commands = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async () => ({
      value: {
        status: 'ready',
        checkpointId: 'cp',
        revision: 1,
        root: ROOT,
        files: [
          file('design/mockups/home.html', 'A'),
          file('design/mockups/settings.html', 'A'),
          file('notes-new.md', 'A'),
        ],
        canUndo: true,
        canReapply: false,
      },
    }),
    visualizeCommand: async (command) => {
      commands.push(command);
    },
  };
  t.after(() => resyncVisualizeStates([]));
  const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');
  const { useConversationLinkSurfaces } = await import('./use-conversation-link-surfaces.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const user = { kind: 'user', id: 'u1', text: 'make mockups', at: 1 };
  const reply = {
    kind: 'assistant',
    id: 'a1',
    text: 'Created design/mockups/home.html and design/mockups/settings.html.',
    at: 2,
  };
  const turndone = { kind: 'turndone', id: 'd1', status: 'done', checkpointId: 'cp', at: 3 };
  function Conversation({ ended }) {
    const settledItems = ended ? [user, reply, turndone] : [user];
    const settledTurnKeys = transcriptTurnKeys(settledItems);
    const links = useConversationLinkSurfaces(
      {},
      {
        turnChangesSessionId: 's1',
        turnChangesBusy: !ended,
        turnChangesRunning: !ended,
        runningTurnKey: ended ? '' : settledTurnKeys.at(-1),
      }
    );
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId: 's1' },
      disclosureScope: 's1',
      readOnly: false,
      transitioning: false,
      renderAssistantRow: () => 'assistant',
      onOpenSettings() {},
      settledItems,
      settledTurnKeys,
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
      agentMode: false,
    });
    const rows = [
      { _tag: 'UserMessage', key: 'u1', turnKey: settledTurnKeys[0], item: user },
      ...(ended
        ? [
            {
              _tag: 'AssistantPart',
              key: 'a1',
              turnKey: settledTurnKeys[1],
              item: reply,
              turnChanges: { checkpointId: 'cp', boundary: 'd1', trailing: true },
            },
          ]
        : []),
    ];
    return h(
      TurnChangesContext.Provider,
      { value: links.turnChangesSurface },
      rows.map((row, index) => h('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
    );
  }
  await act(async () => root.render(h(Conversation, { ended: false })));
  await settle();
  assert.equal(transcriptTurnKeys([user])[0], 'turn:u1');
  assert.equal(transcriptTurnKeys([user, reply, turndone])[1], 'checkpoint:cp', 'the turn re-keys at its end');
  assert.deepEqual(commands, [], 'nothing opens while the turn runs');
  await act(async () => root.render(h(Conversation, { ended: true })));
  await settle();
  assert.deepEqual(
    [...document.querySelectorAll('.transcript-visualize-tile b')].map((tile) => tile.textContent),
    ['home.html', 'settings.html'],
    'the markdown file is no panel kind, so it gets no tile'
  );
  assert.deepEqual(
    commands.map((command) => command.targets[0]),
    [`${ROOT}/design/mockups/settings.html`, `${ROOT}/design/mockups/home.html`],
    'both mockups open, the first created shown last'
  );
});

// The card follows the turn's changes, never whether `visualize open` ran.
const showTabs = (tabs) =>
  applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs, active: tabs[0].id } });
const mockupTab = (id, name, versions) => ({
  id,
  label: name,
  revision: 0,
  panes: [{ target: `${ROOT}/design/mockups/${name}` }],
  ...(versions ? { versions: Array.from({ length: versions }, (_, index) => ({ n: index + 1, at: index })) } : {}),
});
const tilesOf = (view) =>
  view.qa('.transcript-visualize-tile').map((tile) => [tile.querySelector('b').textContent, tile.dataset.version]);

test('a turn that only changed an open tab (no visualize open, file ignored by Git) gets its card', async (t) => {
  showTabs([mockupTab('v1', 'a.html', 2)]);
  const view = await mountTurn(t, { files: [file('design/mockups/a.html', 'M', { ignored: true })] });
  assert.deepEqual(tilesOf(view), [['a.html', '2']]);
  assert.equal(view.q('.transcript-visualize-tile').dataset.visualizeTab, 'v1');
  assert.equal(view.q('.transcript-visualize-turn').dataset.visualizeCount, '1');
});

test('a turn that added one artifact and changed another has one card with both', async (t) => {
  showTabs([mockupTab('v1', 'a.html', 2), mockupTab('v2', 'b.html')]);
  const open = {
    id: 'open-b',
    kind: 'tool',
    name: 'visualize',
    args: { action: 'open', input: { targets: [`${ROOT}/design/mockups/b.html`] } },
    result: 'Showing b.html (html) in the side panel as tab v2.',
    status: 'done',
    startedAt: 5,
    completedAt: 6,
  };
  const view = await mountTurn(t, {
    items: [open],
    files: [
      file('design/mockups/a.html', 'M', { ignored: true }),
      file('design/mockups/b.html', 'A', { ignored: true }),
    ],
  });
  assert.equal(view.qa('.transcript-visualize-turn').length, 1);
  assert.deepEqual(
    tilesOf(view)
      .map(([name]) => name)
      .sort(),
    ['a.html', 'b.html']
  );
});

test('a turn that changed no visualize artifact gets no card', async (t) => {
  showTabs([mockupTab('v1', 'a.html', 2)]);
  // A shell command's ignored output is not in the turn's record: no entry, no card.
  const view = await mountTurn(t, { files: [file('src/app.ts'), file('dist/out.html', 'A', { ignored: true })] });
  assert.equal(view.q('.transcript-visualize-turn'), null);
});

test('an agent-written Git-ignored deliverable gets a card even with no open tab', async (t) => {
  const view = await mountTurn(t, {
    files: [file('deliverables/report.pdf', 'A', { ignored: true })],
    replyText: '[r](deliverables/report.pdf)',
  });
  assert.deepEqual(
    tilesOf(view).map(([name]) => name),
    ['report.pdf']
  );
});

test('turn 1 creates and links report.html → card; the source page stays in the diff only', async (t) => {
  const view = await mountTurn(t, {
    files: [file('reports/report.html', 'A'), file('src/renderer/desktop-pet.html')],
    replyText: 'Made [the report](reports/report.html).',
  });
  assert.deepEqual(
    tilesOf(view).map(([name]) => name),
    ['report.html']
  );
  assert.equal(view.q('.turn-changes-card').dataset.fileCount, '1');
});

test('turn 2 edits the earlier-linked report.html without a link → card', async (t) => {
  const view = await mountTurn(t, {
    files: [file('reports/report.html'), file('src/renderer/desktop-pet.html')],
    replyText: 'Fixed the header.',
    // As the conversation derives it from the earlier rows' replies.
    surfacedBefore: linkedLocalPaths('Made [the report](reports/report.html).'),
  });
  assert.deepEqual(
    tilesOf(view).map(([name]) => name),
    ['report.html']
  );
});

test('an HTML page never linked or opened never gets a card', async (t) => {
  const view = await mountTurn(t, { files: [file('src/renderer/desktop-pet.html')], replyText: 'Fixed the title.' });
  assert.equal(view.q('.transcript-visualize-turn'), null);
});
test('an older turn’s card reads its version from the host record, never drawn live and after a reload', () => {
  resetVisualizeCardMemory();
  const call = (id, tabId, at) => ({ id, pending: false, targets: ['a.html'], label: '', tabId, at, preview: true });
  const turn1 = call('preview:cp1:a.html', 'v1', 10);
  const turn2 = call('preview:cp2:a.html', 'v1', 120);
  // The host's state: version 1 ended turn 1 (0-50 ms), version 2 turn 2 (100-150).
  const tab = {
    ...mockupTab('v1', 'a.html'),
    versions: [
      { n: 1, at: 5, turns: [{ since: 0, end: 50 }] },
      { n: 2, at: 110, turns: [{ since: 100, end: 150 }] },
    ],
  };
  // A freshly loaded renderer: nothing was drawn, no memory of either card.
  noteVisualizeCards('s1', [turn1, turn2]);
  assert.equal(visualizeCardNewest('s1', turn1), false);
  assert.equal(visualizeCardOwnVersion('s1', turn1, 2, false, tab), 1, 'the old turn stays on version 1');
  assert.equal(visualizeCardOwnVersion('s1', turn2, 2, true, tab), 2, 'the newest follows the tab');
  assert.equal(versionProducedAt(tab.versions, 200), 0, 'no turn there');
  assert.equal(globalThis.window?.localStorage?.getItem?.('mixdog.visualize.cardVersions') ?? null, null);
});
test('more than six tiles page at the card’s bottom-right', async (t) => {
  const files = Array.from({ length: 8 }, (_, index) => file(`shots/s${index}.png`, 'A'));
  const view = await mountTurn(t, { files, replyText: files.map((one) => `[s](${one.path})`).join(' ') });
  assert.equal(view.q('.transcript-visualize-title').textContent, 'Previews 8');
  assert.equal(view.qa('.transcript-visualize-tile').length, 6);
  const [prev, next] = view.qa('.transcript-visualize-page');
  assert.equal(view.q('.transcript-visualize-page-label').textContent, '1 / 2');
  assert.equal(prev.getAttribute('aria-label'), 'Previous page');
  assert.equal(next.getAttribute('aria-label'), 'Next page');
  assert.equal(prev.disabled, true);
  await view.click(next);
  assert.equal(view.qa('.transcript-visualize-tile').length, 2);
  assert.equal(view.q('.transcript-visualize-page-label').textContent, '2 / 2');
  assert.equal(view.qa('.transcript-visualize-page')[1].disabled, true);
});
