import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { FileDiffBody, buildDiffItems, parseHunk } from './inline-diff.tsx';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { DiffHeaderControls, diffModeActions } from './diff-header-controls.tsx';
import { DockHeaderRow, splitDockActions } from './pane-dock-chrome.tsx';
const { overrideConfirmAction } = await import('./app-confirm.tsx');

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

test('the pane stacks every changed file with its diff in one scroll: no list level, no back button', async () => {
  const view = await mount(h(SessionDiffPane, { sessionId: 'sd-stack', active: true, onClose() {} }), (win) => {
    win.mixdogDesktop = {
      invokeCapability: async () => ({
        value: {
          supported: true,
          files: [
            { path: 'src/cart.js', status: 'M', additions: 2, deletions: 1, binary: false },
            { path: 'src/receipt.js', status: 'M', additions: 2, deletions: 1, binary: false },
          ],
          patch: PATCH + PATCH.replaceAll('cart', 'receipt'),
        },
      }),
    };
  });
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const q = (selector) => view.container.querySelector(selector);
    const sections = [...view.container.querySelectorAll('.session-diff-section')];
    assert.equal(sections.length, 2);
    assert.deepEqual(
      sections.map((section) => section.dataset.sessionDiffPath),
      ['src/cart.js', 'src/receipt.js']
    );
    // Each section carries its own sticky header and its own diff.
    for (const section of sections) {
      assert.ok(section.querySelector('.session-diff-section-head'));
      assert.ok(section.querySelector('.inline-diff'));
    }
    assert.match(sections[0].querySelector('.session-diff-section-head').textContent, /src\/.*cart\.js.*\+2.*\u22121/);
    assert.equal(sections[0].querySelector('.session-diff-section-title').title, 'src/cart.js');
    assert.equal(q('.session-diff-back'), null);
    assert.equal(q('.session-diff-files'), null);
    assert.match(q('.session-diff-toolbar .session-diff-scope').title, /2 files changed/);
  } finally {
    await view.done();
  }
});
test('a recorded file without a diff explains why instead of showing an empty diff', async () => {
  const view = await mount(h(SessionDiffPane, { sessionId: 'sd-reason', active: true, onClose() {} }), (win) => {
    win.mixdogDesktop = {
      invokeCapability: async () => ({
        value: {
          supported: true,
          files: [
            {
              path: 'C:/outside/note.txt',
              status: 'A',
              additions: 1,
              deletions: 0,
              reason: 'file is outside the recorded root',
            },
          ],
          patch: '',
        },
      }),
    };
  });
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(view.container.querySelector('.inline-diff-empty').textContent, 'No diff was recorded for this file.');
  } finally {
    await view.done();
  }
});

test('revert sends the turn checkpoint and is disabled while the session is busy', async () => {
  const sessionId = 'sd-revert';
  const calls = [];
  const view = await mount(h(SessionDiffPane, { sessionId, active: true, onClose() {} }), (win) => {
    overrideConfirmAction(() => true);
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

test('an idle lane republish does not re-read the turn review; a new turn does', async () => {
  const sessionId = 'sd-revert-idle';
  const calls = [];
  const view = await mount(h(SessionDiffPane, { sessionId, active: true, onClose() {} }), (win) => {
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
  const reviews = () => calls.filter((call) => call.capability === 'getTurnReviewDiff').length;
  const publish = (contentRevision, items) =>
    act(async () => {
      defaultSessionLaneStore.apply({
        sessionId,
        frameSource: 'live',
        contentRevision,
        snapshot: { sessionId, items, busy: false },
      });
    });
  const turn = (id) => [
    { kind: 'user', id: `u-${id}`, text: 'go', checkpointId: id },
    { kind: 'turndone', id: `d-${id}`, status: 'complete', checkpointId: id },
  ];
  try {
    const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await publish(1, turn('cp-1'));
    await wait();
    const settled = reviews();
    assert.ok(settled >= 1);
    // Background agent status reaching the idle Lead moves only the lane's
    // publication revision: the review the Revert buttons answer from is unchanged.
    for (const revision of [2, 3, 4, 5]) {
      await publish(revision, turn('cp-1'));
      await wait();
    }
    assert.equal(reviews(), settled);
    // A finished new turn has a new checkpoint: its review is read.
    await publish(6, [...turn('cp-1'), ...turn('cp-2')]);
    await wait();
    assert.equal(reviews(), settled + 1);
  } finally {
    await view.done();
  }
});

test('a revert re-reads the turn review without a new checkpoint', async () => {
  const sessionId = 'sd-revert-reread';
  const calls = [];
  let reviewed = ['src/cart.js', 'src/util.js'];
  const view = await mount(h(SessionDiffPane, { sessionId, active: true, onClose() {} }), (win) => {
    overrideConfirmAction(() => true);
    win.mixdogDesktop = {
      invokeCapability: async (request) => {
        calls.push(request);
        if (request.capability === 'getTurnReviewDiff') {
          return { value: { checkpointId: 'cp-1', files: reviewed.map((path) => ({ path })) } };
        }
        if (request.capability === 'revertTurnReviewFile') {
          // The turn's review no longer lists the restored file; the
          // checkpoint and the history epoch are unchanged.
          reviewed = reviewed.filter((path) => path !== request.args[0]);
          return { value: { ok: true } };
        }
        return {
          value: {
            supported: true,
            files: ['src/cart.js', 'src/util.js'].map((path) => ({
              path,
              status: 'M',
              additions: 2,
              deletions: 1,
              binary: false,
            })),
            patch: '',
          },
        };
      },
    };
  });
  const reviews = () => calls.filter((call) => call.capability === 'getTurnReviewDiff').length;
  const revert = (path) => view.container.querySelector(`[aria-label="Revert ${path}"]`);
  try {
    const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await wait();
    assert.equal(revert('src/cart.js').disabled, false);
    const settled = reviews();
    await view.click(revert('src/cart.js'));
    await wait();
    assert.equal(reviews(), settled + 1, 'the revert re-read the review');
    assert.equal(revert('src/cart.js').disabled, true, 'the reverted file is no longer revertable');
    assert.equal(revert('src/util.js').disabled, false);
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
    assert.equal(fold.textContent, '');
    assert.equal(fold.getAttribute('aria-label'), '4 unmodified lines');
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

test('code lines wrap in every shared diff: the session pane and tool cards never scroll sideways', () => {
  const css = readFileSync(new URL('./desktop/25-scm-dock.css', import.meta.url), 'utf8');
  const rule = css.match(/\.inline-diff-code\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(rule, /white-space:\s*pre-wrap/u);
  assert.match(rule, /overflow-wrap:\s*anywhere/u);
  assert.match(css.match(/\.inline-diff\s*\{([^}]*)\}/u)?.[1] ?? '', /var\(--mx-font-mono\)/u);
  // The session pane's sections and the chat's tool-card diffs share one rule
  // set, which keeps the wrapping code column (no max-content rows, no
  // sideways scroller).
  const stack = readFileSync(new URL('./desktop/27-search-review.css', import.meta.url), 'utf8');
  const shared = (part) =>
    stack.match(
      new RegExp(`:is\\(\\.session-diff-section, \\.tool-diff-frame\\) \\.${part}\\s*\\{([^}]*)\\}`, 'u')
    )?.[1] ?? '';
  // 13px at the default chat text size; tool-card diffs follow its scale.
  assert.match(shared('inline-diff'), /font-size:\s*calc\(13px \* var\(--mx-content-scale, 1\)\)/u);
  assert.doesNotMatch(shared('inline-diff'), /overflow-x/u);
  assert.equal(shared('inline-diff-code'), '');
  assert.equal(shared('inline-diff-row'), '');
  assert.match(stack.match(/\.session-diff-section-head\s*\{([^}]*)\}/u)?.[1] ?? '', /position:\s*sticky/u);
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
  assert.doesNotMatch(pane, /<DiffHeaderControls|diff-search-input|onQuery/u);
  // Row 2 is the toolbar row (browser nav-row geometry) with the scope pill.
  assert.match(pane, /browser-pane-toolbar session-diff-toolbar/u);
  // "Changes" is always a tab of the pane's own tab strip, never a title chip.
  const tabStrip = readFileSync(new URL('./session-diff-tab-strip.tsx', import.meta.url), 'utf8');
  assert.match(pane, /<SessionDiffTabStrip/u);
  assert.match(tabStrip, /browser-tab-list session-diff-tabs" role="tablist"/u);
  assert.doesNotMatch(tabStrip, /dock-header-chip/u);
  assert.doesNotMatch(pane, /dock-header-chip/u);
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
    true, // the pane opens on the list, whose header counts the files
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
      assert.equal(q('.session-diff-toolbar .session-diff-scope[title]').length, expectCount ? 1 : 0);
      const refresh = view.container.querySelector('[aria-label="Refresh"]');
      if (refresh) assert.equal(refresh.disabled, expectRefreshDisabled);
    } finally {
      await view.done();
    }
  });
}

test('file-count changes grow or shrink the stack in place', async () => {
  const files = (...paths) => paths.map((path) => ({ path, status: 'M', additions: 2, deletions: 1, binary: false }));
  let current = files('src/cart.js');
  const view = await mount(h(SessionDiffPane, { sessionId: 'sd-count', active: true, onClose() {} }), (win) => {
    win.mixdogDesktop = {
      invokeCapability: async () => ({ value: { supported: true, files: current, patch: PATCH } }),
    };
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  try {
    await settle();
    assert.equal(view.container.querySelectorAll('.session-diff-section').length, 1);
    current = files('src/cart.js', 'src/receipt.js');
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'sd-count',
        frameSource: 'live',
        snapshot: { sessionId: 'sd-count', items: [{ id: 'rev-1' }], contentRevision: 1 },
      });
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(view.container.querySelectorAll('.session-diff-section').length, 2);
    assert.equal(view.container.querySelector('.session-diff-back'), null);
  } finally {
    await view.done();
  }
});
