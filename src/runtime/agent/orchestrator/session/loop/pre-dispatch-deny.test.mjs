import assert from 'node:assert/strict';
import test from 'node:test';

import { preDispatchDenyForSession, routeWebFetchCall } from './pre-dispatch-deny.mjs';

test('Agent runtime denies only recursive agent control', () => {
  const reviewer = { owner: 'agent', agent: 'reviewer' };
  assert.match(
    preDispatchDenyForSession(reviewer, { name: 'agent', arguments: {} }),
    /Lead-only/,
  );
  assert.equal(
    preDispatchDenyForSession(reviewer, { name: 'inject_input', arguments: {} }),
    null,
  );
  assert.equal(
    preDispatchDenyForSession(reviewer, { name: 'apply_patch', arguments: {} }),
    null,
  );
});

test('internal Agent roles use the same runtime tool gate', () => {
  const cycle = { owner: 'agent', agent: 'cycle1-agent' };
  assert.equal(
    preDispatchDenyForSession(cycle, { name: 'apply_patch', arguments: {} }),
    null,
  );
});

test('session schema allowlists gate dispatch as well as schema injection', () => {
  const headless = { schemaAllowedTools: ['read', 'Shell'] };
  assert.equal(
    preDispatchDenyForSession(headless, { name: 'shell', arguments: {} }),
    null,
  );
  assert.match(
    preDispatchDenyForSession(headless, { name: 'goal', arguments: {} }),
    /schema allowlist/,
  );
});

test('internal web fetch transport rewrites retain the public schema identity', () => {
  const call = { name: 'web_fetch', arguments: { url: 'http://127.0.0.1:8123/' } };
  routeWebFetchCall(call);
  assert.equal(call.name, 'local_fetch');
  assert.equal(call.schemaName, 'web_fetch');
  assert.equal(
    preDispatchDenyForSession({ schemaAllowedTools: ['web_fetch'] }, call),
    null,
  );
});
