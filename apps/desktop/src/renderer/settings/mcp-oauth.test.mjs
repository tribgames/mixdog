import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.FormData = window.FormData;
globalThis.Event = window.Event;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

// react-dom reads the DOM capabilities once at load (text input events), so it loads after the test DOM exists.
const { createRoot } = await import('react-dom/client');
const { CategoryPanel } = await import('./capability-panels.tsx');
const { mcpStatus, mcpErrorSummary } = await import('./mcp-editor-dialog.tsx');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait on the condition instead of a fixed delay (debounce and poll timers are real).
async function waitFor(condition, limitMs = 5000) {
  for (let waited = 0; !condition() && waited < limitMs; waited += 20) await act(async () => sleep(20));
}

function server(overrides = {}) {
  return {
    name: 'cloudflare',
    enabled: true,
    config: { type: 'http', url: 'https://mcp.cloudflare.com/mcp' },
    ...overrides,
  };
}

async function mountMcp({ servers, run, createOpen = false, refreshExtensions = async () => {}, closeCreate }) {
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(CategoryPanel, {
        category: 'mcp',
        context: {
          api: {},
          data: { mcp: { servers }, __loadedSections: ['mcp'] },
          snapshot: null,
          pending: '',
          run,
          refreshExtensions,
          async route() {},
          async setFast() {},
          confirm() {},
          notice() {},
          updaterState: { status: 'disabled' },
          async checkDesktopUpdate() {},
          async installDesktopUpdate() {},
          createOpen,
          closeCreate,
        },
      })
    )
  );
  return {
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function actionLabels() {
  return [...document.querySelectorAll('.extensions-mcp-dialog .extensions-action')].map(
    (button) => button.textContent
  );
}

async function openEditor(name) {
  await act(async () => {
    document.querySelector(`[data-extension-row="${name}"]`).click();
  });
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('mcpStatus reports a sign-in wait as a warning, not a failure', () => {
  const status = mcpStatus({ name: 'a', enabled: true, authRequired: true, status: 'sign-in required' });
  assert.deepEqual(status, { label: 'Sign-in required', tone: 'warn', connected: false });
  assert.equal(mcpStatus({ name: 'a', enabled: true, error: 'boom' }).tone, 'danger');
  assert.equal(mcpStatus({ name: 'a', enabled: false, authRequired: true }).label, 'Disabled');
});

test('mcpStatus never shows a raw runtime status', () => {
  assert.deepEqual(mcpStatus({ name: 'a', enabled: true, status: 'disconnected' }), {
    label: 'Not connected',
    tone: 'warn',
    connected: false,
  });
  assert.equal(mcpStatus({ name: 'a', enabled: true, status: 'pending' }).label, 'Pending');
  assert.equal(mcpStatus({ name: 'a', enabled: true, status: 'weird-new-state' }).label, 'Not connected');
});

test('mcpErrorSummary words a refused connection without naming a provider', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  assert.equal(mcpErrorSummary(refused), 'Connection failed');
  assert.equal(mcpErrorSummary('Something odd happened'), 'Something odd happened');
});

test('a sign-in required server connects through the login wait dialog and refreshes when done', async () => {
  const calls = [];
  let refreshed = 0;
  let polls = 0;
  const view = await mountMcp({
    servers: [server({ authRequired: true, status: 'sign-in required' })],
    refreshExtensions: async () => {
      refreshed += 1;
    },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
      if (capability === 'beginMcpOAuthLogin') return { flowId: 'f1', state: 'pending', url: 'https://auth.test/x' };
      if (capability === 'getMcpOAuthLoginStatus') {
        polls += 1;
        return { flowId: 'f1', state: 'complete' };
      }
    },
  });
  try {
    assert.equal(
      document.querySelector('[data-extension-row="cloudflare"] .sidebar-resource-tag').textContent,
      'Sign-in required'
    );
    await openEditor('cloudflare');
    assert.equal(document.querySelector('.extensions-dialog-title-status').textContent, 'Sign-in required');
    assert.deepEqual(actionLabels(), ['Connect']);
    await act(async () => {
      document.querySelector('.extensions-mcp-dialog .extensions-action').click();
    });
    assert.deepEqual(calls.at(-1), ['beginMcpOAuthLogin', ['cloudflare']]);
    const dialog = document.querySelector('.settings-oauth-dialog');
    assert.equal(dialog.querySelector('h3').textContent, 'Sign in');
    assert.equal(dialog.querySelector('header p'), null, 'no subtitle under the title');
    assert.equal(dialog.querySelector('.settings-oauth-host').textContent, 'auth.test', 'host only');
    assert.equal(dialog.querySelector('.settings-oauth-hint').textContent, 'Sign in in the browser');
    assert.ok(dialog.querySelector('[aria-label="Open again"]'));
    assert.ok(dialog.querySelector('[aria-label="Copy link"]'));
    assert.match(dialog.querySelector('.settings-oauth-wait').textContent, /Waiting…/);
    assert.equal(dialog.querySelector('textarea'), null, 'no manual URL box');
    assert.equal(dialog.querySelector('form.settings-oauth-code'), null, 'a local client has no paste field');
    const written = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => written.push(text) },
    });
    await act(async () => {
      dialog.querySelector('[aria-label="Copy link"]').click();
    });
    assert.deepEqual(written, ['https://auth.test/x']);
    assert.ok(dialog.querySelector('[aria-label="Copied"]'), 'copy feedback');
    await waitFor(() => document.querySelector('.settings-oauth-dialog') === null);
    assert.equal(polls, 1);
    assert.equal(refreshed, 1, 'MCP data re-reads once the login completed');
    assert.equal(document.querySelector('.settings-oauth-dialog'), null);
  } finally {
    await view.cleanup();
  }
});

test('closing the login wait dialog cancels the flow', async () => {
  const calls = [];
  const view = await mountMcp({
    servers: [server({ authRequired: true })],
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
      if (capability === 'beginMcpOAuthLogin') return { flowId: 'f2', state: 'pending', url: 'https://auth.test/x' };
      if (capability === 'getMcpOAuthLoginStatus') return { flowId: 'f2', state: 'pending' };
    },
  });
  try {
    await openEditor('cloudflare');
    await act(async () => {
      document.querySelector('.extensions-mcp-dialog .extensions-action').click();
    });
    await act(async () => {
      document.querySelector('.settings-oauth-dialog [aria-label="Close OAuth login"]').click();
    });
    assert.equal(document.querySelector('.settings-oauth-dialog'), null);
    assert.deepEqual(calls.at(-1), ['cancelMcpOAuthLogin', ['f2']]);
  } finally {
    await view.cleanup();
  }
});

test('a failed login shows its error in the wait dialog', async () => {
  const view = await mountMcp({
    servers: [server({ authRequired: true })],
    async run(capability) {
      if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
      if (capability === 'beginMcpOAuthLogin') return { flowId: 'f3', state: 'pending' };
      if (capability === 'getMcpOAuthLoginStatus') return { flowId: 'f3', state: 'failed', error: 'access_denied' };
    },
  });
  try {
    await openEditor('cloudflare');
    await act(async () => {
      document.querySelector('.extensions-mcp-dialog .extensions-action').click();
    });
    await waitFor(() =>
      /Failed/.test(document.querySelector('.settings-oauth-dialog .settings-oauth-wait')?.textContent ?? '')
    );
    const dialog = document.querySelector('.settings-oauth-dialog');
    assert.ok(dialog, 'the dialog stays open on failure');
    assert.match(dialog.querySelector('.settings-oauth-wait').textContent, /Failed/);
    assert.match(dialog.textContent, /access_denied/);
  } finally {
    await view.cleanup();
  }
});

test('a signed-in server offers Reconnect and Disconnect, Disconnect signs out', async () => {
  const calls = [];
  const view = await mountMcp({
    servers: [server({ connected: true, status: 'connected', oauth: { signedIn: true } })],
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
    },
  });
  try {
    await openEditor('cloudflare');
    assert.deepEqual(actionLabels(), ['Reconnect', 'Disconnect']);
    const disconnect = document.querySelector('.extensions-mcp-dialog .extensions-action.danger');
    await act(async () => disconnect.click());
    assert.deepEqual(calls.at(-1), ['signOutMcpServer', ['cloudflare']]);
  } finally {
    await view.cleanup();
  }
});

test('a failed or disconnected server still offers Connect, a connected unsigned one does not', async () => {
  const view = await mountMcp({
    servers: [
      server({ name: 'broken', status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:9' }),
      server({ name: 'idle', status: 'disconnected' }),
      server({ name: 'live', connected: true, status: 'connected' }),
    ],
    async run(capability) {
      if (capability === 'getMcpServerConfig') return { name: 'x', config: server().config };
    },
  });
  try {
    const expected = { broken: ['Connect'], idle: ['Connect'], live: [] };
    for (const [name, labels] of Object.entries(expected)) {
      await openEditor(name);
      assert.deepEqual(actionLabels(), labels, name);
      await act(async () => {
        document.querySelector('.extensions-mcp-dialog header button[aria-label="Close"]').click();
      });
    }
  } finally {
    await view.cleanup();
  }
});

// A client away from the host: a remote device, or an SSH server window.
const awayVariants = {
  remote: () => {
    window.mixdogRemoteServer = 'https://host.test';
    return () => {
      delete window.mixdogRemoteServer;
    };
  },
  ssh: () => {
    window.mixdogDesktop.connection = { kind: 'ssh' };
    return () => {
      delete window.mixdogDesktop.connection;
    };
  },
};

for (const [variant, enter] of Object.entries(awayVariants)) {
  test(`away from the host (${variant}) signs in on this device and pastes the final redirect back`, async () => {
    const { setRemoteHostOpenAccess } = await import('../remote-host-access.ts');
    const leave = enter();
    setRemoteHostOpenAccess(true);
    const opened = [];
    window.mixdogDesktop.openExternal = async (url) => {
      opened.push(url);
    };
    const calls = [];
    let refreshed = 0;
    let polls = 0;
    const view = await mountMcp({
      servers: [server({ authRequired: true, status: 'sign-in required' })],
      refreshExtensions: async () => {
        refreshed += 1;
      },
      async run(capability, args) {
        calls.push([capability, args]);
        if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
        if (capability === 'beginMcpOAuthLogin') return { flowId: 'f9', state: 'pending', url: 'https://auth.test/x' };
        if (capability === 'getMcpOAuthLoginStatus') {
          // The first poll omits the sign-in url; the next one fails.
          polls += 1;
          return polls === 1 ? { flowId: 'f9', state: 'pending' } : undefined;
        }
        if (capability === 'completeMcpOAuthLogin') {
          if (args[1] === 'nonsense') {
            throw new Error(
              'The pasted sign-in URL is invalid. Paste the full address the browser was redirected to after signing in.'
            );
          }
          return { flowId: 'f9', state: 'complete' };
        }
      },
    });
    try {
      await openEditor('cloudflare');
      assert.deepEqual(actionLabels(), ['Connect']);
      assert.doesNotMatch(document.querySelector('.extensions-mcp-dialog').textContent, /Manage on the host computer/);
      await act(async () => {
        document.querySelector('.extensions-mcp-dialog .extensions-action').click();
      });
      assert.deepEqual(calls.at(-1), ['beginMcpOAuthLogin', ['cloudflare', { openBrowser: false }]]);
      assert.deepEqual(opened, ['https://auth.test/x'], 'the sign-in page opens on this device');
      const dialog = document.querySelector('.settings-oauth-dialog');
      assert.equal(dialog.querySelector('h3').textContent, 'Sign in');
      assert.equal(dialog.querySelector('.settings-oauth-host').textContent, 'auth.test');
      assert.match(dialog.querySelector('form.settings-oauth-code > b').textContent, /Sign-in redirect URL or code/);
      assert.equal(
        dialog.querySelector('form.settings-oauth-code input').placeholder,
        'Paste the final redirect URL or code'
      );
      assert.ok(dialog.querySelector('[aria-label="Open again"]'));
      await waitFor(() => polls >= 2);
      assert.ok(polls >= 2);
      assert.equal(
        dialog.querySelector('.settings-oauth-host').textContent,
        'auth.test',
        'a status without url keeps the link'
      );
      assert.ok(dialog.querySelector('[aria-label="Open again"]'));
      assert.match(dialog.textContent, /OAuth status could not be checked\./);
      const paste = dialog.querySelector('form.settings-oauth-code input[name="code"]');
      assert.ok(paste);
      await act(async () => setInput(paste, 'nonsense'));
      await act(async () => {
        dialog.querySelector('form.settings-oauth-code').requestSubmit();
      });
      assert.deepEqual(calls.at(-1), ['completeMcpOAuthLogin', ['f9', 'nonsense']]);
      const afterPaste = document.querySelector('.settings-oauth-dialog').textContent;
      assert.match(
        document.querySelector('.settings-oauth-paste-error').textContent,
        /^Invalid sign-in address\. Paste the full address you were redirected to after signing in\.$/,
        'the runtime error maps to the friendly sentence'
      );
      assert.equal(
        document.querySelector('form.settings-oauth-code input').getAttribute('aria-invalid'),
        'true',
        'the field is marked invalid'
      );
      assert.match(afterPaste, /OAuth status could not be checked\./, 'the status error is its own notice');
      assert.equal(refreshed, 0, 'an invalid paste keeps the dialog open');
      await act(async () =>
        setInput(
          document.querySelector('form.settings-oauth-code input[name="code"]'),
          'http://127.0.0.1:1/cb?code=a&state=b'
        )
      );
      await act(async () => {
        document.querySelector('form.settings-oauth-code').requestSubmit();
      });
      await act(async () => {
        await sleep(20);
      });
      assert.deepEqual(calls.filter(([capability]) => capability === 'completeMcpOAuthLogin').at(-1), [
        'completeMcpOAuthLogin',
        ['f9', 'http://127.0.0.1:1/cb?code=a&state=b'],
      ]);
      assert.equal(refreshed, 1);
      assert.equal(document.querySelector('.settings-oauth-dialog'), null);
    } finally {
      await view.cleanup();
      leave();
      delete window.mixdogDesktop.openExternal;
      setRemoteHostOpenAccess(false);
    }
  });

  test(`away from the host (${variant}) offers Reconnect/Disconnect and the add dialog Connect`, async () => {
    const { setRemoteHostOpenAccess } = await import('../remote-host-access.ts');
    const leave = enter();
    setRemoteHostOpenAccess(true);
    const calls = [];
    const view = await mountMcp({
      servers: [server({ connected: true, status: 'connected', oauth: { signedIn: true } })],
      async run(capability, args) {
        calls.push([capability, args]);
        if (capability === 'getMcpServerConfig') return { name: 'cloudflare', config: server().config };
      },
    });
    try {
      await openEditor('cloudflare');
      assert.deepEqual(actionLabels(), ['Reconnect', 'Disconnect']);
      await act(async () => {
        document.querySelector('.extensions-mcp-dialog .extensions-action.danger').click();
      });
      assert.deepEqual(calls.at(-1), ['signOutMcpServer', ['cloudflare']]);
    } finally {
      await view.cleanup();
    }
    const addView = await mountMcp({
      servers: [],
      createOpen: true,
      async run(capability) {
        if (capability === 'probeMcpServerAuth') return { auth: 'oauth' };
      },
    });
    try {
      await chooseHttp();
      await act(async () => setInput(document.querySelector('[name="mcp-url"]'), 'https://mcp.cloudflare.com/mcp'));
      await waitFor(() => document.querySelector('[data-mcp-oauth-probe]'));
      assert.equal(document.querySelector('[data-mcp-oauth-probe] .extensions-action').textContent, 'Connect');
    } finally {
      await addView.cleanup();
      leave();
      setRemoteHostOpenAccess(false);
    }
  });
}

test('no sign-in actions for stdio, disabled or credentialed servers', async () => {
  const view = await mountMcp({
    servers: [
      { name: 'local', enabled: true, authRequired: true, config: { type: 'stdio', command: 'x' } },
      server({ name: 'off', enabled: false, authRequired: true }),
      server({
        name: 'keyed',
        authRequired: true,
        config: { type: 'http', url: 'https://k.test/mcp', bearer_token_env_var: 'TOKEN' },
      }),
    ],
    async run(capability, args) {
      if (capability === 'getMcpServerConfig') {
        const row = { local: 'local', off: 'off', keyed: 'keyed' };
        assert.ok(row[args[0]]);
        return {
          name: args[0],
          config:
            args[0] === 'local'
              ? { type: 'stdio', command: 'x' }
              : args[0] === 'keyed'
                ? { type: 'http', url: 'https://k.test/mcp', bearer_token_env_var: 'TOKEN' }
                : server().config,
        };
      }
    },
  });
  try {
    for (const name of ['local', 'off', 'keyed']) {
      await openEditor(name);
      assert.deepEqual(actionLabels(), [], name);
      await act(async () => {
        document.querySelector('.extensions-mcp-dialog header button[aria-label="Close"]').click();
      });
    }
  } finally {
    await view.cleanup();
  }
});

async function chooseHttp() {
  const button = [...document.querySelectorAll('.extensions-mcp-transport button')].find((entry) =>
    /Streamable HTTP/.test(entry.textContent)
  );
  await act(async () => button.click());
}

test('the add dialog probes the URL, offers Connect for OAuth servers and saves before signing in', async () => {
  const calls = [];
  let closed = 0;
  const view = await mountMcp({
    servers: [],
    createOpen: true,
    closeCreate() {
      closed += 1;
    },
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'probeMcpServerAuth') return { auth: 'oauth' };
      if (capability === 'addMcpServer') return { name: args[0].name };
      if (capability === 'beginMcpOAuthLogin') return { flowId: 'f4', state: 'pending' };
      if (capability === 'getMcpOAuthLoginStatus') return { flowId: 'f4', state: 'pending' };
    },
  });
  try {
    await chooseHttp();
    document.querySelector('[name="mcp-name"]').value = 'cloudflare';
    const url = document.querySelector('[name="mcp-url"]');
    await act(async () => setInput(url, 'https://mcp.cloudflare.com/mcp'));
    assert.equal(document.querySelector('[data-mcp-oauth-probe]'), null, 'waits for typing to stop');
    await waitFor(() => calls.length > 0 && document.querySelector('[data-mcp-oauth-probe]'));
    assert.deepEqual(calls[0], ['probeMcpServerAuth', [{ type: 'http', url: 'https://mcp.cloudflare.com/mcp' }]]);
    const card = document.querySelector('[data-mcp-oauth-probe]');
    assert.ok(card);
    assert.match(card.textContent, /Connection/);
    assert.match(card.querySelector('.extensions-item-status').textContent, /Sign-in required/);
    assert.equal(card.querySelector('.extensions-action').textContent, 'Connect');
    await act(async () => {
      card.querySelector('.extensions-action').click();
    });
    await act(async () => {
      await sleep(5);
    });
    assert.deepEqual(
      calls.slice(1).map(([capability]) => capability),
      ['addMcpServer', 'beginMcpOAuthLogin']
    );
    assert.equal(calls[1][1][0].url, 'https://mcp.cloudflare.com/mcp');
    assert.deepEqual(calls[2][1], ['cloudflare']);
    assert.equal(closed, 1);
    assert.equal(document.querySelector('.settings-oauth-dialog h3').textContent, 'Sign in');
  } finally {
    await view.cleanup();
  }
});

test('leaving the URL field probes at once, and an unreachable server never blocks saving', async () => {
  const calls = [];
  const view = await mountMcp({
    servers: [],
    createOpen: true,
    async run(capability, args) {
      calls.push([capability, args]);
      if (capability === 'probeMcpServerAuth') return { auth: 'unreachable', error: 'connect ECONNREFUSED' };
      if (capability === 'addMcpServer') return { name: args[0].name };
    },
  });
  try {
    await chooseHttp();
    document.querySelector('[name="mcp-name"]').value = 'down';
    const url = document.querySelector('[name="mcp-url"]');
    await act(async () => setInput(url, 'https://down.test/mcp'));
    await act(async () => {
      url.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      await sleep(30);
    });
    assert.equal(calls.length, 1, 'probed without waiting out the typing delay');
    assert.match(document.querySelector('.extensions-mcp-dialog').textContent, /ECONNREFUSED/);
    assert.equal(document.querySelector('[data-mcp-oauth-probe]'), null);
    await act(async () => {
      document
        .querySelector('.extensions-mcp-dialog form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(calls.at(-1)[0], 'addMcpServer');
  } finally {
    await view.cleanup();
  }
});

test('the add dialog does not probe when auth is already configured', async () => {
  const calls = [];
  const view = await mountMcp({
    servers: [],
    createOpen: true,
    async run(capability) {
      calls.push(capability);
      return { auth: 'oauth' };
    },
  });
  try {
    await chooseHttp();
    await act(async () => setInput(document.querySelector('[name="mcp-bearer-token-env"]'), 'TOKEN'));
    await act(async () => setInput(document.querySelector('[name="mcp-url"]'), 'https://k.test/mcp'));
    await act(async () => {
      await sleep(650);
    });
    assert.deepEqual(calls, []);
    assert.equal(document.querySelector('[data-mcp-oauth-probe]'), null);
  } finally {
    await view.cleanup();
  }
});

test('the shared dialog keeps provider extras: device code, manual code paste, other errors, verify children', async () => {
  const { OAuthLoginDialog } = await import('./oauth-login-flow.tsx');
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const submitted = [];
  await act(async () =>
    root.render(
      React.createElement(
        OAuthLoginDialog,
        {
          id: 'anthropic-oauth',
          closeLabel: 'Close OAuth login',
          flow: {
            flowId: 'p1',
            state: 'pending',
            manualUrl: 'https://claude.ai/oauth/authorize?x=1',
            userCode: 'ABCD-1234',
          },
          error: '',
          paste: {
            title: 'Anthropic authorization code',
            placeholder: 'Authorization code or code#state',
            ariaLabel: 'Anthropic authorization code',
            error: 'Some other failure',
            onSubmit: (value) => submitted.push(value),
          },
          disabled: false,
          onClose() {},
        },
        React.createElement('section', { className: 'settings-oauth-verify' }, 'verify extra')
      )
    )
  );
  try {
    const dialog = document.querySelector('.settings-oauth-dialog');
    assert.equal(dialog.querySelector('h3').textContent, 'Sign in');
    assert.equal(dialog.querySelector('.settings-oauth-host').textContent, 'claude.ai');
    assert.equal(dialog.querySelector('.settings-oauth-url input').value, 'ABCD-1234');
    assert.match(dialog.querySelector('form.settings-oauth-code > b').textContent, /Anthropic authorization code/);
    assert.equal(dialog.querySelector('.settings-oauth-paste-error').textContent, 'Some other failure');
    assert.match(dialog.textContent, /verify extra/);
    await act(async () => setInput(dialog.querySelector('form input[name="code"]'), 'abc#def'));
    await act(async () => {
      dialog.querySelector('form.settings-oauth-code').requestSubmit();
    });
    assert.deepEqual(submitted, ['abc#def']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
