// Extensions → 커넥터: every item kind lands in one group, a paste is
// detected without running anything, the one-click OAuth row walks its
// states, 연결 해제 is not uninstall, the server id is immutable, and no skill
// is listed anywhere on the two tabs.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/** Scripted host: `handlers[capability](...args)` answers each call. */
const calls = [];
let handlers = {};
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  openExternal: async () => {},
  async invokeCapability({ capability, args }) {
    calls.push([capability, args]);
    const handler = handlers[capability];
    if (!handler) throw new Error(`unexpected ${capability}`);
    return { value: await handler(...(args || [])) };
  },
};

const { groupConnectors, detectConnectorSource, uniqueServerName, isConnectorPlugin, connectorRowView } = await import(
  '../connectors-model.ts'
);
const { connectCatalogConnector, connectorLoginState, cancelConnectorLogin, startConnectorLogin } = await import(
  '../connector-connect.ts'
);
const { connectorById } = await import('../../../../../src/runtime/shared/connector-catalog.mjs');
const { CategoryPanel } = await import('./capability-panels.tsx');
const { ConnectorStep } = await import('../connector-step.tsx');
const { McpEditorDialog, mcpErrorSummary } = await import('./mcp-editor-dialog.tsx');

const SKILL = 'secret-skill-name';
const servers = [
  { name: 'notion-2', connector: 'notion', enabled: true, connected: true, status: 'connected', source: 'config' },
  // A custom Notion server the user made: never adopted into the catalog row.
  { name: 'notion', enabled: true, connected: false, authRequired: true, status: 'sign-in required', source: 'config' },
  { name: 'unitymcp', enabled: true, connected: true, status: 'connected', source: 'config' },
  { name: 'broken', enabled: true, connected: false, error: 'spawn ENOENT', status: 'failed', source: 'config' },
  { name: 'off', enabled: false, connected: false, status: 'disabled', source: 'config' },
  {
    name: 'docs-search',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'plugin',
    owner: { kind: 'plugin', id: 'docs-pack', key: 'search' },
    tools: [{ name: 'search', annotations: { readOnlyHint: true } }, { name: 'write' }],
  },
];
const plugins = [
  {
    id: 'docs-pack',
    name: 'docs-pack',
    title: 'Docs pack',
    enabled: true,
    managed: true,
    hooks: true,
    root: 'C:/data/plugins/docs-pack',
    mcpServers: [{ name: 'docs-search' }],
  },
  { id: 'skills-only', name: 'skills-only', title: 'Skills only', enabled: true, skillCount: 3, mcpServers: [] },
  { id: 'hooks-only', name: 'hooks-only', title: 'Hooks only', enabled: true, hooks: true, mcpServers: [] },
  {
    id: 'broken-mcp',
    name: 'broken-mcp',
    title: 'Broken MCP',
    enabled: true,
    mcpServers: [],
    mcpErrors: [{ message: 'bad' }],
  },
];

test('every item kind lands in exactly one group', () => {
  const groups = groupConnectors(servers, plugins);
  assert.equal(groups.catalog.length, 16, 'Google Calendar and Drive are listed without a server');
  const names = groups.catalog.map((row) => row.entry.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
  );
  assert.equal(groups.catalog.find((row) => row.entry.id === 'notion').server.name, 'notion-2');
  assert.equal(
    groups.catalog.some((row) => row.entry.id === 'github'),
    false,
    'GitHub is the GitHub CLI, not a connector'
  );
  assert.deepEqual(
    groups.custom.map((server) => server.name),
    ['broken', 'notion', 'off', 'unitymcp'],
    'raw servers, disabled and broken ones included'
  );
  assert.deepEqual(
    groups.packages.map((entry) => [entry.plugin.id, entry.servers.map((server) => server.name)]),
    [
      ['broken-mcp', []],
      ['docs-pack', ['docs-search']],
    ]
  );
  assert.equal(isConnectorPlugin(plugins[1]), false);
  assert.equal(isConnectorPlugin(plugins[2]), false);
});

test('a pasted address or command is detected, never run', () => {
  assert.deepEqual(detectConnectorSource('https://mcp.example.com/sse'), {
    kind: 'mcp-url',
    alternatives: [],
    name: 'example',
    url: 'https://mcp.example.com/sse',
  });
  const npx = detectConnectorSource('npx -y "@example/unity-mcp@1.2" --port 3');
  assert.equal(npx.kind, 'mcp-command');
  assert.equal(npx.command, 'npx');
  assert.deepEqual(npx.args, ['-y', '@example/unity-mcp@1.2', '--port', '3']);
  assert.equal(npx.name, 'unity-mcp');
  assert.equal(detectConnectorSource('https://github.com/org/plugin').kind, 'plugin');
  assert.equal(detectConnectorSource('org/plugin').kind, 'plugin');
  assert.equal(detectConnectorSource('git@github.com:org/plugin.git').kind, 'plugin');
  const ambiguous = detectConnectorSource('https://tools.example.com/connect');
  assert.equal(ambiguous.kind, 'mcp-url');
  assert.deepEqual(ambiguous.alternatives, ['plugin']);
  assert.deepEqual(detectConnectorSource('C:\\tools\\server.exe').alternatives, ['mcp-command']);
  assert.equal(detectConnectorSource('notion'), null);
  assert.equal(detectConnectorSource('  '), null);
  assert.equal(uniqueServerName('Notion', ['notion', 'notion-2']), 'notion-3');
});

function panelContext(overrides = {}) {
  return {
    api: {},
    data: {
      mcp: { servers },
      plugins: { plugins },
      skills: { skills: [{ name: SKILL, owner: { kind: 'plugin', id: 'skills-only' } }] },
      disabledSkills: { disabled: [] },
      toolModules: {},
      __loadedSections: ['mcp', 'plugins', 'skills', 'toolModules'],
    },
    snapshot: null,
    pending: '',
    async run(capability, args) {
      calls.push([`run:${capability}`, args]);
      return {};
    },
    async refreshExtensions() {},
    async route() {},
    async setFast() {},
    confirm() {},
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
    ...overrides,
  };
}

async function render(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const button = (scope, label) =>
  [...scope.querySelectorAll('button')].find(
    (node) => node.textContent.trim() === label || node.getAttribute('aria-label') === label
  );

async function click(node) {
  assert.ok(node, 'button exists');
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

test('the two tabs list connectors and packages, never skills', async () => {
  handlers = { mcpStatus: () => ({ servers }) };
  const connectors = await render(
    React.createElement(CategoryPanel, { category: 'connectors', context: panelContext() })
  );
  const text = connectors.host.textContent;
  assert.ok(text.includes('Custom connectors'));
  assert.ok(text.includes('Add custom connector'));
  const notion = connectors.host.querySelector('[data-connector-row="notion"] .sidebar-resource-tag');
  assert.equal(notion?.textContent, 'Connected');
  assert.equal(notion?.dataset.tone, 'ok');
  assert.ok(
    connectors.host.querySelector('[data-connector-row="airtable"] .extensions-action'),
    'unconnected rows offer 연결'
  );
  assert.ok(connectors.host.querySelector('[data-connector-package="docs-pack"]'));
  assert.match(connectors.host.querySelector('[data-connector-row="broken"]').textContent, /Failed/);
  assert.match(connectors.host.querySelector('[data-connector-row="off"]').textContent, /Disabled/);
  assert.ok(!text.includes(SKILL));
  await connectors.unmount();

  const extensions = await render(React.createElement(CategoryPanel, { category: 'plugins', context: panelContext() }));
  const listed = [...extensions.host.querySelectorAll('[data-extension-row]')].map((row) => row.dataset.extensionRow);
  assert.ok(listed.includes('Skills only') && listed.includes('Hooks only'));
  assert.ok(!listed.includes('Docs pack') && !listed.includes('Broken MCP'), 'MCP plugins are connectors');
  assert.ok(!extensions.host.textContent.includes(SKILL));
  await extensions.unmount();
});

test('the catalog OAuth row goes 연결 → browser sign-in → 연결됨, and a retry keeps the id', async () => {
  let live = servers.filter((server) => server.name === 'notion');
  let flowState = 'pending';
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: live }),
    addMcpServer: (input) => {
      live = [...live, { name: input.name, connector: input.connector, enabled: true, authRequired: true }];
      return { name: input.name };
    },
    beginMcpOAuthLogin: () => ({ flowId: 'f1', state: 'pending', url: 'https://mcp.notion.com/authorize' }),
    getMcpOAuthLoginStatus: () => ({
      flowId: 'f1',
      state: flowState,
      error: flowState === 'failed' ? 'denied' : undefined,
    }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  const notion = connectorById('notion');
  await connectCatalogConnector(notion);
  const added = calls.find(([capability]) => capability === 'addMcpServer')[1][0];
  assert.equal(added.name, 'notion-2', 'the custom "notion" server keeps its name');
  assert.equal(added.connector, 'notion');
  assert.equal(connectorLoginState('notion-2').phase, 'browser');

  // The row shows the inline sign-in with 취소.
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  const row = pane.host.querySelector('[data-connector-row="notion"]');
  assert.match(row.textContent, /Sign in in your browser…/);
  assert.equal(row.querySelector('.extensions-action').textContent, 'Cancel');

  // A failed sign-in says so, with its reason, and offers 다시 시도.
  flowState = 'failed';
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(connectorLoginState('notion-2').phase, 'failed');
  await act(async () => {});
  const failed = pane.host.querySelector('[data-connector-row="notion"]');
  assert.match(failed.textContent, /Couldn't connect/);
  assert.equal(failed.querySelector('.extensions-action').textContent, 'Try again');

  // Retry: same id, no second add; connected only once the host says so.
  calls.length = 0;
  flowState = 'complete';
  live = live.map((server) => (server.name === 'notion-2' ? { ...server, connected: true } : server));
  await connectCatalogConnector(notion);
  assert.ok(!calls.some(([capability]) => capability === 'addMcpServer'));
  assert.deepEqual(calls.find(([capability]) => capability === 'beginMcpOAuthLogin')[1], ['notion-2']);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(connectorLoginState('notion-2').phase, 'connected');
  assert.ok(calls.filter(([capability]) => capability === 'mcpStatus').length >= 2, 'the host status confirmed it');
  cancelConnectorLogin('notion-2');
  await pane.unmount();
});

const rowOf = (scope, id) => scope.querySelector(`[data-connector-row="${id}"]`);
const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

test('one row state: a server the host reports connected ends a pending sign-in (never 연결됨 beside 취소)', async () => {
  // The model alone: every combination of the two sources.
  const pending = { phase: 'browser', mode: 'connect' };
  const connected = { name: 'gmail', connected: true };
  assert.deepEqual(
    [connectorRowView(connected, pending).status, connectorRowView(connected, pending).step],
    ['connected', null]
  );
  assert.equal(connectorRowView(connected, pending).finished, true);
  assert.equal(connectorRowView({ name: 'gmail', connected: false }, pending).status, 'pending');
  // A 계정 바꾸기 runs beside the working connection and shows its own step.
  assert.equal(connectorRowView(connected, { phase: 'browser', mode: 'switch' }).status, 'pending');
  assert.equal(connectorRowView({ connected: false }, { phase: 'connected' }).status, 'connected');
  assert.equal(connectorRowView({ connected: true }, { phase: 'failed', error: 'x' }).status, 'connected');
  assert.equal(connectorRowView({ enabled: false }, null).status, 'disabled');
  assert.equal(connectorRowView({ authRequired: true, oauth: { signedIn: true } }, null).status, 'needs-reauth');
  assert.equal(connectorRowView({ authRequired: true, oauth: { signedIn: false } }, null).status, 'needs-connect');

  // The repro: Gmail's sign-in still pending here while the host already
  // reports it connected.
  const gmail = {
    name: 'gmail',
    connector: 'gmail',
    enabled: true,
    connected: false,
    authRequired: true,
    oauth: { signedIn: false },
  };
  handlers = {
    mcpStatus: () => ({ servers: [gmail] }),
    beginMcpOAuthLogin: () => ({
      flowId: 'g1',
      state: 'pending',
      step: 'browser',
      url: 'https://accounts.google.com/x',
    }),
    // The host never answers this flow's status within the test.
    getMcpOAuthLoginStatus: () => new Promise(() => {}),
  };
  await startConnectorLogin('gmail', 'Gmail', { connector: 'gmail' });
  assert.equal(connectorLoginState('gmail').phase, 'browser');
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({
        data: {
          mcp: { servers: [{ ...gmail, connected: true, authRequired: false }] },
          plugins: { plugins: [] },
          __loadedSections: ['mcp'],
        },
      }),
    })
  );
  await settle();
  const row = rowOf(pane.host, 'gmail');
  assert.equal(row.querySelector('.sidebar-resource-tag').textContent, 'Connected');
  assert.doesNotMatch(row.textContent, /Sign in in your browser|Opening the browser|Connecting…|Loading tools/);
  assert.equal(row.querySelector('.connectors-row-step'), null, 'no spinner');
  assert.notEqual(row.querySelector('.extensions-action')?.textContent, 'Cancel');
  assert.equal(connectorLoginState('gmail'), null, 'the pending sign-in is finished, not left running');
  cancelConnectorLogin('gmail');
  await pane.unmount();
});

test('the row follows the host flow step by step and turns 연결됨 in the same update, before the list refresh', async () => {
  const linear = {
    name: 'linear',
    connector: 'linear',
    enabled: true,
    connected: false,
    authRequired: true,
    oauth: { signedIn: false },
  };
  let hostRow = linear;
  // The host's flow: each status read with `since` answers the next step.
  const steps = ['browser', 'connecting', 'tools', 'complete'];
  let release;
  handlers = {
    mcpStatus: () => ({ servers: [hostRow] }),
    beginMcpOAuthLogin: () => ({
      flowId: 'l1',
      state: 'pending',
      step: 'browser',
      url: 'https://mcp.linear.app/authorize',
    }),
    getMcpOAuthLoginStatus: (_flowId, options) =>
      new Promise((resolve) => {
        release = () => {
          const index = options ? steps.indexOf(String(options.since).split(':')[1]) + 1 : 0;
          const step = steps[index];
          resolve(step === 'complete' ? { flowId: 'l1', state: 'complete' } : { flowId: 'l1', state: 'pending', step });
        };
      }),
  };
  let refreshed = 0;
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({
        // The panel's list stays stale (not connected) throughout.
        data: { mcp: { servers: [linear] }, plugins: { plugins: [] }, __loadedSections: ['mcp'] },
        async refreshExtensions() {
          refreshed++;
        },
      }),
    })
  );
  await act(async () => rowOf(pane.host, 'linear').querySelector('.extensions-action').click());
  const seen = [];
  const look = () => {
    const row = rowOf(pane.host, 'linear');
    seen.push(
      `${row.querySelector('small')?.textContent ?? ''}|${row.querySelector('.extensions-action')?.textContent ?? ''}|${row.querySelector('.connectors-row-step') ? 'spin' : ''}`
    );
  };
  look();
  for (let i = 0; i < 4; i++) {
    await settle();
    release();
    if (i === 2) hostRow = { ...linear, connected: true, authRequired: false };
    await settle(10);
    look();
  }
  assert.deepEqual(seen.slice(0, 4), [
    'Sign in in your browser…|Cancel|spin',
    'Sign in in your browser…|Cancel|spin',
    'Connecting…|Cancel|spin',
    'Loading tools…|Cancel|spin',
  ]);
  const done = rowOf(pane.host, 'linear');
  assert.equal(done.querySelector('.sidebar-resource-tag').textContent, 'Connected', 'before the list refresh');
  assert.equal(done.dataset.justConnected, 'true', 'the transition is marked');
  assert.equal(done.querySelector('.extensions-action').textContent, 'Manage');
  assert.equal(done.querySelector('.connectors-row-step'), null);
  assert.ok(refreshed >= 1, 'the panel re-reads its list on the connectors-changed event');
  cancelConnectorLogin('linear');
  await pane.unmount();
});

test('once the list shows the connection, the row follows the host alone (a sign-out right after shows at once)', async () => {
  const notion = {
    name: 'notion',
    connector: 'notion',
    enabled: true,
    connected: false,
    authRequired: true,
    oauth: { signedIn: false },
  };
  handlers = {
    mcpStatus: () => ({ servers: [{ ...notion, connected: true, authRequired: false }] }),
    beginMcpOAuthLogin: () => ({ flowId: 'n1', state: 'complete' }),
  };
  await startConnectorLogin('notion', 'Notion', { connector: 'notion' });
  assert.equal(connectorLoginState('notion').phase, 'connected');
  const listed = (server) =>
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({
        data: { mcp: { servers: [server] }, plugins: { plugins: [] }, __loadedSections: ['mcp'] },
      }),
    });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(listed({ ...notion, connected: true, authRequired: false })));
  await settle();
  assert.equal(connectorLoginState('notion'), null, 'retired once the list caught up');
  assert.equal(rowOf(host, 'notion').dataset.justConnected, 'true', 'the highlight outlives the session');
  // Signed out right after: the list says so and the row follows.
  await act(async () => root.render(listed(notion)));
  assert.equal(rowOf(host, 'notion').querySelector('.extensions-action').textContent, 'Connect');
  assert.notEqual(rowOf(host, 'notion').querySelector('.sidebar-resource-tag')?.textContent, 'Connected');
  await act(async () => root.unmount());
  host.remove();
});

test('a catalog 연결 changes the row on the click itself, before the host made the server', async () => {
  calls.length = 0;
  let addServer;
  handlers = {
    mcpStatus: () => ({ servers: [] }),
    addMcpServer: () =>
      new Promise((resolve) => {
        addServer = resolve;
      }),
  };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: [] }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  await act(async () => rowOf(pane.host, 'sentry').querySelector('.extensions-action').click());
  await settle();
  const row = rowOf(pane.host, 'sentry');
  assert.match(row.textContent, /Opening the browser…/);
  assert.ok(row.querySelector('.connectors-row-step'));
  assert.equal(row.querySelector('.extensions-action').textContent, 'Cancel');
  // 취소 before the server exists: nothing more happens.
  await act(async () => row.querySelector('.extensions-action').click());
  addServer({ name: 'sentry' });
  await settle();
  assert.equal(connectorLoginState('', 'sentry'), null);
  assert.ok(!calls.some(([capability]) => capability === 'beginMcpOAuthLogin'), 'no browser sign-in starts');
  await pane.unmount();
});

test('연결 해제 switches a plugin server off; 플러그인 삭제… shows its impact first', async () => {
  handlers = { mcpStatus: () => ({ servers }) };
  calls.length = 0;
  const pane = await render(React.createElement(CategoryPanel, { category: 'connectors', context: panelContext() }));
  // Expand the package, open its server.
  await click(pane.host.querySelector('[data-connector-package="docs-pack"] .connectors-row-action button'));
  await click(pane.host.querySelector('[data-connector-row="docs-search"] button'));
  await click(button(document.body, 'Disconnect'));
  assert.deepEqual(
    calls.filter(([name]) => name.startsWith('run:')),
    [['run:setMcpServerEnabled', ['docs-search', false]]]
  );

  calls.length = 0;
  await click(pane.host.querySelector('[data-connector-row="docs-search"] button'));
  await click(button(document.body, 'Remove plugin…'));
  const impact = document.body.querySelector('.connectors-plugin-removal');
  assert.match(impact.textContent, /docs-search/);
  assert.match(impact.textContent, /Its hooks stop running\./);
  assert.match(impact.textContent, /C:\/data\/plugins\/docs-pack/);
  assert.deepEqual(calls, [], 'nothing is removed before confirming');
  await click(button(impact, 'Remove plugin'));
  assert.equal(calls.filter(([name]) => name === 'run:removePlugin').length, 1);
  await pane.unmount();
});

test('the server id is immutable in the editor; a plugin config is read-only', async () => {
  const props = { busy: false, onClose() {}, onSave() {} };
  const edit = await render(
    React.createElement(McpEditorDialog, {
      ...props,
      server: { name: 'unitymcp', config: { type: 'stdio', command: 'npx' } },
    })
  );
  assert.equal(document.body.querySelector('input[name="mcp-name"]').readOnly, true);
  await edit.unmount();
  const create = await render(React.createElement(McpEditorDialog, { ...props, server: null }));
  assert.equal(document.body.querySelector('input[name="mcp-name"]').readOnly, false);
  await create.unmount();
  const owned = await render(
    React.createElement(McpEditorDialog, {
      ...props,
      readOnly: true,
      server: { name: 'docs-search', config: { type: 'stdio', command: 'node' } },
    })
  );
  assert.equal(button(document.body, 'Save'), undefined);
  assert.equal(document.body.querySelector('input[name="mcp-command"]').disabled, true);
  await owned.unmount();
});

test('several Gmail accounts side by side: each is its own server, shown with its address, disconnected on its own', async () => {
  const gmail = {
    name: 'gmail',
    connector: 'gmail',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'config',
    oauth: { signedIn: true, account: 'work@example.com' },
  };
  const second = {
    name: 'gmail-2',
    connector: 'gmail',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'config',
    appPassword: { account: 'me@gmail.com' },
  };
  const live = [gmail, second];
  const groups = groupConnectors(live, []);
  const row = groups.catalog.find((item) => item.entry.id === 'gmail');
  assert.deepEqual(
    row.servers.map((server) => server.name),
    ['gmail', 'gmail-2']
  );
  assert.equal(row.server.name, 'gmail', 'single-account consumers still read the first server');

  // Another account: a new server with its own sign-in URL, the first untouched.
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: live }),
    addMcpServer: () => ({}),
    beginMcpOAuthLogin: () => ({ flowId: 'f2', state: 'pending', url: 'https://accounts.google.com/x' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'f2', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
    removeMcpServer: () => ({ signIn: 'removed', revoked: false }),
  };
  await assert.rejects(
    connectCatalogConnector(connectorById('gmail'), '', null, { add: true }),
    /app password only/,
    'Gmail takes no new Google sign-in'
  );
  assert.ok(!calls.some(([capability]) => ['addMcpServer', 'beginMcpOAuthLogin'].includes(capability)));

  // An app-password account of an address already connected is reconnected, not duplicated.
  calls.length = 0;
  handlers.saveMcpServer = () => ({});
  handlers.setMcpServerEnabled = () => ({});
  await connectCatalogConnector(
    connectorById('gmail'),
    '',
    { email: 'ME@gmail.com', password: 'abcdwxyzabcdwxyz' },
    { add: true }
  );
  assert.ok(!calls.some(([capability]) => capability === 'addMcpServer'));
  assert.equal(calls.find(([capability]) => capability === 'saveMcpServer')[1][0].originalName, 'gmail-2');

  // The detail lists both accounts; 연결 해제 on one removes only that server.
  calls.length = 0;
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  await click(rowOf(pane.host, 'gmail').querySelector('button'));
  const dialog = document.body.querySelector('.connectors-detail-dialog');
  assert.match(dialog.textContent, /work@example\.com/);
  assert.match(dialog.textContent, /me@gmail\.com/);
  assert.ok(button(dialog, '+ Add account'));
  assert.equal(button(dialog, 'Add another account'), undefined, 'Gmail adds by app password only');
  assert.equal(button(dialog, 'Disconnect'), undefined, 'Disconnect lives in each row ⋯ menu');
  const menus = dialog.querySelectorAll('.extensions-item .row-overflow-trigger');
  assert.equal(menus.length, 2, 'one ⋯ menu per account');
  await act(async () => menus[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const items = [...document.body.querySelectorAll('.row-overflow-menu [role="menuitem"]')].map((node) =>
    node.textContent.trim()
  );
  assert.deepEqual(items, ['Change app password', 'Disconnect']);
  await click(
    [...document.body.querySelectorAll('.row-overflow-menu [role="menuitem"]')].find(
      (node) => node.textContent.trim() === 'Disconnect'
    )
  );
  assert.deepEqual(
    calls.filter(([name]) => name === 'run:removeMcpServer'),
    [['run:removeMcpServer', ['gmail-2']]]
  );
  await pane.unmount();
});

test('one Gmail server holding several accounts: one row per account, each added, reconnected and removed by its name', async () => {
  const gmail = {
    name: 'gmail',
    connector: 'gmail',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'config',
    tools: [{ name: 'mcp__gmail__search_emails' }],
    accounts: [
      { name: 'gmail', email: 'me@gmail.com', appPassword: { account: 'me@gmail.com' } },
      { name: 'gmail-2', email: 'work@gmail.com', appPassword: { account: 'work@gmail.com' } },
      { name: 'gmail-3', email: '', appPassword: { account: 'team@gmail.com' }, error: 'GMAIL_APP_PASSWORD_MISSING: x' },
    ],
  };
  const live = [gmail];
  const row = groupConnectors(live, []).catalog.find((item) => item.entry.id === 'gmail');
  assert.deepEqual(
    row.servers.map((account) => [account.name, account.server, account.connected, account.appPassword.account]),
    [
      ['gmail', 'gmail', true, 'me@gmail.com'],
      ['gmail-2', 'gmail', true, 'work@gmail.com'],
      ['gmail-3', 'gmail', false, 'team@gmail.com'],
    ]
  );
  assert.equal(row.servers[2].status, 'failed', 'a failing account keeps its own state');
  assert.equal(row.servers[1].accounts, undefined);

  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: live }),
    addMcpServer: () => ({}),
    saveMcpServer: () => ({}),
    removeMcpServer: () => ({ signIn: 'removed', revoked: false }),
  };
  // A connected address is reconnected by its account name, never duplicated.
  await connectCatalogConnector(
    connectorById('gmail'),
    '',
    { email: 'work@gmail.com', password: 'abcdwxyzabcdwxyz' },
    { add: true }
  );
  assert.equal(calls.find(([capability]) => capability === 'saveMcpServer')[1][0].originalName, 'gmail-2');
  // A new address is one more account, under a name no account has.
  calls.length = 0;
  await connectCatalogConnector(
    connectorById('gmail'),
    '',
    { email: 'new@gmail.com', password: 'abcdwxyzabcdwxyz' },
    { add: true }
  );
  assert.equal(calls.find(([capability]) => capability === 'addMcpServer')[1][0].name, 'gmail-4');

  calls.length = 0;
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  await click(rowOf(pane.host, 'gmail').querySelector('button'));
  const dialog = document.body.querySelector('.connectors-detail-dialog');
  for (const address of ['me@gmail.com', 'work@gmail.com', 'team@gmail.com']) assert.match(dialog.textContent, new RegExp(address));
  const menus = dialog.querySelectorAll('.extensions-item .row-overflow-trigger');
  assert.equal(menus.length, 3, 'one ⋯ menu per account');
  await act(async () => menus[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await click(
    [...document.body.querySelectorAll('.row-overflow-menu [role="menuitem"]')].find(
      (node) => node.textContent.trim() === 'Disconnect'
    )
  );
  assert.deepEqual(
    calls.filter(([name]) => name === 'run:removeMcpServer'),
    [['run:removeMcpServer', ['gmail-2']]],
    'only that account goes'
  );
  await pane.unmount();
});

test('a sign-in connector: clicking its unconnected row starts the sign-in at once, no detail first', async () => {
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: [] }),
    addMcpServer: () => ({}),
    beginMcpOAuthLogin: () => ({ flowId: 'f9', state: 'pending', url: 'https://mcp.linear.app/authorize' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'f9', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: [] }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  await click(rowOf(pane.host, 'linear').querySelector('.extensions-row-open'));
  await settle();
  assert.equal(document.body.querySelector('.connectors-detail-dialog'), null, 'no detail dialog first');
  assert.ok(
    calls.some(([capability]) => capability === 'beginMcpOAuthLogin'),
    'the browser sign-in starts'
  );
  assert.equal(rowOf(pane.host, 'linear').querySelector('.extensions-action').textContent, 'Cancel');
  cancelConnectorLogin('linear');
  await pane.unmount();
});

test('a connected sign-in connector shares the Gmail frame: account row with a ⋯ menu, no stacked links', async () => {
  const live = [
    {
      name: 'google-calendar',
      connector: 'google-calendar',
      enabled: true,
      connected: true,
      status: 'connected',
      source: 'config',
      oauth: { signedIn: true, account: 'me@example.com' },
      tools: [{ name: 'list_events' }, { name: 'create_event' }],
    },
  ];
  calls.length = 0;
  handlers = { mcpStatus: () => ({ servers: live }) };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  await click(rowOf(pane.host, 'google-calendar').querySelector('.extensions-row-open'));
  const dialog = document.body.querySelector('.connectors-detail-dialog');
  assert.ok(button(dialog, '+ Add account'), 'multi-account connectors add from the section header');
  assert.equal(button(dialog, 'Add another account'), undefined);
  assert.equal(button(dialog, 'Disconnect'), undefined, 'no footer disconnect');
  assert.ok(button(dialog, '2 tools'), 'the tools fold');
  const trigger = dialog.querySelector('.extensions-item .row-overflow-trigger');
  await act(async () => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const items = [...document.body.querySelectorAll('.row-overflow-menu [role="menuitem"]')].map((node) =>
    node.textContent.trim()
  );
  assert.deepEqual(items, ['Switch account', 'Sign out', 'Disconnect']);
  await pane.unmount();
});

test('Google Calendar and Drive are catalog rows, and "Use my Google key" stays in the add-custom dialog', async () => {
  handlers = { mcpStatus: () => ({ servers: [] }) };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: [] }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  assert.ok(rowOf(pane.host, 'google-calendar'));
  assert.ok(rowOf(pane.host, 'google-drive'));
  await click(rowOf(pane.host, 'add-custom-connector').querySelector('button'));
  await click(button(document.body, 'Use my Google key'));
  await settle();
  assert.ok(document.body.querySelector('#connectors-google-key-title'), 'the own-key dialog opens');
  assert.match(document.body.textContent, /enable the Calendar and Drive APIs/);
  await pane.unmount();
});

test('Google Calendar and Drive sign-ins tell the user to check every box; other connectors do not', async () => {
  for (const id of ['google-calendar', 'google-drive', 'notion']) {
    let live = [];
    calls.length = 0;
    handlers = {
      mcpStatus: () => ({ servers: live, googleClient: true }),
      addMcpServer: (input) => {
        live = [...live, { name: input.name, connector: input.connector, enabled: true, authRequired: true }];
        return { name: input.name };
      },
      beginMcpOAuthLogin: () => ({ flowId: `f-${id}`, state: 'pending', url: 'https://accounts.google.com/auth' }),
      getMcpOAuthLoginStatus: () => ({ flowId: `f-${id}`, state: 'pending', step: 'browser' }),
      cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
    };
    await connectCatalogConnector(connectorById(id));
    const pane = await render(
      React.createElement(CategoryPanel, {
        category: 'connectors',
        context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
      })
    );
    const text = rowOf(pane.host, id).textContent;
    const step = rowOf(pane.host, id).querySelector('.connectors-row-step');
    assert.equal(step.querySelectorAll('.connectors-row-step-text').length, 1, 'one line');
    assert.equal(step.querySelector('.connectors-row-hint'), null);
    if (id === 'notion') {
      assert.match(text, /Sign in in your browser…/);
    } else {
      assert.match(text, /Check access, then Continue/);
      assert.doesNotMatch(text, /Sign in in your browser…/);
      assert.equal(
        step.title,
        'If Google shows a checkbox for the access, check it before Continue — it starts unchecked.'
      );
    }
    cancelConnectorLogin(id);
    await pane.unmount();
  }
});

test('a scopeNotGranted failure row shows the short instruction whole, with the full sentence as its tooltip', async () => {
  let live = [];
  handlers = {
    mcpStatus: () => ({ servers: live, googleClient: true }),
    addMcpServer: (input) => {
      live = [{ name: input.name, connector: input.connector, enabled: true, authRequired: true }];
      return { name: input.name };
    },
    beginMcpOAuthLogin: () => ({ flowId: 'g1', state: 'pending', url: 'https://accounts.google.com/o/oauth2/auth' }),
    getMcpOAuthLoginStatus: () => ({
      flowId: 'g1',
      state: 'failed',
      error: 'MCP OAuth scopeNotGranted: access not granted for https://www.googleapis.com/auth/calendar.events',
    }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  await connectCatalogConnector(connectorById('google-calendar'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  const row = pane.host.querySelector('[data-connector-row="google-calendar"]');
  assert.equal(row.dataset.rowStatus, 'failed');
  const scope = row.querySelector('.connectors-row-scope');
  assert.equal(scope.textContent, 'More access needed');
  assert.match(scope.title, /check the access box on the Google screen before Continue\.$/);
  assert.equal(row.querySelector('.sidebar-resource-title > b').title, 'Google Calendar', 'the full name is the tooltip');
  await pane.unmount();

  // Sidebar rule (structure the CSS keys on): the name is one <b> with its
  // full text as title; the status is ONE <small> holding the badge and one
  // text span, with the full text as its title.
  const status = row.querySelector('.utilities-row-copy > small');
  assert.equal(row.querySelectorAll('.utilities-row-copy > small').length, 1);
  assert.equal(status.firstElementChild.className, 'sidebar-resource-tag');
  assert.equal(status.querySelectorAll('.connectors-row-line').length, 1);
  assert.equal(row.querySelector('.sidebar-resource-title .sidebar-resource-tag'), null, 'badge is not on the name line');

  // The row keys on the failure kind, not on the summary text: after the UI
  // language changes, the stored (English) summary no longer equals the
  // translated sentence, and the short text still appears.
  const { initUiLanguage, setUiLanguagePreference } = await import('../i18n.ts');
  setUiLanguagePreference('ko');
  await initUiLanguage();
  try {
    const korean = await render(
      React.createElement(CategoryPanel, {
        category: 'connectors',
        context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
      })
    );
    const koScope = korean.host.querySelector('[data-connector-row="google-calendar"] .connectors-row-scope');
    assert.ok(koScope, 'the short text shows although the stored summary text differs from the Korean sentence');
    assert.notEqual(koScope.title, mcpErrorSummary('MCP OAuth scopeNotGranted'));
    assert.equal(koScope.textContent, '권한 추가 필요');
    await korean.unmount();
  } finally {
    setUiLanguagePreference('en');
    await initUiLanguage();
  }
});

test('a sign-in Google granted without a requested access reads as the check-every-box sentence', async () => {
  const { connectorLoginErrorText } = await import('../connector-connect.ts');
  const sentence =
    "Google didn't grant the access Mixdog needs. Connect again and check the access box on the Google screen before Continue.";
  const coded = 'MCP OAuth scopeNotGranted: access not granted for https://www.googleapis.com/auth/calendar.events';
  assert.equal(connectorLoginErrorText(coded), sentence);
  assert.equal(connectorLoginErrorText(new Error(coded)), sentence);
  // The plain unfinished sign-in keeps its own sentence.
  assert.equal(
    connectorLoginErrorText('MCP OAuth login failed, cancelled, or timed out'),
    'The browser sign-in was not completed.'
  );
});

test('the full step (chat card, detail note) carries the whole Google notice; only the compact row is one line', async () => {
  const view = { step: 'browser', status: 'pending' };
  const notice = 'If Google shows a checkbox for the access, check it before Continue — it starts unchecked.';
  const full = await render(React.createElement(ConnectorStep, { view, connector: 'google-calendar' }));
  const step = full.host.querySelector('.connectors-row-step');
  assert.equal(step.dataset.compact, undefined, 'no one-line marker, so it wraps');
  assert.equal(step.querySelector('.connectors-row-hint').textContent, notice);
  assert.match(step.textContent, /Sign in in your browser…/);
  await full.unmount();
  const compact = await render(React.createElement(ConnectorStep, { view, connector: 'google-calendar', compact: true }));
  const one = compact.host.querySelector('.connectors-row-step');
  assert.equal(one.dataset.compact, 'true');
  assert.equal(one.querySelectorAll('.connectors-row-step-text').length, 1);
  assert.equal(one.title, notice);
  await compact.unmount();
});

const CLIENT_FILE = JSON.stringify({
  installed: { client_id: 'mine.apps.googleusercontent.com', client_secret: 'GOCSPX-mine' },
});

test('without the built-in Google client a second account asks for a key first and is created on it', async () => {
  const live = [
    {
      name: 'google-calendar',
      connector: 'google-calendar',
      enabled: true,
      connected: true,
      status: 'connected',
      source: 'config',
      ownClient: true,
      oauth: { signedIn: true, account: 'me@example.com' },
    },
  ];
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: live, googleClient: false }),
    getMcpServerConfig: () => ({ oauthClientId: 'mine.apps.googleusercontent.com' }),
    signOutMcpServer: () => ({}),
    saveMcpServer: () => ({}),
    addMcpServer: (input) => {
      live.push({ name: input.name, connector: input.connector, enabled: true, authRequired: true, ownClient: true });
      return { name: input.name };
    },
    beginMcpOAuthLogin: () => ({ flowId: 'k1', state: 'pending', url: 'https://accounts.google.com/x' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'k1', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({
        data: { mcp: { servers: live, googleClient: false }, plugins: { plugins: [] }, __loadedSections: ['mcp'] },
      }),
    })
  );
  await click(rowOf(pane.host, 'google-calendar').querySelector('.extensions-row-open'));
  const detail = document.body.querySelector('.connectors-detail-dialog');
  assert.doesNotMatch(detail.textContent, /no built-in Google sign-in/, 'the connected account needs no note');
  await click(button(detail, '+ Add account'));
  await settle();
  const keyDialog = document.body.querySelector('.connectors-key-dialog');
  assert.ok(keyDialog, 'the own-key dialog opens instead of a doomed sign-in');
  assert.ok(!calls.some(([capability]) => ['addMcpServer', 'beginMcpOAuthLogin'].includes(capability)));

  // The downloaded client file is picked: the dialog applies it at once.
  const picker = keyDialog.querySelector('input[type="file"]');
  Object.defineProperty(picker, 'files', { configurable: true, value: [{ text: async () => CLIENT_FILE }] });
  await act(async () => picker.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle(30);
  const added = calls.filter(([capability]) => capability === 'addMcpServer').map(([, args]) => args[0]);
  const second = added.find((input) => input.connector === 'google-calendar');
  assert.equal(second.name, 'google-calendar-2');
  assert.equal(second.url, 'https://calendar.mixdog.invalid/mcp?account=google-calendar-2');
  assert.equal(second.oauthClientId, 'mine.apps.googleusercontent.com');
  assert.ok(
    !calls.some(([capability]) => ['signOutMcpServer', 'saveMcpServer'].includes(capability)),
    'the existing account is left as it is'
  );
  assert.deepEqual(calls.find(([capability]) => capability === 'beginMcpOAuthLogin')[1], ['google-calendar-2']);
  cancelConnectorLogin('google-calendar-2');
  await pane.unmount();
});

test('a connector with accounts opens its detail even when its first account needs a sign-in; each account connects on its own', async () => {
  const calendar = {
    name: 'google-calendar',
    connector: 'google-calendar',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'config',
    accounts: [
      { name: 'work-cal', authRequired: true, oauth: { signedIn: false } },
      { name: 'home-cal', oauth: { signedIn: true, account: 'b@example.com' } },
    ],
  };
  const gmail = {
    name: 'gmail',
    connector: 'gmail',
    enabled: true,
    connected: true,
    status: 'connected',
    source: 'config',
    accounts: [
      { name: 'gm-a', authRequired: true, appPassword: { account: 'me@gmail.com' } },
      { name: 'gm-b', appPassword: { account: 'work@gmail.com' } },
    ],
  };
  const live = [calendar, gmail];
  const groups = groupConnectors(live, []);
  const first = (id) => groups.catalog.find((row) => row.entry.id === id).servers[0];
  assert.equal(connectorRowView(first('google-calendar'), null).status, 'needs-connect');
  assert.equal(connectorRowView(first('gmail'), null).status, 'needs-connect');

  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: live }),
    beginMcpOAuthLogin: () => ({ flowId: 'acc1', state: 'pending', url: 'https://accounts.google.com/x' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'acc1', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  const pane = await render(
    React.createElement(CategoryPanel, {
      category: 'connectors',
      context: panelContext({ data: { mcp: { servers: live }, plugins: { plugins: [] }, __loadedSections: ['mcp'] } }),
    })
  );
  // Calendar: the row opens the detail (no sign-in starts), listing both accounts.
  await click(rowOf(pane.host, 'google-calendar').querySelector('.extensions-row-open'));
  await settle();
  const detail = document.body.querySelector('.connectors-detail-dialog');
  assert.ok(detail, 'the detail opens');
  assert.ok(!calls.some(([capability]) => capability === 'beginMcpOAuthLogin'), 'no sign-in on opening');
  assert.equal(detail.querySelectorAll('.extensions-item').length, 2, 'both accounts are listed');
  assert.equal(detail.querySelectorAll('.extensions-item .row-overflow-trigger').length, 2, 'each has its menu');
  const connectButtons = [...detail.querySelectorAll('.extensions-item button')].filter(
    (node) => node.textContent.trim() === 'Connect'
  );
  assert.equal(connectButtons.length, 1, 'only the account that needs a sign-in offers Connect');
  assert.match(connectButtons[0].closest('.extensions-item').textContent, /work-cal/);
  await click(connectButtons[0]);
  await settle();
  assert.deepEqual(calls.find(([capability]) => capability === 'beginMcpOAuthLogin')[1], ['work-cal']);
  cancelConnectorLogin('work-cal');
  await click(button(detail, 'Close'));

  // Gmail: the same, and its account connects with its app password.
  await click(rowOf(pane.host, 'gmail').querySelector('.extensions-row-open'));
  await settle();
  const gmailDetail = document.body.querySelector('.connectors-detail-dialog');
  assert.ok(gmailDetail, 'the detail opens');
  assert.equal(document.body.querySelector('[aria-labelledby="connectors-gmail-app-password-title"]'), null);
  await click([...gmailDetail.querySelectorAll('.extensions-item button')].find((node) => node.textContent.trim() === 'Connect'));
  await settle();
  assert.ok(document.body.querySelector('input[name="gmail-app-password"]'), 'the app-password dialog opens');
  await pane.unmount();
});

test('a custom MCP server cannot take a connector account name; the refusal names the connector', async () => {
  const sent = [];
  const create = await render(
    React.createElement(McpEditorDialog, {
      busy: false,
      server: null,
      takenNames: ['gmail'],
      accountOwners: { 'gmail-2': 'Gmail' },
      onClose() {},
      onSave: (payload) => sent.push(payload),
    })
  );
  globalThis.FormData = window.FormData;
  document.querySelector('[name="mcp-name"]').value = 'gmail-2';
  document.querySelector('[name="mcp-command"]').value = 'example';
  await act(async () => {
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(sent, [], 'nothing is sent');
  assert.match(
    document.body.textContent,
    /The name "gmail-2" is used by a Gmail account\. Choose another name\./
  );
  assert.doesNotMatch(document.body.textContent, /already exists/);
  await create.unmount();
});
