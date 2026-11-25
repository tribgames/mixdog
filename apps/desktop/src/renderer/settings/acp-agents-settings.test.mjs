import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom, toolModulesSource } from '../test-support/test-dom.mjs';

const modules = toolModulesSource();

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'FormData', 'history'],
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

const { AcpProviders } = await import('./acp-agents.tsx');
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
  const read = (capability) => {
    if (capability === 'getTidyEngineStatus') {
      return { ok: true, value: { toolsDir: '/tools', core: [], engines: [], installing: null } };
    }
    return { ok: true, value: capability === 'getToolModuleSettings' ? toolModules : null };
  };
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
  const render = (next) => act(async () => root.render(React.createElement(AcpProviders, context(next, handlers))));
  await render(value);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return render;
}

/** The Antigravity ACP section among the providers. */
const dialog = () => document.querySelector('[data-acp-agents]');
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
const signedIn = {
  title: 'Antigravity ACP',
  account: 'Account 1',
  renamed: false,
  marks: ['In use'],
  usage: [],
  actions: [],
};
const fault = (row) =>
  row.querySelector('.extensions-item-fault')?.textContent ??
  row.querySelector('.error-notice-copy span')?.textContent ??
  '';
const button = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent === text);
const checkAgain = () => dialog().querySelector('button[aria-label="Check again"]');

test('Antigravity ACP is among the providers with the core report, and has no switch', async (t) => {
  const render = await mount(t, acpAgents(true, agent('checking')));
  assert.equal(dialog().querySelector('h3').textContent, 'Antigravity ACP');
  assert.equal(dialog().querySelector('input[type="checkbox"]'), null);
  assert.deepEqual(words(agentRow()), ['Checking…', 'Looking for agy…']);

  // Signed in, the agent is the provider account card.
  await render(acpAgents(true, agent('ready', { version: '1.5.15', models: [{ id: 'g', name: 'Gemini' }] })));
  assert.deepEqual(card(agentRow()), signedIn);

  // Off only where the core reports it so (the environment's override, or a host with none): no section.
  await render(acpAgents(false, agent('off')));
  assert.equal(dialog(), null);
});

test('every agent state the core can report reads truthfully and leaves a next step', async (t) => {
  const reported = [
    ['checking', {}, ['Checking…', 'Looking for agy…'], 'muted'],
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
    // Agents of no shared service: each is its own row.
    acpAgents(
      true,
      ...reported.map(([state, extra], index) => agent(state, { ...extra, id: `a${index}`, provider: `acp-a${index}` }))
    )
  );
  reported.forEach(([state, extra, expected, tone], index) => {
    const row = agentRow(`a${index}`);
    assert.deepEqual(words(row), expected, `${state} ${extra.id ?? ''}`);
    assert.equal(row.getAttribute('data-tone'), tone, state);
    // Short of a check under way, the row itself holds the next step (held while the other agents' check runs).
    if (tone !== 'muted') assert.ok(row.querySelector('button'), `${state} ${extra.id ?? ''}`);
  });
  // Nothing is connected: the section's refresh waits for an account, as on a provider's card.
  assert.equal(checkAgain(), null);
  // A failed update beside an agent that still works: it stays Ready and says what failed.
  await render(
    acpAgents(
      true,
      agent('ready', { version: '1.5.15', lastError: { action: 'update', message: 'npm exited with 1' } })
    )
  );
  assert.deepEqual(card(agentRow()), signedIn);
  assert.equal(fault(agentRow()), 'Update failed: npm exited with 1');
  // A state not understood is never a check in progress: its row's Check again stays available.
  await render(acpAgents(true, agent('paused')));
  assert.equal(button(agentRow(), 'Check again').disabled, false);
  // On, with no agent reported: the section says so, and Check again is the way on.
  await render(acpAgents(true));
  assert.match(dialog().textContent, /No agents were reported/);
  assert.equal(checkAgain().disabled, false);
});

test('Check again asks the core to look again while the agents stay on', async (t) => {
  const calls = [];
  const render = await mount(t, acpAgents(true, agent('signedOut', { version: '1.5.15' })), {
    run: async (capability, args) => {
      calls.push([capability, args]);
      return { acpAgents: acpAgents(true, agent('checking', { version: '1.5.15' })) };
    },
  });
  // Signed out with no sign-in of its own, the row looks again.
  await act(async () => button(agentRow(), 'Check again').click());
  await render(acpAgents(true, agent('checking', { version: '1.5.15' })));
  assert.deepEqual(calls, [['setBuiltinToolEnabled', ['acpAgents', true]]]);
  assert.deepEqual(words(agentRow()), ['Checking…', 'Looking for agy…']);
  assert.equal(agentRow().querySelector('button'), null);

  // Connected, the section's refresh looks again.
  await render(acpAgents(true, agent('ready', { version: '1.5.15' })));
  assert.deepEqual(card(agentRow()), signedIn);
  await act(async () => checkAgain().click());
  assert.deepEqual(calls, [
    ['setBuiltinToolEnabled', ['acpAgents', true]],
    ['setBuiltinToolEnabled', ['acpAgents', true]],
  ]);
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
  assert.deepEqual(words(agentRow()), ['Not found', 'Antigravity is not installed.']);
  await act(async () => button(agentRow(), 'Install').click());
  assert.deepEqual(installs, [{ capability: 'installBuiltinFeature', args: ['acpAgents'] }]);
  assert.equal(button(agentRow(), 'Install').disabled, true);
  // The core's progress is the agent's state.
  await render(acpAgents(true, agent('installing', { canInstall: true })));
  assert.deepEqual(words(agentRow()), ['Installing…', 'Downloading and installing Antigravity.']);
  assert.ok(agentRow().querySelector('[role="progressbar"]'));

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

  // A failure no agent says shows under the section, and goes with the agents it was about when they are switched off.
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

// The two shipped presets (mixdog-acp preset.rs `builtin`), both labelled "Antigravity": Google's ACP server for
// Gemini, whose sign-in opens the browser itself, and the agy CLI for the rest, whose sign-in is agy's own.
const official = (state, extra = {}) =>
  agent(state, { minimumVersion: '1.5.2', loginOpensBrowser: true, sharesExternalSignIn: false, ...extra });
const cli = (state, extra = {}) => agent(state, { id: 'antigravity-cli', provider: 'acp-antigravity-cli', ...extra });
const agentRows = () => dialog().querySelectorAll('[data-acp-agent]');

test("Antigravity's two presets are one row: its state combines both, and one Install installs both", async (t) => {
  const installs = [];
  const render = await mount(
    t,
    acpAgents(true, official('ready', { version: '1.5.2' }), cli('notInstalled', { canInstall: true })),
    {
      invoke: (request) => {
        installs.push(request.args);
        return { value: null };
      },
    }
  );
  assert.equal(agentRows().length, 1);
  // Short of ready while either preset needs an install.
  assert.deepEqual(words(agentRow()), ['Not found', 'Antigravity is not installed.']);
  await act(async () => button(agentRow(), 'Install').click());
  assert.deepEqual(installs, [['acpAgents']]);

  await render(
    acpAgents(true, official('ready', { version: '1.5.2' }), cli('signedOut', { version: '1.5.16', canSignIn: true }))
  );
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);

  // Ready when both are: one account card.
  await render(acpAgents(true, official('ready', { version: '1.5.2' }), cli('ready', { version: '1.5.16' })));
  assert.equal(agentRows().length, 1);
  assert.deepEqual(card(agentRow()), signedIn);
});

test('an official server that does not run on this computer leaves Antigravity usable and says Gemini is not available', async (t) => {
  const note = () => dialog().querySelector('.extensions-note')?.textContent ?? '';
  const render = await mount(
    t,
    acpAgents(true, official('unsupported', { canInstall: true }), cli('ready', { version: '1.5.16' }))
  );
  assert.equal(agentRows().length, 1);
  assert.deepEqual(card(agentRow()), signedIn);
  assert.equal(note(), 'Gemini is not available on this computer.');

  await render(
    acpAgents(true, official('unsupported', { canInstall: true }), cli('notInstalled', { canInstall: true }))
  );
  assert.deepEqual(words(agentRow()), ['Not found', 'Antigravity is not installed.']);
  assert.ok(button(agentRow(), 'Install'));
  assert.equal(note(), 'Gemini is not available on this computer.');

  // With nothing else to run, the agent itself does not run here, and nothing installs.
  await render(acpAgents(true, official('unsupported', { canInstall: true })));
  assert.deepEqual(words(agentRow()), ['Not supported', 'Antigravity does not run on this computer.']);
  assert.equal(agentRow().querySelector('button'), null);
  assert.equal(note(), '');
});

/** The core's sign-in flows as the window starts them: each `beginOAuthProviderLogin` opens the next numbered flow. */
function signInCore() {
  const calls = [];
  let flow = 0;
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return capability === 'beginOAuthProviderLogin'
      ? { flowId: `fs${++flow}`, provider: args[0], url: null, state: 'pending' }
      : {};
  };
  return { calls, run, begun: () => calls.filter(([capability]) => capability === 'beginOAuthProviderLogin') };
}
const signInDialog = () => document.querySelector('.settings-oauth-dialog');
/** The dialog's step as the user reads it: its counter (none for a single step) and what it signs in to. */
const signInStep = () => {
  const step = signInDialog().querySelector('[data-oauth-step]');
  return step && [step.querySelector('small')?.textContent ?? null, step.querySelector('b').textContent];
};
const waitLine = () => signInDialog().querySelector('.settings-oauth-wait').textContent;
const consentPage = 'https://accounts.google.com/o/oauth2/auth?client=acp';
const cliPage = 'https://antigravity.example/cli-login';

test('one Sign in walks the signed-out presets as numbered steps of one dialog, Gemini first, and closes after the last', async (t) => {
  const core = signInCore();
  await mount(t, acpAgents(true, official('signedOut', { canSignIn: true }), cli('signedOut', { canSignIn: true })), {
    run: core.run,
  });
  const before = opened.length;
  await act(async () => button(agentRow(), 'Connect').click());
  assert.deepEqual(core.begun(), [['beginOAuthProviderLogin', ['acp-antigravity']]]);
  assert.deepEqual(signInStep(), ['Step 1 of 2', 'Google sign-in for Gemini models']);
  // The core opened the browser for the official server: the dialog shows its link, and the window opens no tab.
  await act(async () => pushLogin('fs1', { flowId: 'fs1', state: 'pending', url: consentPage }));
  assert.equal(opened.length, before);
  assert.equal(signInDialog().querySelector('.settings-oauth-host').textContent, 'accounts.google.com');
  for (const action of ['Open again', 'Copy link']) assert.ok(signInDialog().querySelector(`[aria-label="${action}"]`));

  // That step done, the same dialog moves on to the CLI's, whose page the window opens.
  const dialogShown = signInDialog();
  await act(async () => pushLogin('fs1', { flowId: 'fs1', state: 'complete' }));
  await act(async () => undefined);
  assert.equal(signInDialog(), dialogShown);
  assert.deepEqual(core.begun().at(-1), ['beginOAuthProviderLogin', ['acp-antigravity-cli']]);
  assert.deepEqual(signInStep(), ['Step 2 of 2', 'Google sign-in for Claude models']);
  await act(async () => pushLogin('fs2', { flowId: 'fs2', state: 'pending', url: cliPage }));
  assert.deepEqual(opened.slice(before), [cliPage]);

  // The last step done, the dialog closes by itself and cancels nothing.
  await act(async () => pushLogin('fs2', { flowId: 'fs2', state: 'complete' }));
  await act(async () => undefined);
  assert.equal(signInDialog(), null);
  assert.equal(core.begun().length, 2);
  assert.ok(core.calls.every(([capability]) => capability !== 'cancelOAuthProviderLogin'));
});

test('an install that ends well opens the sign-in it leaves to do; one that leaves the agent ready opens none', async (t) => {
  const core = signInCore();
  let answer = Promise.withResolvers();
  const render = await mount(t, acpAgents(true, official('notInstalled', { canInstall: true })), {
    run: core.run,
    invoke: () => answer.promise,
  });
  await act(async () => button(agentRow(), 'Install').click());
  await render(acpAgents(true, official('installing', { canInstall: true })));
  await act(async () => answer.resolve({ value: null }));
  // The core is still looking at what it installed: nothing opens yet.
  await render(acpAgents(true, official('checking', { canInstall: true })));
  assert.equal(signInDialog(), null);
  await render(acpAgents(true, official('signedOut', { canInstall: true, canSignIn: true })));
  assert.deepEqual(core.begun(), [['beginOAuthProviderLogin', ['acp-antigravity']]]);
  assert.ok(signInDialog());
  await act(async () => button(signInDialog(), 'Cancel').click());
  // The sign-in opens once per install: the row signed out again opens nothing by itself.
  await render(acpAgents(true, official('signedOut', { version: '1.5.2', canInstall: true, canSignIn: true })));
  assert.equal(core.begun().length, 1);

  answer = Promise.withResolvers();
  await render(acpAgents(true, official('versionTooOld', { canInstall: true, version: '1.5.1' })));
  await act(async () => button(agentRow(), 'Update').click());
  await act(async () => answer.resolve({ value: null }));
  await render(acpAgents(true, official('ready', { version: '1.5.2', canInstall: true, canSignIn: true })));
  assert.equal(signInDialog(), null);
  assert.equal(core.begun().length, 1);

  // Switched off before the core settled on what it installed, the agents leave no sign-in for the next time on.
  answer = Promise.withResolvers();
  await render(acpAgents(true, official('notInstalled', { canInstall: true })));
  await act(async () => button(agentRow(), 'Install').click());
  await render(acpAgents(true, official('installing', { canInstall: true })));
  await act(async () => answer.resolve({ value: null }));
  await render(acpAgents(true, official('checking', { canInstall: true })));
  await render(acpAgents(false, official('off')));
  await render(acpAgents(true, official('signedOut', { canInstall: true, canSignIn: true })));
  assert.equal(signInDialog(), null);
  assert.equal(core.begun().length, 1);
});

test('a preset already signed in is skipped: the missing sign-in is one step with no counter', async (t) => {
  const core = signInCore();
  const render = await mount(
    t,
    acpAgents(true, official('ready', { version: '1.5.2' }), cli('signedOut', { canSignIn: true })),
    {
      run: core.run,
    }
  );
  await act(async () => button(agentRow(), 'Connect').click());
  assert.deepEqual(core.begun(), [['beginOAuthProviderLogin', ['acp-antigravity-cli']]]);
  assert.deepEqual(signInStep(), [null, 'Google sign-in for Claude models']);
  await act(async () => button(signInDialog(), 'Cancel').click());

  // The official server's step alone; a window on another machine opens its page, the core's browser being the host's.
  await render(acpAgents(true, official('signedOut', { canSignIn: true }), cli('ready', { version: '1.5.16' })));
  window.mixdogRemoteServer = 'wss://host.example';
  t.after(() => delete window.mixdogRemoteServer);
  const before = opened.length;
  await act(async () => button(agentRow(), 'Connect').click());
  assert.deepEqual(core.begun().at(-1), ['beginOAuthProviderLogin', ['acp-antigravity']]);
  assert.deepEqual(signInStep(), [null, 'Google sign-in for Gemini models']);
  await act(async () => pushLogin('fs2', { flowId: 'fs2', state: 'pending', url: consentPage }));
  assert.deepEqual(opened.slice(before), [consentPage]);
  await act(async () => button(signInDialog(), 'Cancel').click());
});

test('the row offers only what the presets in its own state can do', async (t) => {
  const core = signInCore();
  const render = await mount(
    t,
    acpAgents(true, official('signedOut', { version: '1.5.2' }), cli('ready', { version: '1.5.16', canSignIn: true })),
    { run: core.run }
  );
  // The signed-out preset cannot sign in here: no Sign in that would sign the other one in again.
  assert.deepEqual(words(agentRow()), ['Signed out', 'Run agy in a terminal to sign in, then check again.']);
  assert.equal(button(agentRow(), 'Connect'), undefined);
  assert.deepEqual(core.begun(), []);

  // A preset that does not run here lends its sibling no Install and no failure.
  await render(
    acpAgents(
      true,
      official('unsupported', { canInstall: true, lastError: { action: 'install', message: 'Download failed: 503' } }),
      cli('notInstalled')
    )
  );
  assert.equal(button(agentRow(), 'Install'), undefined);
  assert.equal(fault(agentRow()), '');

  // Nor does a usable preset in another state: its failure stays with its own row state.
  await render(
    acpAgents(
      true,
      official('updating', { canInstall: true, version: '1.5.1' }),
      cli('notInstalled', { canInstall: true, lastError: { action: 'install', message: 'Download failed: 503' } })
    )
  );
  assert.deepEqual(words(agentRow()), ['Updating…', 'Updating Antigravity to the newest version.']);
  assert.equal(fault(agentRow()), '');
  await render(
    acpAgents(
      true,
      official('versionTooOld', { canInstall: true, version: '1.5.1' }),
      cli('ready', { version: '1.5.16', lastError: { action: 'update', message: '429' } })
    )
  );
  assert.equal(fault(agentRow()), '');
  assert.ok(button(agentRow(), 'Update'));
  assert.equal(button(agentRow(), 'Retry'), undefined);
});

test('Back on a phone closes a sign-in of steps, the step under way included', async (t) => {
  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '1');
  t.after(() => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'));
  const core = signInCore();
  await mount(t, acpAgents(true, official('signedOut', { canSignIn: true }), cli('signedOut', { canSignIn: true })), {
    run: core.run,
  });
  await act(async () => button(agentRow(), 'Connect').click());
  await act(async () => pushLogin('fs1', { flowId: 'fs1', state: 'complete' }));
  await act(async () => undefined);
  assert.deepEqual(signInStep(), ['Step 2 of 2', 'Google sign-in for Claude models']);
  await act(async () => window.dispatchEvent(new window.Event('popstate')));
  assert.equal(signInDialog(), null);
  assert.deepEqual(core.calls.slice(-1), [['cancelOAuthProviderLogin', ['fs2']]]);
  assert.equal(core.begun().length, 2);
});

test('cancelling or a failed step ends the sign-in at that step, the steps before it staying signed in', async (t) => {
  const core = signInCore();
  await mount(t, acpAgents(true, official('signedOut', { canSignIn: true }), cli('signedOut', { canSignIn: true })), {
    run: core.run,
  });
  await act(async () => button(agentRow(), 'Connect').click());
  await act(async () => pushLogin('fs1', { flowId: 'fs1', state: 'complete' }));
  await act(async () => undefined);
  assert.deepEqual(signInStep(), ['Step 2 of 2', 'Google sign-in for Claude models']);
  await act(async () => button(signInDialog(), 'Cancel').click());
  // Only the open step's flow is cancelled; nothing signs the completed one out, and no step follows.
  assert.deepEqual(core.calls.slice(-1), [['cancelOAuthProviderLogin', ['fs2']]]);
  assert.equal(signInDialog(), null);
  assert.equal(core.begun().length, 2);
  assert.ok(core.calls.every(([capability]) => capability !== 'forgetProviderAuth'));

  // A step that fails stays on show, at its step, until closed; the next step does not start.
  await act(async () => button(agentRow(), 'Connect').click());
  await act(async () => pushLogin('fs3', { flowId: 'fs3', state: 'failed', error: 'consent was denied' }));
  await act(async () => undefined);
  assert.deepEqual(signInStep(), ['Step 1 of 2', 'Google sign-in for Gemini models']);
  assert.equal(waitLine(), 'Failed');
  assert.equal(core.begun().length, 3);
  await act(async () => button(signInDialog(), 'Close').click());
  assert.equal(signInDialog(), null);
  assert.equal(core.begun().length, 3);
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
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);
  await act(async () => button(agentRow(), 'Connect').click());
  assert.deepEqual(calls.at(-1), ['beginOAuthProviderLogin', ['acp-antigravity']]);
  assert.deepEqual(words(agentRow()), ['Signing in…', 'Finish signing in in your browser.']);
  // No look again (which updates the CLI) while the CLI's own sign-in runs; the dialog names no OAuth.
  assert.equal(agentRow().querySelector('button'), null);
  const signIn = document.querySelector('.settings-oauth-dialog');
  assert.doesNotMatch(
    [...signIn.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).join(' '),
    /OAuth/
  );
  // The page arrives on the flow's feed; the window opens it once.
  const page = 'https://accounts.example/sign-in?code=1';
  const before = opened.length;
  await act(async () => pushLogin('f1', { flowId: 'f1', state: 'pending', url: page, manualCodeSupported: true }));
  assert.deepEqual(opened.slice(before), [page]);

  const form = document.querySelector('.settings-oauth-code');
  form.querySelector('input[name="code"]').value = 'ABCD-1234';
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(calls.at(-1), ['completeOAuthProviderLogin', ['f1', 'ABCD-1234']]);

  await act(async () => button(document.querySelector('.settings-oauth-dialog'), 'Cancel').click());
  assert.deepEqual(calls.at(-1), ['cancelOAuthProviderLogin', ['f1']]);
  assert.equal(document.querySelector('.settings-oauth-dialog'), null);
  assert.deepEqual(words(agentRow()), ['Signed out', 'Sign in to use Antigravity here.']);
  assert.equal(button(agentRow(), 'Connect').disabled, false);
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
  // The agent names no one: the plan it reports stands where a provider's row says who the account is.
  assert.deepEqual(card(agentRow()), {
    title: 'Antigravity ACP',
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
  assert.ok(button(agentRow(), 'Connect'));

  // One Disconnect signs both presets out; the CLI's sign-in is agy's own, so it warns of agy outside Mixdog.
  calls.length = 0;
  await render(
    acpAgents(
      true,
      official('ready', { version: '1.5.2', canSignOut: true }),
      cli('ready', { version: '1.5.16', canSignOut: true })
    )
  );
  await act(async () => button(agentRow(), 'Disconnect').click());
  assert.equal(
    asked[1].description,
    'Every Antigravity session running in Mixdog ends now. The agy command outside Mixdog uses the same sign-in, so it is signed out too.'
  );
  await act(async () => asked[1].onConfirm());
  assert.deepEqual(calls, [
    ['forgetProviderAuth', ['acp-antigravity']],
    ['forgetProviderAuth', ['acp-antigravity-cli']],
  ]);
  // With only the official server to sign out, whose sign-in is Mixdog's own, it warns of the sessions alone.
  await render(acpAgents(true, official('ready', { version: '1.5.2', canSignOut: true }), cli('ready')));
  await act(async () => button(agentRow(), 'Disconnect').click());
  assert.equal(asked[2].description, 'Every Antigravity session running in Mixdog ends now.');
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
  const add = () => agentRow().querySelector('button[aria-label="Sign in with another account"]');
  assert.match(add().getAttribute('title'), /replaces this one/);
  await act(async () => add().click());
  assert.deepEqual(calls.at(-1), ['beginOAuthProviderLogin', ['acp-antigravity']]);
  assert.equal(agentRow().getAttribute('data-acp-state'), 'signingIn');
  assert.equal(add().disabled, true);
  assert.ok(document.querySelector('.settings-oauth-dialog'));
});

test("the agent's card shows its reading also when a provider's row lists the same quota", async (t) => {
  const { publishUsageDashboard } = await import('../usage-dashboard-store.ts');
  publishUsageDashboard({
    rows: [
      { id: 'antigravity-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 20 }] },
      {
        id: 'acp-antigravity',
        label: 'Antigravity ACP',
        status: 'partial',
        sameQuotaAs: 'antigravity-oauth',
        updatedAt: Date.now(),
        windows: [{ label: '7D', usedPct: 20 }],
      },
    ],
  });
  await mount(t, acpAgents(true, agent('ready', { version: '1.5.15' })));
  assert.deepEqual(card(agentRow()).usage, [['7D', '20%']]);
});

test('a reading the core withdrew is no longer painted, and a sign-in from the card reads usage again', async (t) => {
  const { publishUsageDashboard } = await import('../usage-dashboard-store.ts');
  const reading = (usedPct) => ({
    id: 'acp-antigravity',
    label: 'Antigravity ACP',
    status: 'partial',
    updatedAt: Date.now(),
    windows: [{ label: 'Pro', usedPct }],
  });
  publishUsageDashboard({ rows: [reading(40)] });
  const run = async (capability) =>
    capability === 'beginOAuthProviderLogin'
      ? { flowId: 'f-usage', provider: 'acp-antigravity', url: null, state: 'pending' }
      : {};
  await mount(t, acpAgents(true, agent('ready', { version: '1.5.15', canSignIn: true })), { run });
  assert.deepEqual(card(agentRow()).usage, [['PRO', '40%']]);

  // Signed out, or another account signed in: the core's dashboard holds no reading of the agent any more.
  await act(async () => publishUsageDashboard({ rows: [{ id: 'openai-oauth', authenticated: true }] }));
  assert.deepEqual(card(agentRow()).usage, []);

  const reads = [];
  window.mixdogDesktop.readCapabilities = async (requests) => {
    reads.push(...requests);
    return requests.map(() => ({ ok: true, value: { rows: [reading(7)] } }));
  };
  t.after(() => delete window.mixdogDesktop.readCapabilities);
  await act(async () => agentRow().querySelector('button[aria-label="Sign in with another account"]').click());
  await act(async () => pushLogin('f-usage', { flowId: 'f-usage', state: 'complete' }));
  assert.deepEqual(reads, [
    {
      capability: 'getUsageDashboard',
      args: [{ refresh: true, refreshSetup: false, refreshProviders: ['acp-antigravity'] }],
    },
  ]);
  assert.deepEqual(card(agentRow()).usage, [['PRO', '7%']]);
});
