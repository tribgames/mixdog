import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { VertexAccessTokenManager, VERTEX_SCOPE, VERTEX_TOKEN_URI } from './vertex-ai-auth.mjs';
import { VertexAIProvider } from './vertex-ai.mjs';

function serviceAccount(overrides = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'mixdog@test-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: VERTEX_TOKEN_URI,
    ...overrides,
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

test('Vertex access tokens are bound to the account that minted them', async () => {
  const accountA = serviceAccount({ client_email: 'a@project-a.iam.gserviceaccount.com', project_id: 'project-a' });
  const accountB = serviceAccount({ client_email: 'b@project-b.iam.gserviceaccount.com', project_id: 'project-b' });
  let current = JSON.stringify(accountA);
  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const minted = [];
  const manager = new VertexAccessTokenManager({
    credentialResolver: () => current,
    fetchFn: async (_url, init) => {
      const claims = decodeJwtPart(new URLSearchParams(init.body).get('assertion').split('.')[1]);
      minted.push(claims.iss);
      if (claims.iss === accountA.client_email) await gateA;
      return Response.json({ access_token: `token-for-${claims.iss}`, expires_in: 3600 });
    },
  });

  // Account A's token request is still in flight when the credential switches to B.
  const inFlight = manager.getAccessToken();
  current = JSON.stringify(accountB);
  assert.equal(manager.projectId(), 'project-b');
  releaseA();
  assert.equal(await inFlight, `token-for-${accountA.client_email}`);

  // A's late token must not be served for account B.
  assert.equal(await manager.getAccessToken(), `token-for-${accountB.client_email}`);
  assert.deepEqual(minted, [accountA.client_email, accountB.client_email]);
});

test('Vertex credential changes record nothing until the service-account JSON is valid', async () => {
  const account = serviceAccount();
  let current = JSON.stringify(account);
  let tokenRequests = 0;
  const manager = new VertexAccessTokenManager({
    credentialResolver: () => current,
    fetchFn: async () => {
      tokenRequests += 1;
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    },
  });
  assert.equal(await manager.getAccessToken(), 'token-1');

  current = JSON.stringify({ type: 'service_account', client_email: 'other@test.iam.gserviceaccount.com' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(manager.getAccessToken(), /must include client_email, private_key, and project_id/);
    assert.throws(() => manager.projectId(), /must include client_email, private_key, and project_id/);
  }
  current = '{not json';
  await assert.rejects(manager.getAccessToken(), /service-account JSON is invalid/);
  await assert.rejects(manager.getAccessToken(), /service-account JSON is invalid/);
  assert.equal(tokenRequests, 1);
});

test('Vertex cached tokens are not served after the private key is replaced', async () => {
  const account = serviceAccount({ private_key_id: 'key-1' });
  let current = JSON.stringify(account);
  let tokenRequests = 0;
  const manager = new VertexAccessTokenManager({
    credentialResolver: () => current,
    fetchFn: async () => {
      tokenRequests += 1;
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    },
  });
  assert.equal(await manager.getAccessToken(), 'token-1');

  // Same email, project and private_key_id, different key material.
  current = JSON.stringify({ ...account, private_key: 'not a pem' });
  await assert.rejects(manager.getAccessToken(), (error) => error?.code === 'EVERTEXAUTH');
  assert.equal(tokenRequests, 1);
  current = JSON.stringify({ ...account, private_key: serviceAccount().private_key });
  assert.equal(await manager.getAccessToken(), 'token-2');
});

function claudeRequest(provider) {
  return provider.send([{ role: 'user', content: 'hello' }], 'claude-sonnet-5-5', [], {});
}

test('Vertex 401 retry aborts when the credential changed instead of pairing it with the old URL', async () => {
  const accountA = serviceAccount({ client_email: 'a@project-a.iam.gserviceaccount.com', project_id: 'project-a' });
  const accountB = serviceAccount({ client_email: 'b@project-b.iam.gserviceaccount.com', project_id: 'project-b' });
  const changedAuth = (error) =>
    error?.code === 'EVERTEXAUTH' && /credential changed during the request/.test(error.message);

  // Swap before the retry: the rejected request returns 401 as the credential switches.
  {
    const requests = [];
    const provider = new VertexAIProvider({
      apiKey: JSON.stringify(accountA),
      location: 'global',
      fetchFn: async (url, init = {}) => {
        if (url === VERTEX_TOKEN_URI) {
          const iss = decodeJwtPart(new URLSearchParams(init.body).get('assertion').split('.')[1]).iss;
          return Response.json({ access_token: `token-for-${iss}`, expires_in: 3600 });
        }
        requests.push({ url, authorization: new Headers(init.headers).get('authorization') });
        provider.config.apiKey = JSON.stringify(accountB);
        return new Response('unauthorized', { status: 401 });
      },
    });
    await assert.rejects(claudeRequest(provider), changedAuth);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/projects\/project-a\//);
    assert.equal(requests[0].authorization, `Bearer token-for-${accountA.client_email}`);
  }

  // Swap while the retry's token is being acquired.
  {
    let tokenRequests = 0;
    let apiRequests = 0;
    const provider = new VertexAIProvider({
      apiKey: JSON.stringify(accountA),
      location: 'global',
      fetchFn: async (url) => {
        if (url === VERTEX_TOKEN_URI) {
          tokenRequests += 1;
          if (tokenRequests === 2) provider.config.apiKey = JSON.stringify(accountB);
          return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
        }
        apiRequests += 1;
        return apiRequests === 1 ? new Response('unauthorized', { status: 401 }) : claudeSse('wrong-account');
      },
    });
    await assert.rejects(claudeRequest(provider), changedAuth);
    assert.equal(apiRequests, 1);
  }
});

test('Vertex 401 handling drops only the rejected token and reuses a fresher cached one', async () => {
  let now = 1_800_000_000_000;
  const tokenRequests = [];
  const authorizations = [];
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(serviceAccount()),
    location: 'global',
    now: () => now,
    fetchFn: async (url, init = {}) => {
      if (url === VERTEX_TOKEN_URI) {
        tokenRequests.push(url);
        return Response.json({ access_token: `token-${tokenRequests.length}`, expires_in: 3600 });
      }
      authorizations.push(new Headers(init.headers).get('authorization'));
      if (authorizations.length === 1) {
        // A concurrent request refreshes the token while this one is rejected.
        now += 56 * 60_000;
        await provider._auth.getAccessToken();
        return new Response('expired', { status: 401 });
      }
      return claudeSse('retry-ok');
    },
  });
  const result = await claudeRequest(provider);
  assert.equal(result.content, 'retry-ok');
  assert.deepEqual(authorizations, ['Bearer token-1', 'Bearer token-2']);
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

test('Vertex lists the current Gemini, Claude and open-model roster with its service tiers', async () => {
  const { provider } = recordingProvider({}, () => geminiSse());
  const models = await provider.listModels();
  const ids = models.map((model) => model.id);
  for (const id of [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'claude-opus-4-8',
    'claude-haiku-5-5',
    'claude-sonnet-4-6',
    'deepseek-ai/deepseek-v3.2-maas',
    'qwen/qwen3-coder-480b-a35b-instruct-maas',
    'qwen/qwen3-next-80b-a3b-instruct-maas',
    'zai-org/glm-5-maas',
    'moonshotai/kimi-k2-thinking-maas',
    'minimaxai/minimax-m2-maas',
    'openai/gpt-oss-120b-maas',
    'meta/llama-4-maverick-17b-128e-instruct-maas',
    'google/gemma-4-26b-a4b-it-maas',
    'xai/grok-4.7',
  ]) {
    assert.ok(ids.includes(id), id);
  }
  // Retired models are not listed.
  for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']) assert.equal(ids.includes(id), false, id);
  assert.equal(new Set(ids).size, ids.length);
  const tiers = (id) =>
    models
      .find((model) => model.id === id)
      ?.modelParameterOptions?.find((option) => option.id === 'serviceTier')
      ?.options.map((option) => option.value) || null;
  assert.deepEqual(tiers('gemini-3.8-flash'), ['standard', 'flex', 'priority']);
  assert.deepEqual(tiers('gemini-4-argon'), ['standard', 'priority']);
  assert.equal(tiers('claude-opus-5-5'), null);
  assert.equal(tiers('xai/grok-4.7'), null);
  assert.deepEqual(models.find((model) => model.id === 'minimaxai/minimax-m2-maas').locations, ['global']);
  for (const model of models) assert.equal(model.provider, 'vertex-ai');
});

test('Vertex accepts free-form publisher/model ids and routes each publisher to its wire', async () => {
  const gemini = recordingProvider({ location: 'global' }, () => geminiSse());
  await gemini.provider.send([{ role: 'user', content: 'hi' }], 'google/gemini-9-unlisted', [], {});
  assert.match(gemini.requests[0].url, /\/publishers\/google\/models\/gemini-9-unlisted:streamGenerateContent/);
  const claude = recordingProvider({ location: 'global' }, () => claudeSse());
  await claude.provider.send([{ role: 'user', content: 'hi' }], 'publishers/anthropic/models/claude-next-9', [], {});
  assert.match(claude.requests[0].url, /\/publishers\/anthropic\/models\/claude-next-9:streamRawPredict$/);
  const { provider } = recordingProvider({}, () => geminiSse());
  await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'mystery-model', [], {}), /use "publisher\/model"/);
});

test('Vertex rejects tier and location combinations it does not serve before sending', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const cases = [
    ['us-central1', 'gemini-3.8-flash', 'priority', /Priority PayGo is only available with the global, us or eu location/],
    ['eu', 'gemini-3.8-flash', 'flex', /Flex PayGo is only available with the global location/],
    ['global', 'claude-opus-5-5', 'priority', /Priority PayGo is not available for claude-opus-5-5/],
    ['global', 'xai/grok-4.7', 'flex', /Flex PayGo is not available for grok-4.7/],
    ['us', 'claude-sonnet-4-6', '', /claude-sonnet-4-6 is not served on the us multi-region endpoint/],
    ['eu', 'claude-3-7-sonnet', '', /not served on the eu multi-region endpoint/],
  ];
  for (const [location, model, serviceTier, message] of cases) {
    const { provider, requests } = recordingProvider({ location }, () => claudeSse());
    await assert.rejects(provider.send(hi, model, [], { modelParameters: { serviceTier } }), message);
    assert.equal(requests.length, 0, `${location} ${model}`);
  }
  // Claude 4.7 and later, and Priority on a multi-region, are served.
  for (const model of ['claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-5-5']) {
    const { provider, requests } = recordingProvider({ location: 'eu' }, () => claudeSse());
    await provider.send(hi, model, [], {});
    assert.equal(requests.length, 1, model);
  }
  const priority = recordingProvider({ location: 'us' }, () => geminiSse());
  await priority.provider.send(hi, 'gemini-4-argon', [], { modelParameters: { serviceTier: 'priority' } });
  assert.equal(priority.requests.length, 1);
});

test('Vertex prices non-global requests as the regional SKU for Claude and GA Gemini 3+, not previews', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const priced = async (location, model, respond) =>
    (await recordingProvider({ location }, respond).provider.send(hi, model, [], {})).pricingModel;
  assert.equal(await priced('us-central1', 'gemini-3.8-flash', () => geminiSse()), 'gemini-3.8-flash@regional');
  assert.equal(await priced('eu', 'gemini-4-argon', () => geminiSse()), 'gemini-4-argon@regional');
  assert.equal(await priced('us-central1', 'gemini-3.1-pro-preview', () => geminiSse()), undefined);
  assert.equal(await priced('global', 'gemini-3.8-flash', () => geminiSse()), undefined);
  assert.equal(await priced('us', 'claude-opus-4-8', () => claudeSse()), 'claude-opus-4-8@regional');
});

test('Vertex Priority PayGo sends the priority header and reports the served tier', async () => {
  const { withUsageContext } = await import('../../../shared/llm/usage-context.mjs');
  const hi = [{ role: 'user', content: 'hi' }];
  const usage = (trafficType) => ({ promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9, trafficType });
  const run = async (trafficType) => {
    const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse('p', usage(trafficType)));
    const identity = {};
    const result = await withUsageContext(identity, () =>
      provider.send(hi, 'gemini-3.8-flash', [], { modelParameters: { serviceTier: 'priority' } })
    );
    return { result, identity, header: new Headers(requests[0].init.headers).get('x-vertex-ai-llm-shared-request-type') };
  };
  const served = await run('ON_DEMAND_PRIORITY');
  assert.equal(served.header, 'priority');
  assert.equal(served.identity.requestServiceTier, 'priority');
  assert.equal(served.result.serviceTier, 'priority');
  // Downgraded to Standard PayGo: billed at Standard rates (cost.mjs: served "default").
  const downgraded = await run('ON_DEMAND');
  assert.equal(downgraded.identity.requestServiceTier, 'priority');
  assert.equal(downgraded.result.serviceTier, 'default');
});

test('Vertex refuses a location that is not a plain region label before any host is built', async () => {
  for (const location of ['evil.example.com#', 'x.attacker.net/', '-us', '1us', 'us central', 'us@evil']) {
    const { provider, requests } = recordingProvider({ location }, () => geminiSse());
    await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {}), /location is invalid/);
    assert.equal(requests.length, 0, location);
  }
});

test('Vertex Claude keeps a version suffix literal and old Claude bills no regional premium', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const { provider, requests } = recordingProvider({ location: 'us-east5' }, () => claudeSse());
  const result = await provider.send(hi, 'claude-haiku-4-5@20251001', [], {});
  assert.match(requests[0].url, /\/models\/claude-haiku-4-5@20251001:streamRawPredict$/);
  assert.equal(result.pricingModel, 'claude-haiku-4-5@20251001@regional');
  const old = recordingProvider({ location: 'us-east5' }, () => claudeSse());
  assert.equal((await old.provider.send(hi, 'claude-3-5-haiku', [], {})).pricingModel, undefined);
});

test('Vertex Gemini requests carry no functionCall / functionResponse ids', async () => {
  const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse('done'));
  const history = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'file text' },
  ];
  const tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  await provider.send(history, 'gemini-3.8-flash', tools, {});
  const parts = JSON.parse(requests[0].init.body).contents.flatMap((content) => content.parts || []);
  const call = parts.find((part) => part.functionCall);
  const response = parts.find((part) => part.functionResponse);
  assert.equal(call.functionCall.name, 'read');
  assert.equal(response.functionResponse.name, 'read');
  assert.equal('id' in call.functionCall, false);
  assert.equal('id' in response.functionResponse, false);
});

test('Vertex sends a listed open model only to the locations it is served in', async () => {
  const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse());
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'deepseek-ai/deepseek-v3.1-maas', [], {}),
    /deepseek-ai\/deepseek-v3\.1-maas is served only in: us-central1/
  );
  assert.equal(requests.length, 0);
});

test('Vertex maps a not-enabled model to a Model Garden error on every wire', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const notFound = () =>
    Response.json(
      { error: { code: 404, message: 'Publisher Model `projects/key-project/locations/global/publishers/google/models/gemini-3.6-flash` was not found or your project does not have access to it.', status: 'NOT_FOUND' } },
      { status: 404 }
    );
  const gemini = recordingProvider({ location: 'global' }, notFound);
  await assert.rejects(gemini.provider.send(hi, 'gemini-3.6-flash', [], {}), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    assert.equal(error.status, 404);
    assert.match(error.message, /enable the model in Model Garden/);
    assert.match(error.message, /publishers\/google\/model-garden\/gemini-3\.6-flash/);
    assert.match(error.message, /project key-project in global/);
    return true;
  });
  const claude = recordingProvider({ location: 'us-east5' }, () =>
    Response.json(
      { error: { code: 403, message: 'Anthropic model claude-opus-4-6 has not been enabled for this project. Enable it in Model Garden.' } },
      { status: 403 }
    )
  );
  await assert.rejects(claude.provider.send(hi, 'claude-opus-4-6', [], {}), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    assert.match(error.message, /publishers\/anthropic\/model-garden\/claude-opus-4-6/);
    return true;
  });
  // FAILED_PRECONDITION: the project may not use the publisher model.
  const precondition = recordingProvider({ location: 'us-east5' }, () =>
    Response.json(
      {
        error: {
          code: 400,
          message:
            'Project `key-project` is not allowed to use Publisher Model `projects/key-project/locations/us-east5/publishers/anthropic/models/claude-opus-4-5`',
          status: 'FAILED_PRECONDITION',
        },
      },
      { status: 400 }
    )
  );
  await assert.rejects(
    precondition.provider.send(hi, 'claude-opus-4-5', [], {}),
    (error) => error.code === 'VERTEX_MODEL_NOT_ENABLED' && error.status === 400
  );
  // An IAM denial stays IAM, even when it names the publisher model.
  const iamText =
    "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/key-project/locations/global/publishers/anthropic/models/claude-opus-4-6' (or it may not exist). Publisher Model access requires the Agent Platform User role.";
  for (const route of [
    ['claude-opus-4-6', () => Response.json({ error: { code: 403, message: iamText, status: 'PERMISSION_DENIED' } }, { status: 403 })],
    ['gemini-3.8-flash', () => Response.json({ error: { code: 403, message: iamText, status: 'PERMISSION_DENIED' } }, { status: 403 })],
  ]) {
    const iam = recordingProvider({ location: 'global' }, route[1]);
    await assert.rejects(iam.provider.send(hi, route[0], [], {}), (error) => {
      assert.notEqual(error.code, 'VERTEX_MODEL_NOT_ENABLED', route[0]);
      assert.doesNotMatch(error.message, /Model Garden/);
      assert.match(error.message, /aiplatform\.endpoints\.predict/);
      return true;
    });
  }
});

test('Vertex lists open models only with documented locations and enforces them', async () => {
  const { provider } = recordingProvider({}, () => geminiSse());
  const open = (await provider.listModels()).filter((model) => model.id.includes('/'));
  assert.ok(open.length > 0);
  for (const model of open) assert.ok(Array.isArray(model.locations) && model.locations.length > 0, model.id);
  const hi = [{ role: 'user', content: 'hi' }];
  for (const [model, location, served] of [
    ['meta/llama-4-scout-17b-16e-instruct-maas', 'global', /served only in: us-east5/],
    ['openai/gpt-oss-20b-maas', 'global', /served only in: us-central1/],
    ['xai/grok-4.20-reasoning', 'us', /served only in: global/],
    ['xai/grok-4.3', 'us-central1', /served only in: global/],
  ]) {
    const { provider: regional, requests } = recordingProvider({ location }, () => geminiSse());
    await assert.rejects(regional.send(hi, model, [], {}), served, model);
    assert.equal(requests.length, 0, model);
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
