// Display → Composer style "Detailed": the label under the composer is
// opt-in, names the workflow only when there is one to choose, and opens the
// model trigger's menu. The composer card takes over from the one-line bar
// once the bar cannot show every item, and the line under the card follows
// the style.
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
      }
      observe() {
        resizeCallbacks.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
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
    React.createElement('button', { className: 'model-trigger', onClick: () => (opened += 1) }),
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

test('route label: off by default, so the line renders nothing extra', async () => {
  window.localStorage.clear();
  assert.equal(getComposerStyle(), 'basic');
  const view = await mount({ choices: BOTH });
  assert.equal(view.host.querySelector('.composer-route-label'), null);
  await view.unmount();
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

test('composer style: a device that had the route label on starts on "detail"', () => {
  window.localStorage.clear();
  window.localStorage.setItem('mixdog.desktop.route-label.v1', 'on');
  assert.equal(getComposerStyle(), 'detail');
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
        React.createElement('button', { ref: trigger, className: 'model-trigger' })
      ),
      React.createElement('button', { ref: otherTrigger, className: 'other-trigger' }),
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

// A one-line bar whose items are laid out by hand: jsdom has no layout, so the
// widths are what the browser would report for a 200 readout (data-full-width),
// a 120 route label, and a 150 model pill whose 130 label an ellipsis cut to
// 100: 200 + 120 + 5 + 150 + 30 = 505.
const ONE_LINE_ITEMS = 505;
function Bar({ width, active = true, label = true, controlsInLine = true, pickers = false }) {
  const form = React.useRef(null);
  const overflow = useOneLineOverflow(form, active);
  const sized = (box) => (element) => {
    if (element) element.getBoundingClientRect = () => ({ width: box });
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
          Object.defineProperty(element, 'scrollWidth', { value: 130 });
          Object.defineProperty(element, 'clientWidth', { value: 100 });
        },
      })
    )
  );
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'form',
      { ref: form, className: 'composer', 'data-overflow': String(overflow) },
      React.createElement('div', { className: 'composer-footer' }, !controlsInLine && controls)
    ),
    React.createElement(
      'div',
      {
        className: 'composer-model-line',
        style: { padding: '0px' },
        ref: (element) => {
          if (element) Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
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
        : React.createElement('button', { className: 'composer-usage-readout', 'data-full-width': '200' }),
      label && React.createElement('button', { className: 'composer-route-label', ref: sized(120) }),
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
      for (const callback of resizeCallbacks) callback();
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

// The line under the card follows the style: nothing for "simple" (no reserved
// line), the readout alone for "basic", readout and route label for "detail".
test('card line: simple shows nothing, basic the readout alone, detail the readout and the route label', async (t) => {
  t.after(() => setComposerStyle('basic'));
  const props = {
    card: true,
    usageReadout: React.createElement('button', { className: 'composer-usage-readout' }),
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
  assert.deepEqual(await render('basic'), { line: true, shown: ['composer-usage-readout'] });
  assert.deepEqual(await render('detail'), {
    line: true,
    shown: ['composer-usage-readout', 'composer-route-label'],
  });
  const pickers = React.createElement('div', { className: 'composer-model-line-context' });
  assert.deepEqual(await render('simple', { pickers }), { line: true, shown: ['composer-model-line-context'] });
});
