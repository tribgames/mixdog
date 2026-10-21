// The timeline's end is the spacer plus the thread's top inset (44px). The
// inset is a style read: taken while the pane's host was out of the document
// (PersistentPanePortal moves and re-slots its host), it read "" and was kept
// as 0 for the list's whole life, so every end pin landed 44px short of the
// bottom — a group room then rested with its last reply clipped under the
// composer (QA C-23).
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTranscriptScrollGeometry } = await import('./transcript-list-scroll-geometry.ts');
const { transcriptScrollExtent } = await import('./transcript-follow-rules.ts');

function setup() {
  const viewport = document.createElement('div');
  const thread = document.createElement('div');
  thread.style.paddingTop = '44px';
  const spacer = document.createElement('div');
  spacer.style.height = '1000px';
  thread.append(spacer);
  viewport.append(thread);
  const instance = {
    scrollElement: viewport,
    scrollOffset: 0,
    scrollAdjustments: 0,
    getSize: () => 600,
    getTotalSize: () => 1000,
    _willUpdate() {},
  };
  const refs = {
    viewport: { current: viewport },
    spacer: { current: spacer },
    virtualizerRef: { current: instance },
    domTop: { current: null },
    scrollInset: { current: 0 },
  };
  const deviation = { amount: () => 0, drop() {} };
  const contentHeight = () => refs.scrollInset.current + Number.parseFloat(spacer.style.height);
  const Probe = () => {
    useTranscriptScrollGeometry({ ...refs, contentHeight, deviation });
    return null;
  };
  return { viewport, refs, Probe };
}

test('an inset read while the pane is detached is taken again once it is in the document', async () => {
  const { viewport, refs, Probe } = setup();
  const root = createRoot(document.createElement('div'));
  // Chromium resolves no style for an element outside the document ("").
  const original = window.getComputedStyle;
  window.getComputedStyle = (element, ...rest) =>
    element.isConnected ? original.call(window, element, ...rest) : { paddingTop: '' };
  try {
    // First commit: the pane's host is not in the document yet.
    await act(async () => root.render(React.createElement(Probe, { n: 1 })));
    document.getElementById('root').append(viewport);
    await act(async () => root.render(React.createElement(Probe, { n: 2 })));
  } finally {
    window.getComputedStyle = original;
  }
  assert.equal(refs.scrollInset.current, 44);
  assert.equal(transcriptScrollExtent(viewport).maxScrollTop, 1044 - 600, 'the end includes the thread inset');
  await act(async () => root.unmount());
  viewport.remove();
});

test('an attached thread is read once, not on every commit', async () => {
  const { viewport, refs, Probe } = setup();
  document.getElementById('root').append(viewport);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Probe, { n: 1 })));
  assert.equal(refs.scrollInset.current, 44);
  const original = window.getComputedStyle;
  let reads = 0;
  window.getComputedStyle = (...args) => {
    reads += 1;
    return original.apply(window, args);
  };
  try {
    await act(async () => root.render(React.createElement(Probe, { n: 2 })));
    await act(async () => root.render(React.createElement(Probe, { n: 3 })));
  } finally {
    window.getComputedStyle = original;
  }
  assert.equal(reads, 0);
  await act(async () => root.unmount());
  viewport.remove();
});
