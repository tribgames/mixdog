// A stable callback keeps its identity, runs the latest COMMITTED callback,
// and never exposes the closure of a render React abandoned.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, { html: '<!doctype html><body><main></main></body>' });
test.after(() => restore());
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { default: React, act, Suspense, startTransition, use, useLayoutEffect } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStableCallback } = await import('./use-stable-callback.ts');

function setup() {
  const seen = { stable: null, layout: null };
  function Probe({ id }) {
    const stable = useStableCallback(() => id);
    seen.stable = stable;
    // A layout effect of the committing render already sees its own callback.
    useLayoutEffect(() => {
      seen.layout = stable();
    });
    return null;
  }
  function Gate({ gate }) {
    if (gate) use(gate);
    return null;
  }
  const App = ({ id, gate }) =>
    React.createElement(
      Suspense,
      { fallback: 'loading' },
      React.createElement(Probe, { id }),
      React.createElement(Gate, { gate })
    );
  return { seen, App, root: createRoot(document.querySelector('main')) };
}

test('the identity is fixed and the callback runs the latest committed props', async () => {
  const { seen, App, root } = setup();
  try {
    await act(async () => root.render(React.createElement(App, { id: 1 })));
    const first = seen.stable;
    assert.equal(first(), 1);
    assert.equal(seen.layout, 1);
    await act(async () => root.render(React.createElement(App, { id: 2 })));
    assert.equal(seen.stable, first, 'identity does not change');
    assert.equal(first(), 2);
    assert.equal(seen.layout, 2, 'a layout effect sees the callback being committed');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a render that is abandoned (suspended transition) never leaks its callback', async () => {
  const { seen, App, root } = setup();
  try {
    await act(async () => root.render(React.createElement(App, { id: 1 })));
    const stable = seen.stable;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // The transition renders Probe with id 2, then Gate suspends it: the
    // screen keeps showing id 1 and the render is never committed.
    await act(async () => {
      startTransition(() => root.render(React.createElement(App, { id: 2, gate })));
    });
    assert.equal(stable(), 1, 'the uncommitted render must not be visible');
    await act(async () => {
      release();
      await gate;
    });
    assert.equal(stable(), 2, 'once committed, the new callback is live');
  } finally {
    await act(async () => root.unmount());
  }
});
