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
  const f = fixture();
  await assert.rejects(f.api.setDeveloperOption('nope', true), TypeError);
  await assert.rejects(f.api.setDeveloperOption('antigravityOAuth', 'true'), TypeError);
  await assert.rejects(f.api.setDeveloperOption('antigravityOAuth', 1), TypeError);
  await assert.rejects(f.api.setDeveloperOption('antigravityOAuth'), TypeError);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.syncs, []);
});

test('Allow all actions is listed (off by default) and saved at developer.allowAllActions', async () => {
  const f = fixture({ developer: { antigravityOAuth: true } });
  const find = (view) =>
    view.sections
      .flatMap((section) => section.options.map((option) => [section.id, option]))
      .find(([, option]) => option.id === 'allowAllActions');
  const [sectionId, listed] = find(f.api.getDeveloperSettings());
  assert.equal(sectionId, 'approvals');
  assert.equal(listed.enabled, false);
  assert.match(listed.warning, /payments and permanent deletes/);
  const view = await f.api.setDeveloperOption('allowAllActions', true);
  assert.deepEqual(f.config().developer, { antigravityOAuth: true, allowAllActions: true });
  assert.deepEqual(f.syncs, ['allowAllActions']);
  assert.equal(find(view)[1].enabled, true);
  assert.equal((await f.api.setDeveloperOption('allowAllActions', false)).sections.length, 2);
  assert.equal(f.config().developer.allowAllActions, false);
});

test('setDeveloperOption saves developer.<id>, syncs, and returns the view', async () => {
  const f = fixture({ profile: { title: 'Jay' }, developer: { other: true } });
  const providers = (settings) => settings.sections.find((section) => section.id === 'providers');
  assert.equal(providers(f.api.getDeveloperSettings()).options[0].enabled, false);
  const view = await f.api.setDeveloperOption('antigravityOAuth', true);
  assert.deepEqual(f.config(), { profile: { title: 'Jay' }, developer: { other: true, antigravityOAuth: true } });
  assert.deepEqual(f.syncs, ['antigravityOAuth']);
  assert.equal(view.sections[0].id, 'approvals', 'Approvals lists first');
  assert.equal(providers(view).options[0].enabled, true);
  const off = await f.api.setDeveloperOption('antigravityOAuth', false);
  assert.equal(providers(off).options[0].enabled, false);
  assert.deepEqual(f.config().developer, { other: true, antigravityOAuth: false });
});
