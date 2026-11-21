import assert from 'node:assert/strict';
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

const { VisualizePane, visualizePaneTitle, visualizeKeptTabs, VISUALIZE_KEPT_TABS } = await import(
  './VisualizePane.tsx'
);
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

async function withZoomImagePane(run) {
  setZoomBarVisible(true);
  putTab({ id: 't3', label: 'p.png', revision: 0, panes: [image('p.png')] });
  const root = await mount();
  try {
    await run();
  } finally {
    setZoomBarVisible(true);
    await act(async () => root.unmount());
  }
}

test('the Visualize pill scales the content; an image layer grows with the scale', async () => {
  await withZoomImagePane(async () => {
    assert.equal(percent(), '100%');
    assert.equal(layer().style.width, '');
    await click(document.querySelector('[aria-label="Zoom in"]'));
    assert.equal(percent(), '125%');
    assert.equal(layer().style.width, '125%');
    assert.equal(layer().style.height, '125%');
    assert.equal(layer().style.transform, '');

    await click(document.querySelector('.browser-zoom-percent'));
    const entries = [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);
    // 100% is the fit itself, so it is not listed a second time.
    assert.deepEqual(entries, ['Fit to window', '50%', '150%', '200%']);
    await click(document.querySelectorAll('[role="menuitemradio"]')[3]);
    assert.equal(percent(), '200%');
  });
});

test('Ctrl+- steps the Visualize zoom down and Ctrl+0 resets it', async () => {
  await withZoomImagePane(async () => {
    await act(async () => document.querySelector('.visualize-pane').dispatchEvent(new window.Event('pointerenter')));
    await key('=');
    await key('=');
    assert.equal(percent(), '150%');
    await key('-');
    assert.equal(percent(), '125%');
    await key('0');
    assert.equal(percent(), '100%');
    assert.equal(layer().style.width, '');
  });
});

test('Ctrl+wheel over the Visualize pane zooms it', async () => {
  await withZoomImagePane(async () => {
    const wheel = new window.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.querySelector('.visualize-pane').dispatchEvent(wheel));
    assert.equal(wheel.defaultPrevented, true);
    assert.ok(Number.parseInt(percent(), 10) > 100);
  });
});

test('a reload of the same tab’s files keeps the zoom; another tab starts again at 100%', async () => {
  await withZoomImagePane(async () => {
    await click(document.querySelector('[aria-label="Zoom in"]'));
    const zoomed = percent();
    assert.notEqual(zoomed, '100%');
    putTab({ id: 't3', label: 'p.png', revision: 1, panes: [image('p.png')] });
    await act(async () => {});
    assert.equal(percent(), zoomed);
    putTab({ id: 't4', label: 'q.png', revision: 0, panes: [image('q.png')] });
    await act(async () => {});
    assert.equal(percent(), '100%');
  });
});

test('the ⋯ zoom bar toggle hides the pill and the zoom keys keep working', async () => {
  await withZoomImagePane(async () => {
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
  });
});

test('pages and documents zoom in at the pane’s layout width and zoom out laid out at 1/scale', async () => {
  const { visualizeZoomStyle } = await import('./visualize-zoom.ts');
  assert.equal(visualizeZoomStyle(1, 'html'), undefined);
  const placed = { position: 'absolute', top: 0, left: 0 };
  // In: the layout width stays the pane's (no reflow), the drawing grows and scrolls sideways.
  assert.deepEqual(visualizeZoomStyle(2, 'html'), { width: '100%', height: '50%', transform: 'scale(2)' });
  assert.deepEqual(visualizeZoomStyle(0.5, 'pdf'), {
    ...placed,
    width: '200%',
    height: '200%',
    transform: 'scale(0.5)',
  });
  // An image also scales its own drawn size, so one smaller than the pane zooms too.
  assert.deepEqual(visualizeZoomStyle(1.5, 'image'), {
    width: '150%',
    height: '150%',
    margin: 'auto',
    '--visualize-zoom': 1.5,
  });
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

async function withZoomTargets(run) {
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
  const hover = (element, over) =>
    act(async () => {
      element.dispatchEvent(new window.Event(over ? 'pointerenter' : 'pointerleave'));
    });
  const keyEvent = () =>
    new window.KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true });
  try {
    await run({
      editorPercent: () => host.querySelector('#editor .browser-zoom-percent span')?.textContent,
      vizPercent: () => host.querySelector('#viz .browser-zoom-percent span')?.textContent,
      hover,
      keyEvent,
      press: (event = keyEvent()) => act(async () => host.ownerDocument.dispatchEvent(event)),
      panel: host.querySelector('#viz .visualize-pane'),
      frame: host.querySelector('#editor .editor-zoom-frame'),
    });
  } finally {
    await act(async () => {
      editorRoot.unmount();
      vizRoot.unmount();
    });
    host.innerHTML = '';
  }
}

test('a zoom key goes to the focused editor preview, not to a hovered Visualize panel', async () => {
  await withZoomTargets(async ({ editorPercent, vizPercent, hover, press, panel, frame }) => {
    assert.equal(editorPercent(), '100%');
    assert.equal(vizPercent(), '100%');
    await act(async () => frame.focus());
    assert.equal(document.activeElement, frame);
    await hover(panel, true);
    await press();
    assert.equal(editorPercent(), '125%');
    assert.equal(vizPercent(), '100%');
  });
});

test('a zoom key goes to the focused Visualize pane, not to a hovered editor preview', async () => {
  await withZoomTargets(async ({ editorPercent, vizPercent, hover, press, panel }) => {
    const tab = panel.querySelector('.visualize-pane-content');
    tab.setAttribute('tabindex', '0');
    await act(async () => tab.focus());
    await hover(panel, false);
    await press();
    assert.equal(vizPercent(), '125%');
    assert.equal(editorPercent(), '100%');
  });
});

test('with no focus anywhere, hover decides which panel a zoom key goes to', async () => {
  await withZoomTargets(async ({ editorPercent, vizPercent, hover, press, panel }) => {
    await act(async () => document.activeElement.blur());
    await hover(panel, true);
    await press();
    assert.equal(vizPercent(), '125%');
    assert.equal(editorPercent(), '100%');
  });
});

test('a zoom key someone already handled is left alone', async () => {
  await withZoomTargets(async ({ editorPercent, vizPercent, hover, press, keyEvent, panel }) => {
    await act(async () => document.activeElement.blur());
    await hover(panel, true);
    const handled = keyEvent();
    handled.preventDefault();
    await press(handled);
    assert.equal(vizPercent(), '100%');
    assert.equal(editorPercent(), '100%');
  });
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
  } finally {
    await act(async () => root.unmount());
  }
});

test('the panel holds no blocking wheel listener while the pointer is over a pane frame', async () => {
  setZoomBarVisible(true);
  putTab({
    id: 't9',
    label: 'page.html',
    revision: 0,
    panes: [{ kind: 'html', label: 'page.html', target: 'page.html', url: 'http://127.0.0.1:1/tok/page.html' }],
  });
  const root = await mount();
  const panel = document.querySelector('.visualize-pane');
  const frame = panel.querySelector('.visualize-pane-content iframe');
  const content = panel.querySelector('.visualize-pane-content');
  const over = (element) => act(async () => element.dispatchEvent(new window.Event('pointerover', { bubbles: true })));
  // Whether Ctrl+wheel on the panel's own content is still taken (zoomed).
  const zoomWheel = async () => {
    const wheel = new window.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => content.dispatchEvent(wheel));
    return wheel.defaultPrevented;
  };
  try {
    assert.equal(await zoomWheel(), true);
    // Over the page frame the wheel is the frame's own: nothing holds it.
    await over(frame);
    assert.equal(await zoomWheel(), false);
    // Ctrl/Cmd held (a document frame yields the wheel then): taken again.
    await act(async () => applyVisualizeEvent({ sessionId: '', zoomModifier: true }));
    assert.equal(await zoomWheel(), true);
    await act(async () => applyVisualizeEvent({ sessionId: '', zoomModifier: false }));
    assert.equal(await zoomWheel(), false);
    // Back over the panel's own content, Ctrl+wheel zooms there.
    await over(content);
    assert.equal(await zoomWheel(), true);
  } finally {
    await act(async () => root.unmount());
  }
});

test('every split cell has an enlarge button that shows it alone; it is a phone-only, 44px silver target', async () => {
  putTab({
    id: 't9',
    label: 'split',
    revision: 0,
    panes: [
      { kind: 'html', label: 'a.html', target: 'a.html', url: 'http://127.0.0.1:1/a.html' },
      { kind: 'video', label: 'b.mp4', target: 'b.mp4', url: 'http://127.0.0.1:1/b.mp4' },
      image('c.png'),
    ],
  });
  const root = await mount();
  try {
    const buttons = document.querySelectorAll('.visualize-pane-cell > .visualize-pane-enlarge');
    assert.equal(buttons.length, 3);
    await act(async () => buttons[1].click());
    assert.ok(document.querySelector('.visualize-body.is-solo'));
    assert.ok(document.querySelector('.visualize-pane-cell.is-solo[data-visualize-pane="1"]'));
    assert.equal(document.querySelectorAll('.visualize-pane-enlarge').length, 0, 'alone, no enlarge button');
    assert.ok(document.querySelector('.browser-zoom-pill'), 'the pill steps between cells and goes back');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a split tab leads the zoom pill with its view switch: side by side, then one number per pane', async () => {
  putTab({
    id: 't10',
    label: 'split',
    revision: 0,
    panes: [image('a.png'), image('b.png'), image('c.png')],
  });
  const root = await mount();
  const picks = () => [...document.querySelectorAll('.browser-zoom-pill .visualize-view-pick')];
  const pressed = () => picks().map((button) => button.getAttribute('aria-pressed'));
  try {
    assert.deepEqual(
      picks().map((button) => button.textContent),
      ['', '1', '2', '3']
    );
    assert.deepEqual(pressed(), ['true', 'false', 'false', 'false'], 'the split reads pressed');
    assert.equal(picks()[2].dataset.tooltip, '2 · b.png');
    await act(async () => picks()[2].click());
    assert.ok(document.querySelector('.visualize-pane-cell.is-solo[data-visualize-pane="1"]'));
    assert.deepEqual(pressed(), ['false', 'false', 'true', 'false']);
    await act(async () => picks()[0].click());
    assert.equal(document.querySelector('.visualize-body.is-solo'), null, 'side by side again');
    assert.deepEqual(pressed(), ['true', 'false', 'false', 'false']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a one-pane tab has no view switch', async () => {
  putTab({ id: 't11', label: 'one', revision: 0, panes: [image('a.png')] });
  const root = await mount();
  try {
    assert.equal(document.querySelectorAll('.visualize-view-pick').length, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

const htmlPane = { kind: 'html', label: 'a.html', target: 'a.html', url: 'http://127.0.0.1:1/tok/a.html' };
const frames = () => [...document.querySelectorAll('.visualize-pane-cell iframe')];
const fromFrame = (frame, data) =>
  act(async () =>
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { __mixdogVisualize: 1, ...data }, source: frame.contentWindow })
    )
  );
const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

test('a reload loads into a hidden second frame and swaps in once loaded, with no remount', async () => {
  putTab({ id: 'b1', label: 'a.html', revision: 0, panes: [htmlPane] });
  const root = await mount();
  try {
    const [shown] = frames();
    assert.ok(shown);
    const cell = document.querySelector('.visualize-pane-cell');
    // The file changed: same URL, newer revision.
    await act(async () => putTab({ id: 'b1', label: 'a.html', revision: 1, panes: [htmlPane] }));
    assert.equal(document.querySelector('.visualize-pane-cell'), cell, 'the cell survives the reload');
    assert.equal(frames().length, 2);
    assert.equal(frames()[0], shown, 'the old frame stays first and visible');
    assert.equal(shown.classList.contains('visualize-frame-pending'), false);
    const pending = frames()[1];
    assert.ok(pending.classList.contains('visualize-frame-pending'));
    assert.equal(pending.getAttribute('aria-hidden'), 'true');
    // Not swapped until the new document has loaded.
    await wait(20);
    assert.equal(frames().length, 2);
    await act(async () => pending.dispatchEvent(new window.Event('load')));
    assert.equal(frames().length, 1);
    assert.equal(frames()[0], pending, 'the loaded frame itself is shown (no second load)');
    assert.equal(pending.classList.contains('visualize-frame-pending'), false);
  } finally {
    await act(async () => root.unmount());
  }
});

test('revoking outside network replaces the shown page at once, with no buffered reload', async () => {
  putTab({ id: 'n1', label: 'a.html', revision: 0, networkAllowed: true, panes: [htmlPane] });
  const root = await mount();
  try {
    const [shown] = frames();
    await act(async () => putTab({ id: 'n1', label: 'a.html', revision: 1, panes: [htmlPane] }));
    assert.equal(shown.isConnected, false, 'the permissive page is gone before its replacement loads');
    assert.equal(frames().length, 1);
    assert.equal(frames()[0].classList.contains('visualize-frame-pending'), false);
  } finally {
    await act(async () => root.unmount());
  }
});

test('an agent reopening a kept tab (moved last in the state) leaves every kept page where it is', async () => {
  const pageTab = (id, revision = 0) => ({
    id,
    label: `${id}.html`,
    revision,
    panes: [{ ...htmlPane, target: `${id}.html`, url: `http://127.0.0.1:1/tok/${id}.html` }],
  });
  const show = (tabs, active) =>
    act(async () => applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs, active } }));
  await show([pageTab('k1'), pageTab('k2')], 'k1');
  const root = await mount();
  try {
    await show([pageTab('k1'), pageTab('k2')], 'k2');
    const bodies = [...document.querySelectorAll('.visualize-body')];
    assert.equal(bodies.length, 2, 'both tabs stay mounted');
    const moves = [];
    const observer = new window.MutationObserver((records) => moves.push(...records));
    observer.observe(document.querySelector('.visualize-bodies'), { childList: true });
    // The host's reopen of k1 moves it to the end of its tab list.
    await show([pageTab('k2'), pageTab('k1', 1)], 'k1');
    await act(async () => {});
    observer.disconnect();
    assert.deepEqual(moves, [], 'no body left or re-entered the DOM (its frames would reload)');
    assert.deepEqual([...document.querySelectorAll('.visualize-body')], bodies);
    assert.equal(document.querySelector('[data-visualize-body]'), bodies[0], 'k1 is the shown body');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a reload of the same page restores its scroll before the swap; another file just swaps', async () => {
  putTab({ id: 'b2', label: 'a.html', revision: 0, panes: [htmlPane] });
  const root = await mount();
  try {
    const [shown] = frames();
    await fromFrame(shown, { type: 'scrolled', x: 5, y: 320 });
    await act(async () => putTab({ id: 'b2', label: 'a.html', revision: 1, panes: [htmlPane] }));
    const pending = frames()[1];
    const posted = [];
    pending.contentWindow.postMessage = (message) => posted.push(message);
    await act(async () => pending.dispatchEvent(new window.Event('load')));
    assert.equal(frames().length, 2, 'waits for the new page script before showing');
    await fromFrame(pending, { type: 'ready' });
    assert.deepEqual(
      posted.map((message) => [message.type, message.x, message.y]),
      [['scroll-to', 5, 320]]
    );
    await wait(100);
    assert.deepEqual(frames(), [pending]);

    // Another file: nothing to restore, the frame swaps at once.
    const other = { ...htmlPane, target: 'b.html', label: 'b.html', url: 'http://127.0.0.1:1/tok/b.html' };
    await act(async () => putTab({ id: 'b2', label: 'a.html', revision: 2, panes: [other] }));
    const next = frames()[1];
    await act(async () => next.dispatchEvent(new window.Event('load')));
    assert.deepEqual(frames(), [next]);
  } finally {
    await act(async () => root.unmount());
  }
});

test('Elements and Comment bind to the swapped-in frame, even when its ready came before the swap', async () => {
  putTab({ id: 'b3', label: 'a.html', revision: 0, panes: [htmlPane] });
  const root = await mount();
  try {
    const [shown] = frames();
    const menu = await openMenu();
    await click(menu.find((item) => item.textContent.includes('Elements')));
    await fromFrame(shown, { type: 'scrolled', x: 0, y: 40 });
    await act(async () => putTab({ id: 'b3', label: 'a.html', revision: 1, panes: [htmlPane] }));
    const pending = frames()[1];
    const posted = [];
    pending.contentWindow.postMessage = (message) => posted.push(message.type);
    await act(async () => pending.dispatchEvent(new window.Event('load')));
    // The new page announces itself while it is still hidden (the scroll restore waits for it).
    await fromFrame(pending, { type: 'ready' });
    // The swap commits when this wait ends (updates inside act flush on exit), then Elements' own delay runs.
    await wait(150);
    await wait(500);
    assert.deepEqual(frames(), [pending]);
    assert.ok(posted.includes('scroll-to'));
    assert.ok(posted.includes('state'), `Comment's page state reaches the new page: ${posted}`);
    assert.ok(posted.includes('inspect'), `Elements reads the new page: ${posted}`);
    // A page that is shown first and announces itself afterwards is accepted as before.
    const other = { ...htmlPane, target: 'c.html', label: 'c.html', url: 'http://127.0.0.1:1/tok/c.html' };
    await act(async () => putTab({ id: 'b3', label: 'a.html', revision: 2, panes: [other] }));
    const next = frames()[1];
    const later = [];
    next.contentWindow.postMessage = (message) => later.push(message.type);
    await act(async () => next.dispatchEvent(new window.Event('load')));
    assert.deepEqual(frames(), [next]);
    await fromFrame(next, { type: 'ready' });
    await wait(600);
    assert.ok(later.includes('state') && later.includes('inspect'), `late ready: ${later}`);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the tab strip shares its width like the pane strip and the vertical wheel scrolls it', async () => {
  const tabs = ['커넥터', '대화방 머리 줄 시안', 'Mixy 그림·애니메이션'].map((label, index) => ({
    id: `w${index}`,
    label,
    revision: 0,
    panes: [image(`${index}.png`)],
  }));
  applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs, active: 'w2' } });
  const root = await mount();
  try {
    const strip = document.querySelector('.visualize-tabs');
    assert.equal(strip.querySelectorAll('.dock-header-chip').length, 3);
    assert.equal(
      strip.querySelector('[data-visualize-tab-id="w1"] .browser-tab-select').title.includes('대화방 머리 줄 시안'),
      true,
      'the full title is the tooltip'
    );
    const scrolled = [];
    strip.scrollBy = (options) => scrolled.push(options.left);
    const wheel = (init) =>
      act(async () => strip.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, ...init })));
    await wheel({ deltaY: 120 });
    await wheel({ deltaX: 40, deltaY: 5 });
    assert.deepEqual(scrolled, [120], 'only a vertical wheel is mapped; a sideways one scrolls natively');

    // Edge fades follow the scroll position, and drop once the run fits again.
    const fades = () => ['data-fade-start', 'data-fade-end'].filter((name) => strip.hasAttribute(name));
    const geometry = { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 };
    for (const key of Object.keys(geometry)) {
      Object.defineProperty(strip, key, { configurable: true, get: () => geometry[key] });
    }
    const scroll = (left) => {
      geometry.scrollLeft = left;
      return act(async () => strip.dispatchEvent(new window.Event('scroll')));
    };
    await scroll(0);
    assert.deepEqual(fades(), ['data-fade-end']);
    await scroll(150);
    assert.deepEqual(fades(), ['data-fade-start', 'data-fade-end']);
    await scroll(300);
    assert.deepEqual(fades(), ['data-fade-start']);
    geometry.scrollWidth = 300;
    await scroll(0);
    assert.deepEqual(fades(), [], 'a run that fits has no fade');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a two-finger pinch on the panel drives its zoom; one finger is left to scroll', async () => {
  setZoomBarVisible(true);
  putTab({ id: 'z1', label: 'one.png', revision: 0, panes: [image('one.png')] });
  const root = await mount();
  try {
    const panel = document.querySelector('.visualize-pane');
    const touch = (type, points) =>
      act(async () => {
        const event = new window.Event(type, { cancelable: true, bubbles: true });
        Object.defineProperty(event, 'touches', {
          value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
        });
        layer().dispatchEvent(event);
        return event;
      });
    assert.equal(percent(), '100%');
    await touch('touchstart', [[50, 50]]);
    await touch('touchmove', [[50, 120]]);
    assert.equal(percent(), '100%', 'one finger does not zoom');
    await touch('touchstart', [
      [100, 100],
      [200, 100],
    ]);
    await touch('touchmove', [
      [50, 100],
      [250, 100],
    ]);
    assert.equal(percent(), '200%', 'spreading to twice the distance doubles the scale');
    await touch('touchmove', [
      [100, 100],
      [200, 100],
    ]);
    assert.equal(percent(), '100%');
    assert.ok(panel);
  } finally {
    await act(async () => root.unmount());
  }
});

test('switching tabs keeps recent pages mounted (hidden), so switching back does not reload them', async () => {
  const page = (id) => ({
    id,
    label: `${id}.html`,
    revision: 0,
    panes: [{ kind: 'html', label: `${id}.html`, target: `${id}.html`, url: `http://127.0.0.1:1/tok/${id}.html` }],
  });
  const tabs = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map(page);
  const show = (active) =>
    act(async () => applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs, active } }));
  applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs, active: 'k1' } });
  const root = await mount();
  try {
    const frameOf = (id) => document.querySelector(`iframe[src$="/${id}.html"]`);
    const first = frameOf('k1');
    assert.ok(first);
    await show('k2');
    assert.equal(frameOf('k1'), first, 'the earlier page stays mounted');
    assert.equal(first.closest('.visualize-body').hasAttribute('data-kept'), true);
    assert.equal(document.querySelectorAll('[data-visualize-body]').length, 1, 'only the shown tab is the panel body');
    assert.equal(document.querySelector('[data-visualize-body]').dataset.visualizeTab, 'k2');
    await show('k1');
    assert.equal(frameOf('k1'), first, 'switching back shows the same frame, not a reload');
    assert.equal(first.closest('.visualize-body').hasAttribute('data-kept'), false);
    for (const id of ['k3', 'k4', 'k5', 'k6']) await show(id);
    assert.equal(frameOf('k1'), null, `at most ${VISUALIZE_KEPT_TABS} pages stay mounted`);
    assert.equal(document.querySelectorAll('.visualize-body').length, VISUALIZE_KEPT_TABS);
  } finally {
    await act(async () => root.unmount());
  }
  assert.deepEqual(visualizeKeptTabs('b', ['a', 'b', 'c', 'd', 'e']), ['b', 'a', 'c', 'd']);
});

test('a file-change update marks a background tab with a dot and does not switch to it', async () => {
  const two = (n) => ({
    sessionId: 's1',
    active: 'd1',
    tabs: [
      { id: 'd1', label: 'one.png', revision: 0, panes: [image('one.png')] },
      { id: 'd2', label: 'two.png', revision: n, panes: [image('two.png')] },
    ],
  });
  applyVisualizeEvent({ sessionId: 's1', state: two(0) });
  const root = await mount();
  try {
    const dot = (id) => document.querySelector(`[data-visualize-tab-id="${id}"] .visualize-tab-updated`);
    await act(async () => applyVisualizeEvent({ sessionId: 's1', state: two(1), updated: 'd2' }));
    assert.ok(dot('d2'), 'the updated background tab wears the dot');
    assert.equal(dot('d1'), null);
    assert.ok(document.querySelector('[data-visualize-tab-id="d1"].is-active'), 'the active tab did not change');
    await click(document.querySelector('[data-visualize-tab-id="d2"] .browser-tab-select'));
    assert.equal(dot('d2'), null, 'viewing the tab clears the dot');
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
