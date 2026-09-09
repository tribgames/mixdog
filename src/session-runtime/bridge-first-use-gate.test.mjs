import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeToolFamily, createBridgeFirstUseGate } from './bridge-first-use-gate.mjs';

const call = (overrides = {}) => ({
  name: 'browser',
  args: { action: 'navigate', input: { url: 'https://example.test/login' } },
  cwd: 'C:/work',
  sessionId: 's1',
  toolCallId: 'call-1',
  invocationSource: 'model-tool',
  ...overrides,
});

test('browser tools share one family; other tools are not gated', () => {
  assert.equal(bridgeToolFamily('browser'), 'browser');
  assert.equal(bridgeToolFamily('browser_devtools'), 'browser');
  assert.equal(bridgeToolFamily('computer'), 'computer');
  assert.equal(bridgeToolFamily('shell'), null);
});

test('the first call asks once per session and family; a grant covers the rest of the session', async () => {
  const asked = [];
  const hook = async (request) => { asked.push(request); return { approved: true }; };
  const gate = createBridgeFirstUseGate({ getConfig: () => ({}) });
  assert.equal(await gate(call({ toolApprovalHook: hook })), null);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'browser');
  assert.match(asked[0].reason, /first Browser Use call in this session \(navigate https:\/\/example\.test\/login\)/);
  // Same session: the developer tool rides the browser grant; computer asks on its own.
  assert.equal(await gate(call({ name: 'browser_devtools', args: { action: 'emulate' }, toolApprovalHook: hook })), null);
  assert.equal(asked.length, 1);
  assert.equal(await gate(call({ name: 'computer', args: { action: 'list', input: { kind: 'windows' } }, toolApprovalHook: hook })), null);
  assert.equal(asked.length, 2);
  assert.match(asked[1].reason, /first Computer Use call/);
  // Another session asks again.
  assert.equal(await gate(call({ sessionId: 's2', toolApprovalHook: hook })), null);
  assert.equal(asked.length, 3);
  assert.equal(await gate(call({ name: 'shell', args: { command: 'ls' }, toolApprovalHook: hook })), null);
  assert.equal(asked.length, 3);
});

test('a declined or failed approval blocks the call with the reason and asks again next time', async () => {
  let answer = { approved: false, reason: 'not now' };
  const hook = async () => answer;
  const gate = createBridgeFirstUseGate({ getConfig: () => ({}) });
  const denied = await gate(call({ toolApprovalHook: hook }));
  assert.match(denied, /^Error: Browser Use was not approved for this session: not now\./);
  assert.match(denied, /Do not retry/);
  answer = { approved: true };
  assert.equal(await gate(call({ toolApprovalHook: hook })), null);
  const failing = createBridgeFirstUseGate({ getConfig: () => ({}) });
  assert.match(
    await failing(call({ toolApprovalHook: async () => { throw new Error('ui closed'); } })),
    /first-use approval failed: ui closed/,
  );
});

test('the gate stands aside without an approval UI, for non-model callers, and when the profile turns it off', async () => {
  let asked = 0;
  const hook = async () => { asked += 1; return true; };
  const off = createBridgeFirstUseGate({ getConfig: () => ({ builtins: { browser: { firstUseApproval: false } } }) });
  assert.equal(await off(call({ toolApprovalHook: hook })), null);
  assert.equal(await off(call({ name: 'computer', args: { action: 'list' }, toolApprovalHook: hook })), null);
  assert.equal(asked, 1, 'computer is still gated when only browser is off');
  const on = createBridgeFirstUseGate({ getConfig: () => ({}) });
  assert.equal(await on(call()), null);
  assert.equal(await on(call({ toolApprovalHook: hook, invocationSource: 'internal' })), null);
  assert.equal(asked, 1);
  const previous = process.env.MIXDOG_BRIDGE_FIRST_USE_APPROVAL;
  process.env.MIXDOG_BRIDGE_FIRST_USE_APPROVAL = '0';
  try {
    assert.equal(await on(call({ toolApprovalHook: hook })), null);
    assert.equal(asked, 1);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_BRIDGE_FIRST_USE_APPROVAL;
    else process.env.MIXDOG_BRIDGE_FIRST_USE_APPROVAL = previous;
  }
});
