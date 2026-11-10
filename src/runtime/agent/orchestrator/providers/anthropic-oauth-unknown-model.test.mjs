import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// What the live catalog offers after a refresh.
const CATALOG = Object.freeze([
  Object.freeze({ id: 'claude-opus-5', family: 'opus', tier: 'version', contextWindow: 200_000 }),
  Object.freeze({ id: 'claude-sonnet-5', family: 'sonnet', tier: 'version', contextWindow: 200_000 }),
]);

async function withProvider(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-unknown-model-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    const { AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
    const { _setInMemoryCatalog } = await import('./anthropic-model-resolve.mjs');
    const provider = Object.create(AnthropicOAuthProvider.prototype);
    provider.config = {};
    provider.fastModeBetaHeaderLatched = false;
    provider.ensureAuth = async () => ({ accessToken: 'test-access-token' });
    provider.scrubTokens = (text) => String(text || '');
    await run(provider, _setInMemoryCatalog);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

// First attempt is refused with the model-not-found shape; any later attempt
// succeeds, so the model each attempt asked for is what the test reads.
function requestSequence(models) {
  return async (_token, _signal, body) => {
    models.push(body.model);
    const controller = new AbortController();
    if (models.length > 1) {
      return {
        controller,
        cancelHandler: null,
        response: { status: 200, ok: true, headers: new Headers(), text: async () => '' },
      };
    }
    return {
      controller,
      cancelHandler: null,
      response: {
        status: 404,
        ok: false,
        headers: new Headers(),
        text: async () => '{"type":"error","error":{"type":"not_found_error","message":"model not found"}}',
      },
    };
  };
}

function sendWith(provider, model, { models, stages, refresh }) {
  provider._refreshModelCache = refresh;
  return provider.send([{ role: 'user', content: 'hello' }], model, [], {
    _doRequestFn: requestSequence(models),
    _parseSSEFn: async () => ({ model, content: 'answer', usage: { inputTokens: 1 } }),
    onStageChange: (stage, detail) => stages.push({ stage, detail }),
  });
}

const swapNotices = (stages) =>
  stages.map((entry) => String(entry.detail?.message || '')).filter((message) => /no longer offered/.test(message));

test('a 404 for a model the catalog still lists retries the SAME model', async () => {
  await withProvider(async (provider, setCatalog) => {
    setCatalog(CATALOG);
    const models = [];
    const stages = [];
    const result = await sendWith(provider, 'claude-opus-5', {
      models,
      stages,
      refresh: async () => {
        setCatalog(CATALOG);
        return CATALOG;
      },
    });
    assert.equal(result.content, 'answer');
    // A permission/plan refusal must not be answered by a different model.
    assert.deepEqual(models, ['claude-opus-5', 'claude-opus-5']);
    assert.deepEqual(swapNotices(stages), []);
  });
});

test('a model the refreshed catalog dropped is replaced once and announced', async () => {
  await withProvider(async (provider, setCatalog) => {
    setCatalog([]);
    const models = [];
    const stages = [];
    const result = await sendWith(provider, 'claude-opus-4-8', {
      models,
      stages,
      refresh: async () => {
        setCatalog(CATALOG);
        return CATALOG;
      },
    });
    assert.equal(result.content, 'answer');
    assert.deepEqual(models, ['claude-opus-4-8', 'claude-opus-5']);
    assert.deepEqual(swapNotices(stages), ['claude-opus-4.8 is no longer offered — continuing on claude-opus-5']);
  });
});

test('a catalog refresh that failed keeps the requested model', async () => {
  await withProvider(async (provider, setCatalog) => {
    setCatalog(CATALOG);
    const models = [];
    const stages = [];
    // The id is absent from the catalog, but the refresh could not confirm
    // anything — "cannot tell" must never be read as "retired".
    const result = await sendWith(provider, 'claude-opus-4-8', {
      models,
      stages,
      refresh: async () => null,
    });
    assert.equal(result.content, 'answer');
    assert.deepEqual(models, ['claude-opus-4-8', 'claude-opus-4-8']);
    assert.deepEqual(swapNotices(stages), []);
  });
});
