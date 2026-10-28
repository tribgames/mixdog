import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { VertexAccessTokenManager, VERTEX_SCOPE, VERTEX_TOKEN_URI } from './vertex-ai-auth.mjs';
import { VertexAIProvider } from './vertex-ai.mjs';

function serviceAccount() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'mixdog@test-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: VERTEX_TOKEN_URI,
  };
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function geminiSse(text = 'ok', usageMetadata = { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 }) {
  const chunk = {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata,
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function claudeSse(text = 'ok') {
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new Response(
    [
      frame({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      frame({ type: 'message_stop' }),
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

test('Vertex access tokens use an RS256 service-account JWT, cache, and refresh before expiry', async () => {
  const account = serviceAccount();
  let now = 1_800_000_000_000;
  const tokenRequests = [];
  const manager = new VertexAccessTokenManager({
    credentialResolver: () => JSON.stringify(account),
    now: () => now,
    fetchFn: async (url, init) => {
      tokenRequests.push({ url, init });
      return Response.json({ access_token: `token-${tokenRequests.length}`, expires_in: 3600 });
    },
  });

  assert.equal(await manager.getAccessToken(), 'token-1');
  assert.equal(await manager.getAccessToken(), 'token-1');
  assert.equal(tokenRequests.length, 1);
  const form = new URLSearchParams(tokenRequests[0].init.body);
  const [header, claims] = form.get('assertion').split('.');
  assert.equal(decodeJwtPart(header).alg, 'RS256');
  assert.equal(decodeJwtPart(claims).scope, VERTEX_SCOPE);
  assert.equal(decodeJwtPart(claims).aud, VERTEX_TOKEN_URI);

  now += 56 * 60_000;
  assert.equal(await manager.getAccessToken(), 'token-2');
  assert.equal(tokenRequests.length, 2);
});

test('Vertex Gemini routing reuses the Gemini body and bearer auth', async () => {
  const account = serviceAccount();
  const requests = [];
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(account),
    location: 'us-east5',
    projectId: 'override-project',
    fetchFn: async (url, init = {}) => {
      if (url === VERTEX_TOKEN_URI) return Response.json({ access_token: 'gcp-token', expires_in: 3600 });
      requests.push({ url, init });
      return geminiSse('gemini-ok');
    },
  });
  const result = await provider.send(
    [
      { role: 'system', content: 'system rule' },
      { role: 'user', content: 'hello' },
    ],
    'gemini-3.1-pro-preview',
    [],
    {}
  );
  assert.equal(result.content, 'gemini-ok');
  assert.match(
    requests[0].url,
    /^https:\/\/us-east5-aiplatform\.googleapis\.com\/v1\/projects\/override-project\/locations\/us-east5\/publishers\/google\/models\/gemini-3\.1-pro-preview:streamGenerateContent\?alt=sse$/
  );
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer gcp-token');
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system rule' }] });
  assert.equal(body.contents[0].role, 'user');
  assert.equal(new Headers(requests[0].init.headers).get('x-vertex-ai-llm-shared-request-type'), null);
});

function recordingProvider(config, respond) {
  const requests = [];
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(serviceAccount()),
    ...config,
    fetchFn: async (url, init = {}) => {
      if (url === VERTEX_TOKEN_URI) return Response.json({ access_token: 'gcp-token', expires_in: 3600 });
      requests.push({ url, init });
      return respond();
    },
  });
  return { provider, requests };
}

test('Vertex multi-region locations use the representative endpoints', async () => {
  for (const location of ['us', 'eu']) {
    const gemini = recordingProvider({ location }, () => geminiSse());
    await gemini.provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {});
    assert.equal(
      gemini.requests[0].url,
      `https://aiplatform.${location}.rep.googleapis.com/v1/projects/key-project/locations/${location}/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`
    );
    const claude = recordingProvider({ location }, () => claudeSse());
    await claude.provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5-5', [], {});
    assert.equal(
      claude.requests[0].url,
      `https://aiplatform.${location}.rep.googleapis.com/v1/projects/key-project/locations/${location}/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict`
    );
  }
});

test('Vertex Flex PayGo sends the flex header on global and reports a served Flex request', async () => {
  const usage = { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9, trafficType: 'ON_DEMAND_FLEX' };
  const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse('flex-ok', usage));
  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {
    modelParameters: { serviceTier: 'flex' },
  });
  assert.equal(new Headers(requests[0].init.headers).get('x-vertex-ai-llm-shared-request-type'), 'flex');
  assert.equal(result.serviceTier, 'flex');

  const standard = recordingProvider({ location: 'global' }, () => geminiSse('std-ok', usage));
  const plain = await standard.provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {
    modelParameters: { serviceTier: 'standard' },
  });
  assert.equal(new Headers(standard.requests[0].init.headers).get('x-vertex-ai-llm-shared-request-type'), null);
  assert.equal(plain.serviceTier, 'flex', 'the served tier, not the requested one, is reported');

  const regional = recordingProvider({ location: 'us-central1' }, () => geminiSse());
  await assert.rejects(
    regional.provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {
      modelParameters: { serviceTier: 'flex' },
    }),
    /Flex PayGo is only available with the global location/
  );
  assert.equal(regional.requests.length, 0);

  // Gemini 4 Argon offers Standard and Priority PayGo only.
  const argon = recordingProvider({ location: 'global' }, () => geminiSse());
  await assert.rejects(
    argon.provider.send([{ role: 'user', content: 'hi' }], 'gemini-4-argon', [], {
      modelParameters: { serviceTier: 'flex' },
    }),
    /Flex PayGo is not available for gemini-4-argon/
  );
  assert.equal(argon.requests.length, 0);
});

test('Vertex Gemini 4 Argon routes as a Google publisher model with a documented thinking level', async () => {
  const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse('argon-ok'));
  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-4-argon', [], { effort: 'high' });
  assert.equal(result.content, 'argon-ok');
  assert.equal(
    requests[0].url,
    'https://aiplatform.googleapis.com/v1/projects/key-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse'
  );
  const thinking = JSON.parse(requests[0].init.body).generationConfig?.thinkingConfig;
  assert.equal(thinking?.thinkingLevel, 'high');
  assert.equal(Object.hasOwn(thinking || {}, 'thinkingBudget'), false);
});

test('Vertex Gemini usage is cache-exclusive like the Claude route', async () => {
  const usage = { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 5, totalTokenCount: 1005 };
  const { provider } = recordingProvider({ location: 'global' }, () => geminiSse('cached', usage));
  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {});
  assert.equal(VertexAIProvider.inputExcludesCache, true);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.cachedTokens, 800);
  assert.equal(result.usage.promptTokens, 1000);
});

test('Vertex Claude on a regional location is priced as the regional SKU', async () => {
  const regional = recordingProvider({ location: 'us-east5' }, () => claudeSse());
  const priced = await regional.provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5-5', [], {});
  assert.equal(priced.pricingModel, 'claude-sonnet-5-5@regional');
  const global = recordingProvider({ location: 'global' }, () => claudeSse());
  const listed = await global.provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5-5', [], {});
  assert.equal(listed.pricingModel, undefined);
});

test('Vertex lists its publisher models and offers Flex only on Flex-capable Gemini models', async () => {
  const { provider } = recordingProvider({}, () => geminiSse());
  const models = await provider.listModels();
  assert.deepEqual(
    models.map((model) => model.id),
    [
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash-lite',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
    ]
  );
  for (const model of models) {
    assert.equal(model.provider, 'vertex-ai');
    const flex = model.modelParameterOptions?.find((option) => option.id === 'serviceTier');
    assert.equal(Boolean(flex), model.id.startsWith('gemini-') && model.id !== 'gemini-4-argon', model.id);
    if (flex) assert.deepEqual(flex.options.map((option) => option.value), ['standard', 'flex']);
  }
});

test('Vertex Claude routing sends Anthropic Messages body without model', async () => {
  const account = serviceAccount();
  const requests = [];
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(account),
    location: 'global',
    fetchFn: async (url, init = {}) => {
      if (url === VERTEX_TOKEN_URI) return Response.json({ access_token: 'gcp-token', expires_in: 3600 });
      requests.push({ url, init });
      return claudeSse('claude-ok');
    },
  });
  const result = await provider.send([{ role: 'user', content: 'hello' }], 'claude-sonnet-5-5', [], {});
  assert.equal(result.content, 'claude-ok');
  assert.equal(
    requests[0].url,
    'https://aiplatform.googleapis.com/v1/projects/key-project/locations/global/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict'
  );
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(Object.hasOwn(body, 'model'), false);
  assert.equal(body.stream, true);
});

test('Vertex authentication failures surface a clear provider error', async () => {
  const account = serviceAccount();
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(account),
    fetchFn: async (url) => {
      assert.equal(url, VERTEX_TOKEN_URI);
      return Response.json({ error: 'invalid_grant', error_description: 'service account rejected' }, { status: 400 });
    },
  });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hello' }], 'gemini-3.1-pro-preview', [], {}),
    (error) => error?.code === 'EVERTEXAUTH' && /Vertex AI authentication failed: service account rejected/.test(error.message)
  );
});
