// Pairing approval is the trust, so a paired client has the desktop's own
// capabilities. The deny-list holds only host-internal items.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES } from '../shared/contract.ts';
import { DESKTOP_IMPORT_CAPABILITIES } from '../shared/contract-import.ts';
import { assertRemoteCapability, redactRemoteError, REMOTE_BLOCKED_CAPABILITIES } from './remote-methods.ts';

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
    'saveOpenCodeGoUsageAuth',
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
    { capability: 'completeMcpOAuthLogin', args: ['mcp_oauth_1', 'http://127.0.0.1:1/oauth/callback?code=mcpcode1234'] },
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

test('ordinary capabilities are not blocked by the deny-list', () => {
  for (const capability of ['setModel', 'setWorkflow', 'listSessions', 'getSnapshot']) {
    assert.doesNotThrow(() => assertRemoteCapability(capability));
  }
});
