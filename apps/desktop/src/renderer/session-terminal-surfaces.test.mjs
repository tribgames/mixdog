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
dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const fixed = this.classList.contains('main-panel')
    ? { left: 10, top: 0, right: 1010, bottom: 700 }
    : this.classList.contains('pane-side-dock-header')
      ? { left: 600, top: 0, right: 1010, bottom: 48 }
      : null;
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
  return {
    x: visible ? 40 : 0,
    y: visible ? 20 : 0,
    left: visible ? 40 : 0,
    top: visible ? 20 : 0,
    right: visible ? 760 : 0,
    bottom: visible ? 500 : 0,
    width: visible ? 720 : 0,
    height: visible ? 480 : 0,
    toJSON() {
      return this;
    },
  };
};

const { SessionTerminalParkingHost, SessionTerminalSlot, sessionTerminalId, useSessionTerminalSurfaces } = await import(
  './session-terminal-surfaces.tsx'
);
const { applyTerminalActivity, StableTerminalFitScheduler } = await import('./terminal-fit.ts');

const renderFixture = (props) =>
  React.createElement('div', {
    className: 'terminal-surface-fixture',
    'data-cwd': props.cwd,
    'data-active': props.active ? 'true' : 'false',
    'data-parked': props.parked ? 'true' : 'false',
    'data-expanded': props.expanded ? 'true' : 'false',
    onClick: props.onToggleExpanded,
  });

function Harness({ sessionId, active, cwd, disposeTerminal, onController, docked = false }) {
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

test('an expanded terminal covers the main panel below the dock header and resets when parked', async () => {
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
    assert.equal(container.dataset.parked, 'true');
    assert.equal(container.dataset.expanded, 'false');
    assert.equal(header.dataset.surfaceExpanded, undefined);
    assert.equal(header.style.left, '');
    assert.equal(header.style.width, '');
    await act(async () => root.render(React.createElement(Harness, { ...props, active: true })));
    assert.equal(container.dataset.expanded, 'false');
    assert.equal(container.style.top, '20px');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('one session terminal root parks and restores at Browser Use width', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(Harness, {
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

    await act(async () =>
      root.render(
        React.createElement(Harness, {
          sessionId: 'alpha',
          active: false,
          cwd: 'C:/alpha',
        })
      )
    );
    assert.equal(document.querySelector('.session-terminal-surface-container'), container);
    assert.equal(container.dataset.parked, 'true');
    assert.equal(container.style.width, '720px');
    assert.equal(container.style.height, '480px');
    assert.equal(container.querySelector('.terminal-surface-fixture').dataset.parked, 'true');

    await act(async () =>
      root.render(
        React.createElement(Harness, {
          sessionId: 'alpha',
          active: true,
          cwd: 'C:/alpha',
        })
      )
    );
    assert.equal(document.querySelector('.session-terminal-surface-container'), container);
    assert.equal(container.dataset.parked, 'false');
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
