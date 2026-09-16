import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';

function harness(t, { globalTimers = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const saved = new Map();
  const clock = createRendererClock();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    ...(globalTimers
      ? {
          setTimeout: clock.win.setTimeout,
          clearTimeout: clock.win.clearTimeout,
        }
      : {}),
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.assign(window, {
    setTimeout: clock.win.setTimeout,
    clearTimeout: clock.win.clearTimeout,
    setInterval: clock.win.setInterval,
    clearInterval: clock.win.clearInterval,
    requestAnimationFrame: (callback) => clock.win.setTimeout(() => callback(clock.now), 16),
    cancelAnimationFrame: clock.win.clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    mixdogDesktop: {
      rendererDiagnostic() {},
      invokeCapability: () => new Promise(() => {}),
      listAgentPool: () => new Promise(() => {}),
    },
  });
  const host = document.querySelector('main');
  const root = createRoot(host);
  const originalNow = Date.now;
  if (globalTimers) Date.now = () => clock.now;
  t.after(async () => {
    await act(async () => root.unmount());
    if (globalTimers) Date.now = originalNow;
    clock.timers.clear();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    host,
    root,
    dom,
    render: (node) => act(async () => root.render(node)),
    advance: (ms) => act(async () => clock.advance(ms)),
    settle: (work) =>
      act(async () => {
        work();
        await clock.settle();
      }),
  };
}

test('cold lists expose a neutral pending state on their very first render', async (t) => {
  const view = harness(t);
  const [
    { ProjectsPane },
    { SchedulesPane },
    { WebhooksPane },
    { WorkflowsPane },
    { AgentActivityPane },
    { SessionDiffPane },
    { SessionSidebar },
    { SourceControlDock },
    { resetSidebarReferenceCache },
  ] = await Promise.all([
    import('./ProjectsView.tsx'),
    import('./SchedulesView.tsx'),
    import('./WebhooksView.tsx'),
    import('./WorkflowsView.tsx'),
    import('./AgentActivityPane.tsx'),
    import('./SessionDiffPane.tsx'),
    import('./session-sidebar.tsx'),
    import('./SourceControlDock.tsx'),
    import('./sidebar-reference-cache.ts'),
  ]);
  const cases = [
    [ProjectsPane, { projects: [], projectsReady: false, selectedProjectPath: '' }, /No projects yet/],
    [SchedulesPane, {}, /No scheduled tasks yet/],
    [WebhooksPane, {}, /No webhooks/],
    [WorkflowsPane, {}, /No workflows/],
    [AgentActivityPane, { sessions: [], sessionsReady: false }, /Loading activity|No agents are running/],
    [SessionDiffPane, { sessionId: 'cold-diff' }, /No changes from this session|0 files changed|Loading session diff/],
    [
      SessionSidebar,
      {
        open: true,
        sessions: [],
        sessionsReady: false,
        selection: { kind: 'new' },
        onNewTask() {},
        onResumeSession() {},
      },
      /Loading sessions|No sessions/,
    ],
    [
      SourceControlDock,
      {
        projectPath: 'C:/project',
        status: null,
        statusReady: false,
        loading: true,
        onRefreshStatus() {},
        onReadyChange() {},
        readinessKey: 'cold-git',
      },
      /No changes in this project|Loading…/,
    ],
  ];
  function FirstPaint({ children, onPaint }) {
    useLayoutEffect(onPaint);
    return children;
  }
  for (const [Component, props, incorrect] of cases) {
    resetSidebarReferenceCache();
    let element;
    // Observe the committed DOM before passive effects. These are client
    // surfaces; requiring an SSR snapshot would test a different contract.
    await view.render(
      React.createElement(
        FirstPaint,
        {
          onPaint: () => {
            element ||= view.host.cloneNode(true);
          },
        },
        React.createElement(Component, { active: false, ...props })
      )
    );
    const pending = element.querySelector('[role="status"][aria-busy="true"]');
    assert.ok(pending, `${Component.name} has no first-read placeholder`);
    assert.equal(pending.textContent, '', 'loading is accessible without flashing visible copy');
    assert.doesNotMatch(element.textContent, incorrect);
    await view.render(null);
  }
});

for (const navigation of ['close', 'tab', 'project', 'remount']) {
  test(`Source Control validates cached rows before first paint and after ${navigation}`, async (t) => {
    const view = harness(t, { globalTimers: true });
    const { UtilityDock, prewarmUtilityDockGitState } = await import('./UtilityDock.tsx');
    const requests = [];
    window.mixdogDesktop.gitStatus = (projectPath) => {
      const request = Promise.withResolvers();
      requests.push({ ...request, projectPath });
      return request.promise;
    };
    const status = (path) => ({
      repository: true,
      branch: 'main',
      files: [
        {
          path,
          indexStatus: ' ',
          worktreeStatus: 'M',
          staged: false,
          conflicted: false,
        },
      ],
    });
    const projectPath = `C:/entry-${navigation}`;
    const warm = prewarmUtilityDockGitState(projectPath);
    requests[0].resolve(status('cached-old.ts'));
    await warm;
    const props = { open: true, tab: 'source-control', snapshot: {}, projectPath };
    let firstPaint;
    function FirstPaint({ children }) {
      useLayoutEffect(() => {
        firstPaint ||= view.host.cloneNode(true);
      });
      return children;
    }
    const render = async (next = props) => {
      firstPaint = null;
      await view.render(React.createElement(FirstPaint, null, React.createElement(UtilityDock, next)));
    };
    const assertPending = () => {
      for (const element of [firstPaint, view.host]) {
        assert.ok(element.querySelector('[role="status"][aria-busy="true"]'));
        assert.doesNotMatch(element.textContent, /cached-old\.ts|current\.ts/);
      }
    };
    await render();
    assertPending();
    assert.equal(requests.length, 2);
    await view.settle(() => requests[1].resolve(status('current.ts')));
    assert.match(view.host.textContent, /current\.ts/);

    // Live refresh keeps the established list rather than replaying entry loading.
    await view.advance(3_000);
    await view.settle(() => window.dispatchEvent(new window.Event('focus')));
    assert.equal(requests.length, 3);
    assert.match(view.host.textContent, /current\.ts/);
    assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
    await view.settle(() => requests[2].resolve(status('current.ts')));

    let next = props;
    if (navigation === 'close') await render({ ...props, open: false });
    if (navigation === 'tab') await render({ ...props, tab: 'agents' });
    if (navigation === 'remount') await view.render(null);
    if (navigation === 'project') {
      next = { ...props, projectPath: `${projectPath}-other` };
      const preload = prewarmUtilityDockGitState(next.projectPath);
      requests.at(-1).resolve(status('cached-old.ts'));
      await preload;
    }
    const before = requests.length;
    await render(next);
    assertPending();
    assert.equal(requests.length, before + 1);
    await view.settle(() => requests.at(-1).resolve(status('latest.ts')));
    assert.match(view.host.textContent, /latest\.ts/);
    assert.doesNotMatch(view.host.textContent, /cached-old\.ts|current\.ts/);

    if (navigation === 'close') {
      await render({ ...props, open: false });
      await render();
      await view.settle(() => requests.at(-1).reject(new Error('Host unavailable')));
      assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
      assert.match(view.host.textContent, /Source Control is temporarily unavailable/);
      assert.doesNotMatch(view.host.textContent, /latest\.ts|Host unavailable/);
      await view.advance(3_000);
      await view.settle(() => window.dispatchEvent(new window.Event('focus')));
      await view.settle(() => requests.at(-1).resolve(status('recovered.ts')));
      assert.match(view.host.textContent, /recovered\.ts/);
    }
  });
}

test('Projects distinguishes an unknown catalog from a confirmed empty result and retains cached rows', async (t) => {
  const view = harness(t);
  const { ProjectsPane } = await import('./ProjectsView.tsx');
  const props = { active: false, projects: [], selectedProjectPath: '', projectsReady: false };
  await view.render(React.createElement(ProjectsPane, props));
  assert.ok(view.host.querySelector('[aria-busy="true"]'));
  await view.render(React.createElement(ProjectsPane, { ...props, projectsReady: true }));
  assert.match(view.host.textContent, /No projects yet/);
  await view.render(
    React.createElement(ProjectsPane, {
      ...props,
      projects: [{ path: 'C:/project', name: 'Retained project' }],
    })
  );
  assert.match(view.host.textContent, /Retained project/);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
});

test('Workflow reserves its slot, can show the inherited value, then enables the loaded choices', async (t) => {
  const view = harness(t);
  const request = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = () => request.promise;
  const { WorkflowSelect } = await import('./model-controls.tsx');
  const props = { disabled: false, invokeResult: (work) => work(), applySnapshot() {} };
  await view.render(React.createElement(WorkflowSelect, props));
  assert.ok(view.host.querySelector('[aria-busy="true"]'));
  await view.render(
    React.createElement(WorkflowSelect, {
      ...props,
      workflow: { id: 'solo', name: 'Solo' },
    })
  );
  assert.match(view.host.textContent, /Solo/);
  assert.equal(view.host.querySelector('button').disabled, true);
  await view.settle(() => request.resolve({ value: [{ id: 'solo', name: 'Solo', active: true }] }));
  assert.equal(view.host.querySelector('button').disabled, false);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
});

test('agent data arriving before the session catalog cannot announce no running agents', async (t) => {
  const view = harness(t);
  const request = Promise.withResolvers();
  window.mixdogDesktop.listAgentPool = () => request.promise;
  const { AgentActivityPane } = await import('./AgentActivityPane.tsx');
  const props = { active: false, sessions: [], sessionsReady: false };
  await view.render(React.createElement(AgentActivityPane, props));
  await view.settle(() => request.resolve([]));
  assert.ok(view.host.querySelector('[aria-busy="true"]'));
  assert.doesNotMatch(view.host.textContent, /No agents/);
  await view.render(React.createElement(AgentActivityPane, { ...props, sessionsReady: true }));
  assert.match(view.host.textContent, /No agents are running/);
});

test('native boot keeps the mounted content inert until its ready frame, with bounded recovery', async (t) => {
  const view = harness(t);
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { _resetBootMetricsForTest } = await import('./boot-metrics.ts');
  _resetBootMetricsForTest();
  const content = React.createElement('button', null, 'Restored task');
  await view.render(React.createElement(DesktopBootGate, { ready: false }, content));
  const original = view.host.querySelector('button');
  assert.ok(original.closest('[inert]'), 'a browser must not expose the unfinished task');
  await view.render(React.createElement(DesktopBootGate, { ready: true }, content));
  await view.advance(120);
  assert.equal(view.host.querySelector('button'), original, 'reveal does not remount the task');
  assert.equal(original.closest('[inert]'), null);
  await view.render(null);
  _resetBootMetricsForTest();
  await view.render(React.createElement(DesktopBootGate, { ready: false }, content));
  await view.advance(1_200);
  await view.advance(4_000);
  await view.advance(120);
  assert.equal(
    view.host.querySelector('button').closest('[inert]'),
    null,
    'a failed optional read must not leave an endless splash'
  );
});

test('remote boot cannot bypass connection or hydration and offers a working retry', async (t) => {
  const view = harness(t);
  window.mixdogRemoteServer = 'https://mixdog.test';
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { _resetBootMetricsForTest } = await import('./boot-metrics.ts');
  const { setRemoteConnectionState, REMOTE_WAKE_EVENT } = await import('./remote-connection-state.ts');
  _resetBootMetricsForTest();
  const content = React.createElement('button', { id: 'task' }, 'Restored task');
  // Even disabling the native cover cannot bypass the remote connection gate.
  await view.render(React.createElement(DesktopBootGate, { ready: true, enabled: false }, content));
  const original = view.host.querySelector('#task');
  assert.ok(original.closest('[inert]'), 'missing approval is not a ready connection');
  await view.settle(() => setRemoteConnectionState('connecting'));
  await view.advance(1_200);
  await view.advance(30_000);
  assert.ok(original.closest('[inert]'), 'elapsed time cannot reveal an offline workspace');
  let retries = 0;
  window.addEventListener(REMOTE_WAKE_EVENT, () => {
    retries++;
  });
  const retry = view.host.querySelector('.desktop-boot-cover .remote-connection-overlay');
  assert.ok(retry, 'initial connection failure must offer retry outside the inert workspace');
  await view.settle(() => retry.click());
  assert.equal(retries, 1);
  await view.settle(() => setRemoteConnectionState('syncing'));
  await view.advance(30_000);
  assert.ok(original.closest('[inert]'), 'an open socket is not completed synchronization');
  await view.render(React.createElement(DesktopBootGate, { ready: false }, content));
  await view.settle(() => setRemoteConnectionState('connected'));
  await view.advance(30_000);
  assert.ok(original.closest('[inert]'), 'connection alone cannot replace initial data');
  await view.render(React.createElement(DesktopBootGate, { ready: true }, content));
  // Losing the connection during the fade must cancel the pending handoff.
  await view.settle(() => setRemoteConnectionState('reconnecting'));
  await view.advance(120);
  assert.ok(original.closest('[inert]'));
  assert.notEqual(view.host.querySelector('.desktop-boot-cover').dataset.leaving, 'true');
  await view.settle(() => setRemoteConnectionState('connected'));
  await view.advance(120);
  assert.equal(view.host.querySelector('#task'), original);
  assert.equal(original.closest('[inert]'), null);
  assert.equal(view.host.querySelector('.desktop-boot-cover'), null);
});

test('failed remote snapshot stays unhydrated and recovers on connection without remounting', async (t) => {
  const view = harness(t);
  window.mixdogRemoteServer = 'https://mixdog.test';
  const { useDesktopState } = await import('./app-desktop-state.ts');
  const { setRemoteConnectionState } = await import('./remote-connection-state.ts');
  let calls = 0;
  const recovered = Promise.withResolvers();
  window.mixdogDesktop.getSnapshot = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('Host offline')) : recovered.promise;
  };
  window.mixdogDesktop.subscribeState = () => () => {};
  function Probe() {
    const { hydrated, error } = useDesktopState();
    return React.createElement('output', { 'data-hydrated': String(hydrated) }, error);
  }
  await view.settle(() => setRemoteConnectionState('connecting'));
  await view.render(React.createElement(Probe));
  assert.equal(view.host.querySelector('output').dataset.hydrated, 'false');
  assert.equal(view.host.textContent, 'Host offline');
  await view.settle(() => setRemoteConnectionState('connected'));
  assert.equal(calls, 2);
  assert.equal(view.host.querySelector('output').dataset.hydrated, 'false');
  await view.settle(() => recovered.resolve({ sessionId: '' }));
  assert.equal(view.host.querySelector('output').dataset.hydrated, 'true');
  assert.equal(view.host.textContent, '');
  await view.settle(() => setRemoteConnectionState('reconnecting'));
  await view.settle(() => setRemoteConnectionState('connected'));
  assert.equal(calls, 2, 'a repaired initial read does not need another recovery read');
});

test('startup emits no settled signal while persisted panes are still being validated', async (t) => {
  const view = harness(t);
  const { useAppStartupRestore } = await import('./use-app-startup-restore.ts');
  let settled = 0;
  window.addEventListener('mixdog:startup-settled', () => {
    settled += 1;
  });
  const props = {
    restoredFromStorage: false,
    startupFocusedPaneSelection: null,
    startupNavigationSelection: null,
    projectCatalogReady: true,
    snapshot: {},
    snapshotReady: true,
    sessions: [],
    selectionRef: { current: { kind: 'new' } },
    viewedSessionRef: { current: '' },
    unreadViewedSessionRef: { current: '' },
    setSelection() {},
    setStartupSettled() {},
    activateSelection() {},
    openSessionRef: { current: async () => {} },
    lastNewTaskPrefs: { current: null },
    effectiveDraftProjectPath: (path) => path,
    preferredDraftProjectPath: '',
    setNewTaskDeferred() {},
    resetNewTaskDraft() {},
    lastSessionStorageKey: 'test-session',
    lastProjectStorageKey: 'test-project',
  };
  function Probe({ pending }) {
    useAppStartupRestore({ ...props, restorePending: pending });
    return null;
  }
  await view.render(React.createElement(Probe, { pending: true }));
  await view.advance(1_000);
  assert.equal(settled, 0);
  await view.render(React.createElement(Probe, { pending: false }));
  assert.equal(settled, 1);
});

test('usage pin waits for its initial setting and data, without letting a late read undo a user toggle', async (t) => {
  const view = harness(t);
  const settings = Promise.withResolvers();
  window.mixdogDesktop.readSettings = () => settings.promise;
  const { useUsageRailPin } = await import('./use-usage-rail-pin.ts');
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 800,
  });
  let toggle;
  function Probe({ snapshot }) {
    const rail = useRef(null);
    const nav = useRef(null);
    const button = useRef(null);
    const state = useUsageRailPin(snapshot, { rail, nav, settings: button }, true);
    toggle = state.toggleUsagePin;
    return React.createElement(
      'aside',
      { ref: rail },
      React.createElement('nav', { ref: nav }),
      React.createElement('button', { ref: button }),
      React.createElement(
        'output',
        null,
        state.loading
          ? 'pending'
          : state.usagePinned
            ? state.usagePinRows.map((row) => `${row.label} ${row.percent}%`).join()
            : 'icon'
      )
    );
  }
  const snapshot = { dashboard: {}, status: 'loading', loading: true, refreshedAt: 0 };
  await view.render(React.createElement(Probe, { snapshot }));
  assert.equal(view.host.querySelector('output').textContent, 'pending');
  await view.settle(() => toggle());
  await view.settle(() => settings.resolve({ usagePinned: false }));
  assert.equal(view.host.querySelector('output').textContent, 'pending');
  await view.render(
    React.createElement(Probe, {
      snapshot: {
        ...snapshot,
        status: 'ready',
        loading: false,
        dashboard: {
          rows: [
            {
              id: 'openai',
              group: 'oauth',
              windows: [{ label: 'W', usedPct: 25 }],
            },
          ],
        },
      },
    })
  );
  assert.equal(view.host.querySelector('output').textContent, 'Codex 25%');
});
