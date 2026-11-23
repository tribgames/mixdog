import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom, toolModulesSource } from '../test-support/test-dom.mjs';

const modules = toolModulesSource();

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'FormData'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// The core's `login:<flowId>` feed as the window receives it, and the pages the window opened.
const loginListeners = new Set();
const pushLogin = (flowId, state) => {
  for (const listener of [...loginListeners]) listener({ flowId, state });
};
const opened = [];
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  openExternal: async (url) => void opened.push(url),
  sections: {
    ...modules.sections,
    subscribeLoginUpdated(listener) {
      loginListeners.add(listener);
      return () => loginListeners.delete(listener);
    },
    subscribeLoginFeedLost: () => () => undefined,
    loginFeed: async () => ({ state: null, lost: false }),
  },
};

const { CategoryPanel } = await import('./capability-panels.tsx');
const { SettingsConfirmDialog } = await import('./capability-controls.tsx');

// The core's `acpAgents` value (mixdog-acp agents.rs `status`).
const agent = (state, extra = {}) => ({
  id: 'antigravity',
  label: 'Antigravity',
  provider: 'acp-antigravity',
  command: 'agy',
  minimumVersion: '1.5.1',
  state,
  version: null,
  message: null,
  models: [],
  lastError: null,
  canInstall: false,
  canSignIn: false,
  ...extra,
});
const acpAgents = (enabled, ...agents) => ({ enabled, agents });

/** The panel over a core that holds `value`; `run` answers the panel's commands, `invoke` its direct calls. */
function context(value, { run = async () => ({}), invoke = async () => ({ value: null }), confirm = () => {} } = {}) {
  const toolModules = {
    webSearch: { enabled: true },
    memory: { enabled: true, installed: true },
    git: { enabled: true, installed: true },
    office: { enabled: true, installed: true },
    tidy: { enabled: true, installed: true },
    acpAgents: value,
  };
  modules.publish(toolModules);
  const read = (capability) =>
    capability === 'getTidyEngineStatus'
      ? { ok: true, value: { toolsDir: '/tools', core: [], engines: [], installing: null } }
      : { ok: true, value: capability === 'getToolModuleSettings' ? toolModules : null };
  return {
    api: {
      readCapabilities: async (requests) => requests.map(({ capability }) => read(capability)),
      invokeCapability: async (request) =>
        request.capability === 'installBuiltinFeature' ? invoke(request) : { value: read(request.capability).value },
      readSettings: async () => ({ browserControl: false, computerControl: false }),
      gitCliStatus: async () => ({ installed: true }),
    },
    data: { toolModules, voice: { enabled: false, installed: false } },
    snapshot: null,
    pending: '',
    run,
    async route() {},
    async setFast() {},
    confirm,
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
  };
}

async function mount(t, value, handlers) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) =>
    act(async () =>
      root.render(React.createElement(CategoryPanel, { category: 'builtins', context: context(next, handlers) }))
    );
  await render(value);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return render;
}

const listRow = () => document.querySelector('button[data-built-in-feature="acpAgents"]');
const dialog = () => document.querySelector('[data-feature-id="acpAgents"]');
const open = () => act(async () => listRow().click());
const toggle = () =>
  [...dialog().querySelectorAll('input')].find((input) => input.getAttribute('aria-label') === 'Antigravity ACP');
const agentRow = (id = 'antigravity') => dialog().querySelector(`[data-acp-agent="${id}"]`);
const words = (row) => [
  row.querySelector('.extensions-item-status').textContent,
  row.querySelector('small').textContent,
];
/** A signed-in agent's row: the provider account card, with its one account's name, marks, usage rows and actions. */
const card = (row) => ({
  title: row.querySelector('.provider-accounts-heading b')?.textContent ?? null,
  account: row.querySelector('.provider-account-name b')?.textContent ?? null,
  renamed: Boolean(row.querySelector('button.provider-account-name')),
  marks: [...row.querySelectorAll('.provider-account-title .settings-status')].map((node) => node.textContent),
  usage: [...row.querySelectorAll('.provider-account-usage > span')].map((node) => [
    node.querySelector('small').textContent,
    node.querySelector('b').textContent,
  ]),
  actions: [...row.querySelectorAll('.settings-resource-actions button')].map((node) => node.textContent),
});
const signedIn = { title: 'Antigravity', account: 'Account 1', renamed: false, marks: ['In use'], usage: [], actions: [] };
const fault = (row) =>
  row.querySelector('.extensions-item-fault')?.textContent ??
  row.querySelector('.error-notice-copy span')?.textContent ??
  '';
const button = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent === text);
const checkAgain = () => dialog().querySelector('button[aria-label="Check again"]');

test('Antigravity ACP is listed off by default; turning it on asks the core and shows its report', async (t) => {
  const calls = [];
  const render = await mount(t, acpAgents(false, agent('off')), {
    run: async (capability, args) => {
      calls.push([capability, args]);
      return { acpAgents: acpAgents(true, agent('checking')) };
    },
  });
  assert.equal(listRow().getAttribute('data-enabled'), 'false');
  await open();
  assert.equal(toggle().checked, false);
  assert.equal(dialog().querySelector('[data-acp-agents]'), null);

  await act(async () => toggle().click());
  await render(acpAgents(true, agent('checking')));
  assert.deepEqual(calls, [['setBuiltinToolEnabled', ['acpAgents', true]]]);
  assert.deepEqual(words(agentRow()), ['Checking…', 'Looking for agy… To stop, turn Antigravity ACP off.']);

  await render(acpAgents(true, agent('ready', { version: '1.5.15', models: [{ id: 'g', name: 'Gemini' }] })));
  assert.equal(listRow().getAttribute('data-enabled'), 'true');
  // Signed in, the agent is the provider account card; its CLI's version is the dialog's Info.
  assert.deepEqual(card(agentRow()), signedIn);
  assert.match(dialog().textContent, /1\.5\.15/);
});

test('every agent state the core can report reads truthfully and leaves a next step', async (t) => {
  const reported = [
    ['checking', {}, ['Checking…', 'Looking for agy… To stop, turn Antigravity ACP off.'], 'muted'],
    ['installing', { canInstall: true }, ['Installing…', 'Downloading and installing Antigravity.'], 'muted'],
    [
      'updating',
      { canInstall: true, version: '1.5.1' },
      ['Updating…', 'Updating Antigravity to the newest version.'],
      'muted',
    ],
    [
      'notInstalled',
      {},
      ['Not found', 'The agy command was not found. Install Antigravity, then check again.'],
      'warn',
    ],
    [
      'versionUnknown',
      {},
      ['Version unknown', 'agy did not report its version. Update Antigravity, then check again.'],
      'warn',
    ],
    [
      'versionTooOld',
      { version: '1.3.3' },
      ['Update needed', 'Antigravity 1.3.3 is installed; 1.5.1 or later is needed.'],
      'warn',
    ],
    ['signedOut', { version: '1.5.15' }, ['Signed out', 'Run agy in a terminal to sign in, then check again.'], 'warn'],
    ['failed', { message: 'ACP mode exited (code 2)' }, ['Failed', 'ACP mode exited (code 2)'], 'danger'],
    // What the wire can carry beyond the documented values.
    ['off', {}, ['Not checked', 'Not checked yet. Check again to look for it.'], 'muted'],
    [
      'paused',
      {},
      [
        'Not understood',
        'This version of Mixdog does not understand the state "paused". Check again, or update Mixdog.',
      ],
      'warn',
    ],
    [
      'notInstalled',
      { id: 'no-command', command: '' },
      ['Not found', 'Antigravity was not found. Install it, then check again.'],
      'warn',
    ],
    [
      'versionTooOld',
      { id: 'no-versions', minimumVersion: '' },
      ['Update needed', 'A newer version of Antigravity is needed.'],
      'warn',
    ],
    [
      'signedOut',
      { id: 'no-login', command: '' },
      ['Signed out', 'Sign in to Antigravity in a terminal, then check again.'],
      'warn',
    ],
  ];
  const render = await mount(
    t,
    acpAgents(true, ...reported.map(([state, extra], index) => agent(state, { ...extra, id: `a${index}` })))
  );
  await open();
  reported.forEach(([state, extra, expected, tone], index) => {
    const row = agentRow(`a${index}`);
    assert.deepEqual(words(row), expected, `${state} ${extra.id ?? ''}`);
    assert.equal(row.getAttribute('data-tone'), tone, state);
  });
  // A failed update beside an agent that still works: it stays Ready and says what failed.
  await render(
    acpAgents(
      true,
      agent('ready', { version: '1.5.15', lastError: { action: 'update', message: 'npm exited with 1' } })
    )
  );
  assert.deepEqual(card(agentRow()), signedIn);
  assert.equal(fault(agentRow()), 'Update failed: npm exited with 1');
  // A state not understood is never a check in progress: Check again stays available.
  await render(acpAgents(true, agent('paused')));
  assert.equal(checkAgain().disabled, false);
  assert.match(listRow().textContent, /Setup needed/);
  // On, with no agent reported: the section says so, and Check again is the way on.
  await render(acpAgents(true));
  assert.match(dialog().querySelector('[data-acp-agents]').textContent, /No agents were reported/);
  assert.equal(checkAgain().disabled, false);
});

test('Check again asks the core to look again without turning the feature off', async (t) => {
  const calls = [];
  const render = await mount(t, acpAgents(true, agent('signedOut', { version: '1.5.15' })), {
    run: async (capability, args) => {
      calls.push([capability, args]);
      return { acpAgents: acpAgents(true, agent('checking', { version: '1.5.15' })) };
    },
  });
  await open();
  await act(async () => checkAgain().click());
  await render(acpAgents(true, agent('checking', { version: '1.5.15' })));
  assert.deepEqual(calls, [['setBuiltinToolEnabled', ['acpAgents', true]]]);
  assert.equal(toggle().checked, true);
  assert.deepEqual(words(agentRow()), ['Checking…', 'Looking for agy… To stop, turn Antigravity ACP off.']);
  assert.equal(checkAgain().disabled, true);

  await render(acpAgents(true, agent('ready', { version: '1.5.15' })));
  assert.deepEqual(card(agentRow()), signedIn);
  assert.equal(checkAgain().disabled, false);
});

test('Install and Update run the core install, show its progress, and a failure beside a Retry', async (t) => {
  const installs = [];
  let answer = Promise.withResolvers();
  const render = await mount(t, acpAgents(true, agent('notInstalled', { canInstall: true })), {
    invoke: (request) => {
      installs.push(request);
      return answer.promise;
    },
  });
  await open();
  assert.deepEqual(words(agentRow()), ['Not found', 'Antigravity is not installed.']);
  await act(async () => button(agentRow(), 'Install').click());
  assert.deepEqual(installs, [{ capability: 'installBuiltinFeature', args: ['acpAgents'] }]);
  assert.equal(checkAgain().disabled, true);
  // The core's progress is the agent's state; the feature's switch stays usable, turning it off ends the install.
  await render(acpAgents(true, agent('installing', { canInstall: true })));
  assert.deepEqual(words(agentRow()), ['Installing…', 'Downloading and installing Antigravity.']);
  assert.ok(agentRow().querySelector('[role="progressbar"]'));
  assert.equal(toggle().disabled, false);

  const failed = acpAgents(
    true,
    agent('notInstalled', { canInstall: true, lastError: { action: 'install', message: 'Download failed: 503' } })
  );
  await render(failed);
  await act(async () => answer.reject(new Error('Antigravity could not be installed: Download failed: 503')));
  assert.equal(fault(agentRow()), 'Install failed: Download failed: 503');
  assert.ok(button(agentRow(), 'Retry'));
  // The core's answer is the failure the row already says: it is said once.
  assert.equal(dialog().textContent.split('Download failed: 503').length - 1, 1);

  // A failure no agent says shows under Agents, and goes with the agents it was about when the feature is off.
  answer = Promise.withResolvers();
  await act(async () => button(agentRow(), 'Retry').click());
  await render(acpAgents(true, agent('notInstalled', { canInstall: true })));
  await act(async () => answer.reject(new Error('The setting could not be written.')));
  assert.match(dialog().textContent, /The setting could not be written\./);
  await render(acpAgents(false, agent('off')));
  await render(acpAgents(true, agent('notInstalled', { canInstall: true })));
  assert.doesNotMatch(dialog().textContent, /could not be written/);
  assert.equal(installs.length, 2);

  answer = Promise.withResolvers();
  await render(acpAgents(true, agent('versionTooOld', { canInstall: true, version: '1.3.3' })));
  await act(async () => button(agentRow(), 'Update').click());
  assert.equal(installs.length, 3);
  await render(acpAgents(true, agent('updating', { canInstall: true, version: '1.3.3' })));
  assert.deepEqual(words(agentRow()), ['Updating…', 'Updating Antigravity to the newest version.']);
  await act(async () =>
    answer.resolve({ value: { acpAgents: acpAgents(true, agent('ready', { version: '1.5.15' })) } })
  );
  await render(acpAgents(true, agent('ready', { version: '1.5.15', canInstall: true })));
  assert.deepEqual(card(agentRow()), signedIn);
  assert.equal(fault(agentRow()), '');
});

test('Sign in opens the page the core hands over, takes the code, and can be cancelled', async (t) => {
  const calls = [];
  let flow = 0;
  const run = async (capability, args) => {
    calls.push([capability, args]);
    if (capability === 'beginOAuthProviderLogin') {
      flow += 1;
      return {
        flowId: `f${flow}`,
        provider: 'acp-antigravity',
        url: null,
        state: 'pending',
        manualCodeSupported: true,
      };
    }
    if (capability === 'completeOAuthProviderLogin') return { flowId: args[0], state: 'pending' };
    return {};
  };
  const signedOut = acpAgents(true, agent('signedOut', { version: '1.5.15', canSignIn: true }));
  await mount(t, signedOut, { run });
  await open();
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);
  await act(async () => button(agentRow(), 'Sign in').click());
  assert.deepEqual(calls.at(-1), ['beginOAuthProviderLogin', ['acp-antigravity']]);
  assert.deepEqual(words(agentRow()), ['Signing in…', 'Finish signing in in your browser.']);
  // No look again (which updates the CLI) while the CLI's own sign-in runs; the dialog names no OAuth.
  assert.equal(checkAgain().disabled, true);
  const signIn = document.querySelector('.settings-oauth-dialog');
  assert.doesNotMatch(
    [...signIn.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).join(' '),
    /OAuth/
  );
  // The page arrives on the flow's feed; the window opens it once.
  const page = 'https://accounts.example/sign-in?code=1';
  await act(async () => pushLogin('f1', { flowId: 'f1', state: 'pending', url: page, manualCodeSupported: true }));
  assert.deepEqual(opened, [page]);

  const form = document.querySelector('.settings-oauth-code');
  form.querySelector('input[name="code"]').value = 'ABCD-1234';
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(calls.at(-1), ['completeOAuthProviderLogin', ['f1', 'ABCD-1234']]);

  await act(async () => button(document.querySelector('.settings-oauth-dialog'), 'Cancel').click());
  assert.deepEqual(calls.at(-1), ['cancelOAuthProviderLogin', ['f1']]);
  assert.equal(document.querySelector('.settings-oauth-dialog'), null);
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);
  assert.equal(checkAgain().disabled, false);
});

test('a signed-in agent is the provider account card: one account in use under its plan, its usage, and no rename', async (t) => {
  const { publishUsageDashboard } = await import('../usage-dashboard-store.ts');
  const resetAt = Date.now() + 3_600_000;
  publishUsageDashboard({
    rows: [
      {
        id: 'acp-antigravity',
        label: 'Antigravity ACP',
        status: 'connected',
        updatedAt: Date.now(),
        windows: [
          { label: 'Pro', usedPct: 40, resetAt },
          { label: 'Flash', usedPct: 5, resetAt },
        ],
      },
    ],
  });
  const render = await mount(
    t,
    acpAgents(true, agent('ready', { version: '1.5.15', plan: 'Google AI Ultra', canSignIn: true, canSignOut: true }))
  );
  await open();
  // The agent names no one: the plan it reports stands where a provider's row says who the account is.
  assert.deepEqual(card(agentRow()), {
    title: 'Antigravity',
    account: 'Google AI Ultra',
    renamed: false,
    marks: ['In use'],
    usage: [
      ['PRO', '40%'],
      ['FLASH', '5%'],
    ],
    actions: ['Disconnect'],
  });
  assert.equal(agentRow().querySelectorAll('.provider-accounts-list > li').length, 1);

  // An agent that reports no plan and offers no sign-out: the account is still listed, with nothing to disconnect.
  await render(acpAgents(true, agent('ready', { version: '1.5.15' })));
  assert.deepEqual(card(agentRow()).actions, []);
  assert.equal(card(agentRow()).account, 'Account 1');
  assert.equal(agentRow().querySelector('button[aria-label="Sign in with another account"]'), null);
});

test('Disconnect asks first, then has the core sign the agent out; the row follows the state it reports', async (t) => {
  const calls = [];
  const asked = [];
  const render = await mount(
    t,
    acpAgents(true, agent('ready', { version: '1.5.15', plan: 'Google AI Ultra', canSignIn: true, canSignOut: true })),
    {
      run: async (capability, args) => {
        calls.push([capability, args]);
        return true;
      },
      confirm: (options) => asked.push(options),
    }
  );
  await open();
  await act(async () => button(agentRow(), 'Disconnect').click());
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
  // The settings window's own confirmation, as the user sees it.
  const shown = document.createElement('div');
  document.body.append(shown);
  const confirmation = createRoot(shown);
  t.after(async () => {
    await act(async () => confirmation.unmount());
    shown.remove();
  });
  await act(async () =>
    confirmation.render(
      React.createElement(SettingsConfirmDialog, {
        options: asked[0],
        onClose() {},
      })
    )
  );
  const dialogShown = shown.querySelector('[role="alertdialog"]');
  assert.equal(dialogShown.querySelector('h3').textContent, 'Disconnect account?');
  // What else the sign-out does: the agent's running sessions end, and the CLI outside Mixdog shares the sign-in.
  assert.equal(
    dialogShown.querySelector('p').textContent,
    'Every Antigravity session running in Mixdog ends now. The agy command outside Mixdog uses the same sign-in, so it is signed out too.'
  );
  await act(async () => button(dialogShown, 'Disconnect').click());
  assert.deepEqual(calls, [['forgetProviderAuth', ['acp-antigravity']]]);

  await render(acpAgents(true, agent('signedOut', { version: '1.5.15', canSignIn: true })));
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);
  assert.ok(button(agentRow(), 'Sign in'));
});

test('the + of a signed-in agent runs its sign-in again, which replaces the one account it keeps', async (t) => {
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return capability === 'beginOAuthProviderLogin'
      ? { flowId: 'f1', provider: 'acp-antigravity', url: null, state: 'pending', manualCodeSupported: true }
      : {};
  };
  await mount(t, acpAgents(true, agent('ready', { version: '1.5.15', canSignIn: true })), { run });
  await open();
  const add = () => agentRow().querySelector('button[aria-label="Sign in with another account"]');
  assert.match(add().getAttribute('title'), /replaces this one/);
  await act(async () => add().click());
  assert.deepEqual(calls.at(-1), ['beginOAuthProviderLogin', ['acp-antigravity']]);
  assert.equal(agentRow().getAttribute('data-acp-state'), 'signingIn');
  assert.equal(add().disabled, true);
  assert.ok(document.querySelector('.settings-oauth-dialog'));
});
