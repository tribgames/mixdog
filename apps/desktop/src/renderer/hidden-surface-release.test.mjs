import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';
import { createFolderWatchRegistry } from '../main/desktop-operations.ts';
import { startEditorDiskWatch } from './editor-disk-watch.ts';
import { useExplorerDirs } from './explorer-dir-state.ts';
import { useRetainedDiff } from './pane-side-dock.tsx';
import { installTestDom } from './test-support/test-dom.mjs';
import { attachTerminalOutput, detachTerminalOutput } from './terminal-output-subscription.ts';

test('terminal output feed is view-owned: attached once, survives pane unmount, released on dispose', () => {
  let subscribed = 0;
  let released = 0;
  let listener = null;
  const subscribe = (next) => {
    subscribed += 1;
    listener = next;
    return () => {
      released += 1;
      listener = null;
    };
  };
  const pushed = [];
  const view = { id: 'term-1', writer: { push: (id, data) => pushed.push([id, data]) }, localEcho: null };
  attachTerminalOutput(view, subscribe);
  attachTerminalOutput(view, subscribe); // a remount's ensure must not stack a second feed
  assert.equal(subscribed, 1);
  listener({ id: 'term-1', data: 'a' });
  listener({ id: 'other', data: 'ignored' });
  assert.deepEqual(pushed, [['term-1', 'a']]);
  // Pane unmount does not touch the view: output keeps flowing (and is acked by the pump).
  listener({ id: 'term-1', data: 'b' });
  assert.equal(pushed.length, 2);
  assert.equal(released, 0);
  detachTerminalOutput(view);
  detachTerminalOutput(view);
  assert.equal(released, 1);
  assert.equal(listener, null);
});

test('editor disk polling owns no timer while the window is hidden and checks once on return', () => {
  const clock = createRendererClock();
  let checks = 0;
  const stop = startEditorDiskWatch(clock.win, () => {
    checks += 1;
  });
  assert.equal(clock.timers.size, 1);
  clock.visibility('hidden');
  assert.equal(clock.timers.size, 0);
  clock.visibility('visible');
  assert.equal(checks, 1);
  assert.equal(clock.timers.size, 1);
  stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.win.listenerCount() + clock.doc.listenerCount(), 0);
});

test('folder watch registry closes a watcher whose native watch errored', () => {
  const watchers = [];
  const fakeWatch = () => {
    const watcher = new EventEmitter();
    watcher.closed = 0;
    watcher.close = () => {
      watcher.closed += 1;
    };
    watchers.push(watcher);
    return watcher;
  };
  const registry = createFolderWatchRegistry(() => {}, fakeWatch);
  registry.watch('/repo', true);
  watchers[0].emit('error', new Error('EPERM'));
  assert.equal(watchers[0].closed, 1);
  registry.watch('/repo', true);
  assert.equal(watchers.length, 2, 'a fresh watcher replaces the failed one');
  registry.dispose();
  assert.equal(watchers[1].closed, 1);
});

function domHarness(t) {
  const clock = createRendererClock();
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { pretendToBeVisual: true },
  });
  let visibility = 'visible';
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
  dom.window.setInterval = clock.win.setInterval;
  dom.window.clearInterval = clock.win.clearInterval;
  dom.window.setTimeout = clock.win.setTimeout;
  dom.window.clearTimeout = clock.win.clearTimeout;
  const root = createRoot(dom.window.document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  return {
    dom,
    clock,
    root,
    visibility: (value) =>
      act(async () => {
        visibility = value;
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      }),
  };
}

test('explorer safety refresh pauses while hidden and stops when the Files pane goes inactive', async (t) => {
  const view = domHarness(t);
  let lists = 0;
  const api = {
    listProjectDir: async () => {
      lists += 1;
      return [];
    },
  };
  function Probe({ active }) {
    useExplorerDirs({
      api,
      projectPath: '/repo',
      active,
      readinessKey: 'k',
      onReadyChange() {},
      onProjectReset() {},
    });
    return null;
  }
  const render = (active) => act(async () => view.root.render(React.createElement(Probe, { active })));
  await render(true);
  const baseline = view.clock.timers.size;
  assert.ok(baseline >= 1, 'active pane keeps its safety timer');
  await view.visibility('hidden');
  assert.equal(view.clock.timers.size, baseline - 1);
  await view.visibility('visible');
  assert.equal(view.clock.timers.size, baseline);
  await render(false);
  assert.equal(view.clock.timers.size, 0);
  assert.ok(lists >= 1);
});

test('retained diff releases its document input listeners once the tree is dropped', async (t) => {
  const view = domHarness(t);
  t.mock.method(performance, 'now', () => view.clock.now);
  const doc = view.dom.window.document;
  const added = new Set();
  const addListener = doc.addEventListener.bind(doc);
  const removeListener = doc.removeEventListener.bind(doc);
  doc.addEventListener = (name, fn, opts) => {
    if (name === 'keydown' || name === 'input') added.add(fn);
    return addListener(name, fn, opts);
  };
  doc.removeEventListener = (name, fn, opts) => {
    if (name === 'keydown' || name === 'input') added.delete(fn);
    return removeListener(name, fn, opts);
  };
  let retained = 'unset';
  function Probe({ diff }) {
    retained = useRetainedDiff(diff);
    return null;
  }
  const shown = { kind: 'diff', project: '/repo', rel: 'a.ts', source: 'unstaged' };
  await act(async () => view.root.render(React.createElement(Probe, { diff: shown })));
  await act(async () => view.root.render(React.createElement(Probe, { diff: null })));
  assert.equal(added.size, 1, 'listening while the closed diff is retained');
  assert.equal(retained, shown);
  await act(async () => view.clock.advance(1_600));
  await act(async () => view.clock.advance(1_600));
  assert.equal(retained, null);
  assert.equal(added.size, 0, 'listeners are gone after the retained tree is dropped');
});
