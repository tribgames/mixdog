import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

test('a late compact reply cannot reopen a completed pane without a focus change', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
    globals: {
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    },
  });
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Composer } = await import('./Composer.tsx');
  const { createSessionLaneStore, useSessionLane } = await import('./session-lane-store.ts');
  const store = createSessionLaneStore({
    decorator: { decorate: (snapshot) => snapshot, clear() {} },
  });
  const sessionId = 'compact-pane';
  const idle = { sessionId, busy: false, commandBusy: false, commandStatus: null, items: [] };
  const running = {
    ...idle,
    commandBusy: true,
    commandStatus: { active: true, mode: 'compacting', startedAt: Date.now() },
  };
  const complete = {
    ...idle,
    items: [{ id: 'compact-done', kind: 'statusdone', label: 'Compact complete', detail: '2s' }],
  };
  const publish = (snapshot) => store.apply({ sessionId, snapshot, frameSource: 'live' });
  publish(idle);
  let reply;
  const requests = [];
  window.mixdogDesktop = {
    invokeCapability: (request) => {
      if (request.capability === 'getVoiceStatus') {
        return Promise.resolve({ value: { installed: false } });
      }
      // The composer reads its session's skills on its own; not a command.
      if (request.capability === 'skillsStatus') return Promise.resolve({ value: { skills: [] } });
      requests.push(request);
      publish(running);
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
  };
  function Harness() {
    const snapshot = useSessionLane(sessionId, store);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('output', null, snapshot.commandBusy ? 'Compacting' : snapshot.items.at(-1)?.label || 'Idle'),
      React.createElement(Composer, {
        turnBusy: false,
        commandBusy: snapshot.commandBusy,
        transitioning: false,
        focusRequest: 0,
        historyScope: sessionId,
        identityScope: sessionId,
        recoveryScope: sessionId,
        projectScope: '',
        sessionId,
        hasConversation: true,
        provider: 'openai-oauth',
        model: 'test-model',
        effort: 'medium',
        fast: false,
        fastCapable: false,
        submit: async () => {},
        abort: async () => {},
        invokeResult: (action) => action(),
        applySnapshot: publish,
        onNewTask() {},
        onResumeSession() {},
        onOpenSessions() {},
        onOpenProjects() {},
        onOpenSettings() {},
        onOpenCommandSurface() {},
        dropTargetRef: { current: null },
      })
    );
  }
  const host = document.querySelector('main');
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const input = host.querySelector('textarea');
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '/compact');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].capability, 'compact');
    assert.equal(requests[0].sessionId, sessionId);
    assert.equal(host.querySelector('output').textContent, 'Compacting');
    await act(async () => publish(complete));
    assert.equal(host.querySelector('output').textContent, 'Compact complete');
    await act(async () => reply({ value: { changed: true }, snapshot: running }));
    assert.equal(host.querySelector('output').textContent, 'Compact complete');
    assert.equal(input.disabled, false);
  } finally {
    await act(async () => root.unmount());
    store.clear();
    restore();
  }
});
