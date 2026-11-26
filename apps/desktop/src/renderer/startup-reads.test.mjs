import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HELD_READS = ['getBranchMenu', 'getQuotaHistory', 'getUsageStats'];

async function bootWorld(t) {
  const clock = createRendererClock();
  const { restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  });
  const requests = [];
  const transcriptShown = () =>
    (window.__mixdogBootMetrics ?? []).some((entry) => entry.surface === 'conversation' && entry.stage === 'ready');
  Object.assign(window, {
    setTimeout: clock.win.setTimeout,
    clearTimeout: clock.win.clearTimeout,
    requestAnimationFrame: (callback) => clock.win.setTimeout(() => callback(clock.now), 16),
    cancelAnimationFrame: clock.win.clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    mixdogDesktop: {
      invokeCapability: async (request) => {
        requests.push({
          capability: request.capability,
          composerInert: document.querySelector('textarea').closest('[inert]') !== null,
          transcriptShown: transcriptShown(),
        });
        return {
          value: request.capability === 'getBranchMenu' ? { workspace: { transition: { state: 'idle' } } } : {},
        };
      },
    },
  });
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { _resetBootMetricsForTest, beginBootSurface, reportBootSurfaceReady } = await import('./boot-metrics.ts');
  const { holdStartupReads, _resetStartupReadsForTest } = await import('./startup-reads.ts');
  const { holdStatsDataCache } = await import('./command-surface-cache.ts');
  const { prefetchQuotaUsage } = await import('./quota-usage-cache.ts');
  const { useBranchMenuData, clearBranchMenuReads } = await import('./branch-menu-data.ts');
  _resetBootMetricsForTest();
  _resetStartupReadsForTest();
  clearBranchMenuReads();
  holdStartupReads();

  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    _resetStartupReadsForTest();
    clock.timers.clear();
    restore();
  });
  function Workspace() {
    beginBootSurface('conversation', 'restored');
    useEffect(() => holdStatsDataCache(window.mixdogDesktop), []);
    useEffect(() => prefetchQuotaUsage(window.mixdogDesktop), []);
    useBranchMenuData({ draft: false, projectPath: 'C:/repo', sessionId: 's1', intentKey: 's1', refreshKey: '' });
    return React.createElement('textarea', { 'aria-label': 'Composer' });
  }
  const render = (restorePending) =>
    act(async () =>
      root.render(
        React.createElement(DesktopBootGate, { ready: !restorePending, restorePending }, React.createElement(Workspace))
      )
    );
  // Effects flush when `act` ends, so the cover's fade timer lands in a later step.
  const advance = async (ms) => {
    for (let step = 0; step < 4; step += 1) await act(async () => clock.advance(ms / 4));
  };
  const paintTranscript = () => act(async () => reportBootSurfaceReady('conversation', 'restored'));
  return { requests, render, advance, paintTranscript };
}

test('at start usage statistics, quota history and the branch menu are read only after the restored transcript shows and the composer takes input', async (t) => {
  const { requests, render, advance, paintTranscript } = await bootWorld(t);
  await render(true);
  await advance(10_000);
  assert.deepEqual(requests, [], 'nothing is read while the last session is restored');
  await render(false);
  await advance(500);
  assert.deepEqual(requests, [], 'nothing is read before the restored transcript paints');

  await paintTranscript();
  await advance(1_000);
  assert.equal(document.querySelector('textarea').closest('[inert]'), null, 'the composer takes input');
  assert.deepEqual(
    requests.map((request) => request.capability).sort(),
    HELD_READS,
    'the surfaces fill in without the user asking'
  );
  for (const request of requests) {
    assert.equal(request.transcriptShown, true, `${request.capability} waited for the transcript`);
    assert.equal(request.composerInert, false, `${request.capability} waited for the composer`);
  }
});

test('a boot cover that times out on a transcript that never paints still releases the held reads', async (t) => {
  const { requests, render, advance } = await bootWorld(t);
  await render(true);
  await render(false);
  await advance(10_000);
  assert.equal(document.querySelector('textarea').closest('[inert]'), null, 'the timed-out cover hands off');
  assert.deepEqual(
    requests.map((request) => request.capability).sort(),
    HELD_READS,
    'a usable composer never sits beside held reads'
  );
  for (const request of requests) {
    assert.equal(request.composerInert, false, `${request.capability} waited for the composer`);
  }
});
