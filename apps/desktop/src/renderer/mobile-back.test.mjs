import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://mixdog.test/',
});
dom.window.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { __resetMobileBackForTest, registerMobileBack, useMobileBack } = await import('./mobile-back.ts');
const { SurfaceActiveContext } = await import('./surface-activity.ts');

/** jsdom traverses history on its own event loop, so a fixed tick is not a
 *  synchronisation point: wait for the popstate the traversal actually
 *  delivers (plus any follow-up history.forward()/go() veto restoration), one
 *  more tick so the module's own listener runs first. */
function afterPopState(trigger) {
  return new Promise((resolve, reject) => {
    const targetHistory = dom.window.history;
    const originalForward = targetHistory.forward;
    const originalGo = targetHistory.go;
    let pending = 1;
    let insideTrigger = true;
    targetHistory.forward = function (...args) {
      if (!insideTrigger) pending += 1;
      return originalForward.apply(this, args);
    };
    if (typeof originalGo === 'function') {
      targetHistory.go = function (delta, ...rest) {
        if (!insideTrigger && typeof delta === 'number' && delta !== 0) pending += 1;
        return originalGo.call(this, delta, ...rest);
      };
    }
    const cleanup = () => {
      clearTimeout(timer);
      dom.window.removeEventListener('popstate', onPop);
      targetHistory.forward = originalForward;
      if (typeof originalGo === 'function') {
        targetHistory.go = originalGo;
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('popstate never arrived'));
    }, 2_000);
    function onPop() {
      pending -= 1;
      if (pending <= 0) {
        cleanup();
        setTimeout(resolve, 0);
      }
    }
    dom.window.addEventListener('popstate', onPop);
    try {
      trigger();
    } finally {
      insideTrigger = false;
    }
  });
}

/** No traversal is expected: give one a chance to arrive and report it. */
function quietWindow(trigger) {
  return new Promise((resolve) => {
    let seen = 0;
    const count = () => {
      seen += 1;
    };
    dom.window.addEventListener('popstate', count);
    trigger();
    setTimeout(() => {
      dom.window.removeEventListener('popstate', count);
      resolve(seen);
    }, 200);
  });
}

/** Wait until popstate settles on the expected pathname (used when a disarmed
 *  sentinel forwards a real browser Back one step to the prior page). */
function waitForPath(pathname, trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dom.window.removeEventListener('popstate', onPop);
      reject(new Error(`expected pathname ${pathname}, got ${dom.window.location.pathname}`));
    }, 2_000);
    function onPop() {
      if (dom.window.location.pathname === pathname) {
        clearTimeout(timer);
        dom.window.removeEventListener('popstate', onPop);
        setTimeout(resolve, 0);
      }
    }
    dom.window.addEventListener('popstate', onPop);
    trigger();
  });
}

test.beforeEach(() => {
  dom.window.history.replaceState(null, '', '/');
  __resetMobileBackForTest();
});

test('hardware back closes the topmost layer, one layer per press', async () => {
  const closed = [];
  registerMobileBack(() => closed.push('sheet'));
  registerMobileBack(() => closed.push('pane'));

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['pane']);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['pane', 'sheet']);
});

test('a layer that closes itself over an open parent does not traverse history', async () => {
  const closed = [];
  registerMobileBack(() => closed.push('dialog'));
  const releaseMenu = registerMobileBack(() => closed.push('menu'));
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  // The select inside the dialog closed through the UI while dialog stays open:
  // single shared sentinel stays armed with zero history.back() traversals.
  assert.equal(await quietWindow(() => releaseMenu()), 0);
  assert.deepEqual(closed, []);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['dialog']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('a synchronous replacement layer reuses the single sentinel without history traversal', async () => {
  const closed = [];
  const releaseMenu = registerMobileBack(() => closed.push('menu'));

  assert.equal(
    await quietWindow(() => {
      releaseMenu();
      registerMobileBack(() => closed.push('settings'));
    }),
    0
  );
  assert.deepEqual(closed, []);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['settings']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('next-microtask replacement makes zero history.back() calls and stays armed', async () => {
  const closed = [];
  let backCalls = 0;
  let pushCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  try {
    const releaseMenu = registerMobileBack(() => closed.push('menu'));
    assert.equal(pushCalls, 1);
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    releaseMenu();
    assert.equal(dom.window.history.state?.mixdogBack, undefined, '1 -> 0 disarms mixdogBack synchronously in place');
    assert.equal(backCalls, 0, '1 -> 0 must never call history.back()');

    await Promise.resolve().then(() => {
      registerMobileBack(() => closed.push('settings'));
    });

    assert.equal(backCalls, 0, 'next-microtask replacement must see zero history.back() calls');
    assert.equal(pushCalls, 1, 'next-microtask replacement reuses disarmed sentinel in place');
    assert.deepEqual(closed, []);
    assert.equal(dom.window.history.state?.mixdogBack, 1);
  } finally {
    dom.window.history.back = originalBack;
    dom.window.history.pushState = originalPush;
  }

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['settings']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('releasing an entry the back button already consumed is a no-op', async () => {
  const closed = [];
  const release = registerMobileBack(() => closed.push('sheet'));
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['sheet']);

  const length = dom.window.history.length;
  assert.equal(await quietWindow(() => release()), 0);
  assert.equal(dom.window.history.length, length);
});

/** Installs a fake CloseWatcher plus a controllable transient user activation. */
function installCloseWatcher() {
  const watchers = [];
  const activation = { isActive: true };
  dom.window.CloseWatcher = class {
    onclose = null;
    destroyed = false;
    closed = false;
    constructor() {
      watchers.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  };
  Object.defineProperty(dom.window.navigator, 'userActivation', { configurable: true, value: activation });
  return {
    watchers,
    activation,
    triggerClose(watcher) {
      watcher.closed = true;
      watcher.onclose?.();
    },
    live: () => watchers.filter((watcher) => !watcher.destroyed && !watcher.closed),
    uninstall() {
      delete dom.window.CloseWatcher;
      delete dom.window.navigator.userActivation;
    },
  };
}

test('CloseWatcher browsers share one watcher across stacked layers without touching history', async () => {
  const { watchers, live, triggerClose, uninstall } = installCloseWatcher();
  let releaseSheet = () => {};
  let releaseMenu = () => {};
  try {
    const closed = [];
    const length = dom.window.history.length;
    releaseSheet = registerMobileBack(() => closed.push('sheet'));
    releaseMenu = registerMobileBack(() => closed.push('menu'));
    assert.equal(dom.window.history.length, length);
    assert.equal(live().length, 1, 'at most one CloseWatcher is active at any time');

    // Back closes only the topmost layer and creates one fresh watcher for the remaining layer.
    triggerClose(watchers[0]);
    assert.deepEqual(closed, ['menu']);
    releaseMenu();
    assert.equal(live().length, 1);
    assert.equal(watchers.length, 2);

    // A UI-side close of the last layer destroys its watcher quietly.
    assert.equal(await quietWindow(() => releaseSheet()), 0);
    assert.equal(watchers[1].destroyed, true);
    assert.equal(live().length, 0);
    assert.deepEqual(closed, ['menu']);
    assert.equal(dom.window.history.length, length);
  } finally {
    releaseMenu();
    releaseSheet();
    uninstall();
  }
});

test('CloseWatcher works without transient user activation and never touches history', async () => {
  const { watchers, live, activation, triggerClose, uninstall } = installCloseWatcher();
  let releaseSheet = () => {};
  let releaseDock = () => {};
  try {
    activation.isActive = false;
    const closed = [];
    const lengthBefore = dom.window.history.length;
    const stateBefore = dom.window.history.state;

    releaseSheet = registerMobileBack(() => closed.push('sheet'));
    releaseDock = registerMobileBack(() => closed.push('dock'));
    assert.equal(live().length, 1, 'single free CloseWatcher active without user activation');
    assert.equal(watchers.length, 1);
    assert.equal(dom.window.history.length, lengthBefore);
    assert.equal(dom.window.history.state, stateBefore);

    // Closing top layer re-arms one fresh CloseWatcher even without activation.
    triggerClose(watchers[0]);
    assert.deepEqual(closed, ['dock']);
    releaseDock();
    assert.equal(live().length, 1);
    assert.equal(watchers.length, 2);
    assert.equal(dom.window.history.length, lengthBefore);

    triggerClose(watchers[1]);
    assert.deepEqual(closed, ['dock', 'sheet']);
    releaseSheet();
    assert.equal(live().length, 0);
    assert.equal(dom.window.history.length, lengthBefore);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    releaseDock();
    releaseSheet();
    uninstall();
  }
});

test('a popstate while a watcher layer is on top never closes it', async () => {
  const { watchers, uninstall } = installCloseWatcher();
  try {
    const closed = [];
    const release = registerMobileBack(() => closed.push('dock'));
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    assert.deepEqual(closed, []);
    watchers[0].onclose();
    assert.deepEqual(closed, ['dock']);
    release();
  } finally {
    uninstall();
  }
});

test('a replacement layer opened after UI close of a sentinel layer reuses the disarmed sentinel in place', async () => {
  let pushCalls = 0;
  let backCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    const closed = [];
    const releaseOld = registerMobileBack(() => closed.push('old'));
    assert.equal(pushCalls, 1);

    releaseOld();
    assert.equal(backCalls, 0, 'closing sentinel layer never calls history.back()');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    registerMobileBack(() => closed.push('replacement'));
    assert.equal(pushCalls, 1, 'reusing the disarmed sentinel does not push a second history entry');
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    dom.window.history.back = originalBack;
    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['replacement']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.pushState = originalPush;
    dom.window.history.back = originalBack;
  }
});

test('desktop surfaces never arm a sentinel', () => {
  const root = dom.window.document.documentElement;
  root.removeAttribute('data-mixdog-mobile-tabs');
  try {
    const length = dom.window.history.length;
    const release = registerMobileBack(() => {
      throw new Error('a desktop layer must never be closed by history');
    });
    assert.equal(dom.window.history.length, length);
    release();
  } finally {
    root.setAttribute('data-mixdog-mobile-tabs', '');
  }
});

test('simultaneous UI close of parent and child with synchronous replacement keeps single sentinel without history traversal', async () => {
  const closed = [];
  const releaseParent = registerMobileBack(() => closed.push('parent'));
  const releaseChild = registerMobileBack(() => closed.push('child'));
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  assert.equal(
    await quietWindow(() => {
      releaseChild();
      releaseParent();
      registerMobileBack(() => closed.push('next'));
    }),
    0
  );
  assert.deepEqual(closed, []);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['next']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('releasing a lower layer keeps the upper layer armed for Back without history traversal', async () => {
  const closed = [];
  const releaseLower = registerMobileBack(() => closed.push('lower'));
  const releaseUpper = registerMobileBack(() => closed.push('upper'));
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  assert.equal(await quietWindow(() => releaseLower()), 0);
  assert.deepEqual(closed, []);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['upper']);
  releaseUpper();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('useMobileBack ignores inactive retained surfaces and re-arms when active', async () => {
  const closed = [];
  function Layer({ label, open }) {
    useMobileBack(open, () => closed.push(label));
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            SurfaceActiveContext.Provider,
            { value: true },
            React.createElement(Layer, { label: 'active-overlay', open: true })
          ),
          React.createElement(
            SurfaceActiveContext.Provider,
            { value: false },
            React.createElement(Layer, { label: 'parked-overlay', open: true })
          )
        )
      );
    });
    assert.equal(dom.window.history.state?.mixdogBack, 1, 'inactive surface must not push a sentinel');

    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['active-overlay']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    // Becoming active again arms the previously parked layer (same mounted component).
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            SurfaceActiveContext.Provider,
            { value: true },
            React.createElement(Layer, { label: 'active-overlay', open: false })
          ),
          React.createElement(
            SurfaceActiveContext.Provider,
            { value: true },
            React.createElement(Layer, { label: 'parked-overlay', open: true })
          )
        )
      );
    });
    assert.equal(dom.window.history.state?.mixdogBack, 1, 're-activated parked surface should arm its sentinel');

    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['active-overlay', 'parked-overlay']);
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test('shell + UI-closed overlay + immediate replacement never dismisses replacement over 250 ms delay', async () => {
  const closed = [];
  const releaseShell = registerMobileBack(() => closed.push('shell'), 'shell');
  const releaseOverlay = registerMobileBack(() => closed.push('overlay'), 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = () => {
    backCalls += 1;
    setTimeout(() => originalBack(), 250);
  };
  try {
    releaseOverlay();
    registerMobileBack(() => closed.push('replacement'), 'overlay');
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    dom.window.history.back = originalBack;
  }

  assert.equal(backCalls, 0, 'shrinking a non-empty stack must never call history.back()');
  assert.deepEqual(closed, [], 'replacement must stay open with zero user Back presses');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['replacement']);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['replacement', 'shell']);
  releaseShell();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('1 -> 0 + replacement triggers zero late cleanup traversal over 410 ms', async () => {
  const closed = [];
  let backCalls = 0;
  const releaseFirst = registerMobileBack(() => closed.push('first'), 'overlay');

  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = () => {
    backCalls += 1;
    setTimeout(() => originalBack(), 410);
  };
  try {
    releaseFirst();
    await Promise.resolve().then(() => {
      registerMobileBack(() => closed.push('replacement'), 'overlay');
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
  } finally {
    dom.window.history.back = originalBack;
  }

  assert.equal(backCalls, 0, 'programmatic 1 -> 0 must never schedule history.back()');
  assert.deepEqual(closed, [], 'no late cleanup traversal may dismiss replacement without user Back');
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['replacement']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('shell + UI-closed overlay closes shell on the first physical Back even when iframes swallow history.back()', async () => {
  const closed = [];
  const releaseShell = registerMobileBack(() => closed.push('shell'), 'shell');
  const releaseOverlay = registerMobileBack(() => closed.push('overlay'), 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = () => {};
  try {
    releaseOverlay();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    dom.window.history.back = originalBack;
  }

  assert.deepEqual(closed, []);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  // Next physical Back closes shell immediately on the very first press.
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['shell']);
  releaseShell();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('iframe activity + programmatic 1 -> 0 close + replacement closes replacement on first real Back', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  const releaseVisualize = registerMobileBack(() => closed.push('visualize'));
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  // Even if history.back() were swallowed by an embedded iframe during UI close,
  // programmatic 1 -> 0 never calls history.back() and disarms in place.
  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = () => {
    backCalls += 1;
  };
  try {
    releaseVisualize();
    assert.equal(backCalls, 0);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
    registerMobileBack(() => closed.push('replacement'));
  } finally {
    dom.window.history.back = originalBack;
  }

  assert.equal(dom.window.history.state?.mixdogBack, 1);
  // Real Back closes replacement (never swallowed as a cleanup echo).
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['replacement']);
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  // Next Back leaves /app for /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('programmatic 1 -> 0 close with no replacement forwards browser Back directly to /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  const releaseLayer = registerMobileBack(() => closed.push('layer'));
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    releaseLayer();
    assert.equal(backCalls, 0, 'programmatic close disarms in place without calling history.back()');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.back = originalBack;
  }

  // Single real browser Back must land directly on /previous, never stopping on /app.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
  assert.deepEqual(closed, []);
});

test('reload immediately strips stale mixdogBack and Back with no open layer lands on /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const preReloadRelease = registerMobileBack(() => {});
  const staleToken = dom.window.history.state?.mixdogBackToken;
  assert.equal(dom.window.history.state?.mixdogBack, 1);
  assert.equal(typeof staleToken, 'string');

  // Simulate renderer reload while browser preserves window.history.state.
  __resetMobileBackForTest();
  void preReloadRelease;
  assert.equal(dom.window.history.state?.mixdogBack, undefined, 'reload immediately strips stale mixdogBack');
  assert.notEqual(dom.window.history.state?.mixdogBackToken, staleToken);

  // With no layer open after reload, a single Back lands directly on /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('reload pushes a fresh sentinel for a new layer to truncate forward entries; Back 1 closes layer, Back 2 lands on /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const preReloadRelease = registerMobileBack(() => {});
  const staleToken = dom.window.history.state?.mixdogBackToken;
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  __resetMobileBackForTest();
  void preReloadRelease;
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  const closed = [];
  try {
    registerMobileBack(() => closed.push('after-reload'));
  } finally {
    dom.window.history.pushState = originalPush;
  }

  assert.equal(pushCalls, 1, 'opening a layer after reload pushes a fresh sentinel to truncate stale forward entries');
  assert.equal(dom.window.history.state?.mixdogBack, 1);
  assert.notEqual(dom.window.history.state?.mixdogBackToken, staleToken);

  // Back #1 closes the layer and lands on /app with clean state.
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['after-reload']);
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  // Back #2 steps past the prior-boot disarmed sentinel and /app directly to /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('returning false from Back handler re-arms layer so busy dialogs absorb repeated Back presses', async () => {
  const closed = [];
  const busy = true;
  const releaseParent = registerMobileBack(() => closed.push('parent'), 'overlay');
  const releaseChild = registerMobileBack(() => {
    closed.push(busy ? 'child-veto' : 'child-close');
    if (busy) return false;
  }, 'modal');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  // Two Back presses while busy must both be absorbed by the child without reaching parent.
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['child-veto']);
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['child-veto', 'child-veto']);
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  // UI-side close after veto leaves the shared sentinel cleanly armed for parent without history traversal.
  assert.equal(await quietWindow(() => releaseChild()), 0);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['child-veto', 'child-veto', 'parent']);
  releaseParent();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('single CloseWatcher ensures prompt veto in same activation never closes parent dock', async () => {
  const { watchers, live, triggerClose, uninstall } = installCloseWatcher();
  let releaseDock = () => {};
  let releasePrompt = () => {};
  try {
    const closed = [];
    let busy = true;
    // Dock and prompt both open during the same transient user activation.
    releaseDock = registerMobileBack(() => closed.push('dock'), 'shell');
    releasePrompt = registerMobileBack(() => {
      closed.push(busy ? 'prompt-veto' : 'prompt-close');
      if (busy) return false;
    }, 'modal');

    // Only ONE CloseWatcher exists, so they can never share a browser close-watcher group.
    assert.equal(live().length, 1, 'at most one CloseWatcher active across dock + prompt');
    assert.equal(watchers.length, 1);

    // Back #1 invokes ONLY prompt veto, NEVER parent dock, and re-arms one fresh watcher.
    triggerClose(watchers[0]);
    assert.deepEqual(closed, ['prompt-veto']);
    assert.equal(live().length, 1);
    assert.equal(watchers.length, 2);

    // Once unblocked, Back #2 closes prompt and re-arms one fresh watcher for dock.
    busy = false;
    triggerClose(watchers[1]);
    assert.deepEqual(closed, ['prompt-veto', 'prompt-close']);
    assert.equal(live().length, 1);
    assert.equal(watchers.length, 3);

    // Back #3 closes dock and leaves zero active watchers.
    triggerClose(watchers[2]);
    assert.deepEqual(closed, ['prompt-veto', 'prompt-close', 'dock']);
    assert.equal(live().length, 0);
  } finally {
    releasePrompt();
    releaseDock();
    uninstall();
  }
});

test('priority tiers close higher tiers first regardless of registration order, keeping LIFO within a tier', async () => {
  const closed = [];
  // Register out of visual order: overlay first, then shell, then tab, then another overlay.
  registerMobileBack(() => closed.push('overlay-1'), 'overlay');
  registerMobileBack(() => closed.push('shell'), 'shell');
  registerMobileBack(() => closed.push('tab'), 'tab');
  registerMobileBack(() => closed.push('overlay-2'), 'overlay');
  registerMobileBack(() => closed.push('shell-sub'), 'shell-sub');
  assert.equal(dom.window.history.state?.mixdogBack, 5);

  for (let i = 0; i < 5; i += 1) {
    await afterPopState(() => dom.window.history.back());
  }
  assert.deepEqual(closed, ['overlay-2', 'overlay-1', 'shell-sub', 'shell', 'tab']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('2-layer history fallback closes layer 2 onto layer 1 sentinel with zero pushState in popstate', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  try {
    registerMobileBack(() => closed.push('layer-1'), 'shell');
    registerMobileBack(() => closed.push('layer-2'), 'overlay');
    assert.equal(pushCalls, 2, 'each stacked layer pushes its sentinel during open');
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    const pushesBeforeBack = pushCalls;
    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['layer-2']);
    assert.equal(dom.window.history.state?.mixdogBack, 1);
    assert.equal(pushCalls, pushesBeforeBack, 'popstate for layer 2 must make zero pushState calls');

    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['layer-2', 'layer-1']);
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
    assert.equal(pushCalls, pushesBeforeBack, 'popstate for layer 1 must make zero pushState calls');

    await waitForPath('/previous', () => dom.window.history.back());
    assert.equal(dom.window.location.pathname, '/previous');
  } finally {
    dom.window.history.pushState = originalPush;
  }
});

test('retained iframe push buries parent sentinel so replacement pushes fresh sentinel on top', async () => {
  // Model browser joint session history where an embedded iframe appends an
  // entry that increases parent `history.length` without changing parent
  // `history.state`, and a Back press off an iframe entry only traverses the
  // iframe without firing parent `popstate`.
  const entries = [
    { kind: 'parent', url: '/previous', state: { page: 'previous' } },
    { kind: 'parent', url: '/app', state: { page: 'app' } },
  ];
  let cursor = 1;
  let iframeTraversals = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const jointHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      entries.push({ kind: 'parent', url: url ?? parentUrl, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = {
        kind: 'parent',
        url: url ?? entries[parentIdx].url,
        state,
      };
    },
    back() {
      if (cursor <= 0) return;
      const prevParentIdx = latestParentIndexAtOrBefore(cursor);
      const leaving = entries[cursor];
      cursor -= 1;
      const nextParentIdx = latestParentIndexAtOrBefore(cursor);
      if (leaving.kind === 'iframe' && prevParentIdx === nextParentIdx) {
        // Real browser behavior: traversing an iframe history entry does not
        // fire popstate on the parent window.
        iframeTraversals += 1;
        return;
      }
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
      });
    },
  };

  const iframePush = (url) => {
    entries.length = cursor + 1;
    entries.push({ kind: 'iframe', url, state: null });
    cursor = entries.length - 1;
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: jointHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: jointHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    const releaseVisualize = registerMobileBack(() => closed.push('visualize'));
    assert.equal(jointHistory.length, 3);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Retained iframe navigates after the parent sentinel: joint history grows
    // to 4 while parent `history.state` still points at the buried sentinel.
    iframePush('/iframe-step-2');
    assert.equal(jointHistory.length, 4);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Programmatic close disarms in place without history.back().
    releaseVisualize();
    assert.equal(jointHistory.state?.mixdogBack, undefined);

    // Replacement layer MUST push a fresh sentinel on top of the iframe entry
    // instead of reusing the buried parent sentinel via replaceState.
    registerMobileBack(() => closed.push('replacement'));
    assert.equal(jointHistory.length, 5, 'replacement pushes a fresh sentinel above the iframe entry');
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // First Back closes replacement immediately rather than only traversing the iframe.
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['replacement']);
    assert.equal(iframeTraversals, 0, 'first Back must close replacement instead of traversing the iframe');
    assert.equal(jointHistory.state?.mixdogBack, undefined);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('reload over sequenced 2-sentinel stack steps through both sentinels and /app to /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');
  registerMobileBack(() => {}, 'shell');
  registerMobileBack(() => {}, 'overlay');

  __resetMobileBackForTest();
  assert.equal(dom.window.history.state?.mixdogBack, undefined, 'reload adopts top sentinel as disarmed');

  // With no open layer, a single Back steps past sentinel 1 and /app directly onto /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('Forward onto a previously popped sentinel adopts it disarmed and Back lands on /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  registerMobileBack(() => closed.push('layer'));
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  // Close last layer with Back -> lands on /app.
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['layer']);
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  // Press Forward onto the previously popped sentinel.
  await afterPopState(() => dom.window.history.forward());
  assert.equal(dom.window.history.state?.mixdogBack, undefined, 'forwarded sentinel must stay disarmed');
  assert.equal(typeof dom.window.history.state?.mixdogBackToken, 'string');

  // Pressing Back now forwards past /app directly onto /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('Back then retained iframe replacing forward entry (length 4 -> 4) pushes fresh sentinel on replacement', async () => {
  const entries = [
    { kind: 'parent', url: '/previous', state: { page: 'previous' } },
    { kind: 'parent', url: '/app', state: { page: 'app' } },
  ];
  let cursor = 1;
  let iframeTraversals = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const jointHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      entries.push({ kind: 'parent', url: url ?? parentUrl, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = {
        kind: 'parent',
        url: url ?? entries[parentIdx].url,
        state,
      };
    },
    back() {
      if (cursor <= 0) return;
      const prevParentIdx = latestParentIndexAtOrBefore(cursor);
      const leaving = entries[cursor];
      cursor -= 1;
      const nextParentIdx = latestParentIndexAtOrBefore(cursor);
      if (leaving.kind === 'iframe' && prevParentIdx === nextParentIdx) {
        iframeTraversals += 1;
        return;
      }
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
      });
    },
  };

  const iframePush = (url) => {
    entries.length = cursor + 1;
    entries.push({ kind: 'iframe', url, state: null });
    cursor = entries.length - 1;
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: jointHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: jointHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    const releaseLower = registerMobileBack(() => closed.push('lower'), 'shell');
    registerMobileBack(() => closed.push('upper'), 'overlay');
    assert.equal(jointHistory.length, 4);
    assert.equal(jointHistory.state?.mixdogBack, 2);

    // Back closes upper layer, leaving 1 forward entry (cursor = 2, length = 4).
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['upper']);
    assert.equal(jointHistory.length, 4);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Retained iframe navigates: replaces forward entry so length stays 4 -> 4
    // while parent `history.state` still holds lower's sentinel token.
    iframePush('/iframe-step-2');
    assert.equal(jointHistory.length, 4);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Close lower via UI (1 -> 0), then open replacement (0 -> 1).
    releaseLower();
    assert.equal(jointHistory.state?.mixdogBack, undefined);

    registerMobileBack(() => closed.push('replacement'), 'overlay');
    assert.equal(
      jointHistory.length,
      5,
      'replacement must push above the iframe entry instead of reusing buried sentinel'
    );
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // First Back closes replacement instead of traversing the iframe.
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['upper', 'replacement']);
    assert.equal(iframeTraversals, 0, 'first Back must close replacement, never traverse iframe');
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('dock + vetoing prompt pressed Back twice performs zero pushState inside popstate', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };

  try {
    const closed = [];
    let busy = true;
    const releaseDock = registerMobileBack(() => closed.push('dock'), 'shell');
    const releasePrompt = registerMobileBack(() => {
      closed.push(busy ? 'prompt-veto' : 'prompt-close');
      if (busy) return false;
    }, 'modal');
    assert.equal(pushCalls, 2);
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    const pushesBeforeBack = pushCalls;
    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['prompt-veto']);
    assert.equal(pushCalls, pushesBeforeBack, 'veto #1 must make zero pushState calls inside popstate');
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['prompt-veto', 'prompt-veto']);
    assert.equal(pushCalls, pushesBeforeBack, 'veto #2 must make zero pushState calls inside popstate');
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    // Once unblocked, Back closes prompt onto dock's pre-pushed sentinel, then dock onto /app.
    busy = false;
    await afterPopState(() => dom.window.history.back());
    releasePrompt();
    assert.deepEqual(closed, ['prompt-veto', 'prompt-veto', 'prompt-close']);
    assert.equal(pushCalls, pushesBeforeBack);
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    await afterPopState(() => dom.window.history.back());
    releaseDock();
    assert.deepEqual(closed, ['prompt-veto', 'prompt-veto', 'prompt-close', 'dock']);
    assert.equal(pushCalls, pushesBeforeBack);
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.pushState = originalPush;
  }
});

test('2 layers -> Back x2 -> Forward x2 stays on /app without calling history.back(), then Back lands on /previous', async () => {
  dom.window.history.pushState({ page: 'previous' }, '', '/previous');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  registerMobileBack(() => closed.push('layer-1'), 'shell');
  registerMobileBack(() => closed.push('layer-2'), 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  await afterPopState(() => dom.window.history.back());
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['layer-2', 'layer-1']);
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    // Forward #1 lands on sentinel 1 -> adopted disarmed, zero history.back().
    await afterPopState(() => dom.window.history.forward());
    assert.equal(backCalls, 0, 'Forward #1 must not trigger history.back()');
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    // Forward #2 lands on sentinel 2 (higher same-boot seq) -> recognized as Forward, zero history.back().
    await afterPopState(() => dom.window.history.forward());
    assert.equal(backCalls, 0, 'Forward #2 must not be mistaken for Back');
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.back = originalBack;
  }

  // Subsequent Back steps past both disarmed sentinels and /app directly onto /previous.
  await waitForPath('/previous', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/previous');
});

test('non-native CloseWatcher browser reload over legacy sentinel leaves history.state untouched', async () => {
  const { watchers, triggerClose, uninstall } = installCloseWatcher();
  const originalReplace = dom.window.history.replaceState.bind(dom.window.history);
  let replaceCalls = 0;
  let release = () => {};
  try {
    originalReplace({ mixdogBack: 1 }, '', '/app');
    dom.window.history.replaceState = (...args) => {
      replaceCalls += 1;
      return originalReplace(...args);
    };

    // Simulate reload on a non-native CloseWatcher browser.
    __resetMobileBackForTest();
    assert.equal(replaceCalls, 0, 'CloseWatcher boot must never rewrite history.state');
    assert.deepEqual(dom.window.history.state, { mixdogBack: 1 });

    // Opening and closing a layer via CloseWatcher also never touches history.state.
    const closed = [];
    release = registerMobileBack(() => closed.push('sheet'));
    triggerClose(watchers[0]);
    assert.deepEqual(closed, ['sheet']);
    release();
    assert.equal(replaceCalls, 0, 'CloseWatcher layer lifecycle must never call replaceState');
    assert.deepEqual(dom.window.history.state, { mixdogBack: 1 });
  } finally {
    release();
    dom.window.history.replaceState = originalReplace;
    uninstall();
  }
});

test('reload on upper sentinel -> open 1 layer -> Back -> Forward stays on /app without sending user to /prev', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  // Boot #1: open two layers pushing lower (seq 1) and upper (seq 2) sentinels.
  registerMobileBack(() => {}, 'shell');
  registerMobileBack(() => {}, 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 2);
  const upperSeqBeforeReload = dom.window.history.state?.mixdogBackSeq;
  assert.equal(typeof upperSeqBeforeReload, 'number');

  // Reload on the upper sentinel: adopts it disarmed while preserving seq.
  __resetMobileBackForTest();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
  assert.equal(dom.window.history.state?.mixdogBackSeq, upperSeqBeforeReload);

  // Open one layer (pushes seq 3 above seq 2), then press Back to close it (lands on seq 2).
  const closed = [];
  registerMobileBack(() => closed.push('post-reload-layer'), 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 1);
  const postReloadSeq = dom.window.history.state?.mixdogBackSeq;
  assert.ok(postReloadSeq > upperSeqBeforeReload);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['post-reload-layer']);
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
  assert.equal(
    dom.window.history.state?.mixdogBackSeq,
    upperSeqBeforeReload,
    'prior-boot sentinel must preserve its original mixdogBackSeq strictly below the post-reload sentinel'
  );

  // Press Forward onto the upper sentinel: must recognize Forward, zero history.back(), stay on /app.
  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    await afterPopState(() => dom.window.history.forward());
    assert.equal(backCalls, 0, 'Forward onto upper sentinel after reload must never call history.back()');
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.back = originalBack;
  }

  // Subsequent Back steps cleanly past both disarmed sentinels and /app to /prev.
  await waitForPath('/prev', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/prev');
});

test('reopening a child over a persistent parent keeps history.length constant across repeated cycles', async () => {
  const closed = [];
  const releaseParent = registerMobileBack(() => closed.push('parent'), 'shell');
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  registerMobileBack(() => closed.push('child-0'), 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 2);
  const steadyLength = dom.window.history.length;

  for (let cycle = 1; cycle <= 4; cycle += 1) {
    await afterPopState(() => dom.window.history.back());
    assert.equal(closed.at(-1), `child-${cycle - 1}`);
    assert.equal(dom.window.history.state?.mixdogBack, 1, `parent stays armed on cycle ${cycle}`);

    registerMobileBack(() => closed.push(`child-${cycle}`), 'overlay');
    assert.equal(dom.window.history.state?.mixdogBack, 2);
    assert.equal(dom.window.history.length, steadyLength, `history.length must stay constant on reopen cycle ${cycle}`);
  }

  // Two Backs close the active child and persistent parent cleanly.
  await afterPopState(() => dom.window.history.back());
  await afterPopState(() => dom.window.history.back());
  releaseParent();
  assert.deepEqual(closed, ['child-0', 'child-1', 'child-2', 'child-3', 'child-4', 'parent']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
});

test('at Chromium 50-entry history cap, UI close + replacement pushes fresh sentinel above iframe entry', async () => {
  const MAX_CAP = 50;
  const entries = [];
  for (let i = 0; i < MAX_CAP - 1; i += 1) {
    entries.push({ kind: 'parent', url: `/page-${i}`, state: { page: i } });
  }
  entries.push({ kind: 'parent', url: '/app', state: { page: 'app' } });
  let cursor = entries.length - 1;
  let iframeTraversals = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const appendCapped = (entry) => {
    entries.length = cursor + 1;
    entries.push(entry);
    if (entries.length > MAX_CAP) {
      entries.shift();
    }
    cursor = entries.length - 1;
  };

  const cappedHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      appendCapped({ kind: 'parent', url: url ?? parentUrl, state });
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = {
        kind: 'parent',
        url: url ?? entries[parentIdx].url,
        state,
      };
    },
    back() {
      if (cursor <= 0) return;
      const prevParentIdx = latestParentIndexAtOrBefore(cursor);
      const leaving = entries[cursor];
      cursor -= 1;
      const nextParentIdx = latestParentIndexAtOrBefore(cursor);
      if (leaving.kind === 'iframe' && prevParentIdx === nextParentIdx) {
        iframeTraversals += 1;
        return;
      }
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: cappedHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: cappedHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    const releaseLayer = registerMobileBack(() => closed.push('visualize'), 'overlay');
    assert.equal(cappedHistory.length, MAX_CAP);
    assert.equal(cappedHistory.state?.mixdogBack, 1);

    // Retained iframe pushes at the 50-entry cap: length stays 50 and no parent popstate fires.
    appendCapped({ kind: 'iframe', url: '/iframe-2', state: null });
    assert.equal(cappedHistory.length, MAX_CAP);
    assert.equal(cappedHistory.state?.mixdogBack, 1);

    // Close layer via UI (1 -> 0) and open replacement (0 -> 1).
    releaseLayer();
    assert.equal(cappedHistory.state?.mixdogBack, undefined);

    registerMobileBack(() => closed.push('replacement'), 'overlay');
    assert.equal(entries[cursor].kind, 'parent', 'replacement must push a fresh sentinel on top of the iframe entry');
    assert.equal(cappedHistory.state?.mixdogBack, 1);

    // First Back closes replacement instead of traversing the iframe.
    await afterPopState(() => cappedHistory.back());
    assert.deepEqual(closed, ['replacement']);
    assert.equal(iframeTraversals, 0, 'first Back must close replacement, never traverse iframe');
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('presence of an iframe in DOM prevents reusing a disarmed sentinel in place', async () => {
  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };

  try {
    const closed = [];
    const releaseFirst = registerMobileBack(() => closed.push('first'), 'overlay');
    assert.equal(pushCalls, 1);

    releaseFirst();
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    registerMobileBack(() => closed.push('replacement'), 'overlay');
    assert.equal(pushCalls, 2, 'subframe presence must push a fresh sentinel instead of reusing disarmed entry');
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    await afterPopState(() => dom.window.history.back());
    assert.deepEqual(closed, ['replacement']);
  } finally {
    dom.window.history.pushState = originalPush;
    iframe.remove();
  }
});

test('reload on lower legacy sequenceless sentinel -> Forward onto upper legacy sentinel stays on /app without history.back()', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');
  dom.window.history.pushState({ mixdogBack: 1 }, '', '/app');
  dom.window.history.pushState({ mixdogBack: 2 }, '', '/app');

  // Go Back to the lower legacy sentinel, then reload (no push in new boot).
  await afterPopState(() => dom.window.history.back());
  __resetMobileBackForTest();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);
  assert.equal(dom.window.history.state?.mixdogBackSeq, undefined);

  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    // Forward onto the upper sequenceless legacy sentinel has unknown direction:
    // must adopt it disarmed and stay put without calling history.back().
    await afterPopState(() => dom.window.history.forward());
    assert.equal(backCalls, 0, 'Forward onto sequenceless legacy sentinel must never call history.back()');
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.back = originalBack;
  }

  // Once this boot pushes a sentinel (truncating forward entries), legacy entries
  // below are proven behind us and Back skips straight through them to /prev.
  const release = registerMobileBack(() => {}, 'overlay');
  release();
  await waitForPath('/prev', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/prev');
});

test('forwardingDisarmed hitting oldest entry at history cap does not hijack a later Forward', async () => {
  // Simulate 50-entry cap where `/app` was evicted so index 0 is a disarmed sentinel.
  const entries = [
    { url: '/app', state: { mixdogBackToken: 'old:48', mixdogBackSeq: 48 } },
    { url: '/app', state: { mixdogBackToken: 'old:49', mixdogBackSeq: 49 } },
    { url: '/app', state: { mixdogBackToken: 'old:50', mixdogBackSeq: 50 } },
  ];
  let cursor = 2;
  let backCalls = 0;

  const cappedHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      entries.push({ url: url ?? entries[cursor].url, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: url ?? entries[cursor].url, state };
    },
    back() {
      backCalls += 1;
      if (cursor <= 0) return; // no-op at index 0, no popstate
      cursor -= 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: cappedHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: cappedHistory });
  __resetMobileBackForTest();

  try {
    // Press Back from index 2 (seq 50) -> steps to index 1 (seq 49) -> steps to
    // index 0 (seq 48) -> calls back() at index 0 (no-op, no popstate).
    cappedHistory.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cursor, 0, 'Back stops at oldest entry index 0');

    const backCallsBeforeForward = backCalls;
    // Now user presses Forward to index 1 (seq 49 > 48): must clear
    // forwardingDisarmed and stay at index 1 with zero extra history.back() calls.
    await afterPopState(() => cappedHistory.forward());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cursor, 1, 'Forward must stay on user-selected entry index 1');
    assert.equal(backCalls, backCallsBeforeForward, 'Forward must not be hijacked by stuck forwardingDisarmed');
    assert.equal(cappedHistory.state?.mixdogBack, undefined);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('reload on lower sentinel pushes fresh sentinel when opening a layer, truncating stale forward entry', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  registerMobileBack(() => {}, 'shell');
  registerMobileBack(() => {}, 'overlay');
  // Go Back to parent sentinel, leaving child sentinel in forward history.
  await afterPopState(() => dom.window.history.back());
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  // Reload on lower sentinel.
  __resetMobileBackForTest();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  const closed = [];
  try {
    registerMobileBack(() => closed.push('new-layer'), 'overlay');
  } finally {
    dom.window.history.pushState = originalPush;
  }

  assert.equal(pushCalls, 1, 'opening a layer after reload must push a fresh sentinel to truncate forward entries');
  // Forward must now be a no-op because the stale forward child entry was truncated.
  assert.equal(await quietWindow(() => dom.window.history.forward()), 0, 'stale forward entry must be truncated');

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['new-layer']);
  await waitForPath('/prev', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/prev');
});

test('closing grandchild via UI then Back out of child keeps history.length constant when reopening child', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  const releaseParent = registerMobileBack(() => closed.push('parent'), 'shell');
  registerMobileBack(() => closed.push('child-1'), 'overlay');
  const releaseGrandchild = registerMobileBack(() => closed.push('grandchild'), 'modal');
  assert.equal(dom.window.history.state?.mixdogBack, 3);
  const lengthAfterGrandchild = dom.window.history.length;

  // Close grandchild via UI (3 -> 2), then press Back out of child (2 -> 1, landing on armed parent).
  releaseGrandchild();
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['child-1']);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  // Reopening child (1 -> 2) must push ONLY 1 fresh sentinel replacing the forward slot,
  // keeping history.length constant instead of rebuilding both parent and child.
  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  try {
    registerMobileBack(() => closed.push('child-2'), 'overlay');
  } finally {
    dom.window.history.pushState = originalPush;
  }

  assert.equal(pushCalls, 1, 'reopening child over armed parent must push only 1 delta sentinel');
  assert.equal(dom.window.history.length, lengthAfterGrandchild, 'history.length must stay constant');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ['child-1', 'child-2']);
  assert.equal(dom.window.history.state?.mixdogBack, 1);

  await afterPopState(() => dom.window.history.back());
  releaseParent();
  assert.deepEqual(closed, ['child-1', 'child-2', 'parent']);
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  await waitForPath('/prev', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/prev');
});

test('multi-step history jump across a vetoing top layer runs the veto callback only once', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const closed = [];
  let busy = true;
  const releaseDock = registerMobileBack(() => closed.push('dock'), 'shell');
  const releasePrompt = registerMobileBack(() => {
    closed.push(busy ? 'prompt-veto' : 'prompt-close');
    if (busy) return false;
  }, 'modal');
  assert.equal(dom.window.history.state?.mixdogBack, 2);

  let pushCalls = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushCalls += 1;
    return originalPush(...args);
  };
  try {
    // Jump 2 steps directly from S2 to /app (browser history menu).
    // Restoration traverses /app -> S1 -> S2 and must invoke veto ONLY ONCE.
    await afterPopState(() => dom.window.history.go(-2));
    assert.deepEqual(closed, ['prompt-veto'], 'multi-step jump across vetoing layer must invoke veto callback once');
    assert.equal(pushCalls, 0, 'multi-step veto restoration must make zero pushState calls');
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    // Unblock and verify both layers still close cleanly one per Back.
    busy = false;
    await afterPopState(() => dom.window.history.back());
    releasePrompt();
    assert.deepEqual(closed, ['prompt-veto', 'prompt-close']);
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    await afterPopState(() => dom.window.history.back());
    releaseDock();
    assert.deepEqual(closed, ['prompt-veto', 'prompt-close', 'dock']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    dom.window.history.pushState = originalPush;
  }
});

test('legacy Forward after reload + push + Back to /app + Forward twice stays put without history.back()', async () => {
  // Start at `/app` as the oldest entry (no `/prev`), with two legacy sentinels L1, L2.
  const entries = [
    { url: '/app', state: { page: 'app' } },
    { url: '/app', state: { mixdogBack: 1 } },
    { url: '/app', state: { mixdogBack: 2 } },
  ];
  let cursor = 2;
  let backCalls = 0;

  const mockHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      entries.push({ url: url ?? entries[cursor].url, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: url ?? entries[cursor].url, state };
    },
    back() {
      backCalls += 1;
      if (cursor <= 0) return;
      cursor -= 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: mockHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: mockHistory });
  __resetMobileBackForTest();

  try {
    // Reload on L2, open a layer (pushes current-boot S3), close S3 via UI,
    // and press Back to land on `/app` (stepping off S3 -> L2 -> L1 -> /app).
    const release = registerMobileBack(() => {}, 'overlay');
    assert.equal(cursor, 3);
    release();

    mockHistory.back();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cursor, 0, 'Back off pushed S3 reaches /app');

    // Now press Forward twice (onto L1, then L2): must NOT be reversed back to /app!
    const backCallsBeforeForward = backCalls;
    await afterPopState(() => mockHistory.forward());
    assert.equal(cursor, 1);
    assert.equal(backCalls, backCallsBeforeForward, 'Forward #1 onto L1 must not call history.back()');

    await afterPopState(() => mockHistory.forward());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cursor, 2, 'Forward #2 onto L2 must stay on L2 instead of reversing to /app');
    assert.equal(backCalls, backCallsBeforeForward, 'Forward #2 onto L2 must not call history.back()');
    assert.equal(mockHistory.state?.mixdogBack, undefined);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('veto restoration after history jump before iframe jumps atomically over iframe via history.go(delta)', async () => {
  const entries = [
    { kind: 'parent', url: '/prev', state: { page: 'prev' } },
    { kind: 'parent', url: '/app', state: { page: 'app' } },
  ];
  let cursor = 1;
  let iframeStalls = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const navigateBy = (delta) => {
    const target = cursor + delta;
    if (target < 0 || target >= entries.length || target === cursor) return;
    const prevParentIdx = latestParentIndexAtOrBefore(cursor);
    const targetEntry = entries[target];
    cursor = target;
    const nextParentIdx = latestParentIndexAtOrBefore(cursor);
    if (targetEntry.kind === 'iframe' && prevParentIdx === nextParentIdx) {
      iframeStalls += 1;
      return;
    }
    queueMicrotask(() => {
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
    });
  };

  const jointHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      entries.push({ kind: 'parent', url: url ?? parentUrl, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = { kind: 'parent', url: url ?? entries[parentIdx].url, state };
    },
    back() {
      navigateBy(-1);
    },
    forward() {
      navigateBy(1);
    },
    go(delta) {
      navigateBy(delta);
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: jointHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: jointHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    let busy = true;
    const releaseDock = registerMobileBack(() => closed.push('dock'), 'shell');
    const s1Cursor = cursor;

    // Dock's iframe navigates (F1).
    entries.push({ kind: 'iframe', url: '/iframe-1', state: null });
    cursor = entries.length - 1;

    // Vetoing prompt opens above F1.
    const releasePrompt = registerMobileBack(() => {
      closed.push(busy ? 'prompt-veto' : 'prompt-close');
      if (busy) return false;
    }, 'modal');
    const topCursor = cursor;
    assert.equal(jointHistory.state?.mixdogBack, 2);

    // History menu jumps straight to S1 (before F1).
    await afterPopState(() => jointHistory.go(s1Cursor - topCursor));
    assert.deepEqual(closed, ['prompt-veto'], 'veto callback runs once');
    assert.equal(iframeStalls, 0, 'atomic history.go(delta) must skip over intermediate iframe entry');
    assert.equal(cursor, topCursor, 'restoration lands directly back on top sentinel');
    assert.equal(jointHistory.state?.mixdogBack, 2);

    // Opening another layer afterward arms normally and closes on Back.
    registerMobileBack(() => closed.push('new-modal'), 'modal');
    assert.equal(jointHistory.state?.mixdogBack, 3);
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['prompt-veto', 'new-modal']);

    busy = false;
    releasePrompt();
    releaseDock();
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('stalled veto restoration on iframe never blocks future layers from arming', async () => {
  // Simulate cap-level restoration where historyPos is unavailable and
  // history.forward() advances onto an iframe entry (no parent popstate).
  const entries = [];
  for (let i = 0; i < 49; i += 1) {
    entries.push({ kind: 'parent', url: `/p-${i}`, state: { page: i } });
  }
  entries.push({ kind: 'parent', url: '/app', state: { page: 'app' } });
  let cursor = entries.length - 1;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const appendCapped = (entry) => {
    entries.length = cursor + 1;
    entries.push(entry);
    if (entries.length > 50) entries.shift();
    cursor = entries.length - 1;
  };

  const navigateBy = (delta) => {
    const target = cursor + delta;
    if (target < 0 || target >= entries.length || target === cursor) return;
    const prevParentIdx = latestParentIndexAtOrBefore(cursor);
    const targetEntry = entries[target];
    cursor = target;
    const nextParentIdx = latestParentIndexAtOrBefore(cursor);
    if (targetEntry.kind === 'iframe' && prevParentIdx === nextParentIdx) {
      return; // iframe-only traversal: no parent popstate
    }
    queueMicrotask(() => {
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
    });
  };

  const cappedHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      appendCapped({ kind: 'parent', url: url ?? parentUrl, state });
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = { kind: 'parent', url: url ?? entries[parentIdx].url, state };
    },
    back() {
      navigateBy(-1);
    },
    forward() {
      navigateBy(1);
    },
    go(delta) {
      navigateBy(delta);
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: cappedHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: cappedHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    const releaseDock = registerMobileBack(() => closed.push('dock'), 'shell');
    appendCapped({ kind: 'iframe', url: '/iframe-cap', state: null });
    const releasePrompt = registerMobileBack(() => {
      closed.push('prompt-veto');
      return false;
    }, 'modal');

    // Jump back before the iframe entry: at cap, historyPos is null so
    // history.forward() lands on the iframe entry and stalls without popstate.
    cappedHistory.go(-3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(closed, ['prompt-veto']);

    // Opening a new layer MUST clear the stalled restoration and arm normally.
    registerMobileBack(() => closed.push('later-layer'), 'modal');
    assert.equal(cappedHistory.state?.mixdogBack, 3);
    assert.equal(entries[cursor].kind, 'parent');

    await afterPopState(() => cappedHistory.back());
    assert.deepEqual(closed, ['prompt-veto', 'later-layer']);
    releasePrompt();
    releaseDock();
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('reopening child when retained iframe navigated into vacated forward slot rebuilds both sentinels above iframe', async () => {
  const entries = [
    { kind: 'parent', url: '/prev', state: { page: 'prev' } },
    { kind: 'parent', url: '/app', state: { page: 'app' } },
  ];
  let cursor = 1;
  let iframeTraversals = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const jointHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      entries.push({ kind: 'parent', url: url ?? parentUrl, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = { kind: 'parent', url: url ?? entries[parentIdx].url, state };
    },
    back() {
      if (cursor <= 0) return;
      const prevParentIdx = latestParentIndexAtOrBefore(cursor);
      const leaving = entries[cursor];
      cursor -= 1;
      const nextParentIdx = latestParentIndexAtOrBefore(cursor);
      if (leaving.kind === 'iframe' && prevParentIdx === nextParentIdx) {
        iframeTraversals += 1;
        return;
      }
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
      });
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: jointHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: jointHistory });
  __resetMobileBackForTest();

  try {
    const closed = [];
    const releaseParent = registerMobileBack(() => closed.push('parent'), 'shell');
    registerMobileBack(() => closed.push('child-1'), 'overlay');
    assert.equal(jointHistory.length, 4);

    // Back closes child-1, landing on parent's sentinel with 1 forward slot.
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['child-1']);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Retained iframe navigates into the vacated forward slot (length stays 4).
    entries.length = cursor + 1;
    entries.push({ kind: 'iframe', url: '/iframe-vacated', state: null });
    cursor = entries.length - 1;
    assert.equal(jointHistory.length, 4);

    // Reopening child must rebuild fresh sentinels for BOTH parent and child above F1.
    registerMobileBack(() => closed.push('child-2'), 'overlay');
    assert.equal(jointHistory.state?.mixdogBack, 2);

    // Back #1 closes child-2, Back #2 closes parent with ZERO iframe traversals.
    await afterPopState(() => jointHistory.back());
    assert.deepEqual(closed, ['child-1', 'child-2']);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    await afterPopState(() => jointHistory.back());
    releaseParent();
    assert.deepEqual(closed, ['child-1', 'child-2', 'parent']);
    assert.equal(iframeTraversals, 0, 'neither child nor parent Back may traverse the iframe');
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('at 50-entry cap with NO iframe, repeated UI open/close reuses sentinel without evicting /prev', async () => {
  const MAX_CAP = 50;
  const entries = [];
  for (let i = 0; i < MAX_CAP - 2; i += 1) {
    entries.push({ url: `/older-${i}`, state: { page: i } });
  }
  entries.push({ url: '/prev', state: { page: 'prev' } });
  entries.push({ url: '/app', state: { page: 'app' } });
  let cursor = entries.length - 1;
  let pushCalls = 0;

  const cappedHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      pushCalls += 1;
      entries.length = cursor + 1;
      entries.push({ url: url ?? entries[cursor].url, state });
      if (entries.length > MAX_CAP) entries.shift();
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: url ?? entries[cursor].url, state };
    },
    back() {
      if (cursor <= 0) return;
      cursor -= 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
      });
    },
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: cappedHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: cappedHistory });
  __resetMobileBackForTest();

  try {
    // Open and UI-close a single layer 50 times at the 50-entry cap with no iframe.
    for (let i = 0; i < 50; i += 1) {
      const release = registerMobileBack(() => {}, 'overlay');
      assert.equal(cappedHistory.state?.mixdogBack, 1);
      release();
      assert.equal(cappedHistory.state?.mixdogBack, undefined);
    }

    assert.equal(pushCalls, 1, 'repeated UI open/close with no iframe reuses the single sentinel in place');
    assert.ok(
      entries.some((entry) => entry.url === '/prev'),
      '/prev must NOT be evicted from capped history'
    );

    // Single real Back steps past the disarmed sentinel and /app directly onto /prev.
    cappedHistory.back();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(entries[cursor].url, '/prev', 'Back must land directly on /prev');
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('vetoed dialog after iframe navigation + UI close restores via +1 without go(+2) overshoot', async () => {
  const entries = [{ kind: 'parent', url: '/app', state: { page: 'app' } }];
  let cursor = 0;
  let outOfRangeGo = 0;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const navigateBy = (delta) => {
    const target = cursor + delta;
    if (target < 0 || target >= entries.length) {
      outOfRangeGo += 1;
      return;
    }
    if (target === cursor) return;
    const prevParentIdx = latestParentIndexAtOrBefore(cursor);
    const targetEntry = entries[target];
    cursor = target;
    const nextParentIdx = latestParentIndexAtOrBefore(cursor);
    if (targetEntry.kind === 'iframe' && prevParentIdx === nextParentIdx) {
      return;
    }
    queueMicrotask(() => {
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: jointHistory.state }));
    });
  };

  const jointHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      entries.push({ kind: 'parent', url: url ?? parentUrl, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = { kind: 'parent', url: url ?? entries[parentIdx].url, state };
    },
    back() {
      navigateBy(-1);
    },
    forward() {
      navigateBy(1);
    },
    go(delta) {
      navigateBy(delta);
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: jointHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: jointHistory });
  __resetMobileBackForTest();

  try {
    // 1. Open layer S1 (pos 2), let iframe navigate F1 (pos 3), UI-close S1, open vetoing S2 (pos 4).
    const closed = [];
    const releaseFirst = registerMobileBack(() => closed.push('first'), 'overlay');
    assert.equal(jointHistory.length, 2);

    entries.push({ kind: 'iframe', url: '/iframe-1', state: null });
    cursor = entries.length - 1;
    assert.equal(jointHistory.length, 3);

    releaseFirst();
    assert.equal(jointHistory.state?.mixdogBack, undefined);

    let busy = true;
    const releaseVeto = registerMobileBack(() => {
      closed.push(busy ? 'veto' : 'close');
      if (busy) return false;
    }, 'modal');
    assert.equal(jointHistory.length, 4);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    // Pressing Back lands on F1 (pos 3); restoration must step +1 (never out-of-range go(+2)).
    await afterPopState(() => jointHistory.back());
    assert.equal(outOfRangeGo, 0, 'restoration must never issue out-of-range go(+2)');
    assert.deepEqual(closed, ['veto']);
    assert.equal(cursor, 3, 'restoration must land back on S2');
    assert.equal(jointHistory.state?.mixdogBack, 1, 'dialog must stay armed after veto');

    // Second Back while still busy also restores cleanly.
    await afterPopState(() => jointHistory.back());
    assert.equal(outOfRangeGo, 0);
    assert.deepEqual(closed, ['veto', 'veto']);
    assert.equal(jointHistory.state?.mixdogBack, 1);

    busy = false;
    releaseVeto();
    assert.equal(jointHistory.state?.mixdogBack, undefined);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('closing all layers after stalled restore at 50-entry cap disarms mixdogBack', async () => {
  const entries = [];
  for (let i = 0; i < 49; i += 1) {
    entries.push({ kind: 'parent', url: `/p-${i}`, state: { page: i } });
  }
  entries.push({ kind: 'parent', url: '/app', state: { page: 'app' } });
  let cursor = entries.length - 1;

  const latestParentIndexAtOrBefore = (idx) => {
    for (let i = idx; i >= 0; i -= 1) {
      if (entries[i].kind === 'parent') return i;
    }
    return 0;
  };

  const appendCapped = (entry) => {
    entries.length = cursor + 1;
    entries.push(entry);
    if (entries.length > 50) entries.shift();
    cursor = entries.length - 1;
  };

  const navigateBy = (delta) => {
    const target = cursor + delta;
    if (target < 0 || target >= entries.length || target === cursor) return;
    const prevParentIdx = latestParentIndexAtOrBefore(cursor);
    const targetEntry = entries[target];
    cursor = target;
    const nextParentIdx = latestParentIndexAtOrBefore(cursor);
    if (targetEntry.kind === 'iframe' && prevParentIdx === nextParentIdx) {
      return;
    }
    queueMicrotask(() => {
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: cappedHistory.state }));
    });
  };

  const cappedHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[latestParentIndexAtOrBefore(cursor)].state;
    },
    pushState(state, _title, url) {
      const parentUrl = entries[latestParentIndexAtOrBefore(cursor)].url;
      appendCapped({ kind: 'parent', url: url ?? parentUrl, state });
    },
    replaceState(state, _title, url) {
      const parentIdx = latestParentIndexAtOrBefore(cursor);
      entries[parentIdx] = { kind: 'parent', url: url ?? entries[parentIdx].url, state };
    },
    back() {
      navigateBy(-1);
    },
    forward() {
      navigateBy(1);
    },
    go(delta) {
      navigateBy(delta);
    },
  };

  const iframe = dom.window.document.createElement('iframe');
  dom.window.document.body.appendChild(iframe);
  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: cappedHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: cappedHistory });
  __resetMobileBackForTest();

  try {
    const releaseDock = registerMobileBack(() => {}, 'shell');
    appendCapped({ kind: 'iframe', url: '/iframe-cap', state: null });
    const releasePrompt = registerMobileBack(() => false, 'modal');

    // Jump back 3 entries onto dock's older sentinel (mixdogBack === 1);
    // restoration forward() lands on the iframe entry and stalls.
    cappedHistory.go(-3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cappedHistory.state?.mixdogBack, 1);

    // UI-close both prompt and dock (0 open layers): mixdogBack MUST be disarmed.
    releasePrompt();
    releaseDock();
    assert.equal(
      cappedHistory.state?.mixdogBack,
      undefined,
      'closing all layers after stalled restore must disarm mixdogBack'
    );
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    iframe.remove();
    __resetMobileBackForTest();
  }
});

test('Forward from oldest sequenceless legacy entry stays on L2 without history.back()', async () => {
  // `/app` evicted: only two legacy sequenceless sentinels remain.
  const entries = [
    { url: '/app', state: { mixdogBack: 1 } },
    { url: '/app', state: { mixdogBack: 2 } },
  ];
  let cursor = 1;
  let backCalls = 0;

  const mockHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      entries.push({ url: url ?? entries[cursor].url, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: url ?? entries[cursor].url, state };
    },
    back() {
      backCalls += 1;
      if (cursor <= 0) return; // no-op at index 0, no popstate
      cursor -= 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: mockHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: mockHistory });
  __resetMobileBackForTest();

  try {
    // Open and UI-close a fresh layer S3 on top of L2.
    const release = registerMobileBack(() => {}, 'overlay');
    assert.equal(cursor, 2);
    release();

    // Back steps S3 -> L2 -> L1 (index 0) and calls back() no-op at index 0.
    mockHistory.back();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cursor, 0, 'Back reaches oldest legacy sentinel L1');

    // Now press Forward onto L2: must NOT be reversed back to L1.
    const backCallsBeforeForward = backCalls;
    await afterPopState(() => mockHistory.forward());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cursor, 1, 'Forward must stay on L2 instead of reversing to L1');
    assert.equal(backCalls, backCallsBeforeForward, 'Forward to L2 must not call history.back()');
    assert.equal(mockHistory.state?.mixdogBack, undefined);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});

test('disarmed sentinel lets normal fragment navigation (/app -> /app#details) stand', async () => {
  dom.window.history.pushState({ page: 'prev' }, '', '/prev');
  dom.window.history.pushState({ page: 'app' }, '', '/app');

  const release = registerMobileBack(() => {}, 'overlay');
  assert.equal(dom.window.history.state?.mixdogBack, 1);
  release();
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  // Fragment link navigation appends `/app#details` with unmarked state and fires popstate.
  let backCalls = 0;
  const originalBack = dom.window.history.back.bind(dom.window.history);
  dom.window.history.back = (...args) => {
    backCalls += 1;
    return originalBack(...args);
  };
  try {
    await afterPopState(() => {
      dom.window.location.hash = '#details';
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(backCalls, 0, 'fragment navigation must never be undone by history.back()');
    assert.equal(dom.window.location.pathname, '/app');
    assert.equal(dom.window.location.hash, '#details');
  } finally {
    dom.window.history.back = originalBack;
  }

  // Back #1 returns from `/app#details` to `/app` (adopted disarmed sentinel).
  await afterPopState(() => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/app');
  assert.equal(dom.window.location.hash, '');
  assert.equal(dom.window.history.state?.mixdogBack, undefined);

  // Back #2 leaves `/app` directly onto `/prev`.
  await waitForPath('/prev', () => dom.window.history.back());
  assert.equal(dom.window.location.pathname, '/prev');
});

test('disarmed sentinel preserves priorTopHistoryLength so same-URL history growth does not trigger history.back()', async () => {
  const entries = [
    { url: '/prev', state: { page: 'prev' } },
    { url: '/app', state: { page: 'app' } },
  ];
  let cursor = 1;
  let backCalls = 0;
  const mockHistory = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      entries.length = cursor + 1;
      entries.push({ url: url ?? entries[cursor].url, state });
      cursor = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: url ?? entries[cursor].url, state };
    },
    back() {
      backCalls += 1;
      if (cursor <= 0) return;
      cursor -= 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      queueMicrotask(() => {
        dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: mockHistory.state }));
      });
    },
  };

  const origGlobalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origWindowHistory = Object.getOwnPropertyDescriptor(dom.window, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: mockHistory });
  Object.defineProperty(dom.window, 'history', { configurable: true, value: mockHistory });
  __resetMobileBackForTest();

  try {
    // Open and UI-close an overlay, leaving a disarmed sentinel at cursor 2 (length 3).
    const release = registerMobileBack(() => {}, 'overlay');
    assert.equal(cursor, 2);
    assert.equal(mockHistory.length, 3);
    release();

    // Simulate a popstate onto an unmarked entry at the SAME URL while history.length grew (3 -> 4).
    entries.push({ url: entries[cursor].url, state: null });
    cursor = 3;
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(backCalls, 0, 'grewHistory must prevent forwarding Back even when the URL did not change');
    assert.equal(cursor, 3);
  } finally {
    if (origGlobalHistory) Object.defineProperty(globalThis, 'history', origGlobalHistory);
    if (origWindowHistory) Object.defineProperty(dom.window, 'history', origWindowHistory);
    __resetMobileBackForTest();
  }
});
