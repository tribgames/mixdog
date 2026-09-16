import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMediaLaneCatalog } from './lanes.mjs';
import { listMediaCatalog } from './tool.mjs';
import { oauthCredentialProbeState } from '../agent/orchestrator/providers/oauth-credential-probes.mjs';
import {
  changeProviderAccounts,
  newProviderAccountId,
  providerAccountPath,
  registerProviderAccount,
} from '../shared/provider-accounts.mjs';
import { replaceProviderAuthBindings, withProviderAccount } from '../shared/provider-auth-binding.mjs';

function openAIAuthFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-studio-auth-'));
  const previous = {
    MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    OPENAI_OAUTH_CREDENTIALS_PATH: process.env.OPENAI_OAUTH_CREDENTIALS_PATH,
  };
  const restoreBindings = replaceProviderAuthBindings({});
  t.after(() => {
    restoreBindings();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = join(dir, 'explicit-openai.json');
  const catalog = createMediaLaneCatalog({
    loadModels: async () => [{ id: 'gpt-6-astra' }],
  });
  return {
    dir,
    resolve: () => catalog.resolveMediaRequest({ lane: 'openai-oauth', kind: 'image' }),
    writeTokens(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
        }),
        { mode: 0o600 }
      );
    },
  };
}

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
  assert.equal(
    fresh.spec.models[0].requestModel,
    'gpt-7-mainline',
    'automatic image routing follows the refreshed account catalog'
  );
  await assert.rejects(
    catalog.resolveMediaRequest({
      lane: lane.id,
      kind: 'image',
      model: 'gpt-6-astra',
    }),
    { code: 'MEDIA_MODEL_UNSUPPORTED' }
  );
});

test('billing-blocked connections are quietly excluded and return after recovery', async (t) => {
  const { catalogHttpError } = await import('./catalog-errors.mjs');
  const diagnostics = [];
  t.mock.method(console, 'warn', (message) => diagnostics.push(message));
  let blocked = true;
  const catalog = createMediaLaneCatalog({
    authenticated: () => true,
    loadModels: async (lane) => {
      if (lane === 'xai' && blocked) throw catalogHttpError(403, '{"error":"team private-id has no credits"}');
      return [{ id: 'grok-imagine-image' }];
    },
  });
  const lanes = await catalog.listMediaLanes();
  assert.equal(
    lanes.some((row) => row.id === 'xai'),
    false
  );
  assert.equal(lanes.find((row) => row.id === 'grok-oauth').image.models.length, 1);
  for (const kind of ['', 'image', 'video']) {
    const listed = listMediaCatalog(lanes, { kind });
    assert.equal(
      listed.lanes.some((row) => row.id === 'xai'),
      false
    );
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
  assert.ok(diagnostics.some((message) => /lane=xai code=MEDIA_BILLING_BLOCKED/.test(message)));
  assert.doesNotMatch(diagnostics.join('\n'), /private-id/);
  blocked = false;
  const recovered = (await catalog.listMediaLanes()).find((row) => row.id === 'xai');
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
  await assert.rejects(catalog.resolveMediaRequest({ lane: 'xai', kind: 'image' }), {
    code: 'MEDIA_CATALOG_UNAVAILABLE',
  });
  await assert.rejects(catalog.resolveMediaRequest({ lane: 'openai-oauth', kind: 'image' }), {
    code: 'MEDIA_LANE_UNAUTHENTICATED',
  });
});

test('Studio recognizes selected-account login and logout immediately without recreating the catalog', async (t) => {
  const auth = openAIAuthFixture(t);
  const id = newProviderAccountId();
  registerProviderAccount('openai-oauth', id);
  const path = providerAccountPath('openai-oauth', id);

  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
  auth.writeTokens(path);
  const request = await auth.resolve();
  assert.equal(request.lane.authenticated, true);
  assert.equal(request.model, 'chatgpt-image-auto');
  unlinkSync(path);
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
});

test('Studio follows account switches and scoped accounts without borrowing default credentials', async (t) => {
  const auth = openAIAuthFixture(t);
  const ready = newProviderAccountId();
  const missing = newProviderAccountId();
  registerProviderAccount('openai-oauth', ready);
  registerProviderAccount('openai-oauth', missing);
  auth.writeTokens(providerAccountPath('openai-oauth', ready));
  auth.writeTokens(join(auth.dir, 'openai-oauth.json'));
  auth.writeTokens(process.env.OPENAI_OAUTH_CREDENTIALS_PATH);

  assert.equal((await auth.resolve()).lane.authenticated, true);
  changeProviderAccounts('openai-oauth', { selectedId: missing });
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
  await withProviderAccount('openai-oauth', ready, async () => {
    assert.equal((await auth.resolve()).lane.authenticated, true);
  });
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
  changeProviderAccounts('openai-oauth', { selectedId: ready });
  assert.equal((await auth.resolve()).lane.authenticated, true);
});

test('Studio honors an explicit host binding ahead of the selected account and environment', async (t) => {
  const auth = openAIAuthFixture(t);
  const selected = newProviderAccountId();
  registerProviderAccount('openai-oauth', selected);
  auth.writeTokens(providerAccountPath('openai-oauth', selected));
  auth.writeTokens(process.env.OPENAI_OAUTH_CREDENTIALS_PATH);
  auth.writeTokens(join(auth.dir, 'openai-oauth.json'));
  const path = join(auth.dir, 'host-openai.json');
  const restore = replaceProviderAuthBindings({ 'openai-oauth': path });
  try {
    await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
    auth.writeTokens(path);
    assert.equal((await auth.resolve()).lane.authenticated, true);
    const scoped = newProviderAccountId();
    await withProviderAccount('openai-oauth', scoped, async () => {
      await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
      auth.writeTokens(providerAccountPath('openai-oauth', scoped));
      assert.equal((await auth.resolve()).lane.authenticated, true);
    });
    assert.equal((await auth.resolve()).lane.authenticated, true);
  } finally {
    restore();
  }
});

test('Studio retains default-account login while respecting an explicit credential path', async (t) => {
  const auth = openAIAuthFixture(t);
  const explicit = process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
  auth.writeTokens(join(auth.dir, 'openai-oauth.json'));

  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
  delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
  assert.equal((await auth.resolve()).lane.authenticated, true);
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = explicit;
  auth.writeTokens(explicit);
  assert.equal((await auth.resolve()).lane.authenticated, true);
  unlinkSync(explicit);
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
});

test('Studio fails closed on incomplete or unreadable selected credentials and recovers after repair', async (t) => {
  const auth = openAIAuthFixture(t);
  const id = newProviderAccountId();
  registerProviderAccount('openai-oauth', id);
  const path = providerAccountPath('openai-oauth', id);
  auth.writeTokens(join(auth.dir, 'openai-oauth.json'));
  auth.writeTokens(process.env.OPENAI_OAUTH_CREDENTIALS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ access_token: 'incomplete-test-token' }));
  assert.equal(oauthCredentialProbeState('openai-oauth'), 'absent');
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });

  writeFileSync(path, '{invalid-json');
  assert.equal(oauthCredentialProbeState('openai-oauth'), 'unreadable');
  await assert.rejects(auth.resolve(), { code: 'MEDIA_LANE_UNAUTHENTICATED' });
  auth.writeTokens(path);
  assert.equal(oauthCredentialProbeState('openai-oauth'), 'present');
  assert.equal((await auth.resolve()).lane.authenticated, true);
});
