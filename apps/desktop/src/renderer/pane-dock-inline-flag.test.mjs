import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { PaneSideDock } from './pane-side-dock.tsx';

const POSITION_KEY = 'mixdog.desktop.side-panel-position.v1';
/** What the frame rules matched before the flag: `.main-panel:has(INLINE)`. */
const INLINE = '.pane-side-dock[data-open="true"]:not([data-overlay="true"]):not([data-expanded="true"])';

function mount(t, position = 'right') {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  dom.window.localStorage.setItem(POSITION_KEY, position);
  dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
  dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  // jsdom lays nothing out: each cell reports the width its test attribute names.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return Number(this.dataset?.testW) || 0;
    },
  });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  return root;
}

const noop = () => {};
const Icon = () => React.createElement('span');
const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]);

function dock(leafId, open) {
  return React.createElement(PaneSideDock, {
    leafId,
    entry: { open, view: 'source-control', surface: '', diff: null },
    groups: [['source-control']],
    descriptors,
    focused: true,
    onSelect: noop,
    onClose: noop,
    onCloseDiff: noop,
    onMoveGroup: noop,
    onMoveView: noop,
    onFocusPane: noop,
    openFileTab: noop,
    renderView: () => React.createElement('div', null, 'panel'),
  });
}

/** Records, in a layout effect of every commit (after the docks' own), whether
 *  the column's flag says what `.main-panel:has(INLINE)` would. */
function Column({ commits, children }) {
  useLayoutEffect(() => {
    const main = document.querySelector('.main-panel');
    commits.push({ has: Boolean(main.querySelector(INLINE)), flag: main.dataset.inlineDock === 'true' });
  });
  return React.createElement('main', { className: 'main-panel' }, children);
}

const cell = (width, ...children) =>
  React.createElement(
    'div',
    { className: 'pane-cell', 'data-test-w': width },
    React.createElement('div', { className: 'pane-surface-stack' }),
    ...children
  );

function render(root, commits, cells) {
  return act(async () => root.render(React.createElement(Column, { commits }, ...cells)));
}

const flag = () => document.querySelector('.main-panel').dataset.inlineDock;
const docks = () =>
  [...document.querySelectorAll('.pane-side-dock')].map(
    (d) => `${d.dataset.open}/${d.dataset.overlay}/${d.dataset.expanded}`
  );

test('the column flag is data-inline-dock="true" exactly while a dock is open, inline and not expanded, in the same commit', async (t) => {
  const root = mount(t);
  const commits = [];
  await render(root, commits, [cell(1600, dock('a', false))]);
  assert.deepEqual(docks(), ['false/false/false']);
  assert.equal(flag(), undefined, 'closed');
  await render(root, commits, [cell(1600, dock('a', true))]);
  assert.deepEqual(docks(), ['true/false/false']);
  assert.equal(flag(), 'true', 'open beside the chat');
  // Expanded over the chat: no longer inline.
  await act(async () => document.querySelector('.pane-side-dock button[aria-label="Expand"]').click());
  assert.deepEqual(docks(), ['true/false/true']);
  assert.equal(flag(), undefined, 'expanded');
  await act(async () => document.querySelector('.pane-side-dock button[aria-label="Restore"]').click());
  assert.equal(flag(), 'true', 'restored');
  // A cell too narrow for the chat and the dock (measured as the dock opens): it overlays.
  await render(root, commits, [cell(400, dock('a', false))]);
  await render(root, commits, [cell(400, dock('a', true))]);
  assert.deepEqual(docks(), ['true/true/false']);
  assert.equal(flag(), undefined, 'overlay');
  await render(root, commits, [cell(1600, dock('a', false))]);
  await render(root, commits, [cell(1600, dock('a', true))]);
  assert.equal(flag(), 'true');
  await render(root, commits, [cell(1600, dock('a', false))]);
  assert.equal(flag(), undefined, 'closed again');
  assert.equal(commits.length, 7, 'one recorded commit per column render');
  for (const [index, commit] of commits.entries()) assert.equal(commit.flag, commit.has, `commit ${index}`);
});

test('below the chat an open dock is inline too; expanded it is not', async (t) => {
  const root = mount(t, 'bottom');
  const commits = [];
  await render(root, commits, [cell(400, dock('a', true))]);
  assert.deepEqual(docks(), ['true/false/false'], 'a bottom dock never overlays');
  assert.equal(flag(), 'true');
  await act(async () => document.querySelector('.pane-side-dock button[aria-label="Expand"]').click());
  assert.deepEqual(docks(), ['true/false/true']);
  assert.equal(flag(), undefined);
  await render(root, commits, [cell(400, dock('a', false))]);
  assert.equal(flag(), undefined);
  for (const [index, commit] of commits.entries()) assert.equal(commit.flag, commit.has, `commit ${index}`);
});

test('split panes: the flag holds while any dock in the column is inline, and leaves with the last', async (t) => {
  const root = mount(t);
  const commits = [];
  const states = [
    [false, false, undefined],
    [true, false, 'true'],
    [true, true, 'true'],
    [false, true, 'true'],
    [false, false, undefined],
  ];
  for (const [a, b, expected] of states) {
    await render(root, commits, [cell(1600, dock('a', a)), cell(1600, dock('b', b))]);
    assert.equal(flag(), expected, `a=${a} b=${b}`);
  }
  // One pane's dock inline, the other's overlaying its narrow cell.
  await render(root, commits, [cell(1600, dock('a', true)), cell(400, dock('b', true))]);
  assert.deepEqual(docks(), ['true/false/false', 'true/true/false']);
  assert.equal(flag(), 'true');
  await render(root, commits, [cell(1600, dock('a', false)), cell(400, dock('b', true))]);
  assert.equal(flag(), undefined, 'only an overlay left');
  // A pane (and its inline dock) removed from the column.
  await render(root, commits, [cell(1600, dock('a', true)), cell(1600, dock('b', true))]);
  await render(root, commits, [cell(1600, dock('b', false))]);
  assert.equal(flag(), undefined, 'the removed pane released its claim');
  for (const [index, commit] of commits.entries()) assert.equal(commit.flag, commit.has, `commit ${index}`);
});

/** A layout effect of every commit that measures what the frame rules decide:
 *  the column flag and a computed style keyed on it (FRAME_RULE). */
function Measure({ log, name }) {
  useLayoutEffect(() => {
    const main = document.querySelector('.main-panel');
    const cellEl = document.querySelector('.pane-cell');
    log.push({
      name,
      dock: document.querySelector('.pane-side-dock')?.dataset.open,
      flag: main.dataset.inlineDock === 'true',
      display: document.defaultView.getComputedStyle(cellEl).display,
    });
  });
  return React.createElement('span', { className: `measure-${name}` });
}

const FRAME_RULE = '.main-panel[data-inline-dock="true"] .pane-cell { display: grid; }';

for (const position of ['right', 'bottom']) {
  test(`${position} dock: layout effects that measure in the opening and closing commits see the flagged layout`, async (t) => {
    const root = mount(t, position);
    const style = document.createElement('style');
    style.textContent = FRAME_RULE;
    document.head.append(style);
    const log = [];
    // The dock's own measurement (a bottom dock's room reads the host's computed style).
    const view = document.defaultView;
    const original = view.getComputedStyle;
    view.getComputedStyle = function (element, ...rest) {
      if (element?.classList?.contains('pane-side-dock')) {
        log.push({ name: 'dock-room', dock: element.dataset.open, flag: flag() === 'true' });
      }
      return original.call(this, element, ...rest);
    };
    t.after(() => {
      view.getComputedStyle = original;
    });
    const tree = (open) =>
      React.createElement(
        'main',
        { className: 'main-panel' },
        React.createElement(
          'div',
          { className: 'pane-cell', 'data-test-w': 1600 },
          // A sibling before the dock: its layout effect runs before the dock's.
          React.createElement(Measure, { log, name: 'sibling' }),
          React.createElement(PaneSideDock, {
            leafId: 'a',
            entry: { open, view: 'source-control', surface: '', diff: null },
            groups: [['source-control']],
            descriptors,
            focused: true,
            prewarm: true,
            onSelect: noop,
            onClose: noop,
            onCloseDiff: noop,
            onMoveGroup: noop,
            onMoveView: noop,
            onFocusPane: noop,
            openFileTab: noop,
            // A child of the dock: its layout effect runs before the dock's too.
            renderView: () => React.createElement(Measure, { log, name: 'child' }),
          })
        )
      );
    await act(async () => root.render(tree(false)));
    // The prewarmed body (and its child) mounts on the next frame.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    assert.ok(document.querySelector('.measure-child'), 'the prewarmed child is mounted');
    for (const open of [true, false, true]) {
      log.length = 0;
      await act(async () => root.render(tree(open)));
      const expected = open ? 'true' : 'false';
      const opening = log.filter((entry) => entry.dock === expected);
      assert.ok(
        opening.some((entry) => entry.name === 'sibling'),
        'the sibling measured'
      );
      assert.ok(
        opening.some((entry) => entry.name === 'child'),
        'the child measured'
      );
      if (position === 'bottom' && open)
        assert.ok(
          opening.some((entry) => entry.name === 'dock-room'),
          'room measured'
        );
      for (const entry of opening) {
        assert.equal(entry.flag, open, `${entry.name} sees the flag of open=${open}`);
        if ('display' in entry)
          assert.equal(entry.display, open ? 'grid' : 'block', `${entry.name} sees the frame rule`);
      }
    }
  });
}

test('a dock outside the workspace column flags nothing', async (t) => {
  const root = mount(t);
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        null,
        React.createElement('main', { className: 'main-panel' }),
        cell(1600, dock('a', true))
      )
    )
  );
  assert.deepEqual(docks(), ['true/false/false']);
  assert.equal(flag(), undefined);
});
