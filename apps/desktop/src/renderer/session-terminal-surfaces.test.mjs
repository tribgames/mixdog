import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement'],
});
// Horizontal offset of the slot, as when the phone sheet is mid-slide.
let slotShift = 0;
dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  let fixed = null;
  if (this.classList.contains('main-panel')) fixed = { left: 10, top: 0, right: 1010, bottom: 700 };
  else if (this.classList.contains('pane-side-dock-header')) fixed = { left: 600, top: 0, right: 1010, bottom: 48 };
  if (fixed) {
    return {
      ...fixed,
      x: fixed.left,
      y: fixed.top,
      width: fixed.right - fixed.left,
      height: fixed.bottom - fixed.top,
      toJSON() {
        return this;
      },
    };
  }
  const visible = this.classList.contains('session-terminal-slot');
  const shift = visible ? slotShift : 0;
  return {
    x: visible ? 40 + shift : 0,
    y: visible ? 20 : 0,
    left: visible ? 40 + shift : 0,
    top: visible ? 20 : 0,
    right: visible ? 760 + shift : 0,
    bottom: visible ? 500 : 0,
    width: visible ? 720 : 0,
    height: visible ? 480 : 0,
    toJSON() {
      return this;
    },
  };
};

const {
  SessionTerminalParkingHost,
  SessionTerminalSlot,
  reportingTerminalDisposer,
  sessionTerminalId,
  useSessionTerminalSurfaces,
} = await import('./session-terminal-surfaces.tsx');
const { applyTerminalActivity, StableTerminalFitScheduler } = await import('./terminal-fit.ts');

const renderFixture = (props) =>
  React.createElement(
    'div',
    {
      className: 'terminal-surface-fixture',
      'data-cwd': props.cwd,
      'data-active': props.active ? 'true' : 'false',
      'data-foreground': props.foreground ? 'true' : 'false',
      'data-parked': props.parked ? 'true' : 'false',
      'data-attach-only': props.attachOnly ? 'true' : 'false',
      'data-expanded': props.expanded ? 'true' : 'false',
      onClick: props.onToggleExpanded,
    },
    React.createElement('button', { type: 'button', className: 'terminal-fixture-key' })
  );

function Harness({ sessionId, active, cwd, disposeTerminal, onController, docked = false, exiting = false }) {
  const controller = useSessionTerminalSurfaces(renderFixture, disposeTerminal);
  React.useEffect(() => {
    onController?.(controller);
  }, [controller, onController]);
  const slot = React.createElement(SessionTerminalSlot, {
    controller,
    sessionId,
    active,
    foreground: active,
    cwd,
    exiting,
  });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SessionTerminalParkingHost, { controller }),
    docked
      ? React.createElement(
          'div',
          { className: 'main-panel' },
          React.createElement(
            'div',
            { className: 'pane-side-dock' },
            React.createElement('div', { className: 'pane-side-dock-header' }),
            slot
          )
        )
      : slot
  );
}

test('an expanded terminal covers the main panel below the dock header and resets when hidden', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const props = { sessionId: 'beta', cwd: 'C:/beta', docked: true };
  try {
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    const container = document.querySelector('.session-terminal-surface-container');
    assert.equal(container.dataset.expanded, 'false');
    assert.equal(container.style.top, '20px');

    await act(async () => container.querySelector('.terminal-surface-fixture').click());
    assert.equal(container.dataset.expanded, 'true');
    assert.equal(container.querySelector('.terminal-surface-fixture').dataset.expanded, 'true');
    assert.equal(container.style.left, '10px');
    assert.equal(container.style.top, '48px');
    assert.equal(container.style.width, '1000px');
    assert.equal(container.style.height, '652px');
    const header = document.querySelector('.pane-side-dock-header');
    assert.equal(header.dataset.surfaceExpanded, 'true');
    assert.equal(header.style.left, '10px');
    assert.equal(header.style.top, '0px');
    assert.equal(header.style.width, '1000px');

    await act(async () => root.render(React.createElement(Harness, { ...props, active: false })));
    assert.equal(document.querySelector('.session-terminal-surface-container'), null);
    assert.equal(header.dataset.surfaceExpanded, undefined);
    assert.equal(header.style.left, '');
    assert.equal(header.style.width, '');

    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    const reopened = document.querySelector('.session-terminal-surface-container');
    assert.ok(reopened);
    assert.notEqual(reopened, container);
    assert.equal(reopened.dataset.expanded, 'false');
    assert.equal(reopened.style.top, '20px');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a hidden session terminal releases its root and container without disposing its PTY, and remounts when shown again', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const disposed = [];
  let mounts = 0;
  let unmounts = 0;
  function TrackedFixture(props) {
    React.useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return renderFixture(props);
  }
  function TrackedHarness({ sessionId, active, cwd }) {
    const controller = useSessionTerminalSurfaces(
      (props) => React.createElement(TrackedFixture, props),
      (terminalId) => disposed.push(terminalId)
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(SessionTerminalParkingHost, { controller }),
      React.createElement(SessionTerminalSlot, {
        controller,
        sessionId,
        active,
        foreground: active,
        cwd,
      })
    );
  }
  try {
    await act(async () =>
      root.render(
        React.createElement(TrackedHarness, {
          sessionId: 'alpha',
          active: true,
          cwd: 'C:/alpha',
        })
      )
    );
    const container = document.querySelector('.session-terminal-surface-container');
    assert.ok(container);
    assert.equal(container.style.width, '720px');
    assert.equal(container.style.height, '480px');
    assert.equal(container.querySelector('.terminal-surface-fixture').dataset.cwd, 'C:/alpha');
    assert.equal(container.querySelector('.terminal-surface-fixture').dataset.active, 'true');
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);

    await act(async () =>
      root.render(
        React.createElement(TrackedHarness, {
          sessionId: 'alpha',
          active: false,
          cwd: 'C:/alpha',
        })
      )
    );
    assert.equal(document.querySelector('.session-terminal-surface-container'), null);
    assert.equal(unmounts, 1, 'hiding the terminal unmounts its dedicated React root');
    assert.deepEqual(disposed, [], 'hiding the terminal keeps the backend PTY alive');

    await act(async () =>
      root.render(
        React.createElement(TrackedHarness, {
          sessionId: 'alpha',
          active: true,
          cwd: 'C:/alpha',
        })
      )
    );
    const reopened = document.querySelector('.session-terminal-surface-container');
    assert.ok(reopened);
    assert.notEqual(reopened, container);
    assert.equal(reopened.dataset.parked, 'false');
    assert.equal(reopened.style.width, '720px');
    assert.equal(reopened.style.height, '480px');
    assert.equal(mounts, 2);
    assert.deepEqual(disposed, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a slot that only moves is re-measured while it slides and after the transition ends', async () => {
  const pending = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    nextFrame += 1;
    pending.set(nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => pending.delete(id);
  const flushFrames = async (count) => {
    for (let index = 0; index < count; index += 1) {
      const batch = [...pending.values()];
      pending.clear();
      await act(async () => {
        for (const callback of batch) callback(0);
      });
    }
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    slotShift = 118;
    await act(async () =>
      root.render(React.createElement(Harness, { sessionId: 'slide', active: true, cwd: 'C:/slide' }))
    );
    const container = document.querySelector('.session-terminal-surface-container');
    assert.equal(container.style.left, '158px');
    await flushFrames(2);
    assert.equal(container.style.left, '158px');

    // The sheet slides: neither size nor window events change, only position.
    // The sliding sheet is an ancestor of the slot; transition events bubble.
    const sheet = document.querySelector('.session-terminal-slot').parentElement;
    sheet.dispatchEvent(new window.Event('transitionrun', { bubbles: true }));
    slotShift = 60;
    await flushFrames(1);
    assert.equal(container.style.left, '100px');
    slotShift = 0;
    await flushFrames(1);
    assert.equal(container.style.left, '40px');

    // A move after the settle window is still picked up by the transition end.
    await flushFrames(60);
    slotShift = 10;
    sheet.dispatchEvent(new window.Event('transitionend', { bubbles: true }));
    await flushFrames(2);
    assert.equal(container.style.left, '50px');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    slotShift = 0;
    delete window.requestAnimationFrame;
    delete window.cancelAnimationFrame;
  }
});

test('a prewarmed session root renders parked before its dock opens and is placed, not remounted, by the open', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let controller = null;
  const props = {
    sessionId: 'warm',
    cwd: 'C:/warm',
    onController: (value) => {
      controller = value;
    },
  };
  try {
    // Closed dock: no active slot, so no root yet.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: false })));
    assert.equal(document.querySelector('.session-terminal-surface-container'), null);

    // The toggle's prewarm: the root renders its tree parked, off screen.
    await act(async () => controller.prewarm('warm'));
    const container = document.querySelector('.session-terminal-surface-container');
    assert.ok(container);
    assert.equal(container.dataset.parked, 'true');
    assert.equal(container.getAttribute('aria-hidden'), 'true');
    assert.equal(container.hasAttribute('inert'), true, 'the warmed tree is out of the Tab order');
    const fixture = container.querySelector('.terminal-surface-fixture');
    assert.equal(fixture.dataset.active, 'false');
    // A warm-up render attaches only: its panes never start or change a shell.
    assert.equal(fixture.dataset.attachOnly, 'true');

    // A second prewarm keeps the root it has.
    await act(async () => controller.prewarm('warm'));
    assert.equal(container.querySelector('.terminal-surface-fixture'), fixture);

    // The open places the same container and tree over the slot.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    assert.equal(document.querySelector('.session-terminal-surface-container'), container);
    assert.equal(container.querySelector('.terminal-surface-fixture'), fixture);
    assert.equal(container.dataset.parked, 'false');
    assert.equal(fixture.dataset.active, 'true');
    assert.equal(fixture.dataset.cwd, 'C:/warm');
    // The real open ends the warm-up: the panes ensure as usual from here.
    assert.equal(fixture.dataset.attachOnly, 'false');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a closing sheet's terminal keeps its pixels but is inert, aria-hidden, unfocused and inactive from the close commit", async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const props = { sessionId: 'exit', cwd: 'C:/exit' };
  try {
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    const container = document.querySelector('.session-terminal-surface-container');
    const fixture = container.querySelector('.terminal-surface-fixture');
    const key = container.querySelector('.terminal-fixture-key');
    key.focus();
    assert.equal(document.activeElement, key);

    // The close commit: the sheet still slides, carrying the surface.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true, exiting: true })));
    assert.equal(container.dataset.parked, 'false', 'still placed over the sliding slot');
    assert.equal(container.style.left, '40px');
    assert.equal(container.hasAttribute('inert'), true);
    assert.equal(container.getAttribute('aria-hidden'), 'true');
    assert.notEqual(document.activeElement, key, 'focus inside is let go');
    assert.equal(fixture.dataset.active, 'false', 'no focus hold, keys or fits');
    assert.equal(fixture.dataset.foreground, 'false');

    // Reopened mid-close: interactive again.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    assert.equal(container.hasAttribute('inert'), false);
    assert.equal(container.hasAttribute('aria-hidden'), false);
    assert.equal(fixture.dataset.active, 'true');
    assert.equal(fixture.dataset.foreground, 'true');

    // The exit ends: surface is unmounted and removed from the DOM.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true, exiting: true })));
    await act(async () => root.render(React.createElement(Harness, { ...props, active: false })));
    assert.equal(document.querySelector('.session-terminal-surface-container'), null);

    // A genuine reopen mounts a fresh interactive surface.
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    const reopened = document.querySelector('.session-terminal-surface-container');
    assert.ok(reopened);
    assert.equal(reopened.hasAttribute('inert'), false);
    assert.equal(reopened.hasAttribute('aria-hidden'), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('releasing a session removes its surface and disposes its terminal identity', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const disposed = [];
  let controller = null;
  try {
    await act(async () =>
      root.render(
        React.createElement(Harness, {
          sessionId: 'alpha',
          active: true,
          cwd: 'C:/alpha',
          disposeTerminal: (terminalId) => disposed.push(terminalId),
          onController: (value) => {
            controller = value;
          },
        })
      )
    );
    assert.ok(document.querySelector('.session-terminal-surface-container'));
    assert.ok(controller);

    await act(async () => controller.release('alpha'));

    assert.equal(document.querySelector('.session-terminal-surface-container'), null);
    assert.deepEqual(disposed, [sessionTerminalId('alpha')]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('releasing a session with no surface still disposes its terminal identity', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const disposed = [];
  let controller = null;
  try {
    await act(async () =>
      root.render(
        React.createElement(Harness, {
          sessionId: 'beta',
          active: false,
          cwd: 'C:/beta',
          disposeTerminal: (terminalId) => disposed.push(terminalId),
          onController: (value) => {
            controller = value;
          },
        })
      )
    );
    assert.equal(document.querySelector('.session-terminal-surface-container'), null);
    await act(async () => controller.release('beta'));
    assert.deepEqual(disposed, [sessionTerminalId('beta')]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a rejected terminal dispose is reported, not left unhandled', async () => {
  const failure = new Error('dispose failed');
  const reports = [];
  const dispose = reportingTerminalDisposer(
    () => Promise.reject(failure),
    (phase, error) => reports.push([phase, error])
  );
  dispose('term-x');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, [['unhandled-rejection', failure]]);
});

test('parked terminal activity releases its renderer and pauses fitting', () => {
  const calls = [];
  const handlers = {
    enableRenderer: () => calls.push('enable'),
    releaseRenderer: () => calls.push('release'),
    scheduleFit: () => calls.push('schedule'),
    pauseFit: () => calls.push('pause'),
    focus: () => calls.push('focus'),
  };

  applyTerminalActivity(false, handlers);
  applyTerminalActivity(true, handlers);

  assert.deepEqual(calls, ['pause', 'release', 'enable', 'schedule', 'focus']);
});

test('stable fitting coalesces changing grids and suppresses duplicate PTY resizes', () => {
  const frames = [];
  const emitted = [];
  const fitCalls = [];
  let current = { cols: 80, rows: 24 };
  let proposed = { cols: 100, rows: 30 };
  const scheduler = new StableTerminalFitScheduler({
    isActive: () => true,
    isMeasurable: () => true,
    currentGrid: () => current,
    proposeGrid: () => proposed,
    fit: (restore) => {
      fitCalls.push(restore);
      current = { ...proposed };
    },
    emitResize: (grid) => emitted.push({ ...grid }),
    onSettled: () => {},
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });
  const flushFrame = () => frames.shift()?.(0);

  scheduler.schedule({ scrollY: 12 });
  flushFrame();
  assert.equal(fitCalls.length, 0);
  flushFrame();
  assert.deepEqual(fitCalls, [{ scrollY: 12 }]);
  assert.deepEqual(emitted, [{ cols: 100, rows: 30 }]);

  scheduler.schedule();
  flushFrame();
  assert.equal(fitCalls.length, 2);
  assert.deepEqual(emitted, [{ cols: 100, rows: 30 }]);

  proposed = { cols: 101, rows: 30 };
  scheduler.schedule();
  flushFrame();
  assert.equal(fitCalls.length, 2);
  scheduler.pause();
  flushFrame();
  assert.equal(fitCalls.length, 2);
});
