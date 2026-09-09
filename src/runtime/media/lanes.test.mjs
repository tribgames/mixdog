import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaLaneCatalog } from './lanes.mjs';
import { listMediaCatalog } from './tool.mjs';

test('Studio listing and generation validation use the same refreshed provider catalog', async () => {
  let models = [{ id: 'gpt-6-astra', display: 'GPT-6 Astra' }];
  const catalog = createMediaLaneCatalog({
    authenticated: (lane) => lane.id === 'openai-oauth',
    loadModels: async () => models,
  });
  const rows = await catalog.listMediaLanes();
  const lane = rows.find((row) => row.id === 'openai-oauth');
  assert.equal(lane.image.defaultModel, 'chatgpt-image-auto');
  assert.equal(lane.image.models[0].label, 'ChatGPT Image · Auto');
  assert.equal(lane.image.models[0].requestModel, 'gpt-6-astra');
  const request = await catalog.resolveMediaRequest({ lane: lane.id, kind: 'image' });
  assert.equal(request.model, lane.image.defaultModel);
  assert.deepEqual(request.spec, lane.image);
  assert.deepEqual(request.spec.models[0].controls, { maxReferences: 5 });

  models = [{ id: 'gpt-7-mainline' }];
  const fresh = await catalog.resolveMediaRequest({ lane: lane.id, kind: 'image', model: 'chatgpt-image-auto' });
  assert.equal(fresh.spec.models[0].requestModel, 'gpt-7-mainline', 'automatic image routing follows the refreshed account catalog');
  await assert.rejects(catalog.resolveMediaRequest({
    lane: lane.id, kind: 'image', model: 'gpt-6-astra',
  }), { code: 'MEDIA_MODEL_UNSUPPORTED' });
});

test('billing-blocked connections are quietly excluded and return after recovery', async (t) => {
  const { catalogHttpError } = await import('./catalog-errors.mjs');
  const diagnostics = [];
  t.mock.method(console, 'warn', message => diagnostics.push(message));
  let blocked = true;
  const catalog = createMediaLaneCatalog({
    authenticated: () => true,
    loadModels: async lane => {
      if (lane === 'xai' && blocked) throw catalogHttpError(403, '{"error":"team private-id has no credits"}');
      return [{ id: 'grok-imagine-image' }];
    },
  });
  const lanes = await catalog.listMediaLanes();
  assert.equal(lanes.some(row => row.id === 'xai'), false);
  assert.equal(lanes.find(row => row.id === 'grok-oauth').image.models.length, 1);
  for (const kind of ['', 'image', 'video']) {
    const listed = listMediaCatalog(lanes, { kind });
    assert.equal(listed.lanes.some(row => row.id === 'xai'), false);
    assert.equal(listed.catalogErrors, undefined);
    assert.equal(listed.catalogWarnings, undefined);
    assert.doesNotMatch(JSON.stringify(listed), /credits|billing|private-id/i);
  }
  for (const kind of ['image', 'video']) {
    await assert.rejects(catalog.resolveMediaRequest({ lane: 'xai', kind }), {
      code: 'MEDIA_MODEL_UNSUPPORTED',
      message: 'The selected media model is not available.',
    });
  }
  assert.ok(diagnostics.some(message => /lane=xai code=MEDIA_BILLING_BLOCKED/.test(message)));
  assert.doesNotMatch(diagnostics.join('\n'), /private-id/);
  blocked = false;
  const recovered = (await catalog.listMediaLanes()).find(row => row.id === 'xai');
  assert.equal(recovered.image.models[0].id, 'grok-imagine-image');
});

test('signed-out lanes never discover models; one provider outage does not hide another lane', async () => {
  const queried = [];
  const catalog = createMediaLaneCatalog({
    authenticated: (lane) => lane.id === 'gemini' || lane.id === 'xai',
    loadModels: async (lane) => {
      queried.push(lane);
      if (lane === 'xai') throw new Error('sensitive upstream detail');
      return [
        { name: 'models/gemini-omni-1.1-flash' },
        { name: 'models/veo-3.1-generate-preview' },
        { name: 'models/gemini-3.1-flash-lite-image' },
      ];
    },
  });
  const rows = await catalog.listMediaLanes();
  assert.deepEqual(queried.sort(), ['gemini', 'xai']);
  const gemini = rows.find((lane) => lane.id === 'gemini');
  assert.deepEqual(gemini.kinds, ['image', 'video']);
  assert.equal(gemini.video.models[0].controls.maxReferences, 3);
  assert.equal(gemini.video.models[1].controls.maxReferences, 1);
  assert.deepEqual(gemini.video.models[1].controls.durations, [4, 6, 8]);
  const xai = rows.find((lane) => lane.id === 'xai');
  assert.equal(xai.authenticated, true);
  assert.deepEqual(xai.kinds, []);
  assert.match(xai.catalogError, /catalog unavailable/);
  assert.doesNotMatch(xai.catalogError, /sensitive/);
  assert.equal(listMediaCatalog(rows).catalogErrors[0].lane, 'xai');
  await assert.rejects(catalog.resolveMediaRequest({ lane: 'xai', kind: 'image' }), { code: 'MEDIA_CATALOG_UNAVAILABLE' });
  await assert.rejects(catalog.resolveMediaRequest({ lane: 'openai-oauth', kind: 'image' }), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
});
