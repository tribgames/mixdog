// A refusal's `code` is what the grant refresh acts on, not the message text: the adapter's error carries the core's code and the page
// links the file again only for the grant code.
//
// Inputs and every observation are Node's: apps/mobile/fixtures/phone-shim/golden.json, recorded from b6f10295a by
// benchmarks/rust-core/recorders/record-phone-shim.mjs. Each test feeds a recorded refusal and compares what the page observed, whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const { input, observed } = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-shim/golden.json', import.meta.url), 'utf8')).grant;

async function openAfterRefusal(refusal) {
  let reads = 0;
  const handlers = {
    readProjectFile: () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error(refusal.error), { code: refusal.errorCode });
      return input.retryValue;
    },
    resolveLocalPaths: () => input.regrant,
  };
  return withPhoneApi(handlers, async ({ api, calls }) => {
    const result = await api.readProjectFile(...input.read).catch((error) => error);
    const asked = calls.find((call) => call.method === 'resolveLocalPaths');
    const retried = calls.filter((call) => call.method === 'readProjectFile')[1];
    return {
      resolveParams: asked?.params ?? null,
      retryParams: retried?.params.slice(0, 3) ?? null,
      result: { content: result.content ?? null, code: result.code ?? null },
    };
  });
}

for (const { refusal, observed: recorded } of observed) {
  test(`a refusal with code ${refusal.errorCode} (${JSON.stringify(refusal.error)}) is handled as Node's page handled it`, async () => {
    assert.deepEqual(await openAfterRefusal(refusal), recorded);
  });
}
