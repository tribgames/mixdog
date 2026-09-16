import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('the composer offers only frequent commands and preserves direct command execution', async () => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Composer } = await import('./Composer.tsx');
  const { desktopComposerSlashCommands, resolveDesktopSlashCommand } = await import('./slash-commands.ts');
  const expected = ['/new', '/model', '/compact', '/context', '/goal', '/inherit', '/fast'];
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getVoiceStatus') return { value: { installed: false } };
      calls.push([request.capability, request.args]);
      return { value: {} };
    },
    setFast: async (enabled, sessionId) => {
      calls.push(['fast', enabled, sessionId]);
      return {};
    },
  };
  const props = {
    turnBusy: false,
    commandBusy: false,
    transitioning: false,
    focusRequest: 0,
    historyScope: 'slash-test',
    identityScope: 'slash-test',
    recoveryScope: 'slash-test',
    projectScope: '',
    sessionId: 'slash-test',
    hasConversation: true,
    provider: 'openai-oauth',
    model: 'test-model',
    effort: 'medium',
    fast: false,
    fastCapable: true,
    paneActive: true,
    submit: async (...args) => {
      calls.push(['submit', ...args]);
    },
    abort: async () => {
      calls.push(['abort']);
    },
    invokeResult: (action) => action(),
    applySnapshot() {},
    onNewTask: () => calls.push(['new']),
    onClearToNewTask: () => calls.push(['new']),
    onResumeSession: (id) => calls.push(['resume', id]),
    onOpenSessions: () => calls.push(['sessions']),
    onOpenProjects() {},
    onOpenSettings: (section) => calls.push(['settings', section]),
    onOpenCommandSurface: (surface) => calls.push(['surface', surface]),
    dropTargetRef: { current: null },
  };
  const root = createRoot(document.querySelector('main'));
  let input;
  const palette = () => document.getElementById('composer-slash-palette');
  const usages = () => Array.from(palette()?.querySelectorAll('code') || [], (node) => node.textContent);
  const type = async (value) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const key = async (name, options = {}) => {
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          bubbles: true,
          cancelable: true,
          ...options,
        })
      );
      input.dispatchEvent(
        new window.KeyboardEvent('keyup', {
          key: name,
          bubbles: true,
          ...options,
        })
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  try {
    assert.deepEqual(
      desktopComposerSlashCommands('/').map((command) => command.usage),
      expected
    );
    for (const value of [
      '',
      'hello /model',
      ' /model',
      '/model x',
      '/model\n',
      '//',
      '/resume',
      '/style',
      '/clear',
      '/unknown',
    ]) {
      assert.deepEqual(desktopComposerSlashCommands(value), [], value);
    }
    assert.equal(resolveDesktopSlashCommand('new')?.action, 'clear');
    assert.equal(resolveDesktopSlashCommand('resume')?.action, 'resume');
    assert.equal(resolveDesktopSlashCommand('style')?.settingsRow, 'output-style');

    await act(async () => root.render(React.createElement(Composer, props)));
    input = document.querySelector('textarea');
    await type('/');
    assert.deepEqual(usages(), expected);
    assert.equal(input.getAttribute('aria-controls'), 'composer-slash-palette');
    assert.equal(input.getAttribute('aria-expanded'), 'true');

    await key('ArrowUp');
    assert.equal(palette().querySelector('[aria-selected="true"] code').textContent, '/fast');
    await key('ArrowDown');
    await key('ArrowDown');
    assert.equal(palette().querySelector('[aria-selected="true"] code').textContent, '/model');
    await key('Tab');
    assert.equal(input.value, '/model ');
    assert.equal(palette(), null);
    assert.deepEqual(calls, []);
    await key('Enter');
    assert.deepEqual(calls.pop(), ['settings', 'model']);

    await type('/CO');
    assert.deepEqual(usages(), ['/compact', '/context']);
    assert.equal(palette().querySelector('[aria-selected="true"] code').textContent, '/compact');
    await key('ArrowDown');
    await key('Enter');
    assert.deepEqual(calls.pop(), ['surface', 'context']);
    assert.equal(input.value, '');
    assert.equal(palette(), null);

    await type('/inh');
    const option = palette().querySelector('button');
    await act(async () => {
      const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
      option.dispatchEvent(down);
      assert.equal(down.defaultPrevented, true);
      option.click();
    });
    assert.deepEqual(calls.pop(), ['surface', 'inherit']);
    assert.equal(document.activeElement, input);

    await type('/new');
    await key('Enter', { isComposing: true, keyCode: 229 });
    assert.equal(input.value, '/new');
    assert.ok(palette());
    assert.deepEqual(calls, []);
    await key('Enter', { repeat: true });
    assert.deepEqual(calls, []);
    await key('Enter');
    assert.deepEqual(calls.pop(), ['new']);

    await type('/compact');
    await key('Enter');
    assert.equal(calls.pop()[0], 'compact');
    await type('/fast');
    await key('Enter');
    assert.deepEqual(calls.pop(), ['fast', true, 'slash-test']);

    await type('/goal');
    await key('Escape');
    assert.equal(input.value, '/goal');
    assert.equal(palette(), null);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(calls, []);
    await type('/go');
    assert.deepEqual(usages(), ['/goal']);

    await type('/model');
    await key('Enter', { shiftKey: true });
    assert.equal(input.value, '/model\n');
    assert.equal(palette(), null);
    assert.deepEqual(calls, []);

    for (const [value, expectedCall] of [
      ['/resume', ['sessions']],
      ['/resume saved-chat', ['resume', 'saved-chat']],
      ['/style', ['settings', 'output-style']],
    ]) {
      await type(value);
      assert.equal(palette(), null);
      await key('Enter');
      assert.deepEqual(calls.pop(), expectedCall);
    }
    await type('/not-a-command');
    await key('Enter');
    assert.equal(input.value, '/not-a-command');
    assert.match(document.body.textContent, /Unknown command: \/not-a-command/);
    assert.deepEqual(calls, []);

    await type('/');
    await act(async () => input.blur());
    assert.equal(palette(), null);
    await act(async () => input.focus());
    assert.deepEqual(usages(), expected);
    await act(async () => root.render(React.createElement(Composer, { ...props, turnBusy: true })));
    await key('Escape');
    assert.equal(palette(), null);
    assert.deepEqual(calls, []);
    await type('/new');
    await key('Enter');
    assert.equal(input.value, '/new');
    assert.match(document.body.textContent, /Wait for the current turn to finish/);
    assert.deepEqual(calls, []);

    await act(async () => root.render(React.createElement(Composer, { ...props, transitioning: true })));
    assert.equal(palette(), null);
    await act(async () => root.render(React.createElement(Composer, { ...props, paneActive: false })));
    await type('/');
    assert.equal(palette(), null);
    await act(async () => root.render(React.createElement(Composer, props)));
    await type('/goal');
    await key('Enter');
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.deepEqual(calls, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
