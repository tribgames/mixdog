import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// A controllable viewport: jsdom has no layout, so the preview scrollers report
// `viewportSize` and a "resize" is a manual ResizeObserver tick.
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this);
  }
};
let viewportSize = { width: 0, height: 0 };
for (const [prop, key] of [
  ['clientWidth', 'width'],
  ['clientHeight', 'height'],
]) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return /\beditor-pane-(document|preview)\b/.test(this.className) ? viewportSize[key] : 0;
    },
  });
}
const setViewport = (width, height = 600) => {
  viewportSize = { width, height };
};
const resizeTo = async (width, height = 600) => {
  setViewport(width, height);
  await act(async () => {
    for (const observer of observers) observer.callback([]);
  });
};

const { EditorPanePreviewSurface } = await import('./editor-pane-surfaces.tsx');
const { EditorPaneDocumentSurface } = await import('./editor-pane-document.tsx');
const { EditorSvgPreview } = await import('./EditorTextViews.tsx');
const { BrowserZoomPill } = await import('./BrowserZoomPill.tsx');
const zoomMath = await import('./zoom-range.ts');
const { forgetZoomMemory } = await import('./ZoomFrame.tsx');

async function render(element) {
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root };
}

const noop = () => {};
const surface = (kind, loaded, extra = {}) =>
  React.createElement(EditorPanePreviewSurface, {
    breadcrumbs: null,
    preview: { kind, url: `file:///x.${kind}` },
    relPath: `x.${kind}`,
    loaded,
    error: '',
    mediaForeground: true,
    mediaRef: { current: null },
    onComplete: noop,
    onFail: noop,
    onOpen: noop,
    ...extra,
  });
const documentSurface = (pages) =>
  React.createElement(EditorPaneDocumentSurface, {
    breadcrumbs: null,
    preview: { pageCount: 1, pages },
    error: '',
    loading: false,
    onRequestPages: noop,
    onFirstPageLoad: noop,
  });
const page = { page: 1, mime: 'image/png', base64: 'AA==', width: 10, height: 10 };
const pillOf = (host) => host.querySelector('.browser-zoom-pill');
const percentOf = (host) => host.querySelector('.browser-zoom-percent span').textContent;
const click = (host, selector) =>
  act(async () => host.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const clickLabel = (host, label) => click(host, `[aria-label="${label}"]`);
const menuItems = (host) =>
  [...host.querySelectorAll('[role="menuitemradio"]')].map((item) => [
    item.textContent,
    item.getAttribute('aria-checked'),
  ]);
const pointer = (type, init = {}) => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
};
const documentWith = (extra = {}) =>
  React.createElement(EditorPaneDocumentSurface, {
    breadcrumbs: null,
    preview: { pageCount: 1, pages: [{ ...page, width: 900, height: 1200 }] },
    error: '',
    loading: false,
    onRequestPages: noop,
    onFirstPageLoad: noop,
    ...extra,
  });
const pageWidthOf = (host) => host.querySelector('.editor-pane-document-page').style.width;

test('image, PDF, SVG and document previews show the pill only once loaded', async () => {
  for (const kind of ['image']) {
    const { host, root } = await render(surface(kind, false));
    try {
      assert.equal(pillOf(host), null, `${kind} before load`);
      await act(async () => root.render(surface(kind, true)));
      assert.ok(pillOf(host), `${kind} after load`);
    } finally {
      await act(async () => root.unmount());
    }
  }
  const svg = await render(
    React.createElement(EditorSvgPreview, {
      url: 'data:image/svg+xml,x',
      name: 'a.svg',
      error: '',
      onComplete: noop,
      onFail: noop,
    })
  );
  try {
    assert.equal(pillOf(svg.host), null);
    await act(async () => svg.host.querySelector('img').dispatchEvent(new window.Event('load')));
    assert.ok(pillOf(svg.host));
  } finally {
    await act(async () => svg.root.unmount());
  }
  const empty = await render(documentSurface([]));
  const full = await render(documentSurface([page]));
  try {
    assert.equal(pillOf(empty.host), null);
    assert.ok(pillOf(full.host));
  } finally {
    await act(async () => empty.root.unmount());
    await act(async () => full.root.unmount());
  }
});

test('document/PDF pages: one scroller, no iframe, reserved heights, pill present', async () => {
  const { host, root } = await render(
    React.createElement(EditorPaneDocumentSurface, {
      breadcrumbs: null,
      preview: { pageCount: 3, pages: [{ ...page, width: 100, height: 200 }] },
      error: '',
      loading: false,
      onRequestPages: noop,
      onFirstPageLoad: noop,
    })
  );
  try {
    assert.equal(host.querySelector('iframe'), null);
    assert.equal(host.querySelectorAll('.editor-pane-document').length, 1, 'a single scroller');
    assert.equal(
      host.querySelectorAll('.editor-pane-document .editor-pane-document, .editor-pane-document [style*="overflow"]')
        .length,
      0
    );
    assert.ok(pillOf(host));
    const slots = [...host.querySelectorAll('.editor-pane-document-page')];
    assert.equal(slots.length, 3);
    // Unloaded pages 2 and 3 reserve the first page's 1:2 ratio.
    assert.equal(slots[1].style.aspectRatio, '0.5');
    assert.equal(slots[2].style.aspectRatio, '0.5');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the native preview surface never renders an iframe, even for a pdf kind', async () => {
  const { host, root } = await render(surface('pdf', true));
  try {
    assert.equal(host.querySelector('iframe'), null);
    assert.equal(pillOf(host), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test('pure helpers: fit, wheel, cursor anchor, snapping and page aspect', async () => {
  const {
    fitWidthScale,
    scaledSize,
    normalizedWheelDelta,
    wheelZoomScale,
    anchoredScroll,
    stepSnapped,
    clickZoomTarget,
  } = zoomMath;
  const { documentPageAspect } = await import('./editor-document-model.ts');
  assert.equal(fitWidthScale(1000, 2000), 0.5);
  assert.equal(fitWidthScale(1000, 2000, 100), 0.45, 'inset is taken off the viewport');
  assert.equal(fitWidthScale(3000, 2000), 1, 'never upscales');
  assert.equal(fitWidthScale(0, 2000), 1);
  assert.equal(fitWidthScale(500, undefined), 1);
  assert.equal(scaledSize(900, 500 / 900), 500, 'float error does not cost a pixel');
  assert.equal(scaledSize(901, 0.5), 450);
  assert.equal(normalizedWheelDelta(500, 0, 600), 40, 'clamped');
  assert.equal(normalizedWheelDelta(-500, 0, 600), -40);
  assert.equal(normalizedWheelDelta(1, 1, 600), 16, 'lines → px');
  assert.equal(normalizedWheelDelta(1, 2, 30), 30, 'pages → viewport height');
  assert.equal(wheelZoomScale(1, -20, 0, 600), Math.exp(0.2));
  assert.equal(wheelZoomScale(2, 0, 0, 600), 2);
  // The content point under the cursor stays under it: before, (100 + 50) px
  // into the content; after doubling it is at 300 px, so scroll 250.
  assert.equal(anchoredScroll(100, 50, 2), 250);
  assert.equal(anchoredScroll(0, 50, 1), 0);
  // With a 12px content origin, and one that moved to 0 once it fills the viewport.
  assert.equal(anchoredScroll(0, 50, 2, 12, 12), 38);
  assert.equal(anchoredScroll(0, 200, 2, 100, 0), 0);
  assert.equal(stepSnapped(0.5556, 1, zoomMath.PREVIEW_ZOOM_RANGE), 0.75);
  assert.equal(stepSnapped(0.5556, -1, zoomMath.PREVIEW_ZOOM_RANGE), 0.5);
  assert.equal(stepSnapped(1, -1, zoomMath.PREVIEW_ZOOM_RANGE), 0.75);
  assert.equal(stepSnapped(0.25, -1, zoomMath.PREVIEW_ZOOM_RANGE), 0.25, 'clamped at 25%');
  assert.equal(stepSnapped(4, 1, zoomMath.PREVIEW_ZOOM_RANGE), 4, 'clamped at 400%');
  assert.deepEqual(clickZoomTarget(true, 0.5), { mode: 'fixed', scale: 1 });
  assert.deepEqual(clickZoomTarget(true, 1), { mode: 'fixed', scale: 2 });
  assert.deepEqual(clickZoomTarget(false, 0.5), { mode: 'fit' });
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: pins the module's intentional A4 ratio, not Math.SQRT1_2.
  assert.equal(documentPageAspect([], 1), 1 / 1.414);
  assert.equal(documentPageAspect([{ page: 1, width: 10, height: 20 }], 5), 0.5);
});

test('preview scrollers use the app scrollbar rules and stay single', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop/26-editor.css', import.meta.url), 'utf8');
  const base = readFileSync(new URL('./desktop/02-base.css', import.meta.url), 'utf8');
  assert.match(
    base,
    /\*::-webkit-scrollbar\s*\{[^}]*--mx-scrollbar-size/,
    'shared scrollbar rule covers every scroller'
  );
  for (const selector of ['.editor-pane-document', '.editor-pane-preview']) {
    const block = css.match(new RegExp(`\\n${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`))[0];
    assert.match(block, /overscroll-behavior:\s*contain/, selector);
    assert.match(block, /box-sizing:\s*border-box/, selector);
  }
  assert.doesNotMatch(css, /editor-pane-preview iframe/);
  for (const file of ['./ZoomFrame.tsx', './zoom-frame-hooks.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /onWheel[\s\S]*scrollTop\s*\+=/, `no custom wheel scrolling in ${file}`);
  }
});

test('image fit contains the whole image, centred and never upscaled; documents stay fit-width', async () => {
  const { fitContainScale } = zoomMath;
  assert.equal(fitContainScale(1000, 600, 2000, 1000), 0.5, 'width limits');
  assert.equal(fitContainScale(1000, 600, 1000, 2000), 0.3, 'height limits');
  assert.equal(fitContainScale(1000, 600, 500, 300), 1, 'never upscales');
  assert.equal(fitContainScale(0, 600, 2000, 1000), 1);
  assert.equal(fitContainScale(1000, 600, undefined, undefined), 1);

  forgetZoomMemory();
  setViewport(1000, 600);
  const { host, root } = await render(surface('image', true));
  try {
    const img = host.querySelector('img');
    Object.defineProperty(img, 'naturalWidth', { value: 1000 });
    Object.defineProperty(img, 'naturalHeight', { value: 2000 });
    await act(async () => img.dispatchEvent(new window.Event('load')));
    assert.equal(percentOf(host), '30%');
    assert.equal(img.style.width, '300px');
    assert.equal(img.style.height, '600px', 'the full height shows: no vertical scrolling at fit');
    await resizeTo(1000, 1200);
    assert.equal(percentOf(host), '60%', 'a taller panel refits');
    assert.equal(img.style.height, '1200px');
  } finally {
    await act(async () => root.unmount());
  }
  // A document page is as tall as it is: fit follows the width only.
  setViewport(524, 100);
  const doc = await render(documentWith());
  try {
    assert.equal(pageWidthOf(doc.host), '500px');
  } finally {
    await act(async () => doc.root.unmount());
  }
});

test('a failed page shows an inline Retry for its batch; the loaded pages stay', async () => {
  setViewport(524);
  const requests = [];
  const { host, root } = await render(
    React.createElement(EditorPaneDocumentSurface, {
      breadcrumbs: null,
      preview: { pageCount: 3, pages: [{ ...page, width: 900, height: 1200 }] },
      error: '',
      loading: false,
      pageErrors: {
        2: { message: 'rasterizer crashed', batch: [2, 3] },
        3: { message: 'rasterizer crashed', batch: [2, 3] },
      },
      onRequestPages: (pages, width) => requests.push([pages, width]),
      onFirstPageLoad: noop,
    })
  );
  try {
    const slots = [...host.querySelectorAll('.editor-pane-document-page')];
    assert.ok(slots[0].querySelector('img'), 'page 1 stays');
    assert.match(slots[1].querySelector('[role="alert"]').textContent, /rasterizer crashed/);
    assert.deepEqual(requests, [], 'a failed batch is not re-requested on its own');
    await act(async () =>
      slots[1].querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    );
    assert.deepEqual(requests, [[[2, 3], 1200]]);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a failed higher-resolution request keeps the image, shows an overlay Retry and re-requests', async () => {
  forgetZoomMemory();
  setViewport(524);
  const requests = [];
  const { host, root } = await render(
    documentWith({
      pageErrors: { 1: { message: 'zoom render failed', batch: [1] } },
      onRequestPages: (pages, width) => requests.push([pages, width]),
    })
  );
  try {
    const slot = host.querySelector('.editor-pane-document-page');
    assert.ok(slot.querySelector('img'), 'the retained image stays');
    assert.match(slot.querySelector('[role="alert"]').textContent, /zoom render failed/);
    assert.deepEqual(requests, [], 'no automatic re-request while failed');
    await act(async () =>
      slot.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    );
    assert.deepEqual(requests, [[[1], 1200]]);
  } finally {
    await act(async () => root.unmount());
  }
});

test('pressing a button inside the scroller does not take pointer capture or pan', async () => {
  forgetZoomMemory();
  setViewport(524);
  const { host, root } = await render(documentWith({ pageErrors: { 1: { message: 'x', batch: [1] } } }));
  try {
    const scroller = host.querySelector('.editor-pane-document');
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 2000 });
    let captured = 0;
    scroller.setPointerCapture = () => {
      captured += 1;
    };
    const button = host.querySelector('.editor-pane-document-page-error button');
    await act(async () => button.dispatchEvent(pointer('pointerdown', { clientX: 5, clientY: 5 })));
    assert.equal(captured, 0);
    await act(async () => host.querySelector('img').dispatchEvent(pointer('pointerdown', { clientX: 5, clientY: 5 })));
    assert.equal(captured, 1, 'panning from the page itself still captures');
  } finally {
    await act(async () => root.unmount());
  }
});

test('audio and video previews get no pill', async () => {
  for (const kind of ['audio', 'video']) {
    const { host, root } = await render(surface(kind, true));
    try {
      assert.equal(pillOf(host), null, kind);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('fit refits when the viewport resizes, never upscales; fixed keeps its scale', async () => {
  forgetZoomMemory();
  setViewport(524);
  const { host, root } = await render(documentWith());
  try {
    assert.equal(pageWidthOf(host), '500px', 'fit = viewport minus the 24px inset');
    assert.equal(percentOf(host), '56%', 'the live percentage shows in fit mode');
    await resizeTo(324);
    assert.equal(pageWidthOf(host), '300px');
    assert.equal(percentOf(host), '33%');
    await resizeTo(2000);
    assert.equal(pageWidthOf(host), '900px', 'smaller content stays at 100%');
    assert.equal(percentOf(host), '100%');

    await resizeTo(524);
    await clickLabel(host, 'Zoom out'); // fit 55.6% → 50%, now a fixed pick
    assert.equal(percentOf(host), '50%');
    assert.equal(pageWidthOf(host), '450px');
    await resizeTo(2000);
    assert.equal(percentOf(host), '50%', 'fixed keeps its scale across a resize');
    assert.equal(pageWidthOf(host), '450px');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the percent menu: fit width first, presets after, checked state follows the mode', async () => {
  forgetZoomMemory();
  setViewport(524);
  const { host, root } = await render(documentWith());
  try {
    await click(host, '.browser-zoom-percent');
    assert.deepEqual(menuItems(host), [
      ['Fit width', 'true'],
      ['50%', 'false'],
      ['100%', 'false'],
      ['150%', 'false'],
      ['200%', 'false'],
    ]);
    const items = () => [...host.querySelectorAll('[role="menuitemradio"]')];
    await act(async () => items()[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(host.querySelector('[role="menu"]'), null, 'picking closes the menu');
    assert.equal(percentOf(host), '150%');
    assert.equal(pageWidthOf(host), '1350px');
    await click(host, '.browser-zoom-percent');
    assert.deepEqual(menuItems(host)[0], ['Fit width', 'false']);
    assert.deepEqual(menuItems(host)[3], ['150%', 'true']);
    await act(async () => items()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(percentOf(host), '56%');
  } finally {
    await act(async () => root.unmount());
  }
});

test('keyboard steps 25% and Ctrl+0 returns to fit; Ctrl+wheel zooms exponentially', async () => {
  forgetZoomMemory();
  setViewport(524);
  const { host, root } = await render(documentWith());
  try {
    host.querySelector('.editor-zoom-frame').focus();
    const key = (k) =>
      act(async () =>
        document.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true })
        )
      );
    await key('=');
    assert.equal(percentOf(host), '75%');
    await key('=');
    assert.equal(percentOf(host), '100%');
    await key('-');
    await key('-');
    assert.equal(percentOf(host), '50%');
    await key('0');
    assert.equal(percentOf(host), '56%');
    assert.equal(
      host.querySelector('.editor-zoom-frame').querySelector('.browser-zoom-pill').classList.contains('is-hidden'),
      false,
      'keyboard zoom reveals the pill'
    );

    const scroller = host.querySelector('.editor-pane-document');
    const wheel = new window.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(wheel));
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(
      percentOf(host),
      `${Math.round(zoomMath.clampZoom(0.5556 * Math.exp(0.4), zoomMath.PREVIEW_ZOOM_RANGE) * 100)}%`
    );
    const plain = new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(plain));
    assert.equal(plain.defaultPrevented, false, 'a plain wheel scrolls natively');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the pill is hidden until the pointer nears the bottom, then hides 0.4s after leaving', async (t) => {
  forgetZoomMemory();
  setViewport(524);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { host, root } = await render(documentWith());
  try {
    const hidden = () => host.querySelector('.browser-zoom-pill').classList.contains('is-hidden');
    const frame = host.querySelector('.editor-zoom-frame');
    assert.equal(hidden(), true, 'hidden by default');
    // jsdom boxes are all zero: y = 0 is inside the bottom 72px, y = -200 is far above it.
    await act(async () => frame.dispatchEvent(pointer('pointermove', { clientY: 0 })));
    assert.equal(hidden(), false);
    await act(async () => frame.dispatchEvent(pointer('pointermove', { clientY: -200 })));
    await act(async () => mock.timers.tick(399));
    assert.equal(hidden(), false, 'still shown inside the 0.4s grace');
    await act(async () => mock.timers.tick(2));
    assert.equal(hidden(), true);

    const scroller = host.querySelector('.editor-pane-document');
    await act(async () =>
      scroller.dispatchEvent(
        new window.WheelEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true })
      )
    );
    assert.equal(hidden(), false, 'Ctrl+wheel reveals it');
    await act(async () => mock.timers.tick(401));
    assert.equal(hidden(), true);

    // Hover keeps it up; leaving starts the countdown.
    await act(async () => frame.dispatchEvent(pointer('pointermove', { clientY: 0 })));
    const pill = host.querySelector('.browser-zoom-pill');
    await act(async () => pill.dispatchEvent(pointer('pointerover')));
    await act(async () => frame.dispatchEvent(pointer('pointermove', { clientY: -200 })));
    await act(async () => mock.timers.tick(1000));
    assert.equal(hidden(), false, 'a hovered pill stays visible');
  } finally {
    await act(async () => root.unmount());
  }
});

test('an image fits the width without upscaling and a click toggles fit ↔ 100%', async () => {
  forgetZoomMemory();
  setViewport(1000);
  const { host, root } = await render(surface('image', true));
  try {
    const img = host.querySelector('img');
    Object.defineProperty(img, 'naturalWidth', { value: 2000 });
    Object.defineProperty(img, 'naturalHeight', { value: 1000 });
    await act(async () => img.dispatchEvent(new window.Event('load')));
    assert.equal(percentOf(host), '50%');
    assert.equal(img.style.width, '1000px');
    assert.equal(host.querySelector('.editor-pane-preview').getAttribute('data-zoom-cursor'), 'in');

    const press = (x = 10, y = 10) =>
      act(async () => img.dispatchEvent(pointer('pointerdown', { clientX: x, clientY: y })));
    const release = (x = 10, y = 10) =>
      act(async () => img.dispatchEvent(pointer('pointerup', { clientX: x, clientY: y })));
    await press();
    await release();
    assert.equal(percentOf(host), '100%');
    assert.equal(img.style.width, '2000px');
    assert.equal(host.querySelector('.editor-pane-preview').getAttribute('data-zoom-cursor'), 'out');
    await press();
    await act(async () => img.dispatchEvent(pointer('pointermove', { clientX: 60, clientY: 10 })));
    await release(60, 10);
    assert.equal(percentOf(host), '100%', 'a drag does not toggle');
    await press();
    await release();
    assert.equal(percentOf(host), '50%', 'back to fit');

    // 100% already is fit: the click goes to 200%, and ≥300% renders pixelated.
    await resizeTo(5000, 5000);
    assert.equal(percentOf(host), '100%');
    await press();
    await release();
    assert.equal(percentOf(host), '200%');
    assert.equal(img.style.imageRendering, '');
    const key = (k) =>
      act(async () =>
        document.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true })
        )
      );
    host.querySelector('.editor-zoom-frame').focus();
    await key('=');
    await key('=');
    await key('=');
    assert.equal(img.style.imageRendering, '', '275% is still smooth');
    await key('=');
    assert.equal(percentOf(host), '300%');
    assert.equal(img.style.imageRendering, 'pixelated');
  } finally {
    await act(async () => root.unmount());
  }
});

test('zoom resets for another file and is remembered per file', async () => {
  forgetZoomMemory();
  setViewport(524);
  const first = surface('image', true, { zoomKey: 'tab|a' });
  const second = surface('image', true, {
    zoomKey: 'tab|b',
    preview: { kind: 'image', url: 'file:///y.image' },
    relPath: 'y.image',
  });
  const { host, root } = await render(first);
  try {
    await clickLabel(host, 'Zoom in');
    assert.equal(percentOf(host), '125%');
    await act(async () => root.render(second));
    assert.equal(percentOf(host), '100%', 'another file starts at fit');
    await act(async () => root.render(first));
    assert.equal(percentOf(host), '125%', 'the first file keeps its pick while it stays open');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the browser pill keeps its range, steps and always-visible state in the new look', async () => {
  const changes = [];
  const { host, root } = await render(
    React.createElement(BrowserZoomPill, { level: 1, onChange: (value) => changes.push(value) })
  );
  try {
    assert.equal(host.querySelector('input[type="range"]'), null, 'no slider any more');
    assert.equal(host.querySelector('.browser-zoom-pill').classList.contains('is-hidden'), false);
    assert.equal(percentOf(host), '100%');
    await clickLabel(host, 'Zoom in');
    await clickLabel(host, 'Zoom out');
    assert.deepEqual(changes, [1.1, 0.9]);
    await click(host, '.browser-zoom-percent');
    assert.deepEqual(menuItems(host), [
      ['Zoom to 100%', 'true'],
      ['50%', 'false'],
      ['75%', 'false'],
      ['125%', 'false'],
      ['150%', 'false'],
      ['200%', 'false'],
    ]);
    await act(async () =>
      host
        .querySelectorAll('[role="menuitemradio"]')[4]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    );
    assert.equal(changes.at(-1), 1.5);
  } finally {
    await act(async () => root.unmount());
  }
});

test('browser pill disables its buttons at the 50%–200% limits', async () => {
  const low = await render(React.createElement(BrowserZoomPill, { level: 0.5, onChange: noop }));
  const high = await render(React.createElement(BrowserZoomPill, { level: 2, onChange: noop }));
  try {
    assert.equal(low.host.querySelector('[aria-label="Zoom out"]').disabled, true);
    assert.equal(high.host.querySelector('[aria-label="Zoom in"]').disabled, true);
  } finally {
    await act(async () => low.root.unmount());
    await act(async () => high.root.unmount());
  }
});
