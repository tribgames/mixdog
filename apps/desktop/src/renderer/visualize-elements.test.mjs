import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import React, { act, useState } from 'react';

import { VISUALIZE_FEEDBACK_TAG } from '../shared/visualize-feedback.ts';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['requestAnimationFrame', 'cancelAnimationFrame'],
  globals: { navigator: { userAgent: 'node', userActivation: { isActive: true } } },
});
const { createRoot } = await import('react-dom/client');
const { startElementPin, useVisualizeInspection, VisualizeElements } = await import('./VisualizeElements.tsx');
const { VisualizeCommentLayer } = await import('./VisualizeFeedback.tsx');
const { resetVisualizeElementPins, requestVisualizeElementPin, takeVisualizeElementPin, VISUALIZE_ELEMENT_PIN_TTL_MS } =
  await import('./visualize-elements-store.ts');
const { resetVisualizeFeedback } = await import('./visualize-feedback-store.ts');

const jsdomUtils = createRequire(import.meta.url)('jsdom/lib/jsdom/living/generated/utils.js');
async function userClick(node) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  jsdomUtils.implForWrapper(event).isTrusted = true;
  await act(async () => jsdomUtils.implForWrapper(node)._dispatch(jsdomUtils.implForWrapper(event)));
}
const scriptClick = (node) =>
  act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

const tab = {
  id: 'v1',
  label: 'Mockup',
  revision: 0,
  panes: [{ kind: 'html', label: 'index.html', target: 'site/index.html', url: '', file: 'site/index.html' }],
};
const tagged = (message) => ({ ...message, [VISUALIZE_FEEDBACK_TAG]: 1 });
const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const inspection = {
  viewport: { width: 375, height: 812 },
  page: { width: 500, height: 900 },
  scope: '',
  outline: [{ depth: 0, kind: 'heading', role: 'heading', level: 1, name: 'Dashboard', selector: 'h1' }],
  elements: [{ role: 'button', name: 'Save', selector: '#save', tag: 'button', x: 1, y: 2, w: 3, h: 4, flags: [] }],
  elementCount: 1,
  findings: [
    {
      kind: 'overflow-x',
      severity: 'error',
      message: 'page scrolls horizontally',
      selector: 'html',
      x: 0,
      y: 0,
      w: 500,
      h: 0,
    },
  ],
  findingCount: 1,
  contrastUnknown: 0,
  partial: false,
};

async function mount(t) {
  resetVisualizeFeedback();
  resetVisualizeElementPins();
  const state = { findingCount: -1, comment: false };
  function Harness() {
    const [body, setBody] = useState(null);
    const [comment, setComment] = useState(false);
    state.comment = comment;
    const reading = useVisualizeInspection({ body, tab });
    state.findingCount = reading.findingCount;
    state.refresh = reading.refresh;
    return React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        { ref: setBody },
        React.createElement(
          'div',
          { 'data-visualize-pane': '0' },
          React.createElement(
            'div',
            { className: 'visualize-pane-content' },
            React.createElement('iframe', { title: 'page' }),
            React.createElement(VisualizeCommentLayer, { sessionId: 's1', tab, pane: tab.panes[0], index: 0, comment })
          )
        )
      ),
      React.createElement(VisualizeElements, {
        tab,
        readings: reading.readings,
        refresh: reading.refresh,
        highlight: reading.highlight,
        onClose: () => {},
        onPin: (pane, selector) => startElementPin(tab.id, pane, selector, setComment),
      })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  const frame = host.querySelector('iframe');
  const toPage = [];
  frame.contentWindow.postMessage = (message) => toPage.push(message);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
    resetVisualizeElementPins();
  });
  const fromPage = async (message, source = frame.contentWindow) => {
    await act(async () => window.dispatchEvent(new window.MessageEvent('message', { data: tagged(message), source })));
    await settle();
  };
  return { host, frame, toPage, fromPage, state };
}

/** The page announces itself; the panel asks it to inspect; the page answers. */
async function readPage({ toPage, fromPage }, answer = inspection) {
  await fromPage({ type: 'ready' });
  await settle(350);
  const request = toPage.find((message) => message.type === 'inspect');
  assert.ok(request, 'a ready page is asked for its reading');
  await fromPage({ type: 'inspected', id: request.id, inspection: answer });
  return request;
}

test('a ready page is read and its findings, outline and elements are listed', async (t) => {
  const page = await mount(t);
  assert.match(page.host.textContent, /Reading the page…/);
  await readPage(page);
  assert.equal(page.state.findingCount, 1);
  const text = page.host.querySelector('.visualize-elements').textContent;
  assert.match(text, /Findings \(1\)/);
  assert.match(text, /page scrolls horizontally/);
  assert.match(text, /Dashboard/);
  assert.match(text, /Interactive \(1\)/);
  assert.match(text, /button.*Save.*#save/);
});

test('answers from other windows, with another id, or malformed are ignored', async (t) => {
  const page = await mount(t);
  await page.fromPage({ type: 'ready' });
  await settle(350);
  const request = page.toPage.find((message) => message.type === 'inspect');
  const stranger = new window.MessageEvent('message', {
    data: tagged({ type: 'inspected', id: request.id, inspection }),
    source: window,
  });
  await act(async () => window.dispatchEvent(stranger));
  await page.fromPage({ type: 'inspected', id: 'guessed', inspection });
  await page.fromPage({ type: 'inspected', id: request.id, inspection: { elements: 'nope' } });
  assert.equal(page.state.findingCount, 0);
  await page.fromPage({ type: 'inspected', id: request.id, inspection });
  assert.equal(page.state.findingCount, 1);
});

test('a page that never answers is unavailable, and an error answer is shown', async (t) => {
  const page = await mount(t);
  await page.fromPage({ type: 'ready' });
  await settle(350);
  await settle(1600);
  assert.match(page.host.textContent, /This page is not running, so its elements cannot be listed\./);
  await page.state.refresh();
  const request = page.toPage.filter((message) => message.type === 'inspect').at(-1);
  await page.fromPage({ type: 'inspected', id: request.id, inspection: { error: 'the selector matched nothing' } });
  assert.match(page.host.textContent, /the selector matched nothing/);
});

test('hovering a row outlines the element in the page, leaving clears it', async (t) => {
  const page = await mount(t);
  await readPage(page);
  const row = [...page.host.querySelectorAll('.visualize-elements-row')].find((node) =>
    node.textContent.includes('Save')
  );
  await act(async () => row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  await act(async () => row.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })));
  const highlights = page.toPage.filter((message) => message.type === 'highlight').map((message) => message.selector);
  assert.deepEqual(highlights, ['#save', null]);
});

test('only a trusted click on a row starts a pin: Comment mode comes on and the page describes that element', async (t) => {
  const page = await mount(t);
  await readPage(page);
  const row = [...page.host.querySelectorAll('.visualize-elements-row')].find((node) =>
    node.textContent.includes('Save')
  );
  await scriptClick(row);
  assert.equal(page.state.comment, false, 'a script-made click does nothing');
  assert.equal(
    page.toPage.some((message) => message.type === 'describe'),
    false
  );

  await userClick(row);
  await settle();
  assert.equal(page.state.comment, true);
  const describe = page.toPage.find((message) => message.type === 'describe');
  assert.equal(describe.selector, '#save');
  assert.ok(describe.id);

  // The request was spent: Comment mode coming on again asks nothing more.
  assert.equal(page.toPage.filter((message) => message.type === 'describe').length, 1);
});

test('the pin request slot is single, scoped to its pane and expires', () => {
  resetVisualizeElementPins();
  requestVisualizeElementPin({ tabId: 'v1', pane: 0, selector: '#a' }, 1000);
  assert.equal(takeVisualizeElementPin('v1', 1, 1001), null, 'another pane cannot take it');
  assert.equal(takeVisualizeElementPin('v2', 0, 1001), null, 'another tab cannot take it');
  assert.deepEqual(takeVisualizeElementPin('v1', 0, 1001), { tabId: 'v1', pane: 0, selector: '#a' });
  assert.equal(takeVisualizeElementPin('v1', 0, 1002), null, 'taken once');
  requestVisualizeElementPin({ tabId: 'v1', pane: 0, selector: '#b' }, 1000);
  assert.equal(
    takeVisualizeElementPin('v1', 0, 1000 + VISUALIZE_ELEMENT_PIN_TTL_MS + 1),
    null,
    'stale requests are dropped'
  );
});
test('a flood of ready messages makes a bounded number of reads, one in flight, trailing-debounced', async (t) => {
  const page = await mount(t);
  const reads = () => page.toPage.filter((message) => message.type === 'inspect');
  // One burst: per-message waits would let the debounce pass mid-flood on a coarse timer.
  await act(async () => {
    for (let i = 0; i < 40; i += 1) {
      window.dispatchEvent(
        new window.MessageEvent('message', { data: tagged({ type: 'ready' }), source: page.frame.contentWindow })
      );
    }
  });
  assert.equal(reads().length, 0, 'nothing is read before the debounce passes');
  await settle(450);
  assert.equal(reads().length, 1, 'the flood collapses to one read');
  await settle(600);

  // While that read is in flight, further readys wait for its answer, then read once.
  for (let i = 0; i < 3; i += 1) await page.fromPage({ type: 'ready' });
  await settle(450);
  assert.equal(reads().length, 1, 'one in flight per pane');
  await page.fromPage({ type: 'inspected', id: reads()[0].id, inspection });
  assert.equal(reads().length, 2, 'the queued read runs after the answer');
  await page.fromPage({ type: 'inspected', id: reads()[1].id, inspection });
  await settle(450);
  assert.equal(reads().length, 2, 'and only once');

  // Beyond the per-second cap further announcements are ignored outright.
  const before = reads().length;
  for (let i = 0; i < 12; i += 1) await page.fromPage({ type: 'ready' });
  await settle(450);
  assert.equal(reads().length, before + 1);
});
