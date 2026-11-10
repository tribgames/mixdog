// The remote surface's download stubs: gated on the host's `fileDownloads` advertisement (re-read per leg), handed to the protocol router
// as the Node method names, and failing with a typed reason the UI can show.
//
// Inputs and every observation are Node's: apps/mobile/fixtures/phone-shim/golden.json, recorded from b6f10295a by
// benchmarks/rust-core/recorders/record-phone-shim.mjs. Each test feeds the recorded inputs and compares what the page observed, whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';
import { wholeOutcome } from './test-support/whole-outcome.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-shim/golden.json', import.meta.url), 'utf8'));

test('a host that did not advertise fileDownloads refuses as host-too-old without a call', async () => {
  const { input, observed } = golden.downloads;
  const handlers = {
    fileDownloadAuthorize: () => {
      throw Object.assign(new Error(input.authorizeRefusal.error), { code: input.authorizeRefusal.errorCode });
    },
    fileDownloadRange: () => input.range.value,
  };
  await withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    const seen = {};
    seen.availableBeforeAdvertisement = api.fileDownloads.available();
    const refusedBefore = await api.fileDownloads.authorize(input.request).catch((error) => error);
    seen.reasonBeforeAdvertisement = fileDownloadErrorReason(refusedBefore);
    seen.outcomeBeforeAdvertisement = wholeOutcome(refusedBefore);
    seen.sentBeforeAdvertisement = calls.length;

    ctx.peerFileDownloads = true;
    seen.availableAfterAdvertisement = api.fileDownloads.available();
    const refusedAfter = await api.fileDownloads.authorize(input.request).catch((error) => error);
    seen.reasonAfterRefusal = fileDownloadErrorReason(refusedAfter);
    seen.outcomeAfterRefusal = wholeOutcome(refusedAfter);
    seen.authorizeParams = calls.at(-1).params;
    seen.rangeResult = wholeOutcome(await api.fileDownloads.readRange(...input.range.args));
    seen.rangeParams = calls.at(-1).params;

    ctx.peerFileDownloads = undefined;
    seen.availableAfterOlderHost = api.fileDownloads.available();
    assert.deepEqual(seen, observed);
  });
});

test('resolveLocalPaths forwards the conversation only when one is named', async () => {
  const { input, observed } = golden.resolveLocalPaths;
  await withPhoneApi({ resolveLocalPaths: () => [] }, async ({ api, calls }) => {
    await api.resolveLocalPaths(input.paths, input.sessionId);
    const namedParams = calls.at(-1).params;
    await api.resolveLocalPaths(input.paths);
    assert.deepEqual({ namedParams, plainParams: calls.at(-1).params }, observed);
  });
});
