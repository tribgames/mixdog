import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { expose: ['navigator', 'Node', 'Element', 'HTMLElement'] });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { default: React } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const {
  ComposerUsageReadout,
  cacheHitShare,
  formatCompactTokens,
  fittingVariant,
  liveTokensPerSecond,
  readoutVariants,
  usageReadoutParts,
  sessionUsageTotals,
  outputTokensPerSecond,
  totalTokens,
  usageReadoutText,
  usageWithCostVariants,
  textWidths,
  FittedReadout,
  ReadoutLayoutContext,
} = await import('./composer-usage-readout.tsx');
const { SurfaceActiveContext } = await import('./surface-activity.ts');

// The readout measures through one canvas context for the whole module: it
// records its font sets and measured texts (7px per character).
const canvas = { sets: [], measured: [] };
{
  const context = {
    _font: '',
    get font() {
      return this._font;
    },
    set font(value) {
      canvas.sets.push(value);
      this._font = value;
    },
    measureText: (text) => {
      canvas.measured.push(text);
      return { width: text.length * 7 };
    },
  };
  const createElement = document.createElement.bind(document);
  document.createElement = (name) => (name === 'canvas' ? { getContext: () => context } : createElement(name));
}

// A fit pass measures every variant's items in one font, and every resize of
// the line runs one. Assigning the canvas `font` re-parses the shorthand each
// time, even to its current value.
test('a measurer measures each text once per font, setting the canvas font once per font', () => {
  canvas.sets.length = canvas.measured.length = 0;
  const font = 'normal 400 12px "Measure"';
  const textWidth = textWidths();
  const texts = ['42.1k tokens', '48 tok/s', 'Cache hit 92.0%', '·', '42.1k'];
  for (const pass of [1, 2]) {
    assert.deepEqual(
      texts.map((text) => textWidth(font, text)),
      texts.map((text) => text.length * 7),
      `pass ${pass}`
    );
  }
  assert.deepEqual(canvas.measured, texts, 'the second pass measures nothing again');
  assert.deepEqual(canvas.sets, [font]);
  // Another font is another width for the same text.
  assert.equal(textWidth('italic 400 12px "Measure"', '42.1k'), 35);
  assert.deepEqual(canvas.measured, [...texts, '42.1k']);
});

// A web font finishing its load changes every text's width, and nothing need
// resize: the widths measured in the fallback font must not be reused.
test('a fitted readout measures its texts again when a web font finishes loading', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const fonts = new window.EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  const resizes = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizes.push(callback);
    }
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const line = document.createElement('div');
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    line.remove();
    delete document.fonts;
    delete globalThis.MutationObserver;
    delete globalThis.ResizeObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  canvas.measured.length = 0;
  const variants = [[{ text: 'Load 1' }, { text: 'Load 2', separator: true }], [{ text: 'Load 1' }]];
  await act(async () => {
    root.render(React.createElement(FittedReadout, { variants, onClick() {}, title: 'Usage' }));
  });
  const once = ['Load 1', 'Load 2', '·'];
  assert.deepEqual(canvas.measured, once);
  // A resize measures nothing again.
  act(() => resizes[0]());
  assert.deepEqual(canvas.measured, once);
  act(() => {
    fonts.dispatchEvent(new window.Event('loadingdone'));
  });
  assert.deepEqual(canvas.measured, [...once, ...once], 'measured afresh in the loaded font');
  // Unmounted, it no longer listens.
  act(() => root.unmount());
  fonts.dispatchEvent(new window.Event('loadingdone'));
  assert.deepEqual(canvas.measured, [...once, ...once]);
});

// The route label joins the readout's line after the readout mounted (its
// setting turned on, or the delegation mode arriving): nothing resizes yet,
// but the label takes room, so the readout must fit again and drop first.
test('a fitted readout hides when a sibling appears after mount and leaves no room', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const widths = new Map();
  const rect = Object.getOwnPropertyDescriptor(window.Element.prototype, 'getBoundingClientRect');
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: widths.get(this) ?? 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const style = document.createElement('style');
  style.textContent = '.after-mount-readout { padding: 0 4px; } .after-mount-line { padding: 0; }';
  document.head.append(style);
  const line = document.createElement('div');
  line.className = 'after-mount-line';
  Object.defineProperty(line, 'clientWidth', { configurable: true, value: 300 });
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    line.remove();
    style.remove();
    Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', rect);
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const variants = [[{ text: 'Load 1' }, { text: 'Load 2', separator: true }], [{ text: 'Load 1' }]];
  function View({ label }) {
    return React.createElement(
      React.Fragment,
      null,
      label && React.createElement('button', { ref: (node) => node && widths.set(node, 290) }, 'Review · Swarm'),
      React.createElement(FittedReadout, { variants, onClick() {}, title: 'Usage', className: 'after-mount-readout' })
    );
  }
  await act(async () => root.render(React.createElement(View, { label: false })));
  const readout = () => line.querySelector('.composer-usage-readout');
  assert.equal(readout().hidden, false, 'it fits alone');
  await act(async () => root.render(React.createElement(View, { label: true })));
  assert.equal(readout().hidden, true, 'the label that left no room hid it');
});

// Session-cumulative totals as the runtime persists them (the speed sums
// already hold only the calls with positive output and positive duration).
const totals = {
  input: 1200,
  cacheRead: 38000,
  cacheWrite: 2100,
  output: 800,
  speedOutputTokens: 720,
  speedMs: 15000,
};

// A turn starting swaps the session's "48 tok/s" for the live "~413 tok/s" and
// back: at no width may that flip the line between the worded and icon form.
test('the usage line keeps its form when a call starts streaming and when it ends', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const resizes = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizes.push(callback);
    }
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let width = 0;
  const style = document.createElement('style');
  style.textContent = '.form-readout { padding: 0 4px; } .form-line { padding: 0; }';
  document.head.append(style);
  const line = document.createElement('div');
  line.className = 'form-line';
  Object.defineProperty(line, 'clientWidth', { configurable: true, get: () => width });
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    act(() => root.unmount());
    line.remove();
    style.remove();
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const usage = sessionUsageTotals({ usageReadout: totals });
  const render = (variants) =>
    act(() =>
      root.render(
        React.createElement(FittedReadout, { variants, onClick() {}, title: 'Usage', className: 'form-readout' })
      )
    );
  const form = () => {
    const readout = line.querySelector('.composer-usage-readout');
    if (readout.hidden) return 'hidden';
    const items = readout.querySelectorAll('.composer-readout-item').length;
    return `${readout.querySelector('.composer-readout-sep') ? 'worded' : 'icons'} ${items}`;
  };
  const seen = new Set();
  for (width = 60; width <= 420; width += 4) {
    render(readoutVariants(usageReadoutParts(usage)));
    act(() => resizes.at(-1)());
    const idle = form();
    render(readoutVariants(usageReadoutParts(usage, 412.6)));
    assert.equal(form(), idle, `${width}px: the live rate changed the form`);
    render(readoutVariants(usageReadoutParts(usage)));
    assert.equal(form(), idle, `${width}px: the call's end changed the form`);
    seen.add(idle);
  }
  assert.ok(seen.has('worded 3') && seen.has('icons 1'), `every form is reached: ${[...seen]}`);
});

test('tok/s is timed output over request time; cache hit is read over the whole prompt', () => {
  const usage = sessionUsageTotals({ usageReadout: totals });
  assert.equal(outputTokensPerSecond(usage), 48);
  assert.equal(cacheHitShare(usage), 38000 / (1200 + 38000 + 2100));
  assert.equal(usageReadoutText(usage), '42.1k 48/s 92.0%');
  // Nothing timed: the others stand without it; no cache read: no cache part.
  assert.equal(usageReadoutText({ ...usage, speedMs: 0, speedOutputTokens: 0 }), '42.1k 92.0%');
  assert.equal(usageReadoutText({ ...usage, cacheRead: 0 }), '4.1k 48/s');
  assert.equal(usageReadoutText(sessionUsageTotals({})), null);
  assert.equal(outputTokensPerSecond(null), null);
  assert.equal(cacheHitShare(null), null);
});

test('tok/s is the request-time rate (first-token wait included); a record without it falls back to the older speed', () => {
  const base = { input: 1200, cacheRead: 38000, cacheWrite: 2100, output: 800 };
  // Saved before the request-time sums: the first-token speed still reads.
  assert.equal(
    outputTokensPerSecond(sessionUsageTotals({ usageReadout: { ...base, speedOutputTokens: 720, speedMs: 4000 } })),
    180
  );
  // Request-time sums take over, ignoring the older pair: 720 tokens over 8 s.
  const both = {
    ...base,
    speedOutputTokens: 720,
    speedMs: 4000,
    requestOutputTokens: 720,
    requestMs: 8000,
  };
  assert.equal(outputTokensPerSecond(sessionUsageTotals({ usageReadout: both })), 90);
  assert.equal(
    outputTokensPerSecond(sessionUsageTotals({ usageReadout: { ...base, requestOutputTokens: 500, requestMs: 5000 } })),
    100
  );
});

test('total tokens sum input, cache read, cache write and output; compact like 12.3k / 1.2M', () => {
  assert.equal(totalTokens(sessionUsageTotals({ usageReadout: totals })), 42100);
  assert.equal(totalTokens(null), null);
  assert.equal(totalTokens(sessionUsageTotals({ usageReadout: { input: 0, output: 0 } })), null);
  // A record saved before the output sum existed shows no total, not a short one.
  const legacy = sessionUsageTotals({ usageReadout: { ...totals, output: undefined } });
  assert.equal(totalTokens(legacy), null);
  assert.equal(usageReadoutText(legacy), '48/s 92.0%');
  const cases = [
    [0, '0'],
    [842, '842'],
    [999, '999'],
    [1000, '1k'],
    [12_345, '12.3k'],
    [999_949, '999.9k'],
    [999_950, '1M'],
    [1_200_000, '1.2M'],
    [1_234_567_890, '1.2B'],
  ];
  for (const [value, text] of cases) assert.equal(formatCompactTokens(value), text, String(value));
  assert.equal(
    usageReadoutText(sessionUsageTotals({ usageReadout: { input: 700_000, cacheRead: 400_000, output: 100_000 } })),
    '1.2M 36.4%'
  );
});

test('the cache part stays hidden until the session has read from the cache', () => {
  const cold = sessionUsageTotals({ usageReadout: { ...totals, cacheRead: 0 } });
  assert.equal(cacheHitShare(cold), null);
  assert.equal(usageReadoutText(cold), '4.1k 48/s');
  assert.equal(
    usageReadoutText(sessionUsageTotals({ usageReadout: { input: 500, cacheWrite: 900 } })),
    null,
    'no output sum, no cache read, no timed call: nothing to say'
  );
});

test('the figures are the session sums, not a mean of per-turn rates', () => {
  // Two turns: 200 tokens in 4 s (50 tok/s) and 100 tokens in 4 s (25 tok/s)
  // read as 300 / 8 s, and a 50% then a 100% cache turn as 3000 / 4000.
  const sum = sessionUsageTotals({
    usageReadout: { input: 1000, cacheRead: 3000, cacheWrite: 0, output: 300, speedOutputTokens: 300, speedMs: 8000 },
  });
  assert.equal(outputTokensPerSecond(sum), 37.5);
  assert.equal(cacheHitShare(sum), 0.75);
  assert.equal(usageReadoutText(sum), '4.3k 38/s 75.0%');
});

test('the streaming call shows its own live rate, past the floors, in place of the session speed', () => {
  const live = (outputTokens, at, startedAt = 10_000) => ({ active: true, liveCall: { startedAt, outputTokens, at } });
  // 300 estimated tokens over 4 s since its request started.
  assert.equal(liveTokensPerSecond(live(300, 14_000)), 75);
  // Not before 50 estimated tokens and 1.5 s of streaming.
  assert.equal(liveTokensPerSecond(live(49, 20_000)), null);
  assert.equal(liveTokensPerSecond(live(200, 11_499)), null);
  assert.equal(liveTokensPerSecond(live(60, 11_500)), 40);
  // Between calls there is no live call (or no active spinner).
  assert.equal(liveTokensPerSecond({ active: true }), null);
  assert.equal(liveTokensPerSecond({ active: true, liveCall: null }), null);
  assert.equal(liveTokensPerSecond({ ...live(300, 14_000), active: false }), null);
  assert.equal(liveTokensPerSecond(null), null);

  const usage = sessionUsageTotals({ usageReadout: totals });
  assert.equal(usageReadoutText(usage, 75), '42.1k ~75/s 92.0%');
  // The live rate stands even before the session has any timed call.
  assert.equal(usageReadoutText(null, 75), '~75/s');
  // Each new sample re-renders: the figure follows the call's latest sample.
  const render = (spinner) =>
    renderToStaticMarkup(
      React.createElement(ComposerUsageReadout, {
        snapshot: { sessionId: 's1', stats: { usageReadout: totals }, spinner },
        onOpenUsage() {},
      })
    );
  const sep = '<span class="composer-readout-sep" aria-hidden="true">·</span>';
  assert.match(
    render(live(300, 14_000)),
    new RegExp(`42\\.1k tokens${sep}</span>.*~75 tok/s${sep}</span>.*Cache hit 92\\.0%</span>`)
  );
  assert.match(render(live(500, 15_000)), new RegExp(`~100 tok/s${sep}</span>`));
  // When the call ends the spinner drops its live call and the session figure returns.
  assert.match(render({ active: true, liveCall: null }), new RegExp(`>48 tok/s${sep}</span>`));
});

test('the readout hides until the session reported usage, then is one button with no hover card', () => {
  const render = (stats) =>
    renderToStaticMarkup(
      React.createElement(ComposerUsageReadout, { snapshot: { sessionId: 's1', stats }, onOpenUsage() {} })
    );
  assert.equal(render(undefined), '');
  assert.equal(render({ inputTokens: 10 }), '');
  // A session saved before the totals existed shows nothing, not a guess.
  assert.equal(render({ inputTokens: 10, promptTokens: 641000, cachedTokens: 610000 }), '');
  const html = render({
    usageReadout: totals,
    promptTokens: 641000,
    cachedTokens: 610000,
    cacheWriteTokens: 13000,
    outputTokens: 12000,
  });
  assert.match(
    html,
    /^<button type="button" class="composer-usage-readout"[^>]*>(<span class="composer-readout-item"[^>]*>.*<\/span>){3}<\/button>$/
  );
});

test('a narrowing line drops cache hit first, then the token total, tok/s last', () => {
  const parts = usageReadoutParts(sessionUsageTotals({ usageReadout: totals }));
  const variants = readoutVariants(parts);
  const texts = (list) =>
    list.map((items) => items.map((item) => (item.separator ? `${item.text} ·` : item.text)).join(' '));
  // Worded first (room to spare), then the icon form, then fewer parts.
  assert.deepEqual(texts(variants), [
    '42.1k tokens · 48 tok/s · Cache hit 92.0%',
    '42.1k 48/s 92.0%',
    '42.1k 48/s',
    '48/s',
  ]);
  assert.deepEqual(
    variants.map((items) => items.some((item) => item.icon)),
    [false, true, true, true]
  );
  assert.equal(usageReadoutText(sessionUsageTotals({ usageReadout: totals }), null, 2), '42.1k 48/s');
  // With no speed yet, the total outlasts the cache hit.
  const noSpeed = usageReadoutParts(sessionUsageTotals({ usageReadout: { ...totals, speedMs: 0 } }));
  assert.deepEqual(texts(readoutVariants(noSpeed)), ['42.1k tokens · Cache hit 92.0%', '42.1k 92.0%', '42.1k']);
  assert.deepEqual(readoutVariants(usageReadoutParts(null)), []);
  // The fullest variant that fits; none fits: the readout hides.
  assert.equal(fittingVariant([300, 200, 80], 400), 0);
  assert.equal(fittingVariant([300, 200, 80], 250), 1);
  assert.equal(fittingVariant([300, 200, 80], 80), 2);
  assert.equal(fittingVariant([300, 200, 80], 79), -1);
});

test("the session panel's usage row: its worded line always carries the cache hit; the cost goes first, the words after it", () => {
  const texts = (list) =>
    list.map((items) => items.map((item) => (item.separator ? `${item.text} ·` : item.text)).join(' '));
  // Before any cache read the hit reads 0.0%, so the worded line has its three parts; no cost, no cost variants.
  const cold = { stats: { usageReadout: { ...totals, cacheRead: 0 } } };
  assert.deepEqual(texts(usageWithCostVariants(cold)), [
    '4.1k tokens · 48 tok/s · Cache hit 0.0%',
    '4.1k 48/s 0.0%',
    '4.1k 48/s',
    '48/s',
  ]);
  // With a cost: worded with it, worded without it, the icon form with it, then the icon forms without it.
  const priced = usageWithCostVariants({ stats: { usageReadout: totals, costUsd: 1.25 } });
  assert.deepEqual(texts(priced), [
    '42.1k tokens · 48 tok/s · Cache hit 92.0% · $1.25',
    '42.1k tokens · 48 tok/s · Cache hit 92.0%',
    '42.1k 48/s 92.0% $1.25',
    '42.1k 48/s 92.0%',
    '42.1k 48/s',
    '48/s',
  ]);
  assert.deepEqual(
    priced.map((items) => items.some((item) => item.icon)),
    [false, false, true, true, true, true]
  );
});

test('each coding item carries its full words as tooltip and accessible name', () => {
  const parts = usageReadoutParts(sessionUsageTotals({ usageReadout: totals }), 75);
  assert.equal(parts.total.label, 'Total tokens 42.1k');
  assert.equal(parts.speed.label, 'Output speed ~75 tok/s');
  assert.equal(parts.hit.label, 'Cache hit 92.0%');
  const html = renderToStaticMarkup(
    React.createElement(ComposerUsageReadout, {
      snapshot: { sessionId: 's1', stats: { usageReadout: totals } },
      onOpenUsage() {},
    })
  );
  assert.match(html, /title="Total tokens 42\.1k" aria-label="Total tokens 42\.1k"/);
  // Room to spare: the worded form, no icons; the icon form is the next variant.
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /42\.1k tokens<span class="composer-readout-sep" aria-hidden="true">·<\/span>/);
  assert.ok(readoutVariants(parts)[1].every((item) => item.icon));
});

test('a fitted readout re-evaluates synchronously on card placement and surface reveal without waiting for observers', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const widths = new Map();
  const rect = Object.getOwnPropertyDescriptor(window.Element.prototype, 'getBoundingClientRect');
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: widths.get(this) ?? 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  // No-op ResizeObserver and MutationObserver prove fitting settles synchronously in useLayoutEffect.
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const style = document.createElement('style');
  style.textContent = '.sync-fit-readout { padding: 0 4px; } .sync-fit-line { padding: 0; }';
  document.head.append(style);
  let lineWidth = 0;
  const line = document.createElement('div');
  line.className = 'sync-fit-line';
  Object.defineProperty(line, 'clientWidth', { configurable: true, get: () => lineWidth });
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    act(() => root.unmount());
    line.remove();
    style.remove();
    Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', rect);
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const variants = [[{ text: '42.1k tokens', separator: true }, { text: '48 tok/s' }], [{ text: '42.1k' }]];
  function View({ surfaceActive, placement, siblingWidth }) {
    return React.createElement(
      SurfaceActiveContext.Provider,
      { value: surfaceActive },
      React.createElement(
        ReadoutLayoutContext.Provider,
        { value: placement },
        React.createElement(FittedReadout, {
          variants,
          onClick() {},
          title: 'Usage',
          className: 'sync-fit-readout',
        }),
        siblingWidth > 0 &&
          React.createElement('span', { ref: (node) => node && widths.set(node, siblingWidth) }, 'Controls')
      )
    );
  }
  const readout = () => line.querySelector('.composer-usage-readout');
  // Hidden panel (0px): readout hides while recording data-full-width.
  lineWidth = 0;
  await act(async () =>
    root.render(React.createElement(View, { surfaceActive: false, placement: 'line:0:0', siblingWidth: 200 }))
  );
  assert.equal(readout().hidden, true);
  assert.ok(Number(readout().dataset.fullWidth) > 0);
  // Revealed at 320px with 200px model controls beside it: fits only the compact variant.
  lineWidth = 320;
  await act(async () =>
    root.render(React.createElement(View, { surfaceActive: true, placement: 'line:0:0', siblingWidth: 200 }))
  );
  assert.equal(readout().hidden, false);
  assert.equal(readout().textContent, '42.1k', 'fits compact variant synchronously on reveal');
  // Card layout moves model controls out of the line (placement flips to detail card): worded form fits synchronously.
  canvas.measured.length = 0;
  await act(async () =>
    root.render(React.createElement(View, { surfaceActive: true, placement: 'detail:0:0', siblingWidth: 0 }))
  );
  assert.equal(readout().hidden, false);
  assert.equal(readout().textContent, '42.1k tokens·48 tok/s', 'expands to worded form synchronously on card switch');
  assert.deepEqual(canvas.measured, [], 'reuses cached text widths across placement re-fits for unchanged variants');
});

test('a fitted readout drops obsolete cached text widths when its variant texts change', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const line = document.createElement('div');
  Object.defineProperty(line, 'clientWidth', { configurable: true, value: 400 });
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    act(() => root.unmount());
    line.remove();
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const first = [[{ text: '10.0k tokens' }]];
  const second = [[{ text: '10.1k tokens' }]];
  canvas.measured.length = 0;
  await act(async () =>
    root.render(React.createElement(FittedReadout, { variants: first, onClick() {}, title: 'Usage', layoutKey: 'a' }))
  );
  assert.deepEqual(canvas.measured, ['10.0k tokens']);
  // Layout-only re-fit with the same variant text reuses the cache.
  canvas.measured.length = 0;
  await act(async () =>
    root.render(React.createElement(FittedReadout, { variants: first, onClick() {}, title: 'Usage', layoutKey: 'b' }))
  );
  assert.deepEqual(canvas.measured, []);
  // Variant text changes: cache is replaced with the new text.
  await act(async () =>
    root.render(React.createElement(FittedReadout, { variants: second, onClick() {}, title: 'Usage', layoutKey: 'b' }))
  );
  assert.deepEqual(canvas.measured, ['10.1k tokens']);
  // Returning to the earlier string measures it again, proving it was not retained.
  canvas.measured.length = 0;
  await act(async () =>
    root.render(React.createElement(FittedReadout, { variants: first, onClick() {}, title: 'Usage', layoutKey: 'b' }))
  );
  assert.deepEqual(canvas.measured, ['10.0k tokens']);
});

test('a fitted readout re-measures fresh widths if fonts finish loading while variants are empty', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const fonts = new window.EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const line = document.createElement('div');
  Object.defineProperty(line, 'clientWidth', { configurable: true, value: 400 });
  document.body.append(line);
  const root = createRoot(line);
  t.after(() => {
    act(() => root.unmount());
    line.remove();
    delete document.fonts;
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
    delete globalThis.getComputedStyle;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const variants = [[{ text: '42.1k tokens' }]];
  canvas.measured.length = 0;
  await act(async () => root.render(React.createElement(FittedReadout, { variants, onClick() {}, title: 'Usage' })));
  assert.deepEqual(canvas.measured, ['42.1k tokens']);
  // Variants empty -> component renders null and disconnects its font-load listener.
  await act(async () =>
    root.render(React.createElement(FittedReadout, { variants: [], onClick() {}, title: 'Usage' }))
  );
  // Font finishes loading while the readout is absent.
  fonts.dispatchEvent(new window.Event('loadingdone'));
  // Returning with the same variants must re-measure in the loaded font instead of reusing stale pre-load widths.
  canvas.measured.length = 0;
  await act(async () => root.render(React.createElement(FittedReadout, { variants, onClick() {}, title: 'Usage' })));
  assert.deepEqual(canvas.measured, ['42.1k tokens']);
});
