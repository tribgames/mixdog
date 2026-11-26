import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const resizeCallbacks = new Set();
const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'MutationObserver', 'getComputedStyle', 'navigator'],
  globals: {
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
      }
      observe(target) {
        this.targets.add(target);
        resizeCallbacks.add(this);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this);
      }
    },
  },
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { ComposerRouteLabel, useRouteLabelParts } = await import('./composer-route-label.tsx');
const { CARD_RETURN_ROOM, useOneLineOverflow, wantsCard } = await import('./composer-card-layout.ts');
const { ComposerModelLine } = await import('./ComposerFooter.tsx');
const { useMenuDismiss } = await import('./menu-dismiss.ts');
const { getComposerStyle, setComposerStyle } = await import('./composer-style-preference.ts');

const choice = (id, valueLabel) => ({ id, label: id, value: id, valueLabel, options: [], onSelect() {} });
const BOTH = [choice('workflow', 'Review'), choice('orchestration-mode', 'Swarm')];
const MODE_ONLY = [choice('orchestration-mode', 'Solo')];

let opened = 0;
function Line({ choices }) {
  const parts = useRouteLabelParts(choices);
  return React.createElement(
    'div',
    { className: 'composer-model-line', style: { padding: '0px' } },
    React.createElement('button', { type: 'button', className: 'model-trigger', onClick: () => (opened += 1) }),
    parts && React.createElement(ComposerRouteLabel, { parts })
  );
}

async function mount(props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Line, props)));
  return { host, unmount: () => act(async () => root.unmount()) };
}

test('composer style: "detail" by default, so the route label shows; "Normal" leaves it out', async (t) => {
  t.after(() => setComposerStyle('basic'));
  window.localStorage.clear();
  assert.equal(getComposerStyle(), 'detail');
  const detail = await mount({ choices: BOTH });
  assert.ok(detail.host.querySelector('.composer-route-label'));
  await detail.unmount();
  setComposerStyle('basic');
  const normal = await mount({ choices: BOTH });
  assert.equal(normal.host.querySelector('.composer-route-label'), null);
  await normal.unmount();
});

test('route label: on shows "workflow · mode", mode alone for one workflow, nothing without a mode', async (t) => {
  t.after(() => setComposerStyle('basic'));
  setComposerStyle('detail');
  const both = await mount({ choices: BOTH });
  assert.equal(both.host.querySelector('.composer-route-label').textContent, 'Review · Swarm');
  await both.unmount();
  const modeOnly = await mount({ choices: MODE_ONLY });
  assert.equal(modeOnly.host.querySelector('.composer-route-label').textContent, 'Solo');
  assert.equal(modeOnly.host.querySelector('.composer-route-label-workflow'), null);
  await modeOnly.unmount();
  const none = await mount({ choices: [choice('workflow', 'Review')] });
  assert.equal(none.host.querySelector('.composer-route-label'), null);
  await none.unmount();
});

test('composer style: the earlier route-label switch is cleared on the first save', () => {
  window.localStorage.clear();
  window.localStorage.setItem('mixdog.desktop.route-label.v1', 'on');
  setComposerStyle('simple');
  assert.equal(window.localStorage.getItem('mixdog.desktop.route-label.v1'), null);
  assert.equal(getComposerStyle(), 'simple');
  setComposerStyle('basic');
});

test('route label: a click opens the menu the model trigger opens', async (t) => {
  t.after(() => setComposerStyle('basic'));
  setComposerStyle('detail');
  const view = await mount({ choices: BOTH });
  opened = 0;
  await act(async () => view.host.querySelector('.composer-route-label').click());
  assert.equal(opened, 1);
  await view.unmount();
});

// Under the card the model trigger is a row away: the label opens its own
// small menu of the delegation choices, anchored to the label.
test('route label under the card: a click opens its own menu of the choices, and a pick closes it', async (t) => {
  t.after(() => setComposerStyle('basic'));
  setComposerStyle('detail');
  const picked = [];
  const mode = {
    ...choice('orchestration-mode', 'Solo'),
    value: 'solo',
    options: [
      { value: 'solo', label: 'Solo', description: 'One agent' },
      { value: 'swarm', label: 'Swarm', description: 'Many agents' },
    ],
    onSelect: (value) => picked.push(value),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        { className: 'composer-model-line' },
        React.createElement('button', { type: 'button', className: 'model-trigger', onClick: () => (opened += 1) }),
        React.createElement(ComposerRouteLabel, { parts: { workflow: '', mode: 'Solo' }, choices: [mode] })
      )
    )
  );
  opened = 0;
  const label = host.querySelector('.composer-route-label');
  await act(async () => label.click());
  const menu = document.querySelector('.composer-route-choices[role="menu"]');
  assert.ok(menu, 'its own menu opened');
  assert.equal(opened, 0, 'the model menu stayed shut');
  assert.equal(label.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    [...menu.querySelectorAll('[role="menuitemradio"]')].map((option) => [
      option.textContent,
      option.getAttribute('aria-checked'),
    ]),
    [
      ['SoloOne agent', 'true'],
      ['SwarmMany agents', 'false'],
    ]
  );
  await act(async () => menu.querySelectorAll('[role="menuitemradio"]')[1].click());
  assert.deepEqual(picked, ['swarm']);
  assert.equal(document.querySelector('.composer-route-choices'), null, 'a pick closes it');
  assert.equal(label.getAttribute('aria-expanded'), 'false');
  // The checked option changes nothing, and still closes the menu.
  await act(async () => label.click());
  await act(async () => document.querySelector('.composer-route-choices [aria-checked="true"]').click());
  assert.deepEqual(picked, ['swarm']);
  assert.equal(document.querySelector('.composer-route-choices'), null, 'the checked option closes it too');
});

// The press that lands on the label is not "outside" the menu: dismissing on it
// would close the menu just before the click re-opens it.
test('route label: pressing it keeps the model menu open but closes any other menu', async () => {
  setComposerStyle('detail');
  let closed = 0;
  let otherClosed = 0;
  function Open() {
    const trigger = React.useRef(null);
    const otherTrigger = React.useRef(null);
    useMenuDismiss({ open: true, close: () => (closed += 1), trigger, panels: () => [] });
    useMenuDismiss({ open: true, close: () => (otherClosed += 1), trigger: otherTrigger, panels: () => [] });
    return React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        { className: 'composer-model-line' },
        React.createElement(ComposerRouteLabel, { parts: { workflow: '', mode: 'Solo' } }),
        React.createElement('button', { type: 'button', ref: trigger, className: 'model-trigger' })
      ),
      React.createElement('button', { type: 'button', ref: otherTrigger, className: 'other-trigger' }),
      React.createElement('p', { className: 'elsewhere' })
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Open)));
  const press = (node) => node.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  press(host.querySelector('.composer-route-label > span'));
  assert.equal(closed, 0, 'the model menu waits for the label click, which toggles it');
  assert.equal(otherClosed, 1, 'another open menu still closes');
  press(host.querySelector('.elsewhere'));
  assert.equal(closed, 1);
  await act(async () => root.unmount());
  setComposerStyle('basic');
});

test('card layout: the card takes over past the items, and gives the line back with room to spare', () => {
  assert.equal(wantsCard(500, 500, false), false, 'exactly fitting stays one line');
  assert.equal(wantsCard(501, 500, false), true);
  assert.equal(wantsCard(500, 500, true), true, 'the card stays while the items only just fit');
  assert.equal(wantsCard(500, 500 + CARD_RETURN_ROOM, true), false);
});

// jsdom has no layout: widths are what a browser reports for a 200 readout
// (data-full-width), a 120 route label and a 150 model pill whose 130 label an
// ellipsis cuts to 100: 200 + 120 + 5 + 150 + 30 = 505.
const ONE_LINE_ITEMS = 505;
// `readout` false is the "simple" style (no usage readout); `lineShown` false is
// its card, which has no line under it, so the form's own width is measured.
function Bar({
  width,
  active = true,
  label = true,
  controlsInLine = true,
  pickers = false,
  readout = true,
  lineShown = true,
  hidden = false,
  layoutKey,
  onLayout,
}) {
  const form = React.useRef(null);
  const overflow = useOneLineOverflow(form, active, layoutKey);
  React.useLayoutEffect(() => {
    onLayout?.({ form: form.current, overflow });
  });
  const measuredWidth = hidden ? 0 : width;
  const sized = (box) => (element) => {
    if (element) element.getBoundingClientRect = () => ({ width: hidden ? 0 : box });
  };
  const controls = React.createElement(
    'span',
    { className: 'composer-model-line-controls' },
    React.createElement(
      'div',
      { className: 'route-controls', ref: sized(150) },
      React.createElement('span', {
        className: 'model-route-label',
        ref: (element) => {
          if (!element) return;
          Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => (hidden ? 0 : 130) });
          Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => (hidden ? 0 : 100) });
        },
      })
    )
  );
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'form',
      {
        ref: (element) => {
          form.current = element;
          // The line's 16px of side padding come off the form's width.
          if (element)
            Object.defineProperty(element, 'clientWidth', {
              configurable: true,
              get: () => (hidden ? 0 : measuredWidth + 16),
            });
        },
        className: 'composer',
        'data-overflow': String(overflow),
      },
      React.createElement('div', { className: 'composer-footer' }, (!controlsInLine || !lineShown) && controls)
    ),
    lineShown &&
      React.createElement(
        'div',
        {
          className: 'composer-model-line',
          style: { padding: '0px' },
          ref: (element) => {
            if (element)
              Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => measuredWidth });
          },
        },
        pickers
          ? // Before the first message the pickers stand in the readout's place;
            // they shrink with the line, so their content is 260 wide.
            React.createElement('div', {
              className: 'composer-model-line-context',
              ref: (element) => {
                if (element) Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 260 });
              },
            })
          : readout &&
              React.createElement('button', {
                type: 'button',
                className: 'composer-usage-readout',
                'data-full-width': '200',
              }),
        label && React.createElement('button', { type: 'button', className: 'composer-route-label', ref: sized(120) }),
        controlsInLine && controls
      )
  );
}

async function renderBar(props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // A re-render stands in for the window's resize: the observers then report it.
  const show = async (next) => {
    await act(async () => root.render(React.createElement(Bar, { ...props, ...next })));
    await act(async () => {
      // Like the browser, only an observed element still in the page reports.
      for (const observer of resizeCallbacks) {
        if ([...observer.targets].some((target) => target.isConnected)) observer.callback();
      }
    });
  };
  await show({});
  const card = () => host.querySelector('form').dataset.overflow === 'true';
  return { card, show, unmount: () => act(async () => root.unmount()) };
}

test('card layout: a PC bar too narrow for its items turns into the card, and back once it widens', async () => {
  const bar = await renderBar({ width: ONE_LINE_ITEMS });
  assert.equal(bar.card(), false, 'every item fits in full');
  await bar.show({ width: ONE_LINE_ITEMS - 1 });
  assert.equal(bar.card(), true, 'one pixel short of the items');
  await bar.unmount();
});

test('card layout: before the first message the pickers count in full', async () => {
  // 260 pickers instead of the 200 readout.
  const items = ONE_LINE_ITEMS - 200 + 260;
  const bar = await renderBar({ width: items, pickers: true });
  assert.equal(bar.card(), false, 'pickers, label and model fit');
  await bar.show({ width: items - 1 });
  assert.equal(bar.card(), true, 'one pixel short of the pickers and the model');
  await bar.unmount();
});

test('card layout: no flip-flop on the boundary, and the items count wherever the controls sit', async () => {
  const bar = await renderBar({ width: ONE_LINE_ITEMS - 10, controlsInLine: false });
  assert.equal(bar.card(), true, 'the controls in the card row still count');
  await bar.show({ width: ONE_LINE_ITEMS + CARD_RETURN_ROOM - 1, controlsInLine: false });
  assert.equal(bar.card(), true, 'room for the items alone is not enough to return');
  await bar.show({ width: ONE_LINE_ITEMS + CARD_RETURN_ROOM, controlsInLine: false });
  assert.equal(bar.card(), false);
  await bar.show({ width: ONE_LINE_ITEMS, controlsInLine: true });
  assert.equal(bar.card(), false, 'once back, the items fitting exactly keeps the line');
  await bar.unmount();
});

test('card layout: without the route label the items need less room, and an inactive bar never asks for the card', async () => {
  const bar = await renderBar({ width: ONE_LINE_ITEMS - 100, label: false });
  assert.equal(bar.card(), false);
  await bar.show({ label: true });
  assert.equal(bar.card(), true);
  await bar.show({ active: false });
  assert.equal(bar.card(), false);
  await bar.unmount();
});

// The "simple" style measures the Standard layout minus the usage readout: its
// card has no line under it, so the form's width stands in for the line's.
// (No route label either: that is the "detail" style's.)
const SIMPLE_ITEMS = ONE_LINE_ITEMS - 200 - (120 + 5);
test('card layout: simple measures like standard without the readout, and returns from its line-less card with room to spare', async () => {
  const bar = await renderBar({ width: SIMPLE_ITEMS, readout: false, label: false });
  assert.equal(bar.card(), false, 'the model alone fits exactly');
  await bar.show({ width: SIMPLE_ITEMS - 1 });
  assert.equal(bar.card(), true, 'one pixel short is the card');
  await bar.show({ width: SIMPLE_ITEMS + CARD_RETURN_ROOM - 1, lineShown: false });
  assert.equal(bar.card(), true, 'the card, with no line to measure, still waits for the room');
  await bar.show({ width: SIMPLE_ITEMS + CARD_RETURN_ROOM, lineShown: false });
  assert.equal(bar.card(), false);
  await bar.show({ width: SIMPLE_ITEMS, lineShown: true });
  assert.equal(bar.card(), false, 'the line is back and the items still fit');
  await bar.unmount();
});

test('card layout: switching Standard to Simple inside the card removes the line, and widening still returns to one line', async () => {
  // In the card the model controls already sit in the footer, so removing the
  // line changes nothing the mutation observer would notice.
  const bar = await renderBar({ width: 100, controlsInLine: false });
  assert.equal(bar.card(), true, 'Standard in a narrow window is the card');
  await bar.show({ readout: false, label: false, lineShown: false });
  assert.equal(bar.card(), true, 'Simple in the same window is the card, with no line under it');
  await bar.show({ width: 1000 });
  assert.equal(bar.card(), false, 'widened, the line-less card is observed and gives the line back');
  await bar.unmount();
});

// The line under the card follows the style: nothing for "simple" under the card
// (no reserved line; the model alone on the one-line layout's), the readout alone for "basic", readout and route label for "detail".
test('card line: simple shows nothing, basic the readout alone, detail the readout and the route label', async (t) => {
  t.after(() => setComposerStyle('basic'));
  const props = {
    card: true,
    usageReadout: React.createElement('button', { type: 'button', className: 'composer-usage-readout' }),
    sessionChoices: BOTH,
  };
  const render = async (style, extra = {}) => {
    setComposerStyle(style);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(React.createElement(ComposerModelLine, { ...props, ...extra })));
    const line = host.querySelector('.composer-model-line');
    const shown = line && [...line.children].map((child) => child.className);
    await act(async () => root.unmount());
    return { line: Boolean(line), shown };
  };
  assert.deepEqual(await render('simple'), { line: false, shown: null });
  // The one-line layout: the model alone on the line, no readout (Standard has it).
  const oneLine = await render('simple', { card: false });
  assert.equal(oneLine.line, true);
  assert.ok(!oneLine.shown.includes('composer-usage-readout'));
  assert.deepEqual(await render('basic'), { line: true, shown: ['composer-usage-readout'] });
  assert.deepEqual(await render('detail'), {
    line: true,
    shown: ['composer-usage-readout', 'composer-route-label'],
  });
  const pickers = React.createElement('div', { className: 'composer-model-line-context' });
  assert.deepEqual(await render('simple', { pickers }), { line: true, shown: ['composer-model-line-context'] });
});

test('card layout: re-evaluates synchronously when bare flips off and the model line mounts', async (t) => {
  const savedMutationObserver = globalThis.MutationObserver;
  // No-op MutationObserver proves overflow and observer rebinding happen
  // synchronously in useLayoutEffect rather than via async DOM mutation callbacks.
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.MutationObserver = savedMutationObserver;
  });
  let passiveFlushed = false;
  const layoutSnapshots = [];
  function HandoffHarness(props) {
    React.useEffect(() => {
      passiveFlushed = true;
    });
    return React.createElement(Bar, {
      ...props,
      onLayout: ({ form }) => {
        const line = host.querySelector('.composer-model-line');
        if (form && line) {
          layoutSnapshots.push({
            overflow: form.dataset.overflow,
            lineObserved: [...resizeCallbacks].some((observer) => observer.targets.has(line)),
            passiveFlushed,
          });
        }
      },
    });
  }
  // Mirror Composer.tsx (`active = !phone && !roomMembers && !bare`): while
  // bare, overflow measurement is inactive and no sibling model line exists.
  await act(async () =>
    root.render(
      React.createElement(HandoffHarness, {
        width: 360,
        active: false,
        lineShown: false,
        controlsInLine: true,
        layoutKey: '1:1',
      })
    )
  );
  assert.equal(host.querySelector('form').dataset.overflow, 'false');
  // Rail hands back to the composer (`bare: true -> false`, `active: false -> true`):
  // the model line mounts and both observer rebinding and overflow must settle
  // during useLayoutEffect before passive effects flush.
  passiveFlushed = false;
  layoutSnapshots.length = 0;
  await act(async () =>
    root.render(
      React.createElement(HandoffHarness, {
        width: 360,
        active: true,
        lineShown: true,
        controlsInLine: true,
        layoutKey: '1:0',
      })
    )
  );
  assert.equal(passiveFlushed, true, 'passive effects ran after layout commit');
  assert.deepEqual(
    layoutSnapshots[0],
    { overflow: 'false', lineObserved: true, passiveFlushed: false },
    'model-line ResizeObserver rebinding occurred during layout effect before passive effects flushed'
  );
  assert.equal(
    layoutSnapshots.at(-1)?.overflow,
    'true',
    'overflow settled synchronously from the layout-effect measurement without observers'
  );
  assert.equal(host.querySelector('form').dataset.overflow, 'true');
  const line = host.querySelector('.composer-model-line');
  assert.ok(
    [...resizeCallbacks].some((observer) => observer.targets.has(line)),
    'the newly mounted model line is now observed for future resizes'
  );
});

test('card layout: re-evaluates synchronously when a hidden panel reveals at a new width', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  // Mounted inside a hidden panel (0px box): must not latch into card mode from 0px.
  await act(async () => root.render(React.createElement(Bar, { width: 515, hidden: true, layoutKey: 'shown:0' })));
  assert.equal(host.querySelector('form').dataset.overflow, 'false');
  // Revealed at 515px (fits 505px items, inside hysteresis band): stays one-line before paint.
  await act(async () => root.render(React.createElement(Bar, { width: 515, hidden: false, layoutKey: 'shown:1' })));
  assert.equal(host.querySelector('form').dataset.overflow, 'false');
  // Hidden again, then revealed at a narrow 360px dock width: switches to card synchronously without ResizeObserver.
  await act(async () => root.render(React.createElement(Bar, { width: 360, hidden: true, layoutKey: 'shown:0' })));
  await act(async () => root.render(React.createElement(Bar, { width: 360, hidden: false, layoutKey: 'shown:1' })));
  assert.equal(host.querySelector('form').dataset.overflow, 'true');
  // Hidden again, then revealed at a wide 640px width: returns to one-line synchronously without ResizeObserver.
  await act(async () => root.render(React.createElement(Bar, { width: 640, hidden: true, layoutKey: 'shown:0' })));
  await act(async () => root.render(React.createElement(Bar, { width: 640, hidden: false, layoutKey: 'shown:1' })));
  assert.equal(host.querySelector('form').dataset.overflow, 'false');
});
