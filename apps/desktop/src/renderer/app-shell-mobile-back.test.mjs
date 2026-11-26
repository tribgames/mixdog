import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { isConversationTabSelection, useAppMobileBack } from './app-shell-mobile-back.ts';
import { useMobileBack } from './mobile-back.ts';

function afterPopState(dom, trigger) {
  return new Promise((resolve, reject) => {
    const targetHistory = dom.window.history;
    const originalForward = targetHistory.forward;
    let pending = 1;
    let insideTrigger = true;
    targetHistory.forward = function (...args) {
      if (!insideTrigger) pending += 1;
      return originalForward.apply(this, args);
    };
    const cleanup = () => {
      clearTimeout(timer);
      dom.window.removeEventListener('popstate', onPop);
      targetHistory.forward = originalForward;
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

test('useAppMobileBack opens each layer, re-renders with fresh callbacks without extra pop/push, and preserves quickAccessMode transitions', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
  });
  dom.window.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');

  const prior = new Map(
    ['window', 'document', 'history', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  let pushStateCount = 0;
  let backCount = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  const originalBack = dom.window.history.back.bind(dom.window.history);

  dom.window.history.pushState = (...args) => {
    pushStateCount++;
    return originalPush(...args);
  };
  dom.window.history.back = (...args) => {
    backCount++;
    return originalBack(...args);
  };

  const defaultProps = {
    sidebarOpen: false,
    applySidebarOpen: () => {},
    bottomPanelOpen: false,
    setBottomPanelOpen: () => {},
    focusedPaneDockOpen: false,
    closeFocusedPaneDock: () => {},
    settingsOpen: false,
    setSettingsOpen: () => {},
    commandSurface: null,
    closeCommandSurface: () => {},
    onboardingOpen: false,
    setOnboardingOpen: () => {},
    quickAccessMode: null,
    closeQuickAccess: () => {},
    pendingUnsavedClose: false,
    cancelPendingTabClose: () => {},
    updateDialogOpen: false,
    updaterState: { status: 'idle' },
    closeDesktopUpdate: () => {},
  };

  function TestHarness(props) {
    useAppMobileBack({ ...defaultProps, ...props });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    // 1. Initial mount with everything closed: no pushes
    await act(async () => {
      root.render(React.createElement(TestHarness, defaultProps));
    });
    assert.equal(pushStateCount, 0);
    assert.equal(backCount, 0);

    // 2. Open each layer consecutively: one shared sentinel tracks stack depth
    const layers = [
      { sidebarOpen: true },
      { bottomPanelOpen: true },
      { focusedPaneDockOpen: true },
      { settingsOpen: true },
      { commandSurface: 'context' },
      { onboardingOpen: true },
      { quickAccessMode: 'commands' },
      { pendingUnsavedClose: true },
      { updateDialogOpen: true, updaterState: { status: 'ready' } },
    ];

    let currentOpenProps = { ...defaultProps };
    let expectedDepth = 0;

    for (const layer of layers) {
      currentOpenProps = { ...currentOpenProps, ...layer };
      await act(async () => {
        root.render(React.createElement(TestHarness, currentOpenProps));
      });
      expectedDepth++;
      assert.equal(
        pushStateCount,
        expectedDepth,
        `Expected pushState count ${expectedDepth} when opening layer on history fallback`
      );
      assert.equal(
        dom.window.history.state?.mixdogBack,
        expectedDepth,
        `Expected sentinel depth ${expectedDepth} when opening layer`
      );
    }

    // 3. Rerender with fresh closures for all handlers while all layers stay open
    // MUST NOT trigger any additional pushState or history.back
    const pushesBeforeRerender = pushStateCount;
    const backBeforeRerender = backCount;

    let quickAccessClosed = 0;
    const closeQuickAccess = () => {
      quickAccessClosed++;
    };

    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          ...currentOpenProps,
          applySidebarOpen: () => {},
          setBottomPanelOpen: () => {},
          closeFocusedPaneDock: () => {},
          setSettingsOpen: () => {},
          closeCommandSurface: () => {},
          setOnboardingOpen: () => {},
          closeQuickAccess,
          cancelPendingTabClose: () => {},
          closeDesktopUpdate: () => {},
        })
      );
    });

    assert.equal(pushStateCount, pushesBeforeRerender, 'Re-render with fresh closures must not re-push history');
    assert.equal(backCount, backBeforeRerender, 'Re-render with fresh closures must not trigger history.back');

    // 4. quickAccessMode transition ("commands" to "files") while lower layers
    // stay open keeps the shared sentinel in place without extra pop/push.
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          ...currentOpenProps,
          quickAccessMode: 'files',
          closeQuickAccess,
        })
      );
    });

    assert.equal(backCount, backBeforeRerender, 'quickAccessMode transition should not pop shared sentinel');
    assert.equal(pushStateCount, pushesBeforeRerender, 'quickAccessMode transition should not re-push shared sentinel');
    assert.equal(dom.window.history.state?.mixdogBack, expectedDepth);

    // Closing the two higher-priority modals leaves quickAccessMode on top of
    // the overlay tier, and hardware Back invokes its handler.
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          ...currentOpenProps,
          quickAccessMode: 'files',
          closeQuickAccess,
          pendingUnsavedClose: false,
          updateDialogOpen: false,
        })
      );
    });
    await afterPopState(dom, () => dom.window.history.back());
    assert.equal(quickAccessClosed, 1, 'hardware Back after quickAccessMode transition closes quick access');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('isConversationTabSelection distinguishes conversation home tabs from non-conversation views', () => {
  assert.equal(isConversationTabSelection(undefined), true);
  assert.equal(isConversationTabSelection({ kind: 'new' }), true);
  assert.equal(isConversationTabSelection({ kind: 'session' }), true);
  assert.equal(isConversationTabSelection({ kind: 'project' }), true);
  for (const kind of ['file', 'diff', 'pull-request', 'studio', 'terminal', 'browser']) {
    assert.equal(isConversationTabSelection({ kind }), false, `${kind} should be non-conversation`);
  }
});

test('mobile Back closes child overlays and sidebar sub-panels before returning from a non-conversation tab', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
  });
  dom.window.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');

  const prior = new Map(
    ['window', 'document', 'history', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const events = [];
  let state = {
    nonConversationTabOpen: false,
    sidebarOpen: false,
    sidebarSubPanelOpen: false,
    childOverlayOpen: false,
  };

  function ChildOverlay({ open, onClose }) {
    useMobileBack(open, onClose);
    return null;
  }

  function TestHarness({ current }) {
    useAppMobileBack({
      nonConversationTabOpen: current.nonConversationTabOpen,
      returnFromNonConversationTab: () => {
        events.push('return-tab');
        state = { ...state, nonConversationTabOpen: false };
      },
      sidebarOpen: current.sidebarOpen,
      applySidebarOpen: (open) => {
        events.push(`sidebar:${open}`);
        state = { ...state, sidebarOpen: open };
      },
      sidebarSubPanelOpen: current.sidebarSubPanelOpen,
      closeSidebarSubPanel: () => {
        events.push('close-subpanel');
        state = { ...state, sidebarSubPanelOpen: false };
      },
      bottomPanelOpen: false,
      setBottomPanelOpen: () => {},
      focusedPaneDockOpen: false,
      closeFocusedPaneDock: () => {},
      settingsOpen: false,
      setSettingsOpen: () => {},
      commandSurface: null,
      closeCommandSurface: () => {},
      onboardingOpen: false,
      setOnboardingOpen: () => {},
      quickAccessMode: null,
      closeQuickAccess: () => {},
      pendingUnsavedClose: false,
      cancelPendingTabClose: () => {},
      updateDialogOpen: false,
      updaterState: { status: 'idle' },
      closeDesktopUpdate: () => {},
    });
    return React.createElement(ChildOverlay, {
      open: current.childOverlayOpen,
      onClose: () => {
        events.push('close-child');
        state = { ...state, childOverlayOpen: false };
      },
    });
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  const rerender = async () => {
    await act(async () => {
      root.render(React.createElement(TestHarness, { current: state }));
    });
  };
  try {
    // Home conversation with nothing open leaves no sentinel.
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    // 1. Open non-conversation tab (e.g. File/Diff/Studio) from home conversation.
    state = { nonConversationTabOpen: true, sidebarOpen: false, sidebarSubPanelOpen: false, childOverlayOpen: false };
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    // 2. Open Sidebar -> open Schedules/Webhooks sub-panel -> open child dialog inside it.
    state = { ...state, sidebarOpen: true };
    await rerender();
    state = { ...state, sidebarSubPanelOpen: true };
    await rerender();
    state = { ...state, childOverlayOpen: true };
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, 4);

    // Press Back 4 times: dialog -> sub-panel -> sidebar -> return to conversation.
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();

    assert.deepEqual(events, ['close-child', 'close-subpanel', 'sidebar:false', 'return-tab']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined, 'home conversation leaves no sentinel');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('mobile Back preserves tier order when Studio opens from an open drawer and when retained dock reopens with child overlay', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
  });
  dom.window.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');

  const prior = new Map(
    ['window', 'document', 'history', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const events = [];
  let state = {
    nonConversationTabOpen: false,
    sidebarOpen: false,
    dockOpen: false,
    historyOpen: false,
    pendingUnsavedClose: false,
    stayOnNonConversation: false,
  };

  function RetainedDockChild({ active, historyOpen, onCloseHistory }) {
    useMobileBack(active && historyOpen, onCloseHistory);
    return null;
  }

  function TestHarness({ current }) {
    useAppMobileBack({
      nonConversationTabOpen: current.nonConversationTabOpen,
      returnFromNonConversationTab: () => {
        events.push('return-tab');
        if (state.stayOnNonConversation) {
          state = { ...state, pendingUnsavedClose: true };
          return false;
        }
        state = { ...state, nonConversationTabOpen: false };
        return undefined;
      },
      sidebarOpen: current.sidebarOpen,
      applySidebarOpen: (open) => {
        events.push(`sidebar:${open}`);
        state = { ...state, sidebarOpen: open };
      },
      bottomPanelOpen: false,
      setBottomPanelOpen: () => {},
      focusedPaneDockOpen: current.dockOpen,
      closeFocusedPaneDock: () => {
        events.push('close-dock');
        state = { ...state, dockOpen: false };
      },
      settingsOpen: false,
      setSettingsOpen: () => {},
      commandSurface: null,
      closeCommandSurface: () => {},
      onboardingOpen: false,
      setOnboardingOpen: () => {},
      quickAccessMode: null,
      closeQuickAccess: () => {},
      pendingUnsavedClose: current.pendingUnsavedClose,
      cancelPendingTabClose: () => {
        events.push('cancel-unsaved');
        state = { ...state, pendingUnsavedClose: false };
      },
      updateDialogOpen: false,
      updaterState: { status: 'idle' },
      closeDesktopUpdate: () => {},
    });
    return React.createElement(RetainedDockChild, {
      active: current.dockOpen,
      historyOpen: current.historyOpen,
      onCloseHistory: () => {
        events.push('close-history');
        state = { ...state, historyOpen: false };
      },
    });
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  const rerender = async () => {
    await act(async () => {
      root.render(React.createElement(TestHarness, { current: state }));
    });
  };

  try {
    // Finding #5: Open phone drawer FIRST, then select Studio (non-conversation tab) while drawer is open.
    state = { ...state, sidebarOpen: true };
    await rerender();
    state = { ...state, nonConversationTabOpen: true };
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    // Back #1 must close drawer, NOT Studio behind it.
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    assert.deepEqual(events, ['sidebar:false']);

    // Finding #6: Dirty file confirm keeps non-conversation tab armed underneath pendingUnsavedClose.
    state = { ...state, stayOnNonConversation: true };
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    assert.deepEqual(events, ['sidebar:false', 'return-tab']);
    assert.equal(dom.window.history.state?.mixdogBack, 2, 'tab stays armed under dirty confirm');

    // Back dismisses dirty confirm first, then next Back returns from tab once clean.
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    state = { ...state, stayOnNonConversation: false };
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    assert.deepEqual(events, ['sidebar:false', 'return-tab', 'cancel-unsaved', 'return-tab']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    // Finding #7: Retained dock reopens with historyOpen already true in the same commit
    // (child useEffect runs before parent useEffect). Back must close history first, then dock.
    events.length = 0;
    state = { ...state, dockOpen: false, historyOpen: true };
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, undefined);

    state = { ...state, dockOpen: true, historyOpen: true };
    await rerender();
    assert.equal(dom.window.history.state?.mixdogBack, 2);

    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    await afterPopState(dom, () => dom.window.history.back());
    await rerender();
    assert.deepEqual(events, ['close-history', 'close-dock']);
    assert.equal(dom.window.history.state?.mixdogBack, undefined);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
