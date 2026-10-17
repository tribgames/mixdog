import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main id="root"></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window', 'KeyboardEvent', 'WheelEvent', 'MouseEvent'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
window.mixdogDesktop = { visualizeCommand: async () => ({}) };

const { VisualizePane, visualizePaneTitle } = await import('./VisualizePane.tsx');
const { applyVisualizeEvent } = await import('./visualize-store.ts');
const { readZoomBarVisible, setZoomBarVisible } = await import('./zoom-bar-pref.ts');
const { BrowserZoomPill } = await import('./BrowserZoomPill.tsx');

const image = (label, extra = {}) => ({ kind: 'image', label, target: `docs/${label}`, url: `x://${label}`, ...extra });
const putTab = (tab, extra = {}) =>
  applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: tab.id, ...extra } });

async function mount() {
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(VisualizePane, { sessionId: 's1', active: true, onClose() {} }))
  );
  return root;
}
const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const openMenu = async () => {
  await click(document.querySelector('button[aria-label="More actions"]'));
  return [...document.querySelectorAll('.dock-header-menu button')];
};
const percent = () => document.querySelector('.browser-zoom-percent span')?.textContent;
const layer = () => document.querySelector('.visualize-zoom-layer');
const key = (k) =>
  act(async () =>
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true })
    )
  );

test('the header keeps Comment and Versions inline; toggles live in ⋯ as checkboxes', async () => {
  setZoomBarVisible(true);
  putTab(
    {
      id: 't1',
      label: 'a.html',
      revision: 0,
      panes: [{ kind: 'html', label: 'a.html', target: 'a.html', url: 'http://127.0.0.1:1/a.html' }],
      versions: [
        { n: 1, at: 1 },
        { n: 2, at: 2 },
      ],
    },
    { history: [] }
  );
  const root = await mount();
  try {
    const header = document.querySelector('.session-diff-header');
    const inline = [...header.querySelectorAll('button')]
      .map((button) => button.getAttribute('aria-label'))
      .filter((label) => label && !['Close tab', 'More actions'].includes(label));
    assert.ok(inline.includes('Comment') && inline.includes('Versions'), inline.join(','));
    for (const gone of ['All visuals', 'Source', 'Elements', 'Tweaks', 'Network allowed', 'Allow outside network']) {
      assert.equal(inline.includes(gone), false, `${gone} is not a header button`);
    }
    const menu = await openMenu();
    const byLabel = (label) => menu.find((item) => item.textContent.includes(label));
    for (const label of ['All visuals', 'Source', 'Zoom bar']) {
      assert.equal(byLabel(label)?.getAttribute('role'), 'menuitemcheckbox', label);
    }
    assert.equal(byLabel('Zoom bar').getAttribute('aria-checked'), 'true');
    assert.equal(
      menu.some((item) => /network/i.test(item.textContent)),
      false,
      'no network toggle'
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('split view has no filename strip; the cell tooltip carries the name and a vN marker', async () => {
  putTab({
    id: 't2',
    label: 'compare',
    revision: 0,
    compare: true,
    panes: [image('a.png', { version: 2 }), image('b.png')],
  });
  const root = await mount();
  try {
    assert.equal(document.querySelector('.visualize-pane-label'), null);
    const cells = [...document.querySelectorAll('.visualize-pane-cell')];
    assert.equal(cells[0].title, 'v2 · a.png\ndocs/a.png');
    assert.equal(cells[1].title, 'Live · b.png\ndocs/b.png');
    assert.equal(visualizePaneTitle({ compare: false, panes: [] }, image('c.png')), 'c.png\ndocs/c.png');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the Visualize pill scales the content, Ctrl+0 resets, and the shared toggle hides it', async () => {
  setZoomBarVisible(true);
  putTab({ id: 't3', label: 'p.png', revision: 0, panes: [image('p.png')] });
  const root = await mount();
  try {
    assert.equal(percent(), '100%');
    assert.equal(layer().style.width, '');
    await click(document.querySelector('[aria-label="Zoom in"]'));
    assert.equal(percent(), '125%');
    // An image is fitted to its layer: the layer grows with the scale.
    assert.equal(layer().style.width, '125%');
    assert.equal(layer().style.height, '125%');
    assert.equal(layer().style.transform, '');

    await click(document.querySelector('.browser-zoom-percent'));
    const entries = [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);
    assert.deepEqual(entries, ['Fit to window', '50%', '100%', '150%', '200%']);
    await click(document.querySelectorAll('[role="menuitemradio"]')[4]);
    assert.equal(percent(), '200%');

    await key('-');
    assert.equal(percent(), '175%');
    await key('0');
    assert.equal(percent(), '100%');
    assert.equal(layer().style.width, '');

    // Ctrl+wheel over the pane zooms too.
    const wheel = new window.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.querySelector('.visualize-pane').dispatchEvent(wheel));
    assert.equal(wheel.defaultPrevented, true);
    assert.ok(Number.parseInt(percent(), 10) > 100);

    // A reload of the same tab's files (a new revision) keeps the zoom…
    const zoomed = percent();
    assert.notEqual(zoomed, '100%');
    putTab({ id: 't3', label: 'p.png', revision: 1, panes: [image('p.png')] });
    await act(async () => {});
    assert.equal(percent(), zoomed);
    // …another tab starts again at 100%.
    putTab({ id: 't4', label: 'q.png', revision: 0, panes: [image('q.png')] });
    await act(async () => {});
    assert.equal(percent(), '100%');

    // The ⋯ toggle hides the pill; the zoom keys keep working.
    const zoomItem = (await openMenu()).find((item) => item.textContent.includes('Zoom bar'));
    await click(zoomItem);
    assert.equal(readZoomBarVisible(), false);
    assert.equal(document.querySelector('.browser-zoom-pill'), null);
    await key('=');
    assert.equal(layer().style.width, '125%');
    const shown = (await openMenu()).find((item) => item.textContent.includes('Zoom bar'));
    assert.equal(shown.getAttribute('aria-checked'), 'false');
    await click(shown);
    assert.equal(percent(), '125%');
  } finally {
    setZoomBarVisible(true);
    await act(async () => root.unmount());
  }
});

test('pages and documents scale like browser zoom: laid out at 1/scale, then scaled up', async () => {
  const { visualizeZoomStyle } = await import('./visualize-zoom.ts');
  assert.equal(visualizeZoomStyle(1, 'html'), undefined);
  assert.deepEqual(visualizeZoomStyle(2, 'html'), { width: '50%', height: '50%', transform: 'scale(2)' });
  assert.deepEqual(visualizeZoomStyle(0.5, 'pdf'), { width: '200%', height: '200%', transform: 'scale(0.5)' });
  // An image also scales its own drawn size, so one smaller than the pane zooms too.
  assert.deepEqual(visualizeZoomStyle(1.5, 'image'), {
    width: '150%',
    height: '150%',
    margin: 'auto',
    '--visualize-zoom': 1.5,
  });
  assert.match(
    readFileSync(new URL('./visualize.css', import.meta.url), 'utf8'),
    /\.visualize-zoom-layer img\s*\{[^}]*zoom:\s*var\(--visualize-zoom/
  );
});

test('zoom gestures made inside a pane frame (a page, a PDF) zoom the panel they land on', async () => {
  setZoomBarVisible(true);
  putTab({
    id: 't5',
    label: 'page.html',
    revision: 0,
    panes: [{ kind: 'html', label: 'page.html', target: 'page.html', url: 'http://127.0.0.1:1/tok/page.html' }],
  });
  const root = await mount();
  const frame = document.querySelector('.visualize-pane-content iframe');
  const gesture = (input, point) => act(async () => applyVisualizeEvent({ sessionId: '', zoom: input, point }));
  // jsdom has no layout: the point hits the frame, or something else.
  let hit = frame;
  document.elementFromPoint = () => hit;
  try {
    assert.equal(percent(), '100%');
    // Ctrl+wheel in the frame comes with where it happened.
    await gesture('in', { x: 5, y: 5 });
    assert.equal(percent(), '125%');
    await gesture('out', { x: 5, y: 5 });
    await gesture('out', { x: 5, y: 5 });
    assert.equal(percent(), '75%');
    // A wheel elsewhere in the window is not this panel's.
    hit = document.body;
    await gesture('in', { x: 900, y: 5 });
    assert.equal(percent(), '75%');
    // A key has no point: the panel holding focus takes it (the frame is the
    // active element while the page inside has focus), another focus does not.
    await gesture('in');
    assert.equal(percent(), '75%');
    frame.setAttribute('tabindex', '0');
    await act(async () => frame.focus());
    await gesture('in');
    assert.equal(percent(), '100%');
    await gesture('in');
    await gesture('reset');
    assert.equal(percent(), '100%');
  } finally {
    delete document.elementFromPoint;
    await act(async () => root.unmount());
  }
});

test('a zoom key goes to ONE target: the focused pane first, hover only as the fallback', async () => {
  const { ZoomFrame } = await import('./ZoomFrame.tsx');
  setZoomBarVisible(true);
  putTab({ id: 't6', label: 'p.png', revision: 0, panes: [image('p.png')] });
  const host = document.getElementById('root');
  host.innerHTML = '<div id="editor"></div><div id="viz"></div>';
  const editorRoot = createRoot(host.querySelector('#editor'));
  const vizRoot = createRoot(host.querySelector('#viz'));
  await act(async () => {
    editorRoot.render(
      React.createElement(ZoomFrame, { ready: true, scrollerClassName: 'editor-pane-preview' }, () =>
        React.createElement('div', null, 'preview')
      )
    );
    vizRoot.render(React.createElement(VisualizePane, { sessionId: 's1', active: true, onClose() {} }));
  });
  const editorPercent = () => host.querySelector('#editor .browser-zoom-percent span')?.textContent;
  const vizPercent = () => host.querySelector('#viz .browser-zoom-percent span')?.textContent;
  const hover = (element, over) =>
    act(async () => {
      element.dispatchEvent(new window.Event(over ? 'pointerenter' : 'pointerleave'));
    });
  const keyEvent = () =>
    new window.KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true });
  const press = (event = keyEvent()) => act(async () => host.ownerDocument.dispatchEvent(event));
  const panel = host.querySelector('#viz .visualize-pane');
  const frame = host.querySelector('#editor .editor-zoom-frame');
  try {
    assert.equal(editorPercent(), '100%');
    assert.equal(vizPercent(), '100%');

    // Focus in the editor preview, pointer over Visualize: the editor alone zooms.
    await act(async () => frame.focus());
    assert.equal(document.activeElement, frame);
    await hover(panel, true);
    await press();
    assert.equal(editorPercent(), '125%');
    assert.equal(vizPercent(), '100%');

    // Focus in Visualize, pointer back over the editor: Visualize alone zooms.
    const tab = panel.querySelector('.visualize-pane-content');
    tab.setAttribute('tabindex', '0');
    await act(async () => tab.focus());
    await hover(panel, false);
    await press();
    assert.equal(vizPercent(), '125%');
    assert.equal(editorPercent(), '125%');

    // No focus anywhere: hover decides.
    await act(async () => document.activeElement.blur());
    await hover(panel, true);
    await press();
    assert.equal(vizPercent(), '150%');
    assert.equal(editorPercent(), '125%');

    // A key someone already handled is left alone.
    const handled = keyEvent();
    handled.preventDefault();
    await press(handled);
    assert.equal(vizPercent(), '150%');
    assert.equal(editorPercent(), '125%');
  } finally {
    await act(async () => {
      editorRoot.unmount();
      vizRoot.unmount();
    });
    host.innerHTML = '';
  }
});

test('Ctrl+wheel scales by the wheel delta and keeps the point under the pointer fixed', async () => {
  const { wheelZoomScale, anchoredScroll } = await import('./zoom-range.ts');
  setZoomBarVisible(true);
  putTab({ id: 't7', label: 'p.png', revision: 0, panes: [image('p.png')] });
  const root = await mount();
  const content = document.querySelector('.visualize-pane-content');
  // jsdom has no layout: a 400×300 viewport at (100, 50) with a scrollable offset.
  const scroll = { left: 0, top: 0 };
  Object.defineProperties(content, {
    clientWidth: { value: 400, configurable: true },
    clientHeight: { value: 300, configurable: true },
    scrollLeft: { get: () => scroll.left, set: (value) => (scroll.left = value), configurable: true },
    scrollTop: { get: () => scroll.top, set: (value) => (scroll.top = value), configurable: true },
  });
  content.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300 });
  try {
    const wheel = new window.WheelEvent('wheel', {
      deltaY: -40,
      ctrlKey: true,
      clientX: 300,
      clientY: 150,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => content.dispatchEvent(wheel));
    // The editor's exponential step (not a 25% notch), rounded like its pill.
    const next = Math.round(wheelZoomScale(1, -40, 0, 300) * 100) / 100;
    assert.equal(next, 1.49);
    assert.equal(percent(), '149%');
    // The point 200px/100px into the viewport stays put: (scroll + p) * ratio - p.
    assert.ok(Math.abs(scroll.left - anchoredScroll(0, 200, next)) < 1e-9);
    assert.ok(Math.abs(scroll.top - anchoredScroll(0, 100, next)) < 1e-9);
    assert.ok(scroll.left > 0);

    // Keys anchor at the centre of the pane (the pointer is over it).
    await act(async () => document.querySelector('.visualize-pane').dispatchEvent(new window.Event('pointerenter')));
    await key('0');
    scroll.left = 0;
    scroll.top = 0;
    await key('=');
    assert.equal(percent(), '125%');
    assert.ok(Math.abs(scroll.left - anchoredScroll(0, 200, 1.25)) < 1e-9);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a PDF cannot zoom on its own: main reports Ctrl and the document frame yields the wheel', async () => {
  setZoomBarVisible(true);
  putTab({
    id: 't8',
    label: 'a.pdf',
    revision: 0,
    panes: [{ kind: 'pdf', label: 'a.pdf', target: 'a.pdf', url: 'http://127.0.0.1:1/tok/a.pdf' }],
  });
  const root = await mount();
  try {
    const panel = document.querySelector('.visualize-pane');
    assert.ok(panel.querySelector('iframe.visualize-document-frame'));
    assert.equal(panel.hasAttribute('data-zoom-modifier'), false);
    // Focus inside the viewer: main sees Ctrl go down and up.
    await act(async () => applyVisualizeEvent({ sessionId: '', zoomModifier: true }));
    assert.equal(panel.hasAttribute('data-zoom-modifier'), true);
    await act(async () => applyVisualizeEvent({ sessionId: '', zoomModifier: false }));
    assert.equal(panel.hasAttribute('data-zoom-modifier'), false);
    // The document's own key events keep it in step too.
    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }))
    );
    assert.equal(panel.hasAttribute('data-zoom-modifier'), true);
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', bubbles: true })));
    assert.equal(panel.hasAttribute('data-zoom-modifier'), false);
    // With Ctrl held the frame takes no pointer, so the wheel reaches the panel.
    assert.match(
      readFileSync(new URL('./visualize.css', import.meta.url), 'utf8'),
      /\.visualize-pane\[data-zoom-modifier\] \.visualize-document-frame\s*\{[^}]*pointer-events:\s*none/
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('the shared toggle reaches the browser pill and every panel at once', async () => {
  setZoomBarVisible(true);
  const { browserHeaderActions } = await import('./BrowserPane.lazy.tsx');
  const actions = browserHeaderActions({
    currentUrl: 'https://a.test/',
    viewportPresetId: 'responsive',
    selectViewportPreset() {},
    credentialSuggestions: [],
    credentialBusy: false,
    credentialStatus: 'idle',
    fillStoredCredential() {},
  });
  const item = actions.find((action) => action.id === 'zoom-bar');
  assert.equal(item.label, 'Zoom bar');
  assert.equal(item.checked, true);
  item.onSelect();
  assert.equal(readZoomBarVisible(), false);
  assert.equal(
    browserHeaderActions({
      currentUrl: '',
      viewportPresetId: 'responsive',
      selectViewportPreset() {},
      credentialSuggestions: [],
      credentialBusy: false,
      credentialStatus: 'idle',
      fillStoredCredential() {},
    }).find((action) => action.id === 'zoom-bar').checked,
    false
  );
  setZoomBarVisible(true);
  assert.equal(typeof BrowserZoomPill, 'function');
  restore();
});
