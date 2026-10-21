import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserApprovalGrants } from './approval-grants.ts';

function service(rows) {
  const calls = [];
  return {
    calls,
    readCapabilities: async (requests) => {
      calls.push(['read', requests[0].capability, requests[0].args]);
      return [{ ok: true, value: rows }];
    },
    invokeCapability: async (capability, args) => {
      calls.push(['write', capability, args]);
      return { value: null };
    },
  };
}

test('grants read the bot own permission table and write one allow per action', async () => {
  const host = service([
    { action: 'browser_submit', mode: 'allow', rememberable: true },
    { action: 'browser_post', mode: 'ask', rememberable: true },
    { action: 'browser_upload', mode: 'allow', rememberable: true },
  ]);
  const grants = createBrowserApprovalGrants(host);
  assert.equal(await grants.isAllowed('marketer', ['browser_submit']), true);
  assert.equal(await grants.isAllowed('marketer', ['browser_submit', 'browser_post']), false);
  assert.equal(await grants.isAllowed('marketer', ['browser_upload']), true);
  assert.deepEqual(host.calls[0], ['read', 'getAgentPermissions', ['marketer']]);
  await grants.remember('marketer', ['browser_submit', 'browser_post']);
  assert.deepEqual(
    host.calls.filter(([kind]) => kind === 'write'),
    [
      ['write', 'setAgentPermission', ['marketer', 'browser_submit', 'allow']],
      ['write', 'setAgentPermission', ['marketer', 'browser_post', 'allow']],
    ]
  );
});

test('audit writes bot, action and decision only, one line per action, and never throws', async () => {
  const host = service([]);
  const grants = createBrowserApprovalGrants(host);
  await grants.audit('marketer', ['browser_submit', 'browser_post'], 'granted');
  assert.deepEqual(host.calls, [
    ['write', 'recordAgentApprovalAudit', ['marketer', 'browser_submit', 'granted']],
    ['write', 'recordAgentApprovalAudit', ['marketer', 'browser_post', 'granted']],
  ]);
  const broken = createBrowserApprovalGrants({
    readCapabilities: async () => [],
    invokeCapability: async () => {
      throw new Error('audit down');
    },
  });
  await broken.audit('marketer', ['browser_submit'], 'approve');
});

test('a failing capability read is an error, never an allow', async () => {
  const grants = createBrowserApprovalGrants({
    readCapabilities: async () => [{ ok: false, error: 'daemon down' }],
    invokeCapability: async () => ({ value: null }),
  });
  await assert.rejects(grants.isAllowed('marketer', ['browser_submit']), /daemon down/);
});
