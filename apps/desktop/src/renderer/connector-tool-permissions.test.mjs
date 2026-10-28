// A bot's per-tool connector permissions in its profile, over the real host
// connector API (read side and writer) with the agent editor reduced to a policy.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent'],
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { AgentProfilePane } = await import('./AgentProfilePane.tsx');
const { createAgentConnectorsApi } = await import(
  '../../../../src/session-runtime/workflow-agents-api/agent-connectors.mjs'
);
const { parseConnectorPolicy } = await import('../../../../src/runtime/agent/orchestrator/mcp/agent-connectors.mjs');
const { rememberServerConnector } = await import(
  '../../../../src/runtime/agent/orchestrator/mcp/server-connectors.mjs'
);
test.after(() => dom.window.close());

// gmail is a catalog connector (its send_email asks by default); notion is not.
rememberServerConnector('gmail', { connector: 'gmail' });
const SERVERS_ONE = [{ name: 'gmail' }, { name: 'notion' }];
const TOOLS_ONE = ['gmail__search_emails', 'gmail__send_email', 'gmail__delete_thing', 'notion__search_pages'].map(
  (name) => ({ name: `mcp__${name}` })
);

/** The profile over a host whose policy is `policy`; returns the policy getter and the writes. */
function host(policy, { second = false } = {}) {
  const state = { policy, writes: [] };
  const SERVERS = second ? [...SERVERS_ONE, { name: 'gmail-2' }] : SERVERS_ONE;
  const TOOLS = second ? [...TOOLS_ONE, { name: 'mcp__gmail-2__send_email' }] : TOOLS_ONE;
  const editor = {
    getAgentConnectorPolicy: () => state.policy,
    setAgentConnectorPolicy: async (_id, stored) => {
      state.policy = stored ? parseConnectorPolicy(stored) : null;
      return stored;
    },
  };
  const connectors = createAgentConnectorsApi({ mcpStatus: () => ({ servers: SERVERS }), getMcpTools: () => TOOLS }, editor);
  const api = {
    invokeCapability: async ({ capability, args }) => {
      if (capability === 'getAgentDefinition') {
        return { value: { id: args[0], name: args[0], body: 'Work.', route: { provider: 'openai', model: 'm' }, persona: '' } };
      }
      if (typeof connectors[capability] === 'function') {
        if (capability === 'setAgentConnectorToolPermission') state.writes.push(args);
        return { value: await connectors[capability](...args) };
      }
      if (capability === 'getChannelSetup') return { value: { schedules: [], webhooks: [] } };
      return { value: true };
    },
    setModelRoute: async () => null,
  };
  return { api, state };
}

async function open(t, agentId, policy, { remote = false, second = false } = {}) {
  const { api, state } = host(policy, { second });
  if (remote) window.mixdogRemoteServer = 'wss://relay.test';
  const el = document.createElement('main');
  document.body.append(el);
  const root = createRoot(el);
  t.after(async () => {
    delete window.mixdogRemoteServer;
    await act(async () => root.unmount());
    el.remove();
  });
  await act(async () =>
    root.render(React.createElement(AgentProfilePane, { sessionId: `sess_home_${agentId}`, active: true, api, models: [] }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { state };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const row = (id) => document.querySelector(`[data-connector-switch="${id}"]`);
const expand = async (id) => {
  await act(async () => row(id).querySelector('button[aria-expanded]').click());
};
const choice = (connector, tool, permission) =>
  document.querySelector(`[data-connector-tools="${connector}"] [data-connector-tool="${tool}"] [data-permission="${permission}"]`);
const pressed = (connector, tool) =>
  ['auto', 'needs_approval', 'disabled'].filter((p) => choice(connector, tool, p).getAttribute('aria-pressed') === 'true');

test('choosing Needs approval on a disabled tool changes exactly that tool and leaves other overrides', async (t) => {
  const { state } = await open(t, 'seed-bot', { off: [], tools: { gmail: { send_email: 'disabled', delete_thing: 'auto' } } });
  assert.match(row('gmail').textContent, /· 2 changed/);
  assert.equal(document.querySelector('[data-connector-tools]'), null, 'collapsed');
  await expand('gmail');
  assert.deepEqual(pressed('gmail', 'send_email'), ['disabled']);
  await act(async () => choice('gmail', 'send_email', 'needs_approval').click());
  await settle();
  assert.deepEqual(state.writes, [['seed-bot', 'gmail', 'send_email', 'needs_approval']]);
  assert.deepEqual(state.policy.tools, { gmail: { send_email: 'needs_approval', delete_thing: 'auto' } });
  assert.deepEqual(pressed('gmail', 'send_email'), ['needs_approval']);
  assert.equal(document.querySelector('[data-connector-tool="send_email"] .connector-tool-name').title, 'send_email');
});

test('legacy per-account data follows the topmost entry and converges to one entry after a choice', async (t) => {
  const { state } = await open(
    t,
    'accounts-bot',
    { off: [], tools: { gmail: { send_email: 'auto' }, 'gmail-2': { send_email: 'disabled' } } },
    { second: true }
  );
  assert.match(row('gmail').textContent, /· 1 changed/);
  await expand('gmail');
  assert.deepEqual(pressed('gmail', 'send_email'), ['auto'], "the connector's own entry wins over gmail-2's");
  await act(async () => choice('gmail', 'send_email', 'needs_approval').click());
  await settle();
  assert.deepEqual(state.writes, [['accounts-bot', 'gmail', 'send_email', 'needs_approval']], 'one write; the host fans out');
  assert.deepEqual(state.policy.tools, { gmail: { send_email: 'needs_approval' } }, 'one entry under the connector');
  assert.deepEqual(pressed('gmail', 'send_email'), ['needs_approval']);
});

test('a tool with no override shows its effective permission', async (t) => {
  await open(t, 'default-bot', null);
  assert.doesNotMatch(row('gmail').textContent, /changed/);
  await expand('gmail');
  assert.deepEqual(pressed('gmail', 'search_emails'), ['auto']);
  assert.deepEqual(pressed('gmail', 'send_email'), ['needs_approval'], "a catalog connector's high-risk tool asks");
});

test('while the connector is off its tools are dimmed and cannot be changed, and keep their values', async (t) => {
  const { state } = await open(t, 'off-bot', { off: ['notion'], tools: { notion: { search_pages: 'needs_approval' } } });
  await expand('notion');
  const panel = document.querySelector('[data-connector-tools="notion"]');
  assert.ok(panel.hasAttribute('data-dim'));
  assert.deepEqual(pressed('notion', 'search_pages'), ['needs_approval']);
  for (const button of panel.querySelectorAll('[data-permission]')) assert.equal(button.disabled, true);
  await act(async () => choice('notion', 'search_pages', 'auto').click());
  assert.deepEqual(state.writes, []);
});

test('on a remote surface the choices that would widen are disabled; narrowing still works', async (t) => {
  const { state } = await open(
    t,
    'remote-bot',
    { off: [], tools: { gmail: { send_email: 'needs_approval', delete_thing: 'disabled' } } },
    { remote: true }
  );
  await expand('gmail');
  const disabled = (tool) =>
    ['auto', 'needs_approval', 'disabled'].filter((p) => choice('gmail', tool, p).disabled);
  assert.deepEqual(disabled('send_email'), ['auto']);
  assert.deepEqual(disabled('delete_thing'), ['auto', 'needs_approval']);
  assert.deepEqual(disabled('search_emails'), [], "a tool's default auto is not an override: it can only narrow");
  assert.ok(document.querySelector('[data-connector-tools-remote]'));
  await act(async () => choice('gmail', 'send_email', 'disabled').click());
  await settle();
  assert.deepEqual(state.policy.tools.gmail.send_email, 'disabled');
});
