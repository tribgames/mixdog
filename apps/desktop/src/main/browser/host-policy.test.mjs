import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBrowserTaskCleanupContext,
  browserLocalInputOptions,
  browserUrlPolicyFromEnvironment,
  browserViewportEmulation,
  pendingSessionWork,
} from './host-policy.ts';

test('URL policy reads the private-network flag and trimmed domain list from the environment', (t) => {
  const saved = {
    net: process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK,
    domains: process.env.MIXDOG_BROWSER_ALLOWED_DOMAINS,
  };
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK', saved.net],
      ['MIXDOG_BROWSER_ALLOWED_DOMAINS', saved.domains],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK = 'Yes';
  process.env.MIXDOG_BROWSER_ALLOWED_DOMAINS = ' a.test, ,b.test ';
  assert.deepEqual(browserUrlPolicyFromEnvironment({ remote: true }), {
    allowPrivateNetwork: true,
    allowedDomains: ['a.test', 'b.test'],
  });
  delete process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
  delete process.env.MIXDOG_BROWSER_ALLOWED_DOMAINS;
  assert.deepEqual(browserUrlPolicyFromEnvironment({ remote: true }), { allowPrivateNetwork: false, allowedDomains: [] });
});

test('private networks are allowed for a local session and blocked for a remote one unless the env forces them', (t) => {
  const saved = process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
    else process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK = saved;
  });
  delete process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
  assert.equal(browserUrlPolicyFromEnvironment({ remote: false }).allowPrivateNetwork, true);
  assert.equal(browserUrlPolicyFromEnvironment({ remote: true }).allowPrivateNetwork, false);
  process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK = '1';
  assert.equal(browserUrlPolicyFromEnvironment({ remote: true }).allowPrivateNetwork, true);
});

test('a fixed pane viewport emulates fully; a cleared one only resets', () => {
  const config = { width: 800, height: 600, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: null };
  assert.deepEqual(browserViewportEmulation(config), {
    action: 'emulate',
    reset: true,
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: '',
    orientation: 'landscape',
  });
  assert.equal(browserViewportEmulation({ ...config, width: 400 }).orientation, 'portrait');
  assert.deepEqual(browserViewportEmulation({ ...config, width: null }), { action: 'emulate', reset: true });
});

test('task cleanup context needs a session, a positive turn, and only the abort flag', () => {
  assert.doesNotThrow(() => assertBrowserTaskCleanupContext('s', 3, { action: 'finish_turn', aborted: true }));
  for (const [session, turn, input] of [
    ['', 3, {}],
    ['s', 0, {}],
    ['s', 1.5, {}],
    ['s', 3, { extra: 1 }],
  ]) {
    assert.throws(() => assertBrowserTaskCleanupContext(session, turn, input), /Invalid browser task cleanup context/);
  }
});

test('pending session work collects that session prefix only', () => {
  const a = Promise.resolve(1);
  const b = Promise.resolve(2);
  const c = Promise.resolve(3);
  const chains = new Map([
    ['session:x:fg', a],
    ['session:y:fg', c],
  ]);
  const reads = new Map([
    ['session:x:bg', new Set([b])],
    ['session:y:bg', new Set([c])],
  ]);
  assert.deepEqual(pendingSessionWork('session:x:', chains, reads), [a, b]);
});

test('local input options: hover drops, presses hold, releases and typing never expire', () => {
  assert.deepEqual(browserLocalInputOptions({ type: 'pointer', phase: 'mouseMoved', buttons: 0 }), {
    takeover: false,
    dropIfBusy: true,
    maxWaitMs: 2000,
  });
  assert.deepEqual(browserLocalInputOptions({ type: 'pointer', phase: 'mousePressed', buttons: 1 }), {
    takeover: true,
    dropIfBusy: false,
    held: true,
    maxWaitMs: 2000,
  });
  assert.deepEqual(browserLocalInputOptions({ type: 'pointer', phase: 'mouseReleased', buttons: 0 }), {
    takeover: true,
    dropIfBusy: false,
    held: false,
    maxWaitMs: undefined,
  });
  assert.equal(browserLocalInputOptions({ type: 'text', text: 'a' }).maxWaitMs, undefined);
});
