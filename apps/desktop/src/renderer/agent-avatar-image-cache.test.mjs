import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedAgentAvatarImages, forgetAgentAvatarImages } from './agent-avatar-image-cache.ts';

test('an agent keeps only its current avatar images and none once deleted', async () => {
  let loads = 0;
  const load = (value) => () => {
    loads += 1;
    return Promise.resolve(value);
  };
  assert.equal(await cachedAgentAvatarImages('a', 'f1', load('one')), 'one');
  assert.equal(await cachedAgentAvatarImages('a', 'f1', load('again')), 'one');
  assert.equal(loads, 1);
  assert.equal(await cachedAgentAvatarImages('a', 'f2', load('two')), 'two');
  assert.equal(await cachedAgentAvatarImages('a', 'f1', load('three')), 'three', 'the older files were released');
  forgetAgentAvatarImages('a');
  assert.equal(await cachedAgentAvatarImages('a', 'f1', load('four')), 'four', 'a deleted agent holds nothing');
});
