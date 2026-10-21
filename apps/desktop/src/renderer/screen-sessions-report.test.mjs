// The renderer reports what it ACTUALLY shows: pane sessions, minus everything
// while a modal or an expanded sheet covers the workspace.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { useScreenSessions } = await import('./use-visible-sessions.ts');
const { openModal } = await import('./settings/dialog-modality.ts');
const { DockHeaderRow } = await import('./pane-dock-chrome.tsx');

function setup(t) {
  const reports = [];
  window.mixdogDesktop = { reportScreenSessions: (ids) => reports.push(ids) };
  const host = document.getElementById('root');
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
  });
  return { reports, root };
}

function Pane({ ids, children }) {
  useScreenSessions(ids);
  return children ?? null;
}

const mountModal = () => {
  const layer = document.createElement('div');
  document.body.append(layer);
  const release = openModal(layer);
  return () => {
    release();
    layer.remove();
  };
};

test('the shown sessions are reported, split panes included, and re-reported on change', async (t) => {
  const { reports, root } = setup(t);
  await act(async () => root.render(React.createElement(Pane, { ids: ['a', 'b'] })));
  await act(async () => root.render(React.createElement(Pane, { ids: ['a', 'b'] })));
  await act(async () => root.render(React.createElement(Pane, { ids: ['c'] })));
  assert.deepEqual(reports, [['a', 'b'], ['c']]);
});

test('an open modal (settings, onboarding) covers the chat: empty while open, restored on close', async (t) => {
  const { reports, root } = setup(t);
  await act(async () => root.render(React.createElement(Pane, { ids: ['a'] })));
  let closeModal = () => {};
  await act(async () => {
    closeModal = mountModal();
  });
  assert.deepEqual(reports.at(-1), [], 'covered session is reported as not shown');
  await act(async () => closeModal());
  assert.deepEqual(reports.at(-1), ['a'], 'visible again once the modal closes');
  assert.deepEqual(reports, [['a'], [], ['a']]);
});

test('a session opened while a modal covers the workspace is not reported until it closes', async (t) => {
  const { reports, root } = setup(t);
  let closeModal = () => {};
  await act(async () => {
    closeModal = mountModal();
  });
  await act(async () => root.render(React.createElement(Pane, { ids: ['a'] })));
  assert.deepEqual(reports.at(-1), []);
  await act(async () => closeModal());
  assert.deepEqual(reports.at(-1), ['a']);
});

test('an expanded dock, browser or terminal sheet covers the chat; restoring it shows the chat again', async (t) => {
  const { reports, root } = setup(t);
  const render = (expanded) =>
    root.render(
      React.createElement(
        Pane,
        { ids: ['a'] },
        React.createElement(DockHeaderRow, {
          title: 'Browser',
          expanded,
          onToggleExpanded: () => {},
          onClose: () => {},
        })
      )
    );
  await act(async () => render(false));
  assert.deepEqual(reports.at(-1), ['a']);
  await act(async () => render(true));
  assert.deepEqual(reports.at(-1), []);
  await act(async () => render(false));
  assert.deepEqual(reports.at(-1), ['a']);
  await act(async () => render(true));
  assert.deepEqual(reports.at(-1), []);
  // Closing the expanded surface releases the cover too.
  await act(async () => root.render(React.createElement(Pane, { ids: ['a'] }, null)));
  assert.deepEqual(reports.at(-1), ['a']);
});
