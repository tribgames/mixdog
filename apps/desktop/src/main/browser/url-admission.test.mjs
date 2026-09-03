import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserUrlAdmission } from './url-admission.ts';

test('browser URL admission rechecks completed DNS answers and coalesces only concurrent lookups', async () => {
  let calls = 0;
  let releaseFirst;
  const firstLookup = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const admission = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => {
      calls += 1;
      if (calls === 1) {
        await firstLookup;
        return [{ address: '93.184.216.34' }];
      }
      return [{ address: '192.168.1.10' }];
    },
  });
  const first = admission.assertResolvedUrlAllowed('https://rebind.example.test/');
  const concurrent = admission.assertResolvedUrlAllowed('https://rebind.example.test/image.png');
  releaseFirst();
  await Promise.all([first, concurrent]);
  assert.equal(calls, 1, 'concurrent requests should share one DNS lookup');

  await assert.rejects(
    admission.assertResolvedUrlAllowed('https://rebind.example.test/private'),
    /resolved to blocked private or internal address 192\.168\.1\.10/,
  );
  await admission.assertResolvedUrlAllowed('http://[::1]:8080/fixture');
  assert.equal(calls, 2, 'a later request must recheck DNS after the first lookup completed');

  const unresolved = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => {
      throw new Error('fixture DNS failure');
    },
  });
  await assert.rejects(
    unresolved.assertResolvedUrlAllowed('https://unresolved.example.test/'),
    /could not be resolved for private-network validation/,
  );

  let releasePending;
  const pendingLookup = new Promise((resolve) => {
    releasePending = resolve;
  });
  const bounded = createBrowserUrlAdmission({
    policy: {},
    maxPendingResolutions: 1,
    lookupAddresses: async () => {
      await pendingLookup;
      return [{ address: '93.184.216.34' }];
    },
  });
  const occupied = bounded.assertResolvedUrlAllowed('https://one.example.test/');
  await assert.rejects(
    bounded.assertResolvedUrlAllowed('https://two.example.test/'),
    /too many concurrent browser DNS validations/,
  );
  releasePending();
  await occupied;

  const socketAdmission = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => [{ address: '93.184.216.34' }],
  });
  await socketAdmission.assertResolvedResourceUrlAllowed('wss://socket.example.test/live');
  await assert.rejects(
    socketAdmission.assertResolvedResourceUrlAllowed('ws://169.254.169.254/latest/meta-data'),
    /cloud metadata endpoints is blocked/,
  );
});
