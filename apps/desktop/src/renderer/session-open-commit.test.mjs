import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useAppSessionOpen, beginProjectNavigation } = await import('./app-shell-session-open.ts');
const { defaultSessionLaneStore } = await import('./session-lane-store.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const lane = (sessionId) => ({ sessionId, snapshot: { sessionId, items: [{ id: `${sessionId}-1`, role: 'user' }] } });

/** The state a sidebar click drives: the selected session, its requested id
 *  and every committed pair. */
function mount(t) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => act(async () => root.unmount()));
  const commits = [];
  const handle = {};
  function Harness() {
    const [selected, setSelected] = React.useState('a');
    const [requested, setRequested] = React.useState('');
    const navigationEpoch = React.useRef(0);
    const { openSession } = useAppSessionOpen({
      navigationEpoch,
      closeSidebarForNavigation() {},
      setRequestedSessionId: setRequested,
      sessions: [],
      tabs: [],
      finishPendingConversationHandoff() {},
      activateSelection: (selection) => setSelected(selection.id),
    });
    handle.openSession = openSession;
    handle.begin = () => beginProjectNavigation(navigationEpoch, setRequested);
    handle.epoch = navigationEpoch;
    commits.push(`${selected}/${requested}`);
    return React.createElement('div', { id: 'state', 'data-selected': selected, 'data-requested': requested });
  }
  return { root, commits, handle, Harness, read: () => document.getElementById('state').dataset };
}

test('a warm sidebar click selects the session in its own synchronous commit, never holding a requested id', async (t) => {
  const view = mount(t);
  await act(async () => view.root.render(React.createElement(view.Harness)));
  defaultSessionLaneStore.apply(lane('warm-b'));
  view.commits.length = 0;
  await act(async () => {
    flushSync(() => {
      void view.handle.openSession('warm-b');
    });
    // Nothing is left pending behind the click: the transition-lane work an
    // act scope flushes later would paint the outgoing session first.
    assert.equal(view.read().selected, 'warm-b');
    assert.equal(view.read().requested, '');
  });
  assert.ok(
    view.commits.every((entry) => entry === 'warm-b/'),
    `commits: ${view.commits.join(' ')}`
  );
});

test('a cold sidebar click selects at once and drops its requested id after the read', async (t) => {
  const view = mount(t);
  await act(async () => view.root.render(React.createElement(view.Harness)));
  let finishRead;
  window.mixdogDesktop = {
    prefetchSession: () =>
      new Promise((resolve) => {
        finishRead = () => {
          defaultSessionLaneStore.apply(lane('cold-c'));
          resolve(true);
        };
      }),
  };
  t.after(() => {
    delete window.mixdogDesktop;
  });
  await act(async () => {
    flushSync(() => {
      void view.handle.openSession('cold-c');
    });
    assert.equal(view.read().selected, 'cold-c');
    assert.equal(view.read().requested, 'cold-c');
  });
  await act(async () => finishRead());
  assert.equal(view.read().selected, 'cold-c');
  assert.equal(view.read().requested, '');
});

test('entering a project while a cold open is in flight drops its requested id; the late read does not restore it', async (t) => {
  const view = mount(t);
  await act(async () => view.root.render(React.createElement(view.Harness)));
  let finishRead;
  window.mixdogDesktop = {
    prefetchSession: () =>
      new Promise((resolve) => {
        finishRead = () => {
          defaultSessionLaneStore.apply(lane('cold-d'));
          resolve(true);
        };
      }),
  };
  t.after(() => {
    delete window.mixdogDesktop;
  });
  await act(async () => {
    flushSync(() => {
      void view.handle.openSession('cold-d');
    });
  });
  assert.equal(view.read().requested, 'cold-d');
  const before = view.handle.epoch.current;
  await act(async () => view.handle.begin());
  assert.equal(view.handle.epoch.current, before + 1);
  assert.equal(view.read().requested, '', 'the sidebar identity is no longer pinned to the abandoned open');
  await act(async () => finishRead());
  assert.equal(view.read().requested, '');
});
