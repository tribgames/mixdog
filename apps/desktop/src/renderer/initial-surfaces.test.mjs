import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';

function harness(t, { globalTimers = false } = {}) {
  const clock = createRendererClock();
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      ...(globalTimers
        ? {
            setTimeout: clock.win.setTimeout,
            clearTimeout: clock.win.clearTimeout,
          }
        : {}),
    },
  });
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
    restore();
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
    [ProjectsPane, { projects: [], projectsReady: false, selectedProjectPath: '' }, /No projects\./],
    [SchedulesPane, {}, /No schedules\./],
    [WebhooksPane, {}, /No webhooks/],
    [WorkflowsPane, {}, /No workflows/],
    [AgentActivityPane, { sessions: [], sessionsReady: false }, /Loading activity|No bots\./],
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
      /Loading sessions|No sessions\./,
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
  test(`Source Control paints cached rows at once and replaces them with fresh status after ${navigation}`, async (t) => {
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
        // The row window measures its viewport in a layout effect and
        // re-renders synchronously, still before paint: snapshot after that
        // flush, which is what the browser's first painted frame shows.
        queueMicrotask(() => {
          firstPaint ||= view.host.cloneNode(true);
        });
      });
      return children;
    }
    const render = async (next = props) => {
      firstPaint = null;
      await view.render(React.createElement(FirstPaint, null, React.createElement(UtilityDock, next)));
    };
    // The last known status paints in the very first commit, with no loading
    // cover, while the entry revalidation runs in the background.
    const assertCached = (name) => {
      for (const element of [firstPaint, view.host]) {
        assert.equal(element.querySelector('.utility-dock-pane[data-tab="source-control"] [aria-busy="true"]'), null);
        assert.match(element.querySelector('.utility-dock-pane[data-tab="source-control"]').textContent, name);
      }
    };
    await render();
    assertCached(/cached-old\.ts/);
    assert.equal(requests.length, 2);
    await view.settle(() => requests[1].resolve(status('current.ts')));
    assert.match(view.host.textContent, /current\.ts/);
    assert.doesNotMatch(view.host.textContent, /cached-old\.ts/);

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
    assertCached(navigation === 'project' ? /cached-old\.ts/ : /current\.ts/);
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
  assert.match(view.host.textContent, /No projects\./);
  await view.render(
    React.createElement(ProjectsPane, {
      ...props,
      projects: [{ path: 'C:/project', name: 'Retained project' }],
    })
  );
  assert.match(view.host.textContent, /Retained project/);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
});

test('Workflow stays out of the row for a single pack, without reserving a slot, and returns when a choice exists', async (t) => {
  const view = harness(t);
  const request = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = () => request.promise;
  const { WorkflowSelect } = await import('./model-controls.tsx');
  const { invalidateSidebarReferenceForMutation } = await import('./sidebar-reference-cache.ts');
  const props = { disabled: false, invokeResult: (work) => work(), applySnapshot() {} };
  await view.render(React.createElement(WorkflowSelect, props));
  // No reserved slot: a placeholder that resolves to a single pack would shift
  // the whole context row, which is what removing the control avoids.
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
  await view.settle(() => request.resolve({ value: [{ id: 'solo', name: 'Solo', active: true }] }));
  assert.equal(view.host.querySelector('button'), null);
  // A pack edit retires the shared list (the picker reads through the host-scoped
  // sidebar reference loader); a second pack makes it a real choice.
  const reloaded = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = () => reloaded.promise;
  await view.settle(() => invalidateSidebarReferenceForMutation('createWorkflow'));
  await view.settle(() =>
    reloaded.resolve({
      value: [
        { id: 'solo', name: 'Solo', active: true },
        { id: 'default', name: 'Default' },
      ],
    })
  );
  assert.match(view.host.textContent, /Solo/);
  assert.equal(view.host.querySelector('button').disabled, false);
});

test('agent data arriving before the session catalog cannot announce no running agents', async (t) => {
  const view = harness(t);
  const request = Promise.withResolvers();
  window.mixdogDesktop.listAgentPool = () => request.promise;
  const { AgentActivityPane } = await import('./AgentActivityPane.tsx');
  const { resetMixyStatus } = await import('./mixy-identity.ts');
  // A profile with Mixy (the host's answer): she is listed once ready.
  resetMixyStatus({ created: true });
  t.after(() => resetMixyStatus());
  const props = { active: false, sessions: [], sessionsReady: false };
  await view.render(React.createElement(AgentActivityPane, props));
  await view.settle(() => request.resolve([]));
  assert.ok(view.host.querySelector('[aria-busy="true"]'));
  assert.doesNotMatch(view.host.textContent, /No agents/);
  await view.render(React.createElement(AgentActivityPane, { ...props, sessionsReady: true }));
  // Ready and idle: Mixy is listed and the work section shows nothing.
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
  assert.match(view.host.textContent, /Mixy/);
  assert.doesNotMatch(view.host.textContent, /No agents/);
});

test('orchestration selector inherits its mode and stages all four choices without changing workflow', async (t) => {
  const view = harness(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request);
    return { value: 'none', snapshot: null };
  };
  const { _resetInheritedOrchestrationModeForTest } = await import('./orchestration-mode-store.ts');
  _resetInheritedOrchestrationModeForTest();
  const { OrchestrationModeSelect } = await import('./model-controls.tsx');
  const staged = [];
  const props = {
    disabled: false,
    invokeResult: (work) => work(),
    applySnapshot() {},
    onDraftChange: (value) => staged.push(value),
  };
  await view.render(React.createElement(OrchestrationModeSelect, props));
  assert.match(view.host.textContent, /Solo/);
  assert.deepEqual(calls, [{ capability: 'getConfiguredOrchestrationMode', args: [] }]);
  for (const [mode, label] of [
    ['focused', 'Assisted'],
    ['balanced', 'Collaborative'],
    ['swarm', 'Swarm'],
    ['none', 'Solo'],
  ]) {
    await view.render(
      React.createElement(OrchestrationModeSelect, { ...props, mode: mode === 'none' ? 'swarm' : 'none' })
    );
    await view.settle(() => view.host.querySelector('[role="combobox"]').click());
    const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === label);
    assert.ok(option, `${label} is selectable`);
    await view.settle(() => option.click());
    assert.equal(staged.at(-1), mode);
  }
  assert.equal(calls.length, 1, 'draft choices remain local until submit');
});

test('the inherited orchestration mode is read once, shown in the first frame of every mount, and shared on change', async (t) => {
  const view = harness(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request.capability);
    return {
      value: request.capability === 'getConfiguredOrchestrationMode' ? 'focused' : request.args[0],
      snapshot: null,
    };
  };
  const { _resetInheritedOrchestrationModeForTest } = await import('./orchestration-mode-store.ts');
  _resetInheritedOrchestrationModeForTest();
  const { OrchestrationModeSelect } = await import('./model-controls.tsx');
  const props = { disabled: false, invokeResult: (work) => work(), applySnapshot() {} };
  const pair = React.createElement(
    React.Fragment,
    null,
    React.createElement('section', { id: 'a' }, React.createElement(OrchestrationModeSelect, props)),
    React.createElement('section', { id: 'b' }, React.createElement(OrchestrationModeSelect, props))
  );
  await view.render(pair);
  assert.match(view.host.querySelector('#a').textContent, /Assisted/);
  // A later mount (a New Task tab switch) paints the value with no skeleton and no refetch.
  await view.render(null);
  await act(async () => {
    view.root.render(pair);
  });
  assert.match(view.host.querySelector('#a').textContent, /Assisted/);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
  assert.deepEqual(calls, ['getConfiguredOrchestrationMode']);
  // A change made in one composer reaches the other open one.
  await view.settle(() => view.host.querySelector('#a [role="combobox"]').click());
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === 'Swarm');
  await view.settle(() => option.click());
  assert.match(view.host.querySelector('#b').textContent, /Swarm/);
});

async function inheritedModeHarness(
  t,
  { configured = 'focused', activeSession = 'swarm', failFirstRead = false, olderHost = false } = {}
) {
  const view = harness(t);
  const state = { configured, calls: [], failNext: failFirstRead, changeListener: null, settingsListeners: 0 };
  // The ONLY host event the store may follow; a settings-changed subscription is a defect.
  window.mixdogDesktop.subscribeOrchestrationModeChanged = (listener) => {
    state.changeListener = listener;
    return () => {
      state.changeListener = null;
    };
  };
  window.mixdogDesktop.subscribeSettingsChanged = () => {
    state.settingsListeners += 1;
    return () => {};
  };
  state.emit = (mode) => {
    state.configured = mode;
    state.changeListener({ mode });
  };
  window.mixdogDesktop.invokeCapability = async (request) => {
    state.calls.push(request.capability);
    if (request.capability === 'getOrchestrationMode') return { value: activeSession, snapshot: null };
    if (request.capability === 'getConfiguredOrchestrationMode') {
      if (olderHost) throw new TypeError('capability is unavailable.');
      if (state.failNext) {
        state.failNext = false;
        throw new Error('host unavailable');
      }
      return { value: state.configured, snapshot: null };
    }
    return { value: request.args[0], snapshot: null };
  };
  const { _resetInheritedOrchestrationModeForTest } = await import('./orchestration-mode-store.ts');
  _resetInheritedOrchestrationModeForTest();
  const { OrchestrationModeSelect } = await import('./model-controls.tsx');
  const props = { disabled: false, invokeResult: (work) => work(), applySnapshot() {} };
  const composer = (id) =>
    React.createElement('section', { id, key: id }, React.createElement(OrchestrationModeSelect, props));
  const open = (...ids) => view.render(React.createElement(React.Fragment, null, ...ids.map(composer)));
  return { view, state, open, text: (id) => view.host.querySelector(`#${id}`)?.textContent ?? '' };
}

test('a New Task composer shows the configured default, never the active session mode', async (t) => {
  const { state, open, text } = await inheritedModeHarness(t, { configured: 'focused', activeSession: 'swarm' });
  await open('a');
  assert.match(text('a'), /Assisted/);
  assert.doesNotMatch(text('a'), /Swarm/);
  assert.ok(!state.calls.includes('getOrchestrationMode'), 'the active session answers getOrchestrationMode');
  assert.equal(state.settingsListeners, 0, 'the store follows its own event, not settings-changed');
});

test('a change of the configured default reaches open and later composers', async (t) => {
  const { view, state, open, text } = await inheritedModeHarness(t);
  await open('a', 'b');
  assert.match(text('b'), /Assisted/);
  await view.settle(() => state.emit('balanced')); // the setup tool, another window or the settings UI
  assert.match(text('a'), /Collaborative/);
  assert.match(text('b'), /Collaborative/);
  // A change while no composer is open is kept, so a later mount is never stale.
  await open();
  await view.settle(() => state.emit('swarm'));
  await open('a');
  assert.match(text('a'), /Swarm/);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
  assert.equal(state.calls.filter((name) => name === 'getConfiguredOrchestrationMode').length, 1, 'loaded once');
});

test('a read answered after a newer change is read again, not published', async (t) => {
  const { view, state, open, text } = await inheritedModeHarness(t);
  const release = Promise.withResolvers();
  const answer = window.mixdogDesktop.invokeCapability;
  let first = true;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (first && request.capability === 'getConfiguredOrchestrationMode') {
      first = false;
      await release.promise; // the stale answer: 'focused', read before the change
      return { value: 'focused', snapshot: null };
    }
    return answer(request);
  };
  await open('a');
  await view.settle(() => state.emit('balanced'));
  await view.settle(() => release.resolve());
  assert.match(text('a'), /Collaborative/);
});

test('a failed first load stays unknown and recovers on the next event', async (t) => {
  const { view, state, open, text } = await inheritedModeHarness(t, { failFirstRead: true });
  await open('a');
  assert.ok(view.host.querySelector('[aria-busy="true"]'), 'unconfirmed mode stays a pending control');
  assert.doesNotMatch(text('a'), /Assisted/);
  await view.settle(() => state.emit('focused'));
  assert.match(text('a'), /Assisted/);
});

test('a failed first load is read again by the next mount', async (t) => {
  const { view, open, text } = await inheritedModeHarness(t, { failFirstRead: true });
  await open('a');
  await view.settle(() => {});
  assert.doesNotMatch(text('a'), /Assisted/);
  await open();
  await open('a');
  await view.settle(() => {});
  assert.match(text('a'), /Assisted/);
});

test('a failed refresh keeps the cached mode on screen and is read again on the next mount', async (t) => {
  const { view, state, open, text } = await inheritedModeHarness(t);
  const { REMOTE_CONNECTION_READY_EVENT } = await import('./remote-connection-state.ts');
  await open('a');
  assert.match(text('a'), /Assisted/);
  // The link came back and the refresh fails: the last good value stays shown.
  state.failNext = true;
  state.configured = 'balanced';
  await view.settle(() => window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT)));
  assert.match(text('a'), /Assisted/);
  assert.equal(view.host.querySelector('[aria-busy="true"]'), null);
  await open();
  await open('a');
  await view.settle(() => {});
  assert.match(text('a'), /Collaborative/, 'the dirty cache is refreshed on mount');
  const reads = state.calls.filter((name) => name === 'getConfiguredOrchestrationMode').length;
  await open();
  await open('a');
  await view.settle(() => {});
  assert.equal(
    state.calls.filter((name) => name === 'getConfiguredOrchestrationMode').length,
    reads,
    'a clean cache is not read again'
  );
});

test('an older host that rejects the capability falls back to the per-mount read, without retry loops', async (t) => {
  const { view, state, open, text } = await inheritedModeHarness(t, { olderHost: true, activeSession: 'swarm' });
  await open('a');
  await view.settle(() => {});
  assert.match(text('a'), /Swarm/, 'the pre-change path answers');
  await open();
  await open('a', 'b');
  await view.settle(() => {});
  assert.match(text('b'), /Swarm/);
  await view.advance(10_000);
  const count = (name) => state.calls.filter((call) => call === name).length;
  assert.equal(count('getConfiguredOrchestrationMode'), 1, 'the unsupported capability is asked once');
  assert.equal(count('getOrchestrationMode'), 3, 'one read per composer mount (a, then a and b), as before the store');
});

function stubFades(t, fades) {
  const proto = window.HTMLElement.prototype;
  proto.getAnimations = () => fades();
  t.after(() => {
    delete proto.getAnimations;
  });
}

const brandFade = (target, finished, animationName = 'desktop-boot-brand-in') => ({
  animationName,
  effect: { target },
  finished,
});

async function bootedGate(t) {
  const view = harness(t);
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { _resetBootMetricsForTest } = await import('./boot-metrics.ts');
  _resetBootMetricsForTest();
  const boot = async (children) => {
    await view.render(React.createElement(DesktopBootGate, { ready: true }, children));
    await view.advance(120);
    return view.host.querySelector('.desktop-boot-gate');
  };
  return { view, boot };
}

test('the boot brand fade leaves the gate once it finishes, so a later watermark starts at its final opacity', async (t) => {
  const { view, boot } = await bootedGate(t);
  const finished = Promise.withResolvers();
  stubFades(t, () => [brandFade(document.querySelector('.welcome-logo'), finished.promise)]);
  const gate = await boot(React.createElement('div', { className: 'welcome-logo' }));
  // The fade is still running: the attribute that drives it stays.
  assert.equal(gate.dataset.brandHandoff, 'desktop', 'the first boot fade still plays');
  await view.settle(() => finished.resolve());
  assert.equal(gate.dataset.brandHandoff, undefined);
});

test('an interrupted or removed boot fade (animationcancel) also settles the gate', async (t) => {
  const { view, boot } = await bootedGate(t);
  const finished = Promise.withResolvers();
  stubFades(t, () => [brandFade(document.querySelector('.welcome-logo'), finished.promise)]);
  const gate = await boot(React.createElement('div', { className: 'welcome-logo' }));
  assert.equal(gate.dataset.brandHandoff, 'desktop');
  await view.settle(() => finished.reject(new DOMException('cancelled', 'AbortError')));
  assert.equal(gate.dataset.brandHandoff, undefined);
});

test('the boot-only hide rule keys on a class the gate drops at the hand-off', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop/19-studio.css', import.meta.url), 'utf8');
  const markup = (className) =>
    // A descendant that sets its own visibility (the reason for the `*`).
    new JSDOM(`<!doctype html><html><head><style>p span { visibility: visible }</style><style>${css}</style></head><body>
      <div class="${className}" data-ready="false"><div class="desktop-boot-gate-content"><p><span id="leaf">x</span></p></div></div>
    </body></html>`);
  const booting = markup('desktop-boot-gate is-booting');
  assert.equal(
    booting.window.getComputedStyle(booting.window.document.getElementById('leaf')).visibility,
    'hidden',
    'every descendant stays hidden under the cover'
  );
  booting.window.close();
  // Without the boot class the rule never applies, whatever data-ready says.
  const settled = markup('desktop-boot-gate');
  assert.equal(settled.window.getComputedStyle(settled.window.document.getElementById('leaf')).visibility, 'visible');
  settled.window.close();

  const view = harness(t);
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  await view.render(React.createElement(DesktopBootGate, { ready: false }, React.createElement('div')));
  assert.equal(view.host.querySelector('.desktop-boot-gate').classList.contains('is-booting'), true);
  await view.render(React.createElement(DesktopBootGate, { ready: true }, React.createElement('div')));
  await view.advance(120);
  const gate = view.host.querySelector('.desktop-boot-gate');
  assert.equal(gate.dataset.ready, 'true');
  assert.equal(gate.classList.contains('is-booting'), false);
});

test('a hidden logo or no logo plays no fade, so nothing is left to wait for', async (t) => {
  const { boot } = await bootedGate(t);
  stubFades(t, () => []); // display:none / reduced motion / no watermark: no running animation
  const gate = await boot(React.createElement('div', { className: 'welcome-logo' }));
  assert.equal(gate.dataset.brandHandoff, undefined);
});

test('only the watermark fade holds the gate: other animations and other targets are ignored', async (t) => {
  const { boot } = await bootedGate(t);
  const never = new Promise(() => {});
  stubFades(t, () => [
    brandFade(document.querySelector('.welcome-logo'), never, 'some-other-animation'),
    brandFade(document.querySelector('.not-the-logo'), never),
  ]);
  const gate = await boot(
    React.createElement(
      React.Fragment,
      null,
      React.createElement('div', { className: 'welcome-logo' }),
      React.createElement('div', { className: 'not-the-logo' })
    )
  );
  // Neither pending animation qualifies, so neither holds the attribute.
  assert.equal(gate.dataset.brandHandoff, undefined);
});

test('native boot keeps the mounted content inert until its ready frame, with bounded recovery', async (t) => {
  const view = harness(t);
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { _resetBootMetricsForTest } = await import('./boot-metrics.ts');
  _resetBootMetricsForTest();
  // biome-ignore lint/a11y/useButtonType: DOM fixture element, never submitted.
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
  // biome-ignore lint/a11y/useButtonType: DOM fixture element, never submitted.
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
  // The cold boot's failure is the unreachable state, never an endless mark (#134).
  const retry = view.host.querySelector('.desktop-boot-cover .remote-unreachable button');
  assert.ok(retry, 'initial connection failure must offer retry outside the inert workspace');
  assert.equal(retry.textContent, 'Try again');
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

test('a snapshot read cut off by a dropped connection is read again once connected', async (t) => {
  const view = harness(t);
  window.mixdogRemoteServer = 'https://mixdog.test';
  const { useDesktopState } = await import('./app-desktop-state.ts');
  const { remoteConnectionInterruptedError, setRemoteConnectionState } = await import('./remote-connection-state.ts');
  let calls = 0;
  window.mixdogDesktop.getSnapshot = () => {
    calls++;
    return calls === 1 ? Promise.reject(remoteConnectionInterruptedError()) : Promise.resolve({ sessionId: '' });
  };
  window.mixdogDesktop.subscribeState = () => () => {};
  function Probe() {
    const { hydrated } = useDesktopState();
    return React.createElement('output', { 'data-hydrated': String(hydrated) });
  }
  await view.settle(() => setRemoteConnectionState('connecting'));
  await view.render(React.createElement(Probe));
  assert.equal(view.host.querySelector('output').dataset.hydrated, 'false');
  await view.settle(() => setRemoteConnectionState('connected'));
  assert.equal(calls, 2);
  assert.equal(view.host.querySelector('output').dataset.hydrated, 'true');
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

test('usage pin paints cached rows in its first render, before the settings read lands', async (t) => {
  const view = harness(t);
  window.mixdogDesktop.readSettings = () => new Promise(() => {});
  const { useUsageRailPin } = await import('./use-usage-rail-pin.ts');
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 800,
  });
  function Probe({ snapshot }) {
    const rail = useRef(null);
    const nav = useRef(null);
    const button = useRef(null);
    const state = useUsageRailPin(snapshot, { rail, nav, settings: button }, true);
    return React.createElement(
      'aside',
      { ref: rail },
      React.createElement('nav', { ref: nav }),
      // biome-ignore lint/a11y/useButtonType: DOM fixture element, never submitted.
      React.createElement('button', { ref: button }),
      React.createElement('output', null, `${state.loading ? 'pending' : 'ready'}:${state.usagePinRows.length}`)
    );
  }
  const snapshot = {
    status: 'idle',
    loading: false,
    refreshedAt: 0,
    dashboard: { rows: [{ id: 'openai', group: 'oauth', windows: [{ label: 'W', usedPct: 25 }] }] },
  };
  await view.render(React.createElement(Probe, { snapshot }));
  assert.equal(view.host.querySelector('output').textContent, 'ready:1');
});

test('usage pin reserves neutral rows from the connected accounts before any quota arrives', async (t) => {
  const view = harness(t);
  window.localStorage.clear();
  window.mixdogDesktop.readSettings = () => new Promise(() => {});
  window.mixdogDesktop.readCapabilities = async () => [
    {
      ok: true,
      value: {
        oauth: [
          { id: 'openai-oauth', authenticated: true },
          { id: 'anthropic-oauth', authenticated: true },
          { id: 'grok-oauth', authenticated: false },
          { id: 'opencode-go-oauth', authenticated: true },
        ],
        api: [],
      },
    },
  ];
  const { useUsageRailPin } = await import('./use-usage-rail-pin.ts');
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 800,
  });
  function Probe({ snapshot }) {
    const rail = useRef(null);
    const nav = useRef(null);
    const button = useRef(null);
    const state = useUsageRailPin(snapshot, { rail, nav, settings: button }, true);
    const rows = state.usagePinRows.map((row) => `${row.key}${row.pending ? '~' : ''}:${row.bars.length}`).join();
    return React.createElement(
      'aside',
      { ref: rail },
      React.createElement('nav', { ref: nav }),
      // biome-ignore lint/a11y/useButtonType: DOM fixture element, never submitted.
      React.createElement('button', { ref: button }),
      React.createElement('output', null, `${state.loading ? 'pending' : 'ready'} ${rows}`)
    );
  }
  const snapshot = { status: 'loading', loading: true, refreshedAt: 0, dashboard: {} };
  await view.render(React.createElement(Probe, { snapshot }));
  await view.settle(() => {});
  // The rail draws one highest-window bar per provider (bde517a82), so a
  // connected provider whose quota has not arrived reserves exactly one.
  assert.equal(view.host.querySelector('output').textContent, 'ready codex~:1,claude~:1,opencode-go-oauth~:1');
  await view.render(
    React.createElement(Probe, {
      snapshot: {
        status: 'ready',
        loading: false,
        refreshedAt: 1,
        dashboard: {
          rows: [{ id: 'openai-oauth', group: 'oauth', windows: [{ label: 'W', usedPct: 25 }] }],
        },
      },
    })
  );
  // The live result is authoritative: providers without quota drop their rows.
  assert.equal(view.host.querySelector('output').textContent, 'ready codex:1');
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
    let usageText = 'icon';
    if (state.loading) usageText = 'pending';
    else if (state.usagePinned) usageText = state.usagePinRows.map((row) => `${row.label} ${row.percent}%`).join();
    return React.createElement(
      'aside',
      { ref: rail },
      React.createElement('nav', { ref: nav }),
      // biome-ignore lint/a11y/useButtonType: DOM fixture element, never submitted.
      React.createElement('button', { ref: button }),
      React.createElement('output', null, usageText)
    );
  }
  const snapshot = { dashboard: {}, status: 'loading', loading: true, refreshedAt: 0 };
  await view.render(React.createElement(Probe, { snapshot }));
  assert.equal(view.host.querySelector('output').textContent, 'pending');
  // The code default is pinned: unpin, then pin again.
  await view.settle(() => toggle());
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
