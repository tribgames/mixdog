import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

const request = (capability, args) => requiredDesktopCapabilityRequest({ capability, args });

test('Studio board capabilities take bounded string names and ids; only null clears a board', () => {
  for (const [capability, args] of [
    ['createMediaBoard', ['Gacha']],
    ['renameMediaBoard', ['b-1', 'Icons']],
    ['deleteMediaBoard', ['b-1']],
    ['setMediaAssetBoard', [['a-1', 'a-2'], 'b-1']],
    ['setMediaAssetBoard', [['a-1'], null]],
  ]) {
    assert.doesNotThrow(() => request(capability, args), `${capability} ${JSON.stringify(args)}`);
  }
  for (const [capability, args] of [
    ['createMediaBoard', [{}]],
    ['createMediaBoard', ['  ']],
    ['createMediaBoard', ['x'.repeat(121)]],
    ['renameMediaBoard', [17, []]],
    ['renameMediaBoard', ['b-1', {}]],
    ['deleteMediaBoard', [{}]],
    ['deleteMediaBoard', ['x'.repeat(129)]],
    ['setMediaAssetBoard', [{}, false]],
    ['setMediaAssetBoard', [['a-1'], false]],
    ['setMediaAssetBoard', [['a-1'], '']],
    ['setMediaAssetBoard', [[], 'b-1']],
    ['setMediaAssetBoard', [[3], 'b-1']],
  ]) {
    assert.throws(() => request(capability, args), TypeError, `${capability} ${JSON.stringify(args)}`);
  }
});
