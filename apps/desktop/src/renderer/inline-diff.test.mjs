import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { FileDiffBody, buildDiffItems, parseHunk } from './inline-diff.tsx';
import { SessionDiffFiles, SessionDiffPane } from './SessionDiffPane.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { DiffHeaderControls, diffModeActions } from './diff-header-controls.tsx';
import { DockHeaderRow, splitDockActions } from './pane-dock-chrome.tsx';

const h = React.createElement;

const HUNK = [
  '@@ -17,9 +17,10 @@',
  ' a17',
  ' a18',
  ' a19',
  ' a20',
  ' a21',
  ' a22',
  '-old23',
  '+new23',
  '+new24',
  ' a25',
  ' a26',
  ' a27',
].join('\n');

const PATCH = `diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n${HUNK}\n`;
const row = (path, patch) => ({
  path,
  oldPath: '',
  status: 'M',
  additions: 2,
  deletions: 1,
  binary: false,
  parts: [{ patch }],
});

async function mount(element, setup) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><body><main id="root"></main></body>',
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setup?.(dom.window);
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next) => act(async () => root.render(next)),
    click: (node) =>
      act(async () => {
        node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      }),
    done: async () => {
      await act(async () => root.unmount());
      restore();
    },
  };
}

test('line numbers: new numbers for add/context, old numbers for deleted lines', () => {
  const { lines } = parseHunk(HUNK);
  const byText = (text) => lines.find((line) => line.text === text);
  assert.deepEqual([byText('a17').kind, byText('a17').newNo], ['ctx', 17]);
  assert.deepEqual([byText('old23').kind, byText('old23').oldNo], ['del', 23]);
  assert.deepEqual([byText('new23').kind, byText('new23').newNo], ['add', 23]);
  assert.deepEqual([byText('new24').kind, byText('new24').newNo], ['add', 24]);
  assert.equal(byText('a25').newNo, 25);
});

test('long unchanged runs fold into an "N unmodified lines" item', () => {
  const items = buildDiffItems([HUNK]);
  const folds = items.filter((item) => item.type === 'fold');
  assert.equal(folds.length, 1);
  // 6 leading context lines, the hunk start keeps none, the change side keeps 2.
  assert.equal(folds[0].lines.length, 4);
  assert.deepEqual(
    folds[0].lines.map((line) => line.text),
    ['a17', 'a18', 'a19', 'a20']
  );
  // Trailing context (3 lines, keep 2) hides only 1: not folded.
  assert.equal(items.at(-1).line.text, 'a27');
  // A gap before the hunk is named, not expandable.
  const gap = buildDiffItems(['@@ -5,1 +5,1 @@\n-x\n+y']).find((item) => item.type === 'gap');
  assert.equal(gap.count, 4);
});

test('file list rows pick a file; the pane drills list → diff', async () => {
  const rows = [row('src/cart.js', PATCH), row('src/receipt.js', PATCH)];
  const picked = [];
  const listView = await mount(h(SessionDiffFiles, { rows, onSelect: (path) => picked.push(path) }));
  try {
    const mains = [...listView.container.querySelectorAll('.changes-file-main')];
    assert.equal(listView.container.querySelectorAll('.inline-diff').length, 0);
    assert.match(mains[0].textContent, /cart\.js.*src.*\+2.*\u22121/);
    await listView.click(mains[1]);
    assert.deepEqual(picked, ['src/receipt.js']);
  } finally {
    await listView.done();
  }
  const view = await mount(h(SessionDiffPane, { sessionId: 'sd-drill', active: true, onClose() {} }), (win) => {
    win.mixdogDesktop = {
      invokeCapability: async () => ({
        value: {
          supported: true,
          files: [
            { path: 'src/cart.js', status: 'M', additions: 2, deletions: 1, binary: false },
            { path: 'src/receipt.js', status: 'M', additions: 2, deletions: 1, binary: false },
          ],
          patch: PATCH,
        },
      }),
    };
  });
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const q = (selector) => view.container.querySelector(selector);
    // Several changed files: the pane opens on the list, not on one diff.
    assert.ok(q('.session-diff-files'));
    assert.equal(q('.session-diff-body'), null);
    assert.equal(view.container.querySelectorAll('.changes-file-main').length, 2);
    await view.click(view.container.querySelectorAll('.changes-file-main')[0]);
    assert.equal(q('.session-diff-files'), null);
    assert.ok(q('.session-diff-body'));
    assert.equal(q('.session-diff-path').textContent, 'cart.js');
    assert.equal(q('.session-diff-path').title, 'src/cart.js');
    await view.click(q('.session-diff-back'));
    assert.equal(q('.session-diff-body'), null);
    await view.click(view.container.querySelectorAll('.changes-file-main')[1]);
    assert.equal(q('.session-diff-files'), null);
    assert.equal(q('.session-diff-path').textContent, 'receipt.js');
    // Escape is the keyboard way back to the list.
    await act(async () => {
      q('.session-diff-body').dispatchEvent(new view.container.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.ok(q('.session-diff-files'));
  } finally {
    await view.done();
  }
});

test('a single changed file opens straight on its diff', async () => {
  const view = await mount(h(SessionDiffPane, { sessionId: 'sd-single', active: true, onClose() {} }), (win) => {
    win.mixdogDesktop = {
      invokeCapability: async () => ({
        value: {
          supported: true,
          files: [{ path: 'src/cart.js', status: 'M', additions: 2, deletions: 1, binary: false }],
          patch: PATCH,
        },
      }),
    };
  });
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(view.container.querySelector('.session-diff-files'), null);
    assert.equal(view.container.querySelector('.session-diff-path').textContent, 'cart.js');
  } finally {
    await view.done();
  }
});

test('revert sends the turn checkpoint and is disabled while the session is busy', async () => {
  const sessionId = 'sd-revert';
  const calls = [];
  const view = await mount(h(SessionDiffPane, { sessionId, active: true, onClose() {} }), (win) => {
    win.confirm = () => true;
    win.mixdogDesktop = {
      invokeCapability: async (request) => {
        calls.push(request);
        if (request.capability === 'getTurnReviewDiff') {
          return { value: { checkpointId: 'cp-1', files: [{ path: 'src/cart.js' }] } };
        }
        return {
          value: {
            supported: true,
            files: [{ path: 'src/cart.js', status: 'M', additions: 2, deletions: 1, binary: false }],
            patch: PATCH,
          },
        };
      },
    };
  });
  try {
    const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await wait();
    const revert = () => view.container.querySelector('[aria-label="Revert src/cart.js"]');
    assert.equal(revert().disabled, false);
    await view.click(revert());
    await wait();
    const sent = calls.find((call) => call.capability === 'revertTurnReviewFile');
    assert.deepEqual(sent.args, ['src/cart.js', 'cp-1']);
    assert.equal(sent.sessionId, sessionId);
    const before = calls.filter((call) => call.capability === 'revertTurnReviewFile').length;
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId,
        frameSource: 'live',
        snapshot: { sessionId, items: [], busy: true, contentRevision: 1 },
      });
    });
    await wait();
    assert.equal(revert().disabled, true);
    await view.click(revert());
    assert.equal(calls.filter((call) => call.capability === 'revertTurnReviewFile').length, before);
  } finally {
    await view.done();
  }
});

test('the unified diff body shows add/del rows and expandable folds', async () => {
  const view = await mount(h(FileDiffBody, { patch: PATCH, mode: 'unified' }));
  try {
    const first = view.container.querySelector('.inline-diff');
    assert.equal(first.querySelectorAll('[data-kind="add"]').length, 2);
    assert.equal(first.querySelector('[data-kind="del"] .inline-diff-mk').textContent, '\u2212');
    assert.equal(first.querySelector('[data-kind="del"] .inline-diff-ln').textContent, '23');
    // The unmodified run is a button that expands that run.
    const fold = first.querySelector('button.inline-diff-fold');
    assert.match(fold.textContent, /4 unmodified lines/);
    await view.click(fold);
    assert.equal(first.querySelector('button.inline-diff-fold'), null);
    assert.equal(first.querySelectorAll('.inline-diff-row').length, 12);
  } finally {
    await view.done();
  }
});

test('split mode leaves the inline renderer', async () => {
  const view = await mount(h(FileDiffBody, { patch: PATCH, mode: 'split' }));
  try {
    assert.equal(view.container.querySelector('.inline-diff'), null);
  } finally {
    await view.done();
  }
});

test('code lines wrap inside the code column (no horizontal scroll)', () => {
  const css = readFileSync(new URL('./desktop/25-scm-dock.css', import.meta.url), 'utf8');
  const rule = css.match(/\.inline-diff-code\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(rule, /white-space:\s*pre-wrap/u);
  assert.match(rule, /overflow-wrap:\s*anywhere/u);
  assert.match(css.match(/\.inline-diff\s*\{([^}]*)\}/u)?.[1] ?? '', /var\(--mx-font-mono\)/u);
  const list = readFileSync(new URL('./desktop/27-search-review.css', import.meta.url), 'utf8');
  assert.match(list.match(/\.session-diff-files\s*\{([^}]*)\}/u)?.[1] ?? '', /overflow-x:\s*hidden/u);
});

test('DiffHeaderControls: only the ⋯ menu with Unified/Split; no scope text or search', async () => {
  const calls = [];
  const view = await mount(
    h(DiffHeaderControls, { viewMode: 'unified', onViewModeChange: (mode) => calls.push(mode) })
  );
  try {
    const q = (selector) => view.container.querySelector(selector);
    assert.equal(q('.diff-scope-button'), null);
    assert.equal(q('.diff-scope-text'), null);
    assert.equal(q('.diff-search-input'), null);
    assert.equal(q('[aria-label="Search"]'), null);
    assert.equal(view.container.textContent, '');
    await view.click(q('.diff-more-button'));
    const [unified, split] = view.container.querySelectorAll('.diff-more-menu [role="menuitemradio"]');
    assert.equal(unified.getAttribute('aria-checked'), 'true');
    assert.equal(split.getAttribute('aria-checked'), 'false');
    await view.click(split);
    assert.deepEqual(calls, ['split']);
  } finally {
    await view.done();
  }
});
test('Changes view: Unified/Split live in the ⋯ menu of the one DockHeaderRow', async () => {
  const picked = [];
  const actions = [
    { id: 'refresh', label: 'Refresh', onSelect() {} },
    ...diffModeActions('split', (mode) => picked.push(mode)),
  ];
  assert.deepEqual(
    actions.slice(1).map((a) => [a.label, a.menuOnly, a.checked]),
    [
      ['Unified', true, false],
      ['Split', true, true],
    ]
  );
  // Claude header rule: no action is inline unless marked so; refresh and the
  // mode pair are ⋯ items at every width.
  const split = splitDockActions(actions);
  assert.deepEqual(split.inline, []);
  assert.deepEqual(
    split.menu.map((a) => a.id),
    ['refresh', 'diff-mode-unified', 'diff-mode-split']
  );
  const view = await mount(h(DockHeaderRow, { left: h('b', null, 'Changes'), actions, onClose() {} }));
  try {
    assert.equal(view.container.querySelectorAll('[data-dock-header]').length, 1);
    assert.equal(view.container.querySelector('.diff-mode-button'), null);
    await view.click(view.container.querySelector('.dock-header-more'));
    // Unified/Split are a radio pair (menuitemradio); Refresh is a plain menuitem.
    const items = [...document.querySelectorAll('.dock-header-menu [role^="menuitem"]')];
    assert.deepEqual(
      items.map((i) => i.textContent),
      ['Refresh', 'Unified', 'Split']
    );
    await view.click(items[1]);
    assert.deepEqual(picked, ['unified']);
  } finally {
    await view.done();
  }
});

test('the dock draws no second header row for Changes; the header never wraps at 280px', () => {
  const dock = readFileSync(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  assert.match(dock, /!sessionSurfaceShowing && !sessionDiffPanelShowing/u);
  const pane = readFileSync(new URL('./SessionDiffPane.tsx', import.meta.url), 'utf8');
  assert.equal((pane.match(/<DockHeaderRow/gu) ?? []).length, 1);
  // No visible title text on either header; the row keeps an aria-label.
  assert.doesNotMatch(pane, /dock-header-title/u);
  assert.match(pane, /ariaLabel=\{t\('Changes'\)\}/u);
  assert.match(dock, /ariaLabel=\{diffShowing \? t\('Changes'\) : undefined\}/u);
  assert.match(dock, /browser-tab is-active dock-header-chip[\s\S]*?\bdiff\.rel[\s\S]*?<DiffHeaderControls/u);
  assert.doesNotMatch(dock, /diffShowing \? t\('Changes'\) : \(activeDescriptor/u);
  assert.doesNotMatch(pane, /<DiffHeaderControls|diff-search-input|session-diff-scope|onQuery/u);
  assert.match(dock, /title=\{`\$\{diff\.rel\}\\n\$\{diffScopeLabel\(diff\.source\)\}`\}/u);
  const css = readFileSync(new URL('./desktop/27-search-review.css', import.meta.url), 'utf8');
  const summary = css.match(/\.session-diff-summary\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(summary, /flex-wrap:\s*nowrap/u);
  assert.match(summary, /overflow:\s*hidden/u);
  assert.match(css.match(/\.session-diff-header\s*\{([^}]*)\}/u)?.[1] ?? '', /white-space:\s*nowrap/u);
  const scm = readFileSync(new URL('./desktop/25-scm-dock.css', import.meta.url), 'utf8');
  assert.match(scm.match(/\.diff-header-controls\s*\{[^}]*flex-wrap:\s*nowrap/u)?.[0] ?? '', /nowrap/u);
});

// Every state keeps the one DockHeaderRow so close/expand stay reachable.
for (const [state, sessionId, invoke, expectCount, expectRefreshDisabled] of [
  ['no session', '', async () => ({ value: null }), false, true],
  ['loading', 'sd-loading', () => new Promise(() => {}), false, true],
  [
    'error',
    'sd-error',
    async () => {
      throw new Error('boom');
    },
    false,
    false,
  ],
  ['empty', 'sd-empty', async () => ({ value: { supported: true, files: [], patch: '' } }), true, false],
  [
    'with files',
    'sd-files',
    async () => ({
      value: {
        supported: true,
        files: [{ path: 'src/cart.js', status: 'M', additions: 2, deletions: 1, binary: false }],
        patch: PATCH,
      },
    }),
    false, // the diff view's header names the file instead of counting files
    false,
  ],
]) {
  test(`SessionDiffPane renders the one header row with close in the ${state} state`, async () => {
    const view = await mount(h(SessionDiffPane, { sessionId, active: Boolean(sessionId), onClose() {} }), (win) => {
      win.mixdogDesktop = { invokeCapability: invoke };
    });
    try {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      const q = (selector) => view.container.querySelectorAll(selector);
      assert.equal(q('[data-dock-header]').length, 1);
      assert.equal(q('[aria-label="Changes"]').length >= 1, true);
      assert.equal(q('[aria-label="Close panel"]').length, 1);
      assert.equal(q('.session-diff-count').length, expectCount ? 1 : 0);
      const refresh = view.container.querySelector('[aria-label="Refresh"]');
      if (refresh) assert.equal(refresh.disabled, expectRefreshDisabled);
    } finally {
      await view.done();
    }
  });
}

test('the list-vs-diff choice latches on first data: file-count changes never flip the open view', async () => {
  const files = (...paths) => paths.map((path) => ({ path, status: 'M', additions: 2, deletions: 1, binary: false }));
  let current = files('src/cart.js');
  const mountWith = (sessionId) =>
    mount(h(SessionDiffPane, { sessionId, active: true, onClose() {} }), (win) => {
      win.mixdogDesktop = { invokeCapability: async () => ({ value: { supported: true, files: current, patch: PATCH } }) };
    });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  let revision = 0;
  const bump = (sessionId) =>
    act(async () => {
      revision += 1;
      defaultSessionLaneStore.apply({
        sessionId,
        frameSource: 'live',
        snapshot: { sessionId, items: [{ id: `rev-${revision}` }], contentRevision: revision },
      });
    });
  // 1 → 2: opened on the diff, stays on the diff.
  let view = await mountWith('sd-latch-1');
  try {
    await settle();
    assert.ok(view.container.querySelector('.session-diff-body'));
    current = files('src/cart.js', 'src/receipt.js');
    await bump('sd-latch-1');
    await settle();
    assert.ok(view.container.querySelector('.session-diff-body'));
    assert.equal(view.container.querySelector('.session-diff-files'), null);
  } finally {
    await view.done();
  }
  // 2 → 1: opened on the list, stays on the list.
  view = await mountWith('sd-latch-2');
  try {
    await settle();
    assert.ok(view.container.querySelector('.session-diff-files'));
    current = files('src/cart.js');
    await bump('sd-latch-2');
    await settle();
    assert.ok(view.container.querySelector('.session-diff-files'));
    assert.equal(view.container.querySelector('.session-diff-body'), null);
  } finally {
    await view.done();
  }
});