import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// iOS WebKit (up to iOS 26) cancels a touch fling when scrollTop is written,
// so a touch scroll there holds measured-size corrections and page landings
// as a row offset. The hold lands as one native write once the touch scroll
// has been quiet for 150 ms, or at once when the logical offset reaches the
// real top. Native 0 with a page held above it is reached by the momentum
// itself, so it waits there too. A Chromium touch scroll holds the same way
// until scrollend (transcript-follow.test.mjs).

const IPHONE = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

const dom = (globals) =>
  installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
    ...(globals ? { globals } : {}),
  });

function fakeViewport(native, height) {
  const viewport = {
    native,
    writes: [],
    clientHeight: height,
    get scrollTop() {
      return viewport.native;
    },
    set scrollTop(value) {
      viewport.writes.push(value);
      viewport.native = Math.max(0, value);
    },
  };
  return viewport;
}

test('a held correction lands early only once the logical offset reaches the top', async () => {
  const { restore } = dom();
  try {
    const { createTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');
    const viewport = fakeViewport(3_000, 400);
    const space = { style: {} };
    const marks = [];
    const deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => true,
      clampAtEdge: () => true,
      markProgrammaticScroll: (top, intended) => marks.push([top, intended]),
    });
    assert.equal(deviation.hold(8_000), true, 'a page landing mid-fling is held');
    assert.equal(space.style.transform, 'translateY(-5000px)');
    viewport.native = 380;
    deviation.landAtEdge();
    assert.deepEqual(viewport.writes, [], 'short of the top it stays held, even within a screen of it');
    viewport.native = 0;
    deviation.landAtEdge();
    assert.deepEqual(viewport.writes, [], 'native 0 with the page held above it is the momentum’s, not the top');
    assert.equal(space.style.transform, 'translateY(-5000px)');
    assert.equal(deviation.hold(2_000), true, 'a page landing there is held too');
    deviation.drop();
    // A held shrink whose logical offset reaches the top lands at once.
    viewport.native = 1_500;
    assert.equal(deviation.hold(300), true);
    viewport.native = 1_100;
    deviation.landAtEdge();
    assert.deepEqual(viewport.writes, [0], 'a logical offset at or above 0 lands at the top');
    assert.equal(deviation.amount(), 0);
    assert.equal(space.style.transform, '');
    assert.deepEqual(marks, [[0, 0]], 'and is reported as the timeline’s own write');
    // At the real top a landing is never held: the caller writes it natively.
    viewport.native = 400;
    assert.equal(deviation.hold(-20), false, 'a landing at the real top is not held');
    deviation.cancel();
  } finally {
    restore();
  }
});

test('a wheel ramp hold has no edge: it lands only once the ramp is over', async () => {
  const { restore } = dom();
  try {
    const { createTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');
    const viewport = fakeViewport(200, 400);
    const deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => ({ style: {} }),
      hasTouchScroll: () => true,
      clampAtEdge: () => false,
      markProgrammaticScroll: () => {},
    });
    assert.equal(deviation.hold(2_200), true);
    deviation.landAtEdge();
    assert.deepEqual(viewport.writes, []);
    deviation.cancel();
  } finally {
    restore();
  }
});

test('on iOS WebKit a touch scroll holds corrections through its fling and lands them 150 ms after it goes quiet', async () => {
  const { restore } = dom({ navigator: IPHONE });
  const [
    React,
    { createRoot },
    { useTranscriptFollow, registerTranscriptScrollGeometry },
    { createTouchScrollDeviation },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
    import('./transcript-list-touch-deviation.ts'),
  ]);
  const realNow = Date.now;
  let now = 500_000;
  Date.now = () => now;
  let native = 3_000;
  const writes = [];
  let follow = null;
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'ios-touch' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('div', { id: 'space' }, 'rows'))
    );
  }
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const space = document.getElementById('space');
    const viewport = space.parentElement.parentElement;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 20_000 });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => native,
      set: (value) => {
        writes.push(value);
        native = value;
      },
    });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 20_000,
      scrollTop: () => native,
    });
    const deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => follow.holdsScrollCorrections(),
      clampAtEdge: () => follow.touchHoldsCorrections(),
      markProgrammaticScroll: (top, intended) => follow.markProgrammaticScroll(top, intended),
    });
    await React.act(async () => follow.handleScroll());
    const touch = (clientY) => ({ target: space, currentTarget: viewport, touches: [{ clientY }] });
    follow.handleTouchStart(touch(100));
    follow.handleTouchMove(touch(160));
    assert.equal(follow.holdsScrollCorrections(), true, 'the drag holds corrections off the native offset');
    assert.equal(deviation.hold(native + 30), true);
    follow.handleTouchEnd();
    // Momentum: scroll events keep arriving after the finger lifts.
    for (let step = 0; step < 5; step += 1) {
      now += 100;
      native -= 80;
      await React.act(async () => follow.handleScroll());
      await frame();
      assert.equal(follow.holdsScrollCorrections(), true, 'the fling keeps the hold');
    }
    assert.deepEqual(writes, [], 'no scrollTop write under the fling');
    now += 160;
    assert.equal(follow.holdsScrollCorrections(), false, '150 ms of quiet ends the hold');
    const settledAt = native + 30;
    await frame();
    assert.deepEqual(writes, [settledAt], 'the held correction lands as one write');
    release();
    deviation.cancel();
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

// iPhone, long session: a page lands above a fling toward older history and is
// held as a row offset; the fling then runs into native 0, the old first row.
// Landing the hold there wrote scrollTop under the momentum (and the bounce
// it starts): WebKit cancels or drops that write, so the fling stopped and the
// rows jumped by the page. The hold waits out the momentum at the edge too and
// lands once the touch scroll has gone quiet.
test('on iOS WebKit a held page is not landed under the momentum that reaches the top edge', async () => {
  const { restore } = dom({ navigator: IPHONE });
  const [
    React,
    { createRoot },
    { useTranscriptFollow, registerTranscriptScrollGeometry },
    { createTouchScrollDeviation },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
    import('./transcript-list-touch-deviation.ts'),
  ]);
  const realNow = Date.now;
  let now = 900_000;
  Date.now = () => now;
  let native = 1_400;
  const writes = [];
  let follow = null;
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'ios-edge' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('div', { id: 'space' }, 'rows'))
    );
  }
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const space = document.getElementById('space');
    const viewport = space.parentElement.parentElement;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 20_000 });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => native,
      set: (value) => {
        writes.push(value);
        native = Math.max(0, value);
      },
    });
    const deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => follow.holdsScrollCorrections(),
      clampAtEdge: () => follow.touchHoldsCorrections(),
      markProgrammaticScroll: (top, intended) => follow.markProgrammaticScroll(top, intended),
    });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 20_000,
      scrollTop: () => native,
      deviation: () => deviation.amount(),
    });
    // One momentum frame as the list delivers it: its offset observer runs the
    // edge check, then the follow hook sees the scroll.
    const momentum = async (delta) => {
      now += 16;
      native = Math.max(0, native + delta);
      deviation.landAtEdge();
      await React.act(async () => follow.handleScroll());
      await frame();
    };
    await React.act(async () => follow.handleScroll());
    const touch = (clientY) => ({ target: space, currentTarget: viewport, touches: [{ clientY }] });
    follow.handleTouchStart(touch(100));
    follow.handleTouchMove(touch(160));
    await momentum(-60);
    follow.handleTouchEnd();
    assert.equal(deviation.hold(native + 5_000), true, 'the page landing mid-fling is held');
    while (native > 0) await momentum(-80);
    // The momentum is still delivering at the edge (the bounce it starts).
    for (let step = 0; step < 4; step += 1) await momentum(0);
    assert.deepEqual(writes, [], 'no scrollTop write under the momentum, at the top edge either');
    assert.equal(space.style.transform, 'translateY(-5000px)', 'the page stays held above the old first row');
    now += 160;
    await frame();
    assert.deepEqual(writes, [5_000], 'once the touch scroll is quiet the hold lands as one write');
    assert.equal(space.style.transform, '');
    release();
    deviation.cancel();
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

/** A real virtual-core instance on a 400 px viewport over 100 px rows, with
 *  the offset observer in the test's hands. `calls` records each scrollToFn
 *  target (offset plus adjustments). */
function coreHarness(Virtualizer, anchorTo = 'start') {
  const element = document.createElement('div');
  let instance = null;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => instance?.getTotalSize() ?? 0 },
  });
  const calls = [];
  let emit = () => {};
  let keys = Array.from({ length: 20 }, (_, index) => `r${index}`);
  let anchor = anchorTo;
  const options = () => ({
    count: keys.length,
    getScrollElement: () => element,
    getItemKey: (index) => keys[index],
    estimateSize: () => 100,
    anchorTo: anchor,
    scrollToFn: (offset, { adjustments }) => calls.push(offset + (adjustments ?? 0)),
    observeElementRect: (_instance, cb) => {
      cb({ width: 600, height: 400 });
      return () => {};
    },
    observeElementOffset: (_instance, cb) => {
      emit = cb;
      return () => {};
    },
  });
  instance = new Virtualizer(options());
  instance._willUpdate();
  calls.length = 0;
  return {
    instance,
    calls,
    scroll(offset, scrolling = true) {
      emit(offset, scrolling);
      // The render that follows a scroll lays the range out.
      instance.getVirtualItems();
    },
    /** A page of `count` older rows lands above (a render's setOptions). */
    prepend(count) {
      keys = [...Array.from({ length: count }, (_, index) => `p${keys.length}-${index}`), ...keys];
      instance.setOptions(options());
    },
    anchorTo(next) {
      anchor = next;
      instance.setOptions(options());
    },
  };
}

async function withIPhoneCore(run) {
  const { restore } = dom({ navigator: IPHONE });
  const [core, list] = await Promise.all([
    import('@tanstack/virtual-core'),
    import('./transcript-list-virtualizer.ts'),
  ]);
  core._resetIOSDetectionForTests();
  try {
    await run(core, list);
  } finally {
    core._resetIOSDetectionForTests();
    restore();
  }
}

// The handover replaces the core's iOS account by name and its measurement
// path by method name. A virtual-core release that renames either would leave
// the stock deferral (no top edge) silently back in charge: this pins both.
test('virtual-core keeps its iOS deferral in _iosDeferredAdjustment: written by measurements and prepends, read on settle', async () => {
  await withIPhoneCore(async ({ Virtualizer }) => {
    const stock = coreHarness(Virtualizer);
    stock.scroll(1_000);
    // A row above the reader is measured mid-scroll: deferred, nothing written.
    stock.instance.resizeItem(2, 130);
    assert.deepEqual(stock.calls, []);
    assert.equal(stock.instance._iosDeferredAdjustment, 30, 'resizeItem defers into _iosDeferredAdjustment');
    // The scroll settles: the core reads the account back and writes it once.
    stock.scroll(1_000, false);
    assert.deepEqual(stock.calls, [1_030]);
    assert.equal(stock.instance._iosDeferredAdjustment, 0);
    // A prepend while anchored to the end defers its anchor sync there too,
    // with the delta already carried by the core offset.
    const anchored = coreHarness(Virtualizer, 'end');
    anchored.scroll(1_000);
    anchored.prepend(3);
    assert.equal(anchored.instance.scrollOffset, 1_300, 'the prepend moved the core offset at once');
    anchored.instance._willUpdate();
    assert.deepEqual(anchored.calls, []);
    assert.equal(anchored.instance._iosDeferredAdjustment, 300, 'the anchor sync defers into _iosDeferredAdjustment');
  });
});

test('handed over, a measured-size correction reaches the list’s scroll writer at once', async () => {
  await withIPhoneCore(async ({ Virtualizer }, { handOverIOSDeferral }) => {
    const routed = coreHarness(Virtualizer);
    handOverIOSDeferral(routed.instance);
    routed.scroll(1_000);
    routed.instance.resizeItem(2, 130);
    assert.deepEqual(routed.calls, [1_030], 'the correction reaches scrollToFn at once');
    assert.equal(routed.instance._iosDeferredAdjustment, 0, 'nothing is kept in the core account');
    assert.equal(routed.instance.scrollOffset, 1_030);
    routed.scroll(1_030, false);
    assert.deepEqual(routed.calls, [1_030], 'the settle has nothing left to write');
  });
});

// The prepend's anchor delta is already in the core offset when the sync
// runs; routed as a measurement it moved the reader by the page twice.
test('handed over, a prepend’s anchor sync writes the anchored offset once, never the delta again', async () => {
  await withIPhoneCore(async ({ Virtualizer }, { handOverIOSDeferral }) => {
    // The reader released the tail between the page's render and its commit:
    // the pending anchor still syncs, and only once.
    const released = coreHarness(Virtualizer, 'end');
    handOverIOSDeferral(released.instance, () => {});
    released.scroll(1_000);
    released.prepend(3);
    released.anchorTo('start');
    released.instance._willUpdate();
    assert.deepEqual(released.calls, [1_300], 'no page-sized second jump');
    assert.equal(released.instance.scrollOffset, 1_300, 'the core offset carries the delta once');
    // Still anchored: the sync reaches the list's writer (which turns it into
    // the end pin) at the anchored offset.
    const anchored = coreHarness(Virtualizer, 'end');
    handOverIOSDeferral(anchored.instance, () => {});
    anchored.scroll(1_000);
    anchored.prepend(3);
    anchored.instance._willUpdate();
    assert.deepEqual(anchored.calls, [1_300], 'the sync reaches scrollToFn at the anchored offset');
    assert.equal(anchored.instance.scrollOffset, 1_300);
  });
});
