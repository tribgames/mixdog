import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeveloperSettings } from './settings-developer-api.mjs';

function fixture(initial = {}) {
  let config = initial;
  const saves = [];
  const syncs = [];
  const api = createDeveloperSettings({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      saves.push(next);
      config = next;
    },
    syncDeveloperOption: async (id) => {
      syncs.push(id);
    },
  });
  return { api, saves, syncs, config: () => config };
}

test('setDeveloperOption rejects unknown ids and non-boolean values without saving', async () => {
  delete process.env.MIXDOG_DEV_PROVIDERS;
  const f = fixture();
  await assert.rejects(f.api.setDeveloperOption('nope', true), TypeError);
  await assert.rejects(f.api.setDeveloperOption('devProviders', 'true'), TypeError);
  await assert.rejects(f.api.setDeveloperOption('devProviders', 1), TypeError);
  await assert.rejects(f.api.setDeveloperOption('devProviders'), TypeError);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.syncs, []);
});

test('setDeveloperOption saves developer.<id>, syncs, and returns the view', async () => {
  delete process.env.MIXDOG_DEV_PROVIDERS;
  const f = fixture({ profile: { title: 'Jay' }, developer: { other: true } });
  assert.equal(f.api.getDeveloperSettings().sections[0].options[0].enabled, false);
  const view = await f.api.setDeveloperOption('devProviders', true);
  assert.deepEqual(f.config(), { profile: { title: 'Jay' }, developer: { other: true, devProviders: true } });
  assert.deepEqual(f.syncs, ['devProviders']);
  assert.equal(view.sections[0].id, 'providers');
  assert.equal(view.sections[0].options[0].enabled, true);
  const off = await f.api.setDeveloperOption('devProviders', false);
  assert.equal(off.sections[0].options[0].enabled, false);
  assert.deepEqual(f.config().developer, { other: true, devProviders: false });
});
