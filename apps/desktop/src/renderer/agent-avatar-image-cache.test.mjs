import assert from 'node:assert/strict';
import test from 'node:test';
import { agentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  cachedAgentAvatarImages,
  forgetAgentAvatarImages,
  forgetHomeSessionAvatarImages,
} from './agent-avatar-image-cache.ts';

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

test("an agent's home session deleted for good releases that agent's images only", async () => {
  await cachedAgentAvatarImages('bot.one', 'f', () => Promise.resolve('bot'));
  await cachedAgentAvatarImages('other', 'f', () => Promise.resolve('other'));
  forgetHomeSessionAvatarImages(agentHomeSessionId('bot.one'));
  forgetHomeSessionAvatarImages('sess_plain');
  assert.equal(await cachedAgentAvatarImages('bot.one', 'f', () => Promise.resolve('reloaded')), 'reloaded');
  assert.equal(await cachedAgentAvatarImages('other', 'f', () => Promise.resolve('reloaded')), 'other');
});
