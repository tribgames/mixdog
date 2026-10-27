import assert from 'node:assert/strict';
import test from 'node:test';

import { preDispatchDenyForSession, routeWebFetchCall } from './pre-dispatch-deny.mjs';

test('Agent runtime denies only recursive agent control', () => {
  const reviewer = { owner: 'agent', agent: 'reviewer' };
  assert.match(preDispatchDenyForSession(reviewer, { name: 'agent', arguments: {} }), /Lead-only/);
  assert.equal(preDispatchDenyForSession(reviewer, { name: 'inject_input', arguments: {} }), null);
  assert.equal(preDispatchDenyForSession(reviewer, { name: 'apply_patch', arguments: {} }), null);
});

test('internal Agent roles use the same runtime tool gate', () => {
  const cycle = { owner: 'agent', agent: 'cycle1-agent' };
  assert.equal(preDispatchDenyForSession(cycle, { name: 'apply_patch', arguments: {} }), null);
});

test('session schema allowlists gate dispatch as well as schema injection', () => {
  const headless = { schemaAllowedTools: ['read', 'Shell'] };
  assert.equal(preDispatchDenyForSession(headless, { name: 'shell', arguments: {} }), null);
  assert.match(preDispatchDenyForSession(headless, { name: 'goal', arguments: {} }), /schema allowlist/);
});

test('a tool the session policy removed stays refused at dispatch', () => {
  const lead = { disallowedTools: ['git', 'github', 'web_fetch'] };
  assert.match(preDispatchDenyForSession(lead, { name: 'git', arguments: {} }), /not available in this session/);
  assert.match(preDispatchDenyForSession(lead, { name: 'GitHub', arguments: {} }), /not available in this session/);
  const routed = { name: 'web_fetch', arguments: { url: 'http://127.0.0.1:8123/' } };
  routeWebFetchCall(routed);
  assert.match(preDispatchDenyForSession(lead, routed), /not available in this session/);
  assert.equal(preDispatchDenyForSession(lead, { name: 'read', arguments: {} }), null);
});

test('read-only sessions run only the tools their surfaces offer', () => {
  const session = {
    toolSpec: ['tools:readonly'],
    tools: [{ name: 'read' }],
    deferredToolCatalog: [{ name: 'recall' }, { name: 'memory' }],
  };
  assert.equal(preDispatchDenyForSession(session, { name: 'Read', arguments: {} }), null);
  assert.equal(preDispatchDenyForSession(session, { name: 'skill_view', arguments: {} }), null);
  // Catalog tools keep their readonly gate in the deferred call-through.
  assert.equal(preDispatchDenyForSession(session, { name: 'recall', arguments: {} }), null);
  for (const name of ['shell', 'edit', 'apply_patch', 'git', 'Write']) {
    assert.match(preDispatchDenyForSession(session, { name, arguments: {} }), /read-only session/);
  }
  assert.equal(preDispatchDenyForSession({ ...session, toolSpec: 'full' }, { name: 'shell', arguments: {} }), null);
});

test('internal web fetch transport rewrites retain the public schema identity', () => {
  const call = { name: 'web_fetch', arguments: { url: 'http://127.0.0.1:8123/' } };
  routeWebFetchCall(call);
  assert.equal(call.name, 'local_fetch');
  assert.equal(call.schemaName, 'web_fetch');
  assert.equal(preDispatchDenyForSession({ schemaAllowedTools: ['web_fetch'] }, call), null);
});

test('session is Lead-only: worker dispatch is refused, Lead is not', () => {
  assert.match(
    preDispatchDenyForSession({ owner: 'agent', agent: 'worker' }, { name: 'session', arguments: {} }),
    /Lead-only/
  );
  assert.equal(preDispatchDenyForSession({ owner: 'cli', agent: 'lead' }, { name: 'session', arguments: {} }), null);
});

test('ask_user is Lead-only: worker dispatch is refused, Lead is not', () => {
  assert.match(
    preDispatchDenyForSession({ owner: 'agent', agent: 'worker' }, { name: 'ask_user', arguments: {} }),
    /Lead-only/
  );
  assert.equal(preDispatchDenyForSession({ owner: 'cli', agent: 'lead' }, { name: 'ask_user', arguments: {} }), null);
  assert.match(
    preDispatchDenyForSession({ owner: 'agent', agent: 'worker' }, { name: 'handoff_user', arguments: {} }),
    /Lead-only/
  );
  assert.equal(
    preDispatchDenyForSession({ owner: 'cli', agent: 'lead' }, { name: 'handoff_user', arguments: {} }),
    null
  );
});
