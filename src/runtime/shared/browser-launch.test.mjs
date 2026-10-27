import assert from 'node:assert/strict';
import test from 'node:test';

import { launchPuppeteerBrowser } from './browser-launch.mjs';

const launchTimeout = () =>
  Object.assign(new Error('Timed out waiting for the WS endpoint URL'), { name: 'TimeoutError' });

function fakePuppeteer(outcomes) {
  const calls = [];
  return {
    calls,
    async launch(options) {
      calls.push(options);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

test('a launch that times out is retried once with the same options', async () => {
  const browser = { id: 'browser' };
  const puppeteer = fakePuppeteer([launchTimeout(), browser]);
  const options = { headless: true };
  assert.equal(await launchPuppeteerBrowser(puppeteer, options), browser);
  assert.deepEqual(puppeteer.calls, [options, options]);
});

test('a second launch timeout is reported, not retried again', async () => {
  const puppeteer = fakePuppeteer([launchTimeout(), launchTimeout(), { id: 'unused' }]);
  await assert.rejects(launchPuppeteerBrowser(puppeteer, {}), { name: 'TimeoutError' });
  assert.equal(puppeteer.calls.length, 2);
});

test('a launch that times out after its signal aborted is not retried', async () => {
  const puppeteer = fakePuppeteer([launchTimeout(), { id: 'unused' }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchPuppeteerBrowser(puppeteer, {}, { signal: controller.signal }), { name: 'TimeoutError' });
  assert.equal(puppeteer.calls.length, 1);
});

test('a launch error that is not a timeout is not retried', async () => {
  const puppeteer = fakePuppeteer([new Error('Could not find Chrome'), { id: 'unused' }]);
  await assert.rejects(launchPuppeteerBrowser(puppeteer, {}), /Could not find Chrome/);
  assert.equal(puppeteer.calls.length, 1);
});
