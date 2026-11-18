import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostMainRoute } from './draft-pane-prefs-store.ts';
import {
  acknowledgeLeadRoute,
  listPresetsShared,
  resetSidebarReferenceCache,
  subscribePresetsPushes,
} from './sidebar-reference-cache.ts';
import { leadRouteFrom } from './workflows-main-route.ts';

const lead = (extra) => [
  { id: 'workflow-lead', name: 'WORKFLOW LEAD', type: 'agent', provider: 'openai-oauth', model: 'gpt-x', tools: 'full', ...extra },
];

/** A window on a core connection: presets come from the pushed section; the shell snapshot predates the save. */
function coreHost(presets) {
  let push = () => undefined;
  let revision = 1;
  const api = {
    getSnapshot: async () => ({ provider: 'openai-oauth', model: 'old-model', fast: true }),
    invokeCapability: async () => {
      throw new Error('presets are read from the section');
    },
    sections: {
      core: async () => true,
      snapshot: async () => ({
        status: 'connected',
        entries: [{ section: 'presets', key: null, revision, value: presets }],
      }),
      subscribe(listener) {
        push = listener;
        return () => undefined;
      },
    },
  };
  const publish = (value) => {
    revision += 1;
    push({ kind: 'changes', changes: [{ section: 'presets', key: null, entry: { section: 'presets', key: null, revision, value } }] });
  };
  return { api, publish };
}

test('an inheriting New task reads the saved Lead and its speed, not the older shell snapshot', async () => {
  const ultra = coreHost(lead({ fast: true, modelParameters: { serviceTier: 'ultrafast' } }));
  const route = await readHostMainRoute(ultra.api);
  assert.equal(route.model, 'gpt-x');
  assert.equal(route.fast, true);
  assert.deepEqual(route.modelParameters, { serviceTier: 'ultrafast' });
  const standard = coreHost(lead({ fast: false }));
  assert.equal((await readHostMainRoute(standard.api)).fast, false, 'an explicit Standard is not the old Fast');
});

test('a Lead published after its save answers is read again', async () => {
  const host = coreHost(lead({ fast: true, modelParameters: { serviceTier: 'priority' } }));
  assert.deepEqual((await readHostMainRoute(host.api)).modelParameters, { serviceTier: 'priority' });
  let reread = null;
  const stop = subscribePresetsPushes(host.api, () => {
    reread = readHostMainRoute(host.api);
  });
  try {
    host.publish(lead({ fast: true, modelParameters: { serviceTier: 'ultrafast' } }));
    assert.ok(reread, 'the push re-reads the Lead');
    assert.deepEqual((await reread).modelParameters, { serviceTier: 'ultrafast' });
  } finally {
    stop();
  }
});

const SAVED = { provider: 'openai-oauth', model: 'gpt-x', fast: true, modelParameters: { serviceTier: 'ultrafast' } };

test('an answered Lead save outlives the presets section until the core publishes it', async (t) => {
  t.after(() => resetSidebarReferenceCache());
  const host = coreHost(lead({ fast: false }));
  acknowledgeLeadRoute(host.api, SAVED);
  const stale = await readHostMainRoute(host.api);
  assert.equal(stale.fast, true, 'the section still holding the older Lead does not win');
  assert.deepEqual(stale.modelParameters, { serviceTier: 'ultrafast' });
  // A later write published after the save: the push is the newer truth.
  host.publish(lead({ fast: true, modelParameters: { serviceTier: 'priority' } }));
  assert.deepEqual((await readHostMainRoute(host.api)).modelParameters, { serviceTier: 'priority' });
});

test('slot 2 edited alone: reopening keeps slot 1 at its speed until the save is published', async (t) => {
  t.after(() => resetSidebarReferenceCache());
  const slot1 = { fast: true, modelParameters: { serviceTier: 'ultrafast' } };
  const slot2 = (fast) => ({ provider: 'anthropic-oauth', model: 'claude-opus-4-5', fast });
  const other = { id: 'mine', name: 'MINE', provider: 'p', model: 'm' };
  const before = [...lead({ ...slot1, fallbacks: [slot2(false)] }), other];
  const host = coreHost(before);
  await readHostMainRoute(host.api); // the store holds the section: the baseline is known
  acknowledgeLeadRoute(host.api, { provider: 'openai-oauth', model: 'gpt-x', ...slot1, fallbacks: [slot2(true)] });
  const reopened = async () => leadRouteFrom({}, (await listPresetsShared(host.api)).value);
  // An unrelated preset change, then the older Lead pushed again: neither is this save.
  host.publish([...lead({ ...slot1, fallbacks: [slot2(false)] }), { ...other, model: 'm2' }]);
  host.publish(before);
  for (const route of [await reopened(), await readHostMainRoute(host.api)]) {
    assert.deepEqual([route.fast, route.modelParameters], [true, { serviceTier: 'ultrafast' }], 'slot 1');
    assert.equal(route.fallbacks[0].fast, true, 'slot 2');
  }
  // The publication of the save.
  host.publish([...lead({ ...slot1, fallbacks: [slot2(true)], effort: 'high' }), other]);
  const published = await reopened();
  assert.equal(published.effort, 'high', 'the published Lead is read, not the acknowledgement');
  assert.deepEqual([published.fast, published.modelParameters, published.fallbacks[0].fast], [true, { serviceTier: 'ultrafast' }, true]);
});

test('a host preset read started before the save answered never replaces it', async (t) => {
  t.after(() => resetSidebarReferenceCache());
  let presets = lead({ fast: false });
  const pending = [];
  const api = {
    getSnapshot: async () => null,
    invokeCapability: () => new Promise((resolve) => pending.push(() => resolve({ value: presets }))),
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const before = listPresetsShared(api);
  await tick();
  acknowledgeLeadRoute(api, SAVED);
  pending.shift()();
  assert.equal(leadRouteFrom({}, (await before).value).fast, true, 'the older read shows the save');
  presets = lead({ fast: true, modelParameters: { serviceTier: 'priority' } });
  const after = listPresetsShared(api);
  await tick();
  pending.shift()();
  const route = leadRouteFrom({}, (await after).value);
  assert.deepEqual(route.modelParameters, { serviceTier: 'priority' }, 'a host read after the answer is the host');
});

test('an inheriting draft keeps the resolved context of the same model only', () => {
  const presets = lead({ fast: true });
  const same = leadRouteFrom({ provider: 'openai-oauth', model: 'gpt-x', contextPercent: 50, contextTokens: 500000 }, presets);
  assert.deepEqual([same.contextPercent, same.contextTokens], [50, 500000]);
  const other = leadRouteFrom({ provider: 'openai-oauth', model: 'old-model', contextPercent: 50, contextTokens: 500000 }, presets);
  assert.deepEqual([other.contextPercent, other.contextTokens], [undefined, undefined], 'never another model’s');
});
