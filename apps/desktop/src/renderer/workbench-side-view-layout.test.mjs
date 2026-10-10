import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  discardLayoutForPaneBoundRight,
  initialActiveWorkbenchSideViews,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  nextRetainedWorkbenchSideRoots,
  normalizeWorkbenchSideViewLayout,
  normalizeSideSplitSizes,
  resizeSideSplitSizes,
  workbenchSideBarDropPlacement,
  workbenchSidePaneDropIsNoop,
  workbenchSidePaneDropSlot,
} from './workbench-side-view-layout.tsx';

test('switching side groups preserves mounted controls, drafts and scroll positions', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const mounts = new Map();
  const activity = new Map();
  function View({ id, active }) {
    const [count, setCount] = React.useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: counts mounts only, so it must run once
    React.useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
    }, []);
    React.useLayoutEffect(() => {
      activity.set(id, active);
    }, [active, id]);
    return React.createElement(
      'div',
      { 'data-view': id },
      React.createElement('input', { defaultValue: '' }),
      React.createElement('button', { type: 'button', onClick: () => setCount((value) => value + 1) }, String(count))
    );
  }
  const groups = [['sessions', 'projects'], ['agents']];
  const descriptors = new Map(groups.flat().map((id) => [id, { id, label: id, icon: () => null }]));
  const render = (activeRoot, open = true, currentGroups = groups) =>
    root.render(
      React.createElement(WorkbenchSidePanel, {
        side: 'left',
        open,
        embedded: true,
        groups: currentGroups,
        activeRoot,
        descriptors,
        onSelect() {},
        onMoveGroup() {},
        onMoveView() {},
        renderView: (id, active) => React.createElement(View, { id, active }),
      })
    );
  await act(async () => render('sessions'));
  const session = document.querySelector('[data-view="sessions"]');
  const project = document.querySelector('[data-view="projects"]');
  const input = session.querySelector('input');
  input.value = 'unfinished draft';
  session.scrollTop = 47;
  await act(async () => session.querySelector('button').click());
  assert.equal(session.querySelector('button').textContent, '1');

  await act(async () => render('agents'));
  const agent = document.querySelector('[data-view="agents"]');
  assert.equal(document.querySelector('[data-view="sessions"]'), session);
  assert.equal(document.querySelector('[data-view="projects"]'), project);
  assert.equal(activity.get('sessions'), false);
  assert.equal(activity.get('agents'), true);
  assert.equal(session.closest('.workbench-side-panel-body').hidden, true);
  assert.equal(session.closest('.workbench-side-panel-body').getAttribute('aria-hidden'), 'true');

  await act(async () => render('sessions'));
  assert.equal(document.querySelector('[data-view="sessions"]'), session);
  assert.equal(document.querySelector('[data-view="agents"]'), agent);
  assert.equal(session.querySelector('input'), input);
  assert.equal(input.value, 'unfinished draft');
  assert.equal(session.scrollTop, 47);
  assert.equal(session.querySelector('button').textContent, '1');
  assert.equal(session.closest('.workbench-side-panel-body').hidden, false);
  assert.equal(activity.get('sessions'), true);
  assert.equal(activity.get('agents'), false);
  assert.deepEqual(Object.fromEntries(mounts), { sessions: 1, projects: 1, agents: 1 });
  const sashes = session.closest('.workbench-side-panel-body').querySelectorAll('[role="separator"]');
  assert.equal(sashes.length, 1);

  await act(async () => render('sessions', false));
  assert.equal(activity.get('sessions'), false);
  assert.equal(document.querySelector('[data-view="sessions"]'), session);
  await act(async () => render('sessions', true, [['sessions', 'projects']]));
  assert.equal(document.querySelector('[data-view="agents"]'), null);
  assert.equal(document.querySelector('[data-view="sessions"]'), session);
});

test('unchanged side views skip rendering while their drag handles stay current', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  let renders = 0;
  const View = React.memo(({ titleDragProps }) => {
    renders++;
    return React.createElement('span', { ...titleDragProps, 'data-drag-test': true }, 'Title');
  });
  const props = {
    open: true,
    embedded: true,
    groups: [['sessions']],
    activeRoot: 'sessions',
    descriptors: new Map([['sessions', { id: 'sessions', label: 'Sessions', icon: () => null }]]),
    onSelect() {},
    onMoveGroup() {},
    onMoveView() {},
    renderView: (_id, _active, titleDragProps) => React.createElement(View, { titleDragProps }),
  };
  const render = (side = 'left') =>
    act(async () => root.render(React.createElement(WorkbenchSidePanel, { ...props, side })));
  await render();
  const before = renders;
  for (let index = 0; index < 5; index++) await render();
  assert.equal(renders, before);
  const transfers = [];
  const drag = async () =>
    act(async () => {
      const event = new window.Event('dragstart', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: (type, value) => transfers.push([type, value]), setDragImage() {} },
      });
      document.querySelector('[data-drag-test]').dispatchEvent(event);
    });
  await drag();
  assert.ok(transfers.some(([type, value]) => type === 'text/plain' && value === 'sessions'));
  await render('right');
  assert.equal(document.querySelector('[data-drag-test]').draggable, false);
  transfers.length = 0;
  await drag();
  assert.equal(transfers.length, 0, 'a pane-bound right view must not keep the old draggable closure');
});

test('a persisted layout restores its sides and re-seats newly available views', () => {
  // Exactly what the hook does on boot: read the stored JSON, then normalize
  // it against the views this build actually offers.
  const persisted = JSON.stringify({
    left: [['projects']],
    right: [['sessions', 'agents']],
  });
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(JSON.parse(persisted), ['sessions', 'projects', 'agents', 'search']),
    {
      // The right side is pane-bound: Sessions and Agents stored there before
      // the rails were split re-seat on the left in default order, as does
      // Search, instead of trailing whichever side happened to be stored.
      left: [['sessions'], ['agents'], ['projects'], ['search']],
      right: [],
    }
  );
});

test('a stored right side keeps only the views the pane ships there', () => {
  // Source Control lingered on the right of an install whose layout was
  // stored before it moved rails; it comes back to the left without touching
  // the rest of the hand-arranged left rail.
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(
      {
        left: [['sessions'], ['agents'], ['projects']],
        right: [['source-control'], ['session-diff'], ['browser'], ['terminal']],
      },
      ['sessions', 'agents', 'projects', 'source-control', 'session-diff', 'browser', 'terminal']
    ),
    {
      left: [['sessions'], ['agents'], ['projects'], ['source-control']],
      right: [['session-diff'], ['browser'], ['terminal']],
    }
  );
});

test('restoration drops views this build no longer offers', () => {
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout({ left: [['sessions', 'webhooks']], right: [['agents']] }, ['sessions', 'agents']),
    { left: [['sessions'], ['agents']], right: [] }
  );
});

test('a corrupt or missing persisted layout falls back to the defaults', () => {
  assert.deepEqual(normalizeWorkbenchSideViewLayout(null).left, [
    ['sessions'],
    ['agents'],
    ['schedules'],
    ['projects'],
    ['workflows'],
    ['extensions'],
    ['source-control'],
    ['search'],
    ['webhooks'],
  ]);
  assert.deepEqual(normalizeWorkbenchSideViewLayout(null, ['sessions', 'terminal', 'agents']), {
    left: [['sessions'], ['agents']],
    right: [['terminal']],
  });
  // Session surfaces sit beside the pane's project-scoped tools.
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(null, ['sessions', 'source-control', 'session-diff', 'browser', 'terminal']),
    {
      left: [['sessions'], ['source-control']],
      right: [['session-diff'], ['browser'], ['terminal']],
    }
  );
});

test('the stored arrangement is dropped once so the new defaults apply', () => {
  const layoutKey = 'mixdog.desktop.workbench-side-view-layout.v1';
  const store = new Map([[layoutKey, '{}']]);
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  const stored = { left: [['sessions'], ['projects']], right: [['agents']] };
  assert.equal(discardLayoutForPaneBoundRight(storage, stored), null);
  assert.equal(store.has(layoutKey), false);
  // Once only: a rail arranged after the reset survives every later boot.
  const rearranged = { left: [['projects'], ['sessions']], right: [] };
  assert.equal(discardLayoutForPaneBoundRight(storage, rearranged), rearranged);
});

test('views missing from a stored side are restored in default order', () => {
  // A side stored before these views existed rebuilds in DEFAULT order instead
  // of collecting every newcomer behind whatever it happened to keep.
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout({ left: [['sessions']], right: [] }, [
      'sessions',
      'agents',
      'schedules',
      'source-control',
      'session-diff',
      'browser',
      'terminal',
    ]),
    {
      left: [['sessions'], ['agents'], ['schedules'], ['source-control']],
      right: [['session-diff'], ['browser'], ['terminal']],
    }
  );
});

test('each side opens on its leading group, never a last-visited view', () => {
  // Sessions sits on the right here, and neither side restores anything: the
  // left starts on its own first group, the right on the group that leads it.
  assert.deepEqual(
    initialActiveWorkbenchSideViews({
      left: [['projects'], ['search']],
      right: [['sessions', 'agents']],
    }),
    { left: 'projects', right: 'sessions' }
  );
  // A combined group selects its root.
  assert.deepEqual(initialActiveWorkbenchSideViews({ left: [['projects', 'sessions']], right: [] }), {
    left: 'projects',
    right: null,
  });
});

test('the left drawer opens on Agents wherever a stored rail order put it', () => {
  // A phone whose stored rail still leads with Sessions must not reboot into
  // Sessions: Agents is the left home whenever the rail carries it.
  assert.deepEqual(
    initialActiveWorkbenchSideViews({
      left: [['sessions'], ['schedules'], ['agents']],
      right: [],
    }),
    { left: 'agents', right: null }
  );
});

test('an empty side has no active view', () => {
  assert.deepEqual(initialActiveWorkbenchSideViews({ left: [], right: [['agents']] }), { left: null, right: 'agents' });
});

test('side view layout keeps every available category exactly once', () => {
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(
      {
        left: [['projects', 'search', 'projects']],
        right: [['agents', 'source-control']],
      },
      ['projects', 'search', 'agents', 'source-control']
    ),
    {
      left: [['agents'], ['source-control'], ['projects', 'search']],
      right: [],
    }
  );
});

test('the pane-scoped right side neither gives up nor accepts a view', () => {
  const layout = {
    left: [['sessions'], ['projects']],
    right: [['source-control', 'browser']],
  };
  // Dragging out of the right side does nothing…
  assert.equal(moveWorkbenchSideGroup(layout, 'source-control', 'left', 'projects', 'inside'), layout);
  assert.equal(moveWorkbenchSideView(layout, 'browser', 'left', 'projects', 'after'), layout);
  // …and neither does dropping a left view onto it.
  assert.equal(moveWorkbenchSideView(layout, 'projects', 'right', 'source-control', 'after'), layout);
  assert.equal(moveWorkbenchSideGroup(layout, 'sessions', 'right', null, 'after'), layout);
});

test('a category label extracts one view into its own icon', () => {
  const layout = {
    left: [['projects', 'agents', 'search']],
    right: [['source-control']],
  };
  assert.deepEqual(moveWorkbenchSideView(layout, 'search', 'left', 'projects', 'before'), {
    left: [['search'], ['projects', 'agents']],
    right: [['source-control']],
  });
});

test('activity icons reorder groups without combining them', () => {
  const layout = {
    left: [['sessions'], ['projects'], ['extensions']],
    right: [['agents']],
  };
  assert.deepEqual(moveWorkbenchSideGroup(layout, 'extensions', 'left', 'projects', 'before'), {
    left: [['sessions'], ['extensions'], ['projects']],
    right: [['agents']],
  });
});

test('dropping a category on an activity icon adds an independent icon', () => {
  const layout = {
    left: [['projects', 'search'], ['extensions']],
    right: [['agents']],
  };
  assert.deepEqual(moveWorkbenchSideView(layout, 'search', 'left', 'extensions', 'after'), {
    left: [['projects'], ['extensions'], ['search']],
    right: [['agents']],
  });
});

test('pane top and bottom drops combine views at the requested label position', () => {
  const layout = {
    left: [['projects', 'search'], ['extensions'], ['agents']],
    right: [['source-control']],
  };
  assert.deepEqual(moveWorkbenchSideView(layout, 'search', 'left', 'agents', 'inside-after'), {
    left: [['projects'], ['extensions'], ['agents', 'search']],
    right: [['source-control']],
  });
  assert.deepEqual(moveWorkbenchSideGroup(layout, 'extensions', 'left', 'projects', 'inside-before'), {
    left: [['extensions', 'projects', 'search'], ['agents']],
    right: [['source-control']],
  });
});

test('a stored rail order drops the retired Studio launcher id on load', () => {
  // Studio opens from the Sessions panel's fixed launcher rows now, so an
  // older stored layout that still carries the rail icon re-seats without it.
  const layout = normalizeWorkbenchSideViewLayout(
    {
      left: [['sessions'], ['studio'], ['extensions']],
      right: [['session-diff'], ['browser']],
    },
    ['sessions', 'extensions', 'session-diff', 'browser']
  );
  assert.deepEqual(layout, {
    left: [['sessions'], ['extensions']],
    right: [['session-diff'], ['browser']],
  });
});

test('dragging a combined pane label reorders it within the group', () => {
  const layout = {
    left: [['projects', 'search', 'extensions']],
    right: [['agents']],
  };
  assert.deepEqual(moveWorkbenchSideView(layout, 'extensions', 'left', 'projects', 'inside-after'), {
    left: [['projects', 'extensions', 'search']],
    right: [['agents']],
  });
});

test('pane drop targets expose N plus one slots and hide no-op positions', () => {
  assert.equal(workbenchSidePaneDropSlot([100, 300], 50), 0);
  assert.equal(workbenchSidePaneDropSlot([100, 300], 200), 1);
  assert.equal(workbenchSidePaneDropSlot([100, 300], 350), 2);
  assert.equal(workbenchSidePaneDropIsNoop(['projects', 'search'], 'view', 'projects', 1), true);
  assert.equal(workbenchSidePaneDropIsNoop(['projects', 'search'], 'view', 'projects', 2), false);
  assert.equal(workbenchSidePaneDropIsNoop(['projects', 'search'], 'group', 'projects', 2), true);
});

test('activity bar drop zones use the 40/60 hysteresis', () => {
  assert.equal(workbenchSideBarDropPlacement(0.4, 'after'), 'before');
  assert.equal(workbenchSideBarDropPlacement(0.6, 'before'), 'before');
  assert.equal(workbenchSideBarDropPlacement(0.61, 'before'), 'after');
  assert.equal(workbenchSideBarDropPlacement(0.49, null), 'before');
  assert.equal(workbenchSideBarDropPlacement(0.51, null), 'after');
});

test('combined views start evenly split for two and three panes', () => {
  assert.deepEqual(normalizeSideSplitSizes(null, 2), [50, 50]);
  assert.deepEqual(
    normalizeSideSplitSizes(null, 3).map((value) => Math.round(value * 1000) / 1000),
    [33.333, 33.333, 33.333]
  );
});

test('a sash resizes only its adjacent panes and preserves the total', () => {
  const resized = resizeSideSplitSizes([50, 50], 0, 80, 400);
  assert.deepEqual(resized, [70, 30]);
  assert.equal(
    resized.reduce((sum, value) => sum + value, 0),
    100
  );
  assert.deepEqual(resizeSideSplitSizes([50, 50], 0, 500, 400), [76, 24]);
});

test('visited side groups stay retained while removed groups are pruned', () => {
  const groups = [['agents'], ['search'], ['source-control']];
  assert.deepEqual(nextRetainedWorkbenchSideRoots(groups, ['agents'], 'source-control'), ['agents', 'source-control']);
  assert.deepEqual(nextRetainedWorkbenchSideRoots(groups.slice(1), ['agents', 'source-control'], 'search'), [
    'search',
    'source-control',
  ]);
});

test('the whole activity bar accepts a drag and drops after the last icon', async () => {
  const { dom, restore } = installTestDom(null, {
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement'],
  });

  const root = createRoot(document.getElementById('root'));
  const moves = [];
  const Icon = () => React.createElement('span');
  const descriptors = new Map([
    ['projects', { id: 'projects', label: 'Projects', icon: Icon }],
    ['extensions', { id: 'extensions', label: 'Workflows', icon: Icon }],
  ]);
  const transferData = new Map();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...transferData.keys()];
    },
    setData(type, value) {
      transferData.set(type, value);
    },
    getData(type) {
      return transferData.get(type) ?? '';
    },
    setDragImage() {},
  };
  const dragEvent = (type, clientY) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(event, 'clientX', { value: 24 });
    Object.defineProperty(event, 'clientY', { value: clientY });
    return event;
  };

  try {
    await act(async () =>
      root.render(
        React.createElement(WorkbenchSideIconBar, {
          side: 'left',
          groups: [['projects'], ['extensions']],
          activeRoot: 'projects',
          descriptors,
          orientation: 'vertical',
          onSelect() {},
          onMoveGroup(...args) {
            moves.push(args);
          },
          onMoveView() {},
        })
      )
    );
    const bar = document.querySelector('.workbench-side-icon-bar');
    const buttons = [...bar.querySelectorAll('button')];
    assert.equal(buttons.length, 2);
    buttons[0].getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 48,
      bottom: 48,
      left: 0,
      width: 48,
      height: 48,
      toJSON() {},
    });
    buttons[1].getBoundingClientRect = () => ({
      x: 0,
      y: 48,
      top: 48,
      right: 48,
      bottom: 96,
      left: 0,
      width: 48,
      height: 48,
      toJSON() {},
    });

    await act(async () => {
      buttons[0].dispatchEvent(dragEvent('dragstart', 24));
    });
    const over = dragEvent('dragover', 130);
    await act(async () => {
      bar.dispatchEvent(over);
    });
    assert.equal(over.defaultPrevented, true);
    assert.equal(dataTransfer.dropEffect, 'move');
    assert.equal(buttons[1].dataset.dropPosition, 'after');

    await act(async () => {
      bar.dispatchEvent(dragEvent('drop', 130));
    });
    assert.deepEqual(moves, [['projects', 'left', 'extensions', 'after']]);

    // The same bar on the right belongs to the pane: its icons cannot be
    // picked up and a drop landing there changes nothing.
    moves.length = 0;
    await act(async () =>
      root.render(
        React.createElement(WorkbenchSideIconBar, {
          side: 'right',
          groups: [['projects'], ['extensions']],
          activeRoot: 'projects',
          descriptors,
          orientation: 'vertical',
          onSelect() {},
          onMoveGroup(...args) {
            moves.push(args);
          },
          onMoveView(...args) {
            moves.push(args);
          },
        })
      )
    );
    const rightBar = document.querySelector('.workbench-side-icon-bar');
    const rightButtons = [...rightBar.querySelectorAll('button')];
    assert.equal(
      rightButtons.some((button) => button.draggable),
      false
    );
    const rightOver = dragEvent('dragover', 130);
    await act(async () => {
      rightBar.dispatchEvent(rightOver);
      rightBar.dispatchEvent(dragEvent('drop', 130));
    });
    assert.equal(rightOver.defaultPrevented, false);
    assert.deepEqual(moves, []);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a controlled resize reports preview, commit and cancel as distinct phases', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'Element'] });
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  window.Element.prototype.hasPointerCapture = () => true;
  const calls = [];
  await act(async () =>
    root.render(
      React.createElement(WorkbenchSidePanel, {
        side: 'right',
        open: true,
        embedded: true,
        hideTabs: true,
        groups: [['sessions']],
        activeRoot: 'sessions',
        descriptors: new Map([['sessions', { id: 'sessions', label: 'sessions', icon: () => null }]]),
        onSelect() {},
        onMoveGroup() {},
        onMoveView() {},
        widthOverride: 400,
        onWidthDrag: (width, phase) => calls.push([width, phase]),
        renderView: () => null,
      })
    )
  );
  const handle = document.querySelector('.workbench-side-panel-resize');
  const fire = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    handle.dispatchEvent(event);
  };
  await act(async () => {
    fire('pointerdown', 100);
    fire('pointermove', 60);
    fire('pointercancel', 60);
  });
  // Cancel carries the rendered width only as information: the owner restores its own snapshot.
  assert.deepEqual(
    calls.map(([, phase]) => phase),
    ['preview', 'cancel']
  );
  calls.length = 0;
  await act(async () => {
    fire('pointerdown', 100);
    fire('pointermove', 60);
    fire('pointerup', 60);
  });
  assert.deepEqual(calls, [
    [440, 'preview'],
    [440, 'commit'],
  ]);
});
