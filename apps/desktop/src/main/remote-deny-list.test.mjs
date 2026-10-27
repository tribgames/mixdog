// Pairing approval is the trust, so a paired client has the desktop's own
// capabilities. The deny-list holds only host-internal items.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES } from '../shared/contract.ts';
import { DESKTOP_IMPORT_CAPABILITIES } from '../shared/contract-import.ts';
import {
  assertRemoteCapability,
  executeRemoteFrame,
  redactRemoteError,
  REMOTE_BLOCKED_CAPABILITIES,
} from './remote-methods.ts';

test('only the media resolver and local conversation import are denied over remote access', () => {
  assert.deepEqual([...REMOTE_BLOCKED_CAPABILITIES], ['resolveMediaFile', ...DESKTOP_IMPORT_CAPABILITIES]);
  for (const capability of REMOTE_BLOCKED_CAPABILITIES) {
    assert.throws(() => assertRemoteCapability(capability), /is not available over remote access/, capability);
  }
});

test('secret, OAuth, MCP and developer capabilities are allowed for every paired client', () => {
  for (const capability of [
    'saveProviderApiKey',
    'saveOpenAIUsageSessionKey',
    'authenticateProvider',
    'loginOAuthProvider',
    'beginOAuthProviderLogin',
    'getOAuthProviderLoginStatus',
    'completeOAuthProviderLogin',
    'cancelOAuthProviderLogin',
    'saveCustomProvider',
    'removeCustomProvider',
    'updateCustomProviderModel',
    'testCustomProvider',
    'checkCustomProviderKeyEnv',
    'discoverCustomProviderModels',
    'getMcpServerConfig',
    'addMcpServer',
    'saveMcpServer',
    'beginMcpOAuthLogin',
    'getMcpOAuthLoginStatus',
    'cancelMcpOAuthLogin',
    'completeMcpOAuthLogin',
    'signOutMcpServer',
    'probeMcpServerAuth',
    'setDeveloperOption',
    'forgetProviderAuth',
  ]) {
    assert.equal(DESKTOP_CAPABILITIES.includes(capability), true, `${capability} is a real capability`);
    assert.doesNotThrow(() => assertRemoteCapability(capability), capability);
  }
});

test('every deny-list entry still names a real capability', () => {
  const known = new Set(DESKTOP_CAPABILITIES);
  for (const capability of REMOTE_BLOCKED_CAPABILITIES) {
    assert.equal(
      known.has(capability),
      true,
      `${capability} is denied but no longer exists — a rename would open the lane`
    );
  }
});

test('secret-bearing capability errors are redacted for every client', () => {
  const secret = 'sk-live-0123456789';
  const params = [{ capability: 'saveProviderApiKey', args: ['openai', secret] }];
  assert.equal(redactRemoteError(`bad ${secret}`, 'invokeCapability', params), 'bad [redacted]');
  const oauth = [{ capability: 'completeOAuthProviderLogin', args: ['oauth_1', 'http://localhost/cb?code=abcdef123'] }];
  assert.doesNotMatch(
    redactRemoteError('failed http://localhost/cb?code=abcdef123', 'invokeCapability', oauth),
    /abcdef123/
  );
  const mcpPaste = [
    {
      capability: 'completeMcpOAuthLogin',
      args: ['mcp_oauth_1', 'http://127.0.0.1:1/oauth/callback?code=mcpcode1234'],
    },
  ];
  assert.doesNotMatch(
    redactRemoteError('failed http://127.0.0.1:1/oauth/callback?code=mcpcode1234', 'invokeCapability', mcpPaste),
    /mcpcode1234/
  );
  const probe = [
    { capability: 'probeMcpServerAuth', args: [{ type: 'http', url: 'https://x.test', headers: { 'X-Key': secret } }] },
  ];
  assert.equal(redactRemoteError(`bad ${secret}`, 'invokeCapability', probe), 'bad [redacted]');
  assert.equal(
    redactRemoteError(`bad ${secret}`, 'invokeCapability', [{ capability: 'getSnapshot', args: [secret] }]),
    `bad ${secret}`
  );
});

test('a key echoed back in JSON-escaped form is redacted on the relay route too', async () => {
  const secret = 'sk-"quoted"\\back\tslash-0123';
  const escaped = JSON.stringify(secret).slice(1, -1);
  assert.notEqual(escaped, secret);
  const params = [
    { capability: 'saveCustomProviderKey', args: ['custom-0b0a8b3e-1111-4222-8333-444455556666', secret] },
  ];
  const message = `plain ${secret} and in json {"key":"${escaped}"}`;
  const safe = redactRemoteError(message, 'invokeCapability', params);
  assert.equal(safe, 'plain [redacted] and in json {"key":"[redacted]"}');
  // The whole frame: the error that reaches the relay carries neither spelling.
  const response = await executeRemoteFrame(
    {
      invokeCapability: async () => {
        throw new Error(message);
      },
    },
    JSON.stringify({ id: 1, method: 'invokeCapability', params })
  );
  assert.equal(response.ok, false);
  assert.ok(!response.error.includes(secret) && !response.error.includes(escaped));
});

test('ordinary capabilities are not blocked by the deny-list', () => {
  for (const capability of ['setModel', 'setWorkflow', 'listSessions', 'getSnapshot']) {
    assert.doesNotThrow(() => assertRemoteCapability(capability));
  }
});
