import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    /resolved to blocked private or internal address 192\.168\.1\.10/
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
    /could not be resolved for private-network validation/
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
    /too many concurrent browser DNS validations/
  );
  releasePending();
  await occupied;

  // A local session may open hosts that resolve to LAN/Tailscale addresses; a
  // remote one may not. Metadata endpoints are refused in both cases.
  for (const address of ['192.168.1.10', '100.101.102.103']) {
    const local = createBrowserUrlAdmission({
      policy: { allowPrivateNetwork: true },
      lookupAddresses: async () => [{ address }],
    });
    await local.assertResolvedUrlAllowed('https://nas.example.test/');
    await local.assertResolvedUrlAllowed(`http://${address}/`);
    const remote = createBrowserUrlAdmission({
      policy: { allowPrivateNetwork: false },
      lookupAddresses: async () => [{ address }],
    });
    await assert.rejects(remote.assertResolvedUrlAllowed('https://nas.example.test/'), /blocked private or internal/);
    await assert.rejects(remote.assertResolvedUrlAllowed(`http://${address}/`), /private or internal/);
  }
  for (const allowPrivateNetwork of [true, false]) {
    const metadata = createBrowserUrlAdmission({
      policy: { allowPrivateNetwork },
      lookupAddresses: async () => [{ address: '169.254.169.254' }],
    });
    await assert.rejects(metadata.assertResolvedUrlAllowed('https://rebind.example.test/'), /cloud metadata endpoint/);
    await assert.rejects(metadata.assertResolvedUrlAllowed('http://169.254.169.254/'), /cloud metadata endpoints/);
  }

  const socketAdmission = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => [{ address: '93.184.216.34' }],
  });
  await socketAdmission.assertResolvedResourceUrlAllowed('wss://socket.example.test/live');
  await assert.rejects(
    socketAdmission.assertResolvedResourceUrlAllowed('ws://169.254.169.254/latest/meta-data'),
    /cloud metadata endpoints is blocked/
  );
});

/** The corpus the Rust crate mixdog-browser-policy replays as well (native/core/fixtures/browser-parity). */
const corpus = JSON.parse(
  readFileSync(new URL('../../../../../native/core/fixtures/browser-parity/url-admission.json', import.meta.url), 'utf8')
);

test('every case of the shared corpus gets the same verdict as the Rust twin', async () => {
  assert.ok(corpus.length > 40);
  for (const { case: name, input, expect } of corpus) {
    const lookupAddresses = async (host) => {
      const addresses = input.lookup[host];
      if (!addresses) throw new Error('no such host');
      return addresses.map((address) => ({ address }));
    };
    const admission = createBrowserUrlAdmission({ policy: input.policy, lookupAddresses });
    let got;
    try {
      if (input.mode === 'url') {
        await admission.assertResolvedUrlAllowed(input.url, Boolean(input.pageGenerated));
        got = { ok: true };
      } else if (input.mode === 'resource') {
        await admission.assertResolvedResourceUrlAllowed(input.url);
        got = { ok: true };
      } else {
        let link;
        if (input.mailLink) {
          const { ageMs, ...rest } = input.mailLink;
          link = { ...rest, read_at: Date.now() - ageMs };
        }
        got = { ok: await admission.validatedAgentUrl(input.url, link) };
      }
    } catch (error) {
      got = { error: error.message };
    }
    assert.deepEqual(got, expect, name);
  }
});
