import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const EXPECTED_COMMANDS = [
  '/new',
  '/btw',
  '/resume',
  '/model',
  '/compact',
  '/context',
  '/usage',
  '/skills',
  '/goal',
  '/fork',
  '/stop',
  '/doctor',
  '/fast',
];

let mounts = 0;

async function mountComposer() {
  // An unmounted composer parks its draft under its scope for the next mount of that scope.
  const scope = `slash-test-${++mounts}`;
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
  const { desktopComposerSlashCommands, resolveDesktopSlashCommand } = await import('./slash-commands.ts');
  const calls = [];
  const toasts = [];
  window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail.text));
  const toastText = () => toasts.join('\n');
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getVoiceStatus') return { value: { installed: false } };
      // The composer reads its session's skills on its own; not a command.
      if (request.capability === 'skillsStatus') return { value: { skills: [] } };
      // The agent catalog is the core's `agents` section; the test host serves its first read through this capability.
      if (request.capability === 'listAgents') return { value: [] };
      calls.push([request.capability, request.args]);
      return { value: {} };
    },
    setFast: async (enabled, sessionId) => {
      calls.push(['fast', enabled, sessionId]);
      return { sessionId, fast: enabled };
    },
  };
  const props = {
    turnBusy: false,
    commandBusy: false,
    transitioning: false,
    focusRequest: 0,
    historyScope: scope,
    identityScope: scope,
    recoveryScope: scope,
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
      return true;
    },
    abort: async () => {
      calls.push(['abort']);
    },
    invokeResult: (action) => action(),
    applySnapshot(snapshot) {
      assert.notEqual(snapshot?.sessionId, 'slash-test', 'a slash answer must not repaint the held conversation');
    },
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
  const render = (extra = {}) => act(async () => root.render(React.createElement(Composer, { ...props, ...extra })));
  await render();
  const input = document.querySelector('textarea');
  const palette = () => document.getElementById('composer-slash-palette');
  const usages = () => Array.from(palette()?.querySelectorAll('code') || [], (node) => node.textContent);
  const selected = () => palette().querySelector('[aria-selected="true"] code').textContent;
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
  return {
    act,
    calls,
    desktopComposerSlashCommands,
    input,
    key,
    palette,
    render,
    resolveDesktopSlashCommand,
    restore,
    root,
    selected,
    toastText,
    type,
    usages,
  };
}

function composerTest(name, body) {
  test(name, async () => {
    const ui = await mountComposer();
    try {
      await body(ui);
    } finally {
      await ui.act(async () => ui.root.unmount());
      ui.restore();
    }
  });
}

composerTest('the composer offers only frequent commands to the palette', ({ desktopComposerSlashCommands }) => {
  assert.deepEqual(
    desktopComposerSlashCommands('/').map((command) => command.usage),
    EXPECTED_COMMANDS
  );
  for (const value of [
    '',
    'hello /model',
    ' /model',
    '/model x',
    '/model\n',
    '//',
    '/theme',
    '/style',
    '/clear',
    '/unknown',
  ]) {
    assert.deepEqual(desktopComposerSlashCommands(value), [], value);
  }
});

composerTest('slash command names resolve to their actions', ({ resolveDesktopSlashCommand }) => {
  assert.equal(resolveDesktopSlashCommand('new')?.action, 'clear');
  assert.equal(resolveDesktopSlashCommand('resume')?.action, 'resume');
  assert.equal(resolveDesktopSlashCommand('style')?.settingsRow, 'output-style');
  assert.equal(resolveDesktopSlashCommand('inherit')?.name, 'fork');
});

composerTest('typing / opens the palette with every frequent command', async ({ input, type, usages }) => {
  await type('/');
  assert.deepEqual(usages(), EXPECTED_COMMANDS);
  assert.equal(input.getAttribute('aria-controls'), 'composer-slash-palette');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
});

composerTest('arrow keys move the palette selection and Tab completes the command', async (ui) => {
  const { calls, input, key, palette, selected, type } = ui;
  await type('/');
  await key('ArrowUp');
  assert.equal(selected(), '/fast');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowDown');
  assert.equal(selected(), '/model');
  await key('Tab');
  assert.equal(input.value, '/model ');
  assert.equal(palette(), null);
  assert.deepEqual(calls, []);
  await key('Enter');
  assert.deepEqual(calls.pop(), ['settings', 'model']);
});

composerTest('the palette filters case-insensitively and Enter runs the selected command', async (ui) => {
  const { calls, input, key, palette, selected, type, usages } = ui;
  await type('/CO');
  assert.deepEqual(usages(), ['/compact', '/context']);
  assert.equal(selected(), '/compact');
  await key('ArrowDown');
  await key('Enter');
  assert.deepEqual(calls.pop(), ['surface', 'context']);
  assert.equal(input.value, '');
  assert.equal(palette(), null);
});

composerTest('clicking a palette option keeps focus in the input and runs the command', async (ui) => {
  const { act, calls, input, palette, type } = ui;
  await type('/for');
  const option = palette().querySelector('button');
  await act(async () => {
    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    option.click();
  });
  assert.deepEqual(calls.pop(), ['surface', 'inherit']);
  assert.equal(document.activeElement, input);
});

composerTest('with an inheritance host /inherit and /fork carry in place', async (ui) => {
  const { calls, input, key, render, type } = ui;
  await render({
    onInherit: async () => {
      calls.push(['inherit']);
      return true;
    },
  });
  await type('/inherit');
  await key('Enter');
  assert.deepEqual(calls, [['inherit']]);
  calls.pop();
  assert.equal(input.value, '');
  await type('/fork');
  await key('Enter');
  assert.deepEqual(calls, [['inherit']]);
  calls.pop();
  assert.equal(input.value, '');
});

composerTest('/inherit and /fork wait for the running turn to finish', async (ui) => {
  const { calls, input, key, render, toastText, type } = ui;
  await render({
    turnBusy: true,
    onInherit: async () => {
      calls.push(['inherit']);
      return true;
    },
  });
  await type('/inherit');
  await key('Enter');
  assert.equal(input.value, '/inherit');
  assert.match(toastText(), /Wait for the current turn to finish before \/inherit/);
  await type('/fork');
  await key('Enter');
  assert.match(toastText(), /Wait for the current turn to finish before \/fork/);
  assert.deepEqual(calls, []);
});

composerTest('a completed partial command opens its surface', async ({ calls, key, type, usages }) => {
  await type('/doc');
  assert.deepEqual(usages(), ['/doctor']);
  await key('Tab');
  await key('Enter');
  assert.deepEqual(calls.pop(), ['surface', 'doctor']);
});

composerTest('Enter during IME composition or key repeat does not run the command', async (ui) => {
  const { calls, input, key, palette, type } = ui;
  await type('/new');
  await key('Enter', { isComposing: true, keyCode: 229 });
  assert.equal(input.value, '/new');
  assert.ok(palette());
  assert.deepEqual(calls, []);
  await key('Enter', { repeat: true });
  assert.deepEqual(calls, []);
  await key('Enter');
  assert.deepEqual(calls.pop(), ['new']);
});

composerTest('/compact and /fast run directly', async ({ calls, key, type }) => {
  await type('/compact');
  await key('Enter');
  assert.equal(calls.pop()[0], 'compact');
  await type('/fast');
  await key('Enter');
  assert.deepEqual(calls.pop(), ['fast', true, 'slash-test']);
});

composerTest('Escape closes the palette and keeps the typed command', async (ui) => {
  const { calls, input, key, palette, type, usages } = ui;
  await type('/goal');
  await key('Escape');
  assert.equal(input.value, '/goal');
  assert.equal(palette(), null);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(calls, []);
  await type('/go');
  assert.deepEqual(usages(), ['/goal']);
});

composerTest('Shift+Enter inserts a newline instead of running the command', async (ui) => {
  const { calls, input, key, palette, type } = ui;
  await type('/model');
  await key('Enter', { shiftKey: true });
  assert.equal(input.value, '/model\n');
  assert.equal(palette(), null);
  assert.deepEqual(calls, []);
});

composerTest('hidden commands execute directly without a palette', async ({ calls, key, palette, type }) => {
  for (const [value, expectedCall] of [
    ['/theme', ['settings', 'theme']],
    ['/resume saved-chat', ['resume', 'saved-chat']],
    ['/style', ['settings', 'output-style']],
  ]) {
    await type(value);
    assert.equal(palette(), null);
    await key('Enter');
    assert.deepEqual(calls.pop(), expectedCall);
  }
});

composerTest('/skills opens the add menu where a skill is picked for the next message', async (ui) => {
  const { act, calls, input, key, type } = ui;
  assert.equal(document.querySelector('.composer-add-menu'), null);
  await type('/skills');
  await key('Enter');
  assert.ok(document.querySelector('.composer-add-menu'));
  assert.equal(input.value, '');
  assert.equal(
    calls.some(([kind]) => kind === 'settings'),
    false
  );
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.equal(document.querySelector('.composer-add-menu'), null);
});

composerTest('text that is not a command is sent as typed', async ({ calls, input, key, toastText, type }) => {
  for (const literal of ['/', '/m', '/not-a-command', '/tmp/file', '/Users/name/file', '/model/file', '/plain text']) {
    await type(literal);
    await key('Enter');
    const submitted = calls.pop();
    assert.equal(submitted[0], 'submit', literal);
    assert.equal(submitted[1], literal, 'send the original text, not a suggested command');
    assert.equal(input.value, '');
    assert.deepEqual(calls, []);
  }
  assert.doesNotMatch(toastText(), /Unknown command/);
});

composerTest('Escape twice clears the draft', async ({ calls, input, key, toastText, type }) => {
  await type('draft to keep');
  await key('Escape');
  assert.equal(input.value, 'draft to keep');
  assert.match(toastText(), /Esc again to clear/);
  await key('Escape');
  assert.equal(input.value, '');
  assert.deepEqual(calls, []);
});

composerTest('the palette hides on blur and returns on focus', async ({ act, input, palette, type, usages }) => {
  await type('/');
  await act(async () => input.blur());
  assert.equal(palette(), null);
  await act(async () => input.focus());
  assert.deepEqual(usages(), EXPECTED_COMMANDS);
});

composerTest('during a running turn Escape closes the palette and commands are refused', async (ui) => {
  const { calls, input, key, palette, render, toastText, type } = ui;
  await type('/');
  await render({ turnBusy: true });
  await key('Escape');
  assert.equal(palette(), null);
  assert.deepEqual(calls, []);
  await type('/new');
  await key('Enter');
  assert.equal(input.value, '/new');
  assert.match(toastText(), /Wait for the current turn to finish/);
  assert.deepEqual(calls, []);
});

composerTest('a transitioning composer closes the palette', async ({ palette, render, type }) => {
  await type('/new');
  assert.ok(palette());
  await render({ transitioning: true });
  assert.equal(palette(), null);
});

composerTest('an inactive pane shows no palette', async ({ palette, render, type }) => {
  await render({ paneActive: false });
  await type('/');
  assert.equal(palette(), null);
});

composerTest('/goal opens the goal dialog', async ({ calls, key, type }) => {
  await type('/goal');
  await key('Enter');
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.deepEqual(calls, []);
});
