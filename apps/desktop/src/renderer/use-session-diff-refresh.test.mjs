import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionDiffRefresh } from './use-session-diff-refresh.ts';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';

function Probe(props) {
  const state = useSessionDiffRefresh(props);
  props.onRender?.(state);
  return React.createElement('output', null, `${state.loading}|${state.result?.patch || ''}|${state.error}`);
}

function harness(t, invokeCapability, desktop = {}) {
  const clock = createRendererClock();
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><main></main>',
    jsdom: { pretendToBeVisual: true },
  });
  let visibility = 'visible';
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
  dom.window.setInterval = clock.win.setInterval;
  dom.window.clearInterval = clock.win.clearInterval;
  dom.window.mixdogDesktop = { invokeCapability, ...desktop };
  const root = createRoot(dom.window.document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  const base = { sessionId: 'session', active: true, busy: true, revision: 'first' };
  return {
    clock,
    win: dom.window,
    render: (props = {}) => act(async () => root.render(React.createElement(Probe, { ...base, ...props }))),
    empty: () => act(async () => root.render(null)),
    text: () => dom.window.document.querySelector('main').textContent,
    visibility: (value) =>
      act(async () => {
        visibility = value;
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      }),
    advance: (ms) => act(async () => clock.advance(ms)),
    settle: (work) =>
      act(async () => {
        work();
        await clock.settle();
      }),
  };
}

test('session diffs do no hidden polling or revision-triggered reads and refresh on return', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `patch-${calls}` } };
  });
  await view.visibility('hidden');
  await view.render();
  await view.advance(20_000);
  assert.equal(calls, 0);
  assert.equal(view.clock.timers.size, 0);
  await view.visibility('visible');
  assert.equal(calls, 1);
  assert.match(view.text(), /patch-1/);
  await view.advance(4_000);
  assert.equal(calls, 2);
  await view.visibility('hidden');
  await view.render({ revision: 'second' });
  await view.advance(20_000);
  assert.equal(calls, 2);
  await view.visibility('visible');
  assert.equal(calls, 3);
  await view.render({ active: false });
  await view.advance(20_000);
  assert.equal(calls, 3);
  assert.equal(view.clock.timers.size, 0);
});

test('late responses cannot update a closed diff pane and a reopened pane still refreshes', async (t) => {
  let resolve;
  let calls = 0;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const view = harness(t, () => {
    calls += 1;
    return calls === 1
      ? gate
      : Promise.resolve({
          value: { supported: true, files: [], patch: 'fresh' },
        });
  });
  await view.render();
  await view.render({ active: false });
  const closed = view.text();
  await view.settle(() => resolve({ value: { supported: true, files: [], patch: 'late' } }));
  assert.equal(view.text(), closed);
  await view.render();
  assert.equal(calls, 2);
  assert.match(view.text(), /fresh/);
});

test('refresh reports adoption: skipped hidden reads and superseded responses are not adopted', async (t) => {
  const requests = [];
  const view = harness(t, () => {
    const request = Promise.withResolvers();
    requests.push(request);
    return request.promise;
  });
  let refresh;
  await view.render({ onRender: (state) => (refresh = state.refresh) });
  await view.settle(() => requests[0].resolve({ value: { supported: true, files: [], patch: 'initial' } }));
  await view.visibility('hidden');
  assert.equal(await refresh(true), false);
  assert.equal(requests.length, 1);
  await view.visibility('visible');
  const visibleRead = requests.length;
  let first;
  let second;
  await act(async () => {
    first = refresh(true);
    second = refresh(true);
  });
  assert.ok(requests.length > visibleRead - 1);
  await view.settle(() => {
    for (const request of requests.slice(visibleRead - 1)) {
      request.resolve({ value: { supported: true, files: [], patch: 'newer' } });
    }
  });
  assert.equal(await first, false);
  assert.equal(await second, true);
});

test('repeated diff pane mounts leave no timer that can launch another backend read', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: 'diff' } };
  });
  for (let index = 0; index < 200; index += 1) {
    await view.render();
    await view.empty();
    assert.equal(view.clock.timers.size, 0);
  }
  const settledCalls = calls;
  await view.advance(60_000);
  await view.visibility('hidden');
  await view.visibility('visible');
  assert.equal(calls, settledCalls);
});

test('an idle island re-reads after Git changes made outside a turn (project watch, focus)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let calls = 0;
  let notify;
  const watched = [];
  const view = harness(
    t,
    async () => {
      calls += 1;
      return { value: { supported: true, files: [], patch: `idle-${calls}` } };
    },
    {
      folderWatch: async (path) => void watched.push(path),
      folderUnwatch: async () => {},
      subscribeFolderChanges: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    }
  );
  const wait = (work) =>
    act(async () => {
      work();
      for (let index = 0; index < 4; index += 1) {
        t.mock.timers.tick(1_000);
        await view.clock.settle();
      }
    });
  const props = { sessionId: 'idle-git', busy: false, gitWatchPath: 'C:/repo' };
  await view.render(props);
  await wait(() => {});
  const initial = calls;
  assert.ok(initial >= 1);
  assert.deepEqual(watched, ['C:/repo'], "the project is watched (Source Control's evidence)");

  // A commit in a terminal touches .git: the recursive project watch fires.
  await wait(() => notify('C:/repo'));
  assert.equal(calls, initial + 1);
  // Committing in another app, then coming back: focus re-reads.
  await wait(() => view.win.dispatchEvent(new view.win.Event('focus')));
  assert.equal(calls, initial + 2);

  // A running turn's own cadence owns it: the watch is released.
  await view.render({ ...props, busy: true });
  assert.equal(notify, undefined);
});

test('an unchanged background poll neither flips loading nor re-renders; a changed one does', async (t) => {
  let patch = 'same';
  const view = harness(t, async () => ({
    value: { supported: true, files: [{ path: 'a.ts' }], patch },
  }));
  const frames = [];
  let refresh;
  const onRender = (state) => {
    refresh = state.refresh;
    frames.push(state);
  };
  await view.render({ sessionId: 'unchanged-poll', onRender });
  await view.settle(() => {});
  assert.match(view.text(), /false\|same/);
  const rendered = frames.length;
  await act(async () => {
    assert.equal(await refresh(true, true), true);
  });
  await view.settle(() => {});
  assert.equal(frames.length, rendered, 'an unchanged background poll renders nothing');
  patch = 'different';
  await act(async () => {
    await refresh(true, true);
  });
  assert.match(view.text(), /different/);
  assert.ok(frames.slice(rendered).every((frame) => frame.loading === false), 'background polls never flip loading');
});

test("a new session never presents the previous session's diff or an unconfirmed empty result", async (t) => {
  const requests = [];
  const view = harness(t, () => {
    const request = Promise.withResolvers();
    requests.push(request);
    return request.promise;
  });
  await view.render({ sessionId: 'first-initial-diff' });
  await view.settle(() =>
    requests[0].resolve({
      value: { supported: true, files: [], patch: 'previous-session' },
    })
  );
  const frames = [];
  await view.render({
    sessionId: 'second-initial-diff',
    onRender: ({ result, loading, error }) => frames.push({ result, loading, error }),
  });
  assert.ok(frames.length);
  for (const frame of frames) {
    assert.equal(frame.result, null);
    assert.equal(frame.loading, true);
    assert.equal(frame.error, '');
  }
  await view.settle(() =>
    requests[1].resolve({
      value: { supported: true, files: [], patch: 'next-session' },
    })
  );
  assert.match(view.text(), /next-session/);
});
