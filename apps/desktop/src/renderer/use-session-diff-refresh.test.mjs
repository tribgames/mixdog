import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionDiffRefresh } from './use-session-diff-refresh.ts';
import { bumpTurnChangesEpoch } from './turn-changes-model.ts';
import { primeSessionDiff } from './session-diff-cache.ts';
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
  dom.window.setTimeout = clock.win.setTimeout;
  dom.window.clearTimeout = clock.win.clearTimeout;
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
    renderAll: (list) =>
      act(async () =>
        root.render(
          React.createElement(
            React.Fragment,
            null,
            ...list.map((props, index) => React.createElement(Probe, { key: index, ...base, ...props }))
          )
        )
      ),
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

test('session diffs do no hidden, timer or focus polling and read only on change signals', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `patch-${calls}` } };
  });
  const id = 'signals';
  await view.visibility('hidden');
  await view.render({ sessionId: id });
  await view.advance(20_000);
  assert.equal(calls, 0);
  assert.equal(view.clock.timers.size, 0);
  await view.visibility('visible');
  assert.equal(calls, 1);
  assert.match(view.text(), /patch-1/);
  // Busy, idle time, focus and visibility flips start nothing without a signal.
  await view.advance(60_000);
  await view.visibility('hidden');
  await view.visibility('visible');
  await act(async () => view.win.dispatchEvent(new view.win.Event('focus')));
  await view.advance(60_000);
  assert.equal(calls, 1);
  // A signal while hidden is caught up on return.
  await view.visibility('hidden');
  await view.render({ sessionId: id, revision: 'second' });
  await view.advance(20_000);
  assert.equal(calls, 1);
  await view.visibility('visible');
  await view.advance(1_000);
  assert.equal(calls, 2);
  await view.render({ sessionId: id, revision: 'second', active: false });
  await view.advance(60_000);
  assert.equal(calls, 2);
  assert.equal(view.clock.timers.size, 0);
});

test('a revision signal is debounced into one read and a burst during a read costs one follow-up', async (t) => {
  const requests = [];
  const view = harness(t, () => {
    const request = Promise.withResolvers();
    requests.push(request);
    return request.promise;
  });
  const id = 'burst';
  await view.render({ sessionId: id, revision: 'r0' });
  await view.settle(() => requests[0].resolve({ value: { supported: true, files: [], patch: 'p0' } }));
  assert.equal(requests.length, 1);
  for (let index = 1; index <= 6; index += 1) {
    await view.render({ sessionId: id, revision: `r${index}` });
    await view.advance(50);
  }
  assert.equal(requests.length, 1, 'debounce holds the read back');
  await view.advance(300);
  assert.equal(requests.length, 2);
  // More signals while that read runs: one follow-up only.
  for (let index = 7; index <= 12; index += 1) {
    await view.render({ sessionId: id, revision: `r${index}` });
    await view.advance(300);
  }
  assert.equal(requests.length, 2);
  await view.settle(() => requests[1].resolve({ value: { supported: true, files: [], patch: 'p1' } }));
  assert.equal(requests.length, 3);
  await view.settle(() => requests[2].resolve({ value: { supported: true, files: [], patch: 'p2' } }));
  assert.equal(requests.length, 3);
  assert.match(view.text(), /p2/);
});

test('Undo / Delete history (turn-changes epoch bump) still refreshes the diff', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `epoch-${calls}` } };
  });
  const id = 'epoch';
  await view.render({ sessionId: id });
  assert.equal(calls, 1);
  await act(async () => {
    bumpTurnChangesEpoch(id);
  });
  await view.advance(500);
  assert.equal(calls, 2);
  assert.match(view.text(), /epoch-2/);
  await view.advance(60_000);
  assert.equal(calls, 2);
});

test('a failed read keeps its signal dirty: visibility restore retries instead of adopting the old cache', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    if (calls === 2) throw new Error('read failed');
    return { value: { supported: true, files: [], patch: `ok-${calls}` } };
  });
  const id = 'failed-signal';
  await view.render({ sessionId: id, revision: 'r0' });
  assert.equal(calls, 1);
  await view.render({ sessionId: id, revision: 'r1' });
  await view.advance(500);
  assert.equal(calls, 2);
  assert.match(view.text(), /read failed/);
  // Nothing without a signal or focus; restore retries the unanswered signal.
  await view.advance(60_000);
  assert.equal(calls, 2);
  await view.visibility('hidden');
  await view.visibility('visible');
  assert.equal(calls, 3);
  assert.match(view.text(), /false\|ok-3\|$/);
  // Answered now: another restore only re-adopts.
  await view.visibility('hidden');
  await view.visibility('visible');
  assert.equal(calls, 3);
});

test('a read that lands after switching sessions still answers its own session, so returning does not recompute', async (t) => {
  const requests = [];
  const view = harness(t, ({ sessionId }) => {
    const request = Promise.withResolvers();
    requests.push({ sessionId, ...request });
    return request.promise;
  });
  await view.render({ sessionId: 'switch-a', revision: 'a1' });
  assert.equal(requests.length, 1);
  await view.render({ sessionId: 'switch-b', revision: 'b1' });
  assert.equal(requests.length, 2);
  await view.settle(() => requests[0].resolve({ value: { supported: true, files: [], patch: 'a-patch' } }));
  await view.settle(() => requests[1].resolve({ value: { supported: true, files: [], patch: 'b-patch' } }));
  await view.render({ sessionId: 'switch-a', revision: 'a1' });
  await view.advance(1_000);
  assert.equal(requests.length, 2, 'the unchanged session adopts its cache');
  assert.match(view.text(), /a-patch/);
});

test('an inactive same-session sibling with an older signal never suppresses the active pane refresh', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `sibling-${calls}` } };
  });
  const id = 'sibling';
  await view.renderAll([
    { sessionId: id, revision: 'r0' },
    { sessionId: id, revision: 'r0', active: false },
  ]);
  assert.equal(calls, 1);
  await view.renderAll([
    { sessionId: id, revision: 'r1' },
    { sessionId: id, revision: 'r0', active: false },
  ]);
  await view.advance(500);
  assert.equal(calls, 2);
  assert.match(view.text(), /sibling-2/);
});

test('ordinary window focus re-adopts the cached result without a read', async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `read-${calls}` } };
  });
  const id = 'focus-adopt';
  await view.render({ sessionId: id });
  assert.match(view.text(), /read-1/);
  // Another consumer settles a newer result; focus (no visibility flip) adopts it.
  primeSessionDiff(id, { supported: true, files: [], patch: 'primed' });
  await act(async () => view.win.dispatchEvent(new view.win.Event('focus')));
  assert.match(view.text(), /primed/);
  assert.equal(calls, 1);
});

test('a closed pane ignores a late response and a reopened one adopts the settled result', async (t) => {
  let resolve;
  let calls = 0;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const view = harness(t, () => {
    calls += 1;
    return gate;
  });
  const id = 'late';
  await view.render({ sessionId: id });
  await view.render({ sessionId: id, active: false });
  const closed = view.text();
  await view.settle(() => resolve({ value: { supported: true, files: [], patch: 'late' } }));
  assert.equal(view.text(), closed);
  await view.render({ sessionId: id });
  assert.equal(calls, 1);
  assert.match(view.text(), /late/);
});

test('refresh reports adoption: skipped hidden reads and superseded responses are not adopted', async (t) => {
  const requests = [];
  const view = harness(t, () => {
    const request = Promise.withResolvers();
    requests.push(request);
    return request.promise;
  });
  let refresh;
  await view.render({ sessionId: 'adopt', onRender: (state) => (refresh = state.refresh) });
  await view.settle(() => requests[0].resolve({ value: { supported: true, files: [], patch: 'initial' } }));
  await view.visibility('hidden');
  assert.equal(await refresh(true), false);
  assert.equal(requests.length, 1);
  await view.visibility('visible');
  assert.equal(requests.length, 1);
  let first;
  let second;
  await act(async () => {
    first = refresh(true);
    second = refresh(true);
  });
  assert.equal(requests.length, 2);
  await view.settle(() => requests[1].resolve({ value: { supported: true, files: [], patch: 'newer' } }));
  await view.settle(() => requests[2].resolve({ value: { supported: true, files: [], patch: 'newest' } }));
  assert.equal(requests.length, 3, 'two user refreshes cost one read plus one follow-up');
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
    await view.render({ sessionId: 'mounts' });
    await view.empty();
    assert.equal(view.clock.timers.size, 0);
  }
  const settledCalls = calls;
  await view.advance(60_000);
  await view.visibility('hidden');
  await view.visibility('visible');
  assert.equal(calls, settledCalls);
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
  assert.ok(
    frames.slice(rendered).every((frame) => frame.loading === false),
    'background polls never flip loading'
  );
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
