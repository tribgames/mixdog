import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSearchCatalog } from '../../../../session-runtime/provider-models/web-search-catalog.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { GeminiProvider } from './gemini.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';

const ENV_KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function memoryCache() {
  const state = { saved: null };
  return {
    state,
    loadSync: () => state.saved,
    save: (models) => {
      state.saved = models;
    },
  };
}

function geminiFetch(urls) {
  return async (url) => {
    urls.push(String(url));
    if (String(url).includes('generativelanguage.googleapis.com/v1beta/models')) {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-9.0-flash',
              displayName: 'Gemini 9 Flash',
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1000,
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };
}

test('keyless-constructed Gemini refreshes and lists the catalog with the stored key', async () => {
  await withEnv({ GEMINI_API_KEY: 'stored-gemini' }, async () => {
    const created = [];
    for (const method of ['_refreshModelCache', 'listModels']) {
      const urls = [];
      const modelCache = memoryCache();
      const provider = new GeminiProvider({
        enabled: true,
        fetchFn: geminiFetch(urls),
        modelCache,
        preconnectFn: () => {},
        createGenAI: (key) => {
          created.push(key);
          return {};
        },
      });
      const models = await provider[method]();
      assert.ok(
        models.some((m) => m.id === 'gemini-9.0-flash'),
        method
      );
      assert.ok(
        urls.some((u) => u.includes('key=stored-gemini')),
        method
      );
      assert.ok(modelCache.state.saved?.length, `${method} saved the catalog`);
    }
    assert.ok(created.every((key) => key === 'stored-gemini'));
  });
});

test('Gemini rebuilds its SDK client once a key appears after keyless construction', async () => {
  await withEnv({}, async () => {
    const created = [];
    const provider = new GeminiProvider({
      enabled: true,
      preconnectFn: () => {},
      createGenAI: (key) => {
        created.push(key);
        return { getGenerativeModel: () => ({}) };
      },
    });
    process.env.GEMINI_API_KEY = 'late-key';
    provider._currentGenAI();
    assert.equal(created.length, 2);
    assert.equal(created[1], 'late-key');
  });
});

test('Gemini _refreshModelCache rejects on fetch failure', async () => {
  await withEnv({ GEMINI_API_KEY: 'k' }, async () => {
    const provider = new GeminiProvider({
      enabled: true,
      fetchFn: async () => new Response('nope', { status: 500 }),
      modelCache: memoryCache(),
      preconnectFn: () => {},
      createGenAI: () => ({}),
    });
    await assert.rejects(() => provider._refreshModelCache(), /gemini list_models 500/);
  });
});

test('keyless-constructed Anthropic lists models with the stored key', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'stored-anthropic' }, async () => {
    const headers = [];
    globalThis.fetch = async (_url, init) => {
      headers.push(init.headers['x-api-key']);
      return new Response(JSON.stringify({ data: [{ id: 'claude-x', type: 'model' }] }), { status: 200 });
    };
    const provider = new AnthropicProvider({ enabled: true });
    assert.equal(await provider.isAvailable(), true);
    await provider.listModels();
    assert.deepEqual(headers, ['stored-anthropic']);
  });
});

test('keyless-constructed OpenAI listModels uses the stored key', async () => {
  await withEnv({ OPENAI_API_KEY: 'stored-openai' }, async () => {
    const auths = [];
    globalThis.fetch = async (_url, init) => {
      auths.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), { status: 200 });
    };
    const provider = new OpenAIDirectProvider({ enabled: true });
    assert.equal(await provider.isAvailable(), true);
    await provider.listModels();
    assert.deepEqual(auths, ['Bearer stored-openai']);
  });
});

test('keyless-constructed openai-compat provider fetches models with the stored key', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'stored-deepseek' }, async () => {
    const auths = [];
    globalThis.fetch = async (_url, init) => {
      auths.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-x' }] }), { status: 200 });
    };
    const provider = new OpenAICompatProvider('deepseek', { enabled: true, preconnect: false });
    const items = await provider._fetchModelItems();
    assert.deepEqual(items, [{ id: 'deepseek-x' }]);
    assert.deepEqual(auths, ['Bearer stored-deepseek']);
  });
});

test('web-search scanProvider falls back to listModels when a forced refresh fails', async () => {
  let listed = 0;
  const provider = {
    async _refreshModelCache() {
      throw new Error('catalog refresh failed');
    },
    async listModels() {
      listed += 1;
      return [{ id: 'gemini-9.0-flash', provider: 'gemini' }];
    },
  };
  const catalog = createWebSearchCatalog({
    caches: {},
    config: () => ({ providers: { gemini: { enabled: true } } }),
    reg: () => ({ getProvider: () => provider }),
    meta: { remember() {} },
    rows: { providerModelCacheRow: (_name, m) => ({ ...m, supportsWebSearch: true }) },
    quickHelpers: { addDefaultWebSearchModel() {} },
    normalizeWebSearchProviderId: (id) => id,
    isWebSearchCapableProvider: () => true,
    ensureFullConfig() {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
  });
  const rows = await catalog.loadWebSearchProviderModelsFresh({ forceRefresh: true });
  assert.equal(listed, 1);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['gemini-9.0-flash']
  );
});

test('a keyless Gemini refresh does not stay memoized once a key appears', async () => {
  const savedProxy = process.env.MIXDOG_MODEL_PROXY;
  await withEnv({}, async () => {
    const urls = [];
    const modelCache = memoryCache();
    const provider = new GeminiProvider({
      enabled: true,
      fetchFn: geminiFetch(urls),
      modelCache,
      preconnectFn: () => {},
      createGenAI: () => ({}),
    });
    // Proxy client mode hides every stored credential: a genuinely keyless refresh.
    process.env.MIXDOG_MODEL_PROXY = 'client';
    try {
      assert.equal(await provider._refreshModelCache(), null);
    } finally {
      if (savedProxy === undefined) delete process.env.MIXDOG_MODEL_PROXY;
      else process.env.MIXDOG_MODEL_PROXY = savedProxy;
    }
    assert.equal(urls.length, 0);
    process.env.GEMINI_API_KEY = 'late-gemini';
    const models = await provider._refreshModelCache();
    assert.ok(models?.some((m) => m.id === 'gemini-9.0-flash'));
    assert.ok(urls.some((u) => u.includes('key=late-gemini')));
  });
});
