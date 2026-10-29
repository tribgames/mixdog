import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test, { mock } from 'node:test';

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
      return respond(url);
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
  const usage = {
    promptTokenCount: 1000,
    cachedContentTokenCount: 800,
    candidatesTokenCount: 5,
    totalTokenCount: 1005,
  };
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
  // Global: the requested id, not the dated id the stream reports.
  assert.equal(listed.pricingModel, 'claude-sonnet-5-5');
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
  for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'])
    assert.equal(ids.includes(id), false, id);
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
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'mystery-model', [], {}),
    /use "publisher\/model"/
  );
});

test('Vertex rejects tier and location combinations it does not serve before sending', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const cases = [
    [
      'us-central1',
      'gemini-3.8-flash',
      'priority',
      /Priority PayGo is only available with the global, us or eu location/,
    ],
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
    return {
      result,
      identity,
      header: new Headers(requests[0].init.headers).get('x-vertex-ai-llm-shared-request-type'),
    };
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
    await assert.rejects(
      provider.send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [], {}),
      /location is invalid/
    );
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
  assert.equal((await old.provider.send(hi, 'claude-3-5-haiku', [], {})).pricingModel, 'claude-3-5-haiku');
});

// --- Conformance: betas, retries, error shapes, pricing identity, ADC ---

function claudeSseFor(model, text = 'ok') {
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new Response(
    [
      frame({ type: 'message_start', message: { model, usage: { input_tokens: 5 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      frame({ type: 'message_stop' }),
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

const lookupTool = {
  name: 'lookup',
  description: 'Look a word up',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
};

test('Vertex Claude sends the needed Vertex-supported betas in the body and no beta header', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const sent = async (model, tools, opts) => {
    const { provider, requests } = recordingProvider({ location: 'global' }, () => claudeSse());
    await provider.send(hi, model, tools, opts);
    const headers = new Headers(requests[0].init.headers);
    assert.equal(headers.get('anthropic-beta'), null, model);
    assert.equal(headers.get('anthropic-version'), null, model);
    return JSON.parse(requests[0].init.body);
  };
  // Manual thinking budget with tools: interleaved thinking.
  const manual = await sent('claude-sonnet-4-5@20250929', [lookupTool], { effort: 'high' });
  assert.equal(manual.thinking?.type, 'enabled');
  assert.deepEqual(manual.anthropic_beta, ['interleaved-thinking-2025-05-14']);
  // Deferred tools: Vertex's tool-search beta name.
  const deferred = await sent('claude-sonnet-4-5', [lookupTool, { ...lookupTool, name: 'later', deferLoading: true }], {
    effort: 'high',
  });
  assert.deepEqual(deferred.anthropic_beta, ['interleaved-thinking-2025-05-14', 'tool-search-tool-2025-10-19']);
  // Adaptive thinking on a 1M-context model: no effort beta, no 1M beta (native), nothing to send.
  const adaptive = await sent('claude-opus-5-5', [lookupTool], { effort: 'high' });
  assert.equal(adaptive.thinking?.type, 'adaptive');
  assert.equal(Object.hasOwn(adaptive, 'anthropic_beta'), false);
  // No thinking, or no tools: no interleaving to ask for.
  assert.equal(Object.hasOwn(await sent('claude-sonnet-4-5', [lookupTool], {}), 'anthropic_beta'), false);
  assert.equal(Object.hasOwn(await sent('claude-sonnet-4-5', [], { effort: 'high' }), 'anthropic_beta'), false);
  // Mixdog never builds a server-side compaction body on this route.
  assert.equal(Object.hasOwn(manual, 'context_management'), false);
});

test('Vertex Claude retries 429 and 529 like the first-party route and classifies the same shapes', async () => {
  const { classifyError, isServerUnavailable } = await import('./retry-classification.mjs');
  const { providerErrorKind, retryReasonClass } = await import('./provider-error-kind.mjs');
  const { isAccountQuotaError } = await import('./account-pool.mjs');
  const hi = [{ role: 'user', content: 'hi' }];
  const rateLimited = () =>
    Response.json(
      {
        error: {
          code: 429,
          message: 'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
      { status: 429 }
    );
  const overloaded = () =>
    Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
  const wrapped = () =>
    Response.json([{ error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }], {
      status: 503,
    });
  for (const failure of [rateLimited, overloaded, wrapped]) {
    const waits = [];
    let calls = 0;
    const { provider } = recordingProvider({ location: 'global', sleepFn: async (ms) => waits.push(ms) }, () =>
      ++calls === 1 ? failure() : claudeSse('after-retry')
    );
    const result = await provider.send(hi, 'claude-sonnet-5-5', [], {});
    assert.equal(result.content, 'after-retry', failure.name);
    assert.equal(calls, 2, failure.name);
    assert.equal(waits.length, 1, failure.name);
  }
  // Retry budget spent: the classification the loop and route fallback read.
  const previous = process.env.CLAUDE_CODE_MAX_RETRIES;
  process.env.CLAUDE_CODE_MAX_RETRIES = '0';
  try {
    const failed = async (respond) => {
      const { provider } = recordingProvider({ location: 'global' }, respond);
      return await provider.send(hi, 'claude-sonnet-5-5', [], {}).then(
        () => assert.fail('expected a failure'),
        (error) => error
      );
    };
    const limit = await failed(rateLimited);
    assert.equal(limit.status, 429);
    assert.equal(limit.code, 'rate_limit_error');
    assert.equal(providerErrorKind(limit).kind, 'rate_limited');
    assert.equal(classifyError(limit), 'permanent');
    assert.equal(retryReasonClass(limit), 'rate_limited');
    assert.equal(isAccountQuotaError(limit), false);
    const overload = await failed(overloaded);
    assert.equal(overload.code, 'overloaded_error');
    assert.equal(providerErrorKind(overload).kind, 'overloaded');
    assert.equal(classifyError(overload), 'transient');
    assert.equal(isServerUnavailable(overload), true);
    const unavailable = await failed(wrapped);
    assert.equal(unavailable.status, 503);
    assert.equal(classifyError(unavailable), 'transient');
    assert.equal(isServerUnavailable(unavailable), true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES;
    else process.env.CLAUDE_CODE_MAX_RETRIES = previous;
  }
});

test('Vertex retries stay on the account the request was built for on every route', async () => {
  const accountA = serviceAccount({ client_email: 'a@project-a.iam.gserviceaccount.com', project_id: 'project-a' });
  const accountB = serviceAccount({ client_email: 'b@project-b.iam.gserviceaccount.com', project_id: 'project-b' });
  const changedAuth = (error) =>
    error?.code === 'EVERTEXAUTH' && /credential changed during the request/.test(error.message);
  const hi = [{ role: 'user', content: 'hi' }];
  // `failure` answers the first API request; the account switches to B either
  // in the retry sleep or, where the engine's sleep is not injectable, as that
  // failure is answered (before the backoff).
  const run = async (model, failure, { switchInSleep }) => {
    const requests = [];
    let provider;
    const toB = () => {
      provider.config.apiKey = JSON.stringify(accountB);
    };
    provider = new VertexAIProvider({
      apiKey: JSON.stringify(accountA),
      location: 'global',
      preconnect: false,
      sleepFn: async () => (switchInSleep ? toB() : undefined),
      fetchFn: async (url, init = {}) => {
        if (String(url) === VERTEX_TOKEN_URI) {
          const iss = decodeJwtPart(new URLSearchParams(init.body).get('assertion').split('.')[1]).iss;
          return Response.json({ access_token: `token-for-${iss}`, expires_in: 3600 });
        }
        requests.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') });
        if (!switchInSleep) toB();
        return failure();
      },
    });
    await assert.rejects(provider.send(hi, model, [], {}), changedAuth, model);
    assert.equal(requests.length, 1, `${model}: no request after the switch`);
    assert.match(requests[0].url, /\/projects\/project-a\//, model);
    assert.equal(requests[0].authorization, `Bearer token-for-${accountA.client_email}`, model);
  };
  await run(
    'claude-sonnet-5-5',
    () =>
      Response.json({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }),
    { switchInSleep: true }
  );
  await run(
    'gemini-3.8-flash',
    () => Response.json({ error: { code: 503, message: 'Unavailable', status: 'UNAVAILABLE' } }, { status: 503 }),
    { switchInSleep: true }
  );
  await run(
    'zai-org/glm-5-maas',
    () =>
      Response.json([{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }], {
        status: 429,
        headers: { 'retry-after-ms': '1' },
      }),
    { switchInSleep: false }
  );
});

test('Vertex Gemini reads an array-wrapped error body like the plain one', async () => {
  const { geminiRestError } = await import('./gemini.mjs');
  const { providerErrorKind } = await import('./provider-error-kind.mjs');
  const { isAccountQuotaError } = await import('./account-pool.mjs');
  const hi = [{ role: 'user', content: 'hi' }];
  const dayQuota = {
    error: {
      code: 429,
      message: 'Quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }],
        },
      ],
    },
  };
  const plain = geminiRestError(
    new Response(null, { status: 429 }),
    JSON.stringify(dayQuota),
    'Gemini REST streamGenerateContent'
  );
  const { provider } = recordingProvider({ location: 'global', sleepFn: async () => {} }, () =>
    Response.json([dayQuota], { status: 429 })
  );
  const error = await provider.send(hi, 'gemini-3.8-flash', [], {}).then(
    () => assert.fail('expected a failure'),
    (caught) => caught
  );
  assert.equal(error.status, 429);
  assert.equal(error.quotaScope, 'day');
  assert.equal(providerErrorKind(error).kind, providerErrorKind(plain).kind);
  assert.equal(providerErrorKind(error).kind, 'quota_exhausted');
  assert.equal(isAccountQuotaError(error), true);

  // A per-minute throttle with RetryInfo waits the server's delay, then retries.
  const waits = [];
  let calls = 0;
  const minute = recordingProvider({ location: 'global', sleepFn: async (ms) => waits.push(ms) }, () =>
    ++calls === 1
      ? Response.json(
          [
            {
              error: {
                code: 429,
                message: 'Resource exhausted',
                status: 'RESOURCE_EXHAUSTED',
                details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
              },
            },
          ],
          { status: 429 }
        )
      : geminiSse('after-wait')
  );
  assert.equal((await minute.provider.send(hi, 'gemini-3.8-flash', [], {})).content, 'after-wait');
  assert.ok(waits[0] >= 7000, `waited ${waits[0]}ms`);
});

test('Vertex Claude prices a dated or bare id by the requested id, regional and global', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  for (const [location, model, expected] of [
    ['global', 'claude-sonnet-4-5@20250929', 'claude-sonnet-4-5@20250929'],
    ['global', 'claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['us-east5', 'claude-sonnet-4-5@20250929', 'claude-sonnet-4-5@20250929@regional'],
    ['us-east5', 'claude-sonnet-4-5', 'claude-sonnet-4-5@regional'],
  ]) {
    // The stream names the Anthropic-style dated id.
    const { provider } = recordingProvider({ location }, () => claudeSseFor('claude-sonnet-4-5-20250929'));
    const result = await provider.send(hi, model, [], {});
    assert.equal(result.model, 'claude-sonnet-4-5-20250929');
    assert.equal(result.pricingModel, expected, `${location} ${model}`);
  }
});

test('Vertex ADC mode authenticates through the provider and words its 403s', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vx-prov-adc-'));
  const adcPath = join(dir, 'adc.json');
  writeFileSync(
    adcPath,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'client-1.apps.googleusercontent.com',
      client_secret: 'client-secret-1',
      refresh_token: 'refresh-adc',
      account: 'me@example.com',
    })
  );
  const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const adcProvider = (respond) => {
    const grants = [];
    const requests = [];
    const provider = new VertexAIProvider({
      authMode: 'adc',
      projectId: 'adc-project',
      location: 'global',
      preconnect: false,
      fetchFn: async (url, init = {}) => {
        if (String(url) === VERTEX_TOKEN_URI) {
          grants.push(Object.fromEntries(new URLSearchParams(init.body)));
          return Response.json({ access_token: 'adc-token', expires_in: 3600 });
        }
        requests.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') });
        return respond();
      },
    });
    return { provider, grants, requests };
  };
  const hi = [{ role: 'user', content: 'hi' }];
  const ok = adcProvider(() => claudeSse('adc-ok'));
  assert.equal((await ok.provider.send(hi, 'claude-sonnet-5-5', [], {})).content, 'adc-ok');
  assert.equal(ok.grants[0].grant_type, 'refresh_token');
  assert.equal(ok.grants[0].refresh_token, 'refresh-adc');
  assert.equal(ok.requests[0].authorization, 'Bearer adc-token');
  assert.match(ok.requests[0].url, /\/projects\/adc-project\/locations\/global\//);

  const iam = () =>
    Response.json(
      {
        error: {
          code: 403,
          message: "Permission 'aiplatform.endpoints.predict' denied on resource",
          status: 'PERMISSION_DENIED',
        },
      },
      { status: 403 }
    );
  const rejects = async (model, respond) => {
    const { provider } = adcProvider(respond);
    return await provider.send(hi, model, [], {}).then(
      () => assert.fail('expected a failure'),
      (error) => error
    );
  };
  // Claude, Gemini and the open-model route all reword the IAM 403, keeping status and code.
  for (const model of ['claude-sonnet-5-5', 'gemini-3.8-flash', 'zai-org/glm-5-maas']) {
    const error = await rejects(model, iam);
    assert.equal(error.status, 403, model);
    assert.equal(error.vertexAccess, 'permission', model);
    assert.match(
      error.message,
      /me@example\.com does not have permission to use Vertex AI in project adc-project/,
      model
    );
    assert.match(error.message, /roles\/aiplatform\.user/, model);
  }
  const claudePermission = await rejects('claude-sonnet-5-5', iam);
  assert.equal(claudePermission.code, 'permission_error');
  // A not-enabled model keeps the Model Garden error.
  for (const model of ['claude-opus-4-6', 'zai-org/glm-5-maas']) {
    const error = await rejects(model, () =>
      Response.json(
        {
          error: {
            code: 404,
            message: `Publisher Model \`projects/p/locations/global/publishers/x/models/${model}\` was not found or your project does not have access to it.`,
            status: 'NOT_FOUND',
          },
        },
        { status: 404 }
      )
    );
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED', model);
    assert.equal(error.vertexAccess, undefined, model);
    assert.match(error.message, /enable the model in Model Garden/, model);
  }
});

test('Vertex Gemini requests carry no functionCall / functionResponse ids', async () => {
  const { provider, requests } = recordingProvider({ location: 'global' }, () => geminiSse('done'));
  const history = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'file text' },
  ];
  const tools = [
    { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
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
      {
        error: {
          code: 404,
          message:
            'Publisher Model `projects/key-project/locations/global/publishers/google/models/gemini-3.6-flash` was not found or your project does not have access to it.',
          status: 'NOT_FOUND',
        },
      },
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
      {
        error: {
          code: 403,
          message:
            'Project `key-project` is not allowed to use Publisher Model `projects/key-project/locations/us-east5/publishers/anthropic/models/claude-opus-4-6`',
          status: 'PERMISSION_DENIED',
        },
      },
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
    [
      'claude-opus-4-6',
      () => Response.json({ error: { code: 403, message: iamText, status: 'PERMISSION_DENIED' } }, { status: 403 }),
    ],
    [
      'gemini-3.8-flash',
      () => Response.json({ error: { code: 403, message: iamText, status: 'PERMISSION_DENIED' } }, { status: 403 }),
    ],
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

test('Vertex classifies access errors by google.rpc ErrorInfo, not by loose wording', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const status403 = (error) => () => Response.json({ error: { code: 403, ...error } }, { status: 403 });
  // The IAM_PERMISSION_DENIED reason wins over enablement wording in the message.
  const iam = recordingProvider(
    { location: 'global' },
    status403({
      message: 'Project `p` is not allowed to use Publisher Model `m`',
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED' }],
    })
  );
  await assert.rejects(iam.provider.send(hi, 'gemini-3.8-flash', [], {}), (error) => {
    assert.notEqual(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    return true;
  });
  // Wording that is not Google's documented enablement message is not an enablement error.
  for (const message of ['Claude is not enabled here', 'You must accept the terms of service']) {
    const loose = recordingProvider({ location: 'global' }, status403({ message, status: 'PERMISSION_DENIED' }));
    await assert.rejects(loose.provider.send(hi, 'claude-opus-4-6', [], {}), (error) => {
      assert.notEqual(error.code, 'VERTEX_MODEL_NOT_ENABLED', message);
      return true;
    });
  }
  // A FAILED_PRECONDITION message needs the status too.
  const wrongStatus = recordingProvider({ location: 'global' }, () =>
    Response.json(
      {
        error: {
          code: 400,
          message: 'Project `p` is not allowed to use Publisher Model `m`',
          status: 'INVALID_ARGUMENT',
        },
      },
      { status: 400 }
    )
  );
  await assert.rejects(wrongStatus.provider.send(hi, 'claude-opus-4-6', [], {}), (error) => {
    assert.notEqual(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    return true;
  });
});

test('Vertex Claude rules enumerate the older models; an unknown id is a newer model', async () => {
  const { vertexRoute, vertexPricingModel, vertexServingProblem, claudeNeedsInterleavedBeta } = await import(
    './vertex-ai-models.mjs'
  );
  // Google's MaaS ids carry the `-maas` suffix; Gemini ids go to generateContent.
  assert.equal(vertexRoute('google/gemma-4-26b-a4b-it-maas').wire, 'maas');
  assert.equal(vertexRoute('google/some-unlisted-maas').wire, 'maas');
  assert.equal(vertexRoute('google/gemini-9-unlisted').wire, 'gemini');
  assert.equal(vertexRoute('claude-opus-4-8').wire, 'claude');
  const refused = (id, location) => vertexServingProblem(vertexRoute(id), location, '');
  // Every documented model before 4.5: refused on multi-region; on global unless documented there.
  const globalEarlier = new Set(['claude-3-7-sonnet', 'claude-3-5-sonnet-v2']);
  for (const id of [
    'claude-3-sonnet',
    'claude-3-opus',
    'claude-3-haiku',
    'claude-3-5-sonnet',
    'claude-3-5-sonnet-v2',
    'claude-3-5-haiku',
    'claude-3-7-sonnet',
    'claude-sonnet-4',
    'claude-opus-4',
    'claude-opus-4-1',
  ]) {
    for (const spelling of [id, `${id}@20250101`, `${id}-20250101`]) {
      assert.match(refused(spelling, 'eu'), /multi-region/, spelling);
      if (globalEarlier.has(id)) assert.equal(refused(spelling, 'global'), '', spelling);
      else assert.match(refused(spelling, 'global'), /not served on the global endpoint/, spelling);
    }
  }
  // 4.5 and 4.6 are on global but not multi-region; 4.7 and later, and unknown ids, are served.
  for (const id of [
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ]) {
    assert.match(refused(id, 'us'), /multi-region/, id);
    assert.equal(refused(id, 'global'), '', id);
  }
  for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-9-9']) {
    assert.equal(refused(id, 'eu'), '', id);
    assert.equal(refused(id, 'global'), '', id);
  }
  // The regional premium covers every model that is not an enumerated earlier one, unknown ids included.
  const priced = (id) => vertexPricingModel(vertexRoute(id), 'us-east5');
  assert.equal(priced('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5@20250929@regional');
  assert.equal(priced('claude-sonnet-9-9'), 'claude-sonnet-9-9@regional');
  for (const id of ['claude-3-sonnet', 'claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-opus-4-1', 'claude-sonnet-4']) {
    assert.equal(priced(id), id, id);
  }
  // Interleaved thinking beta: everything but the documented exclusions (Haiku 4.5, Opus 4.6,
  // 4.7+ adaptive models, 3.x); unknown ids get it, since Vertex ignores it where unsupported.
  for (const id of [
    'claude-opus-4-5',
    'claude-sonnet-4-5@20250929',
    'claude-sonnet-4-6',
    'claude-sonnet-4',
    'claude-opus-4-1',
    'claude-sonnet-4-5-custom',
    'claude-next-9',
  ]) {
    assert.equal(claudeNeedsInterleavedBeta(id), true, id);
  }
  for (const id of ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5-5', 'claude-3-7-sonnet']) {
    assert.equal(claudeNeedsInterleavedBeta(id), false, id);
  }
});

test('Vertex Claude sends the interleaved-thinking beta to an unknown id that builds manual thinking', async () => {
  const { provider, requests } = recordingProvider({ location: 'global' }, () => claudeSse());
  await provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-5-custom', [lookupTool], {
    effort: 'high',
  });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.thinking?.type, 'enabled');
  assert.deepEqual(body.anthropic_beta, ['interleaved-thinking-2025-05-14']);
});

test('Vertex classifies realistic error bodies of every wire the same way', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const publisher = (name, model) => `projects/p/locations/global/publishers/${name}/models/${model}`;
  const rpc = (code, status, message, details) => ({
    error: { code, message, status, ...(details ? { details } : {}) },
  });
  const anthropic = (type, message) => ({ type: 'error', error: { type, message } });
  const openai = (code, type, message) => ({ error: { message, type, param: null, code } });
  const iamInfo = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED' }];
  const iam = "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/p'";
  // [model, status, body, enablement guidance expected]
  const cases = [
    // Vertex generateContent: google.rpc.Status.
    [
      'gemini-3.6-flash',
      404,
      rpc(
        404,
        'NOT_FOUND',
        `Publisher Model \`${publisher('google', 'gemini-3.6-flash')}\` was not found or your project does not have access to it.`
      ),
      true,
    ],
    ['gemini-3.6-flash', 403, rpc(403, 'PERMISSION_DENIED', iam, iamInfo), false],
    // Anthropic-on-Vertex: google.rpc when the gateway rejects first.
    [
      'claude-opus-4-6',
      404,
      rpc(
        404,
        'NOT_FOUND',
        `Publisher Model \`${publisher('anthropic', 'claude-opus-4-6')}\` was not found or your project does not have access to it.`
      ),
      true,
    ],
    [
      'claude-opus-4-6',
      400,
      rpc(
        400,
        'FAILED_PRECONDITION',
        `Project \`p\` is not allowed to use Publisher Model \`${publisher('anthropic', 'claude-opus-4-6')}\``
      ),
      true,
    ],
    ['claude-opus-4-6', 403, rpc(403, 'PERMISSION_DENIED', iam, iamInfo), false],
    // Anthropic-on-Vertex: Anthropic-shaped {type:'error', error:{type,message}}.
    ['claude-opus-4-6', 404, anthropic('not_found_error', 'model: claude-opus-4-6'), true],
    [
      'claude-opus-4-6',
      403,
      anthropic('permission_error', 'Model claude-opus-4-6 has not been enabled for this project.'),
      false,
    ],
    ['claude-opus-4-6', 403, anthropic('permission_error', iam), false],
    ['claude-opus-4-6', 400, anthropic('invalid_request_error', 'max_tokens: required'), false],
    // MaaS openapi: OpenAI-shaped, and the google.rpc shape Vertex also answers there.
    [
      'zai-org/glm-5-maas',
      404,
      openai('model_not_found', 'invalid_request_error', 'The model `glm-5-maas` does not exist'),
      true,
    ],
    [
      'zai-org/glm-5-maas',
      403,
      openai('403', 'permission_denied', 'Model zai-org/glm-5-maas has not been enabled for this project.'),
      false,
    ],
    ['zai-org/glm-5-maas', 403, openai('403', 'permission_denied', iam), false],
    [
      'zai-org/glm-5-maas',
      404,
      rpc(404, 'NOT_FOUND', `Publisher Model \`${publisher('zai-org', 'glm-5-maas')}\` was not found`),
      true,
    ],
  ];
  for (const [model, status, body, enablement] of cases) {
    const { provider } = recordingProvider({ location: 'global' }, () => Response.json(body, { status }));
    await assert.rejects(provider.send(hi, model, [], {}), (error) => {
      assert.equal(error.code === 'VERTEX_MODEL_NOT_ENABLED', enablement, `${model} ${status} ${JSON.stringify(body)}`);
      assert.equal(error.status, status);
      if (enablement) assert.match(error.message, /Model Garden/);
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

// Sets only `vars` among the region variables for the rest of the test.
const REGION_ENV = [
  'GOOGLE_VERTEX_LOCATION',
  'GOOGLE_CLOUD_LOCATION',
  'CLOUD_ML_REGION',
  'VERTEX_LOCATION',
  'VERTEXAI_LOCATION',
  'VERTEX_REGION_CLAUDE_4_5_SONNET',
  'VERTEX_REGION_CLAUDE_HAIKU_4_5',
  'VERTEX_REGION_CLAUDE_3_5_HAIKU',
];
function regionEnv(t, vars = {}) {
  const saved = Object.fromEntries(REGION_ENV.map((name) => [name, process.env[name]]));
  const apply = (next) => {
    for (const name of REGION_ENV) delete process.env[name];
    Object.assign(process.env, next);
  };
  apply(vars);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return apply;
}

const hostOf = (request) => new URL(request.url).host;

test('Vertex takes its region from the environment only when no location is configured', async (t) => {
  const setEnv = regionEnv(t);
  const hi = [{ role: 'user', content: 'hi' }];
  const chain = [
    ['GOOGLE_VERTEX_LOCATION', 'europe-west1'],
    ['GOOGLE_CLOUD_LOCATION', 'europe-west2'],
    ['CLOUD_ML_REGION', 'europe-west3'],
    ['VERTEX_LOCATION', 'europe-west4'],
    ['VERTEXAI_LOCATION', 'europe-west6'],
  ];
  // Each name wins over the ones after it.
  for (let index = 0; index < chain.length; index += 1) {
    setEnv(Object.fromEntries(chain.slice(index)));
    const { provider, requests } = recordingProvider({}, () => geminiSse());
    await provider.send(hi, 'gemini-3.8-flash', [], {});
    const region = chain[index][1];
    assert.equal(hostOf(requests[0]), `${region}-aiplatform.googleapis.com`, chain[index][0]);
    assert.match(requests[0].url, new RegExp(`/locations/${region}/`));
  }
  // Nothing set: global. A configured location ignores the environment.
  setEnv({});
  const unset = recordingProvider({}, () => geminiSse());
  await unset.provider.send(hi, 'gemini-3.8-flash', [], {});
  assert.equal(hostOf(unset.requests[0]), 'aiplatform.googleapis.com');
  setEnv({ GOOGLE_CLOUD_LOCATION: 'europe-west2' });
  const pinned = recordingProvider({ location: 'us-central1' }, () => geminiSse());
  await pinned.provider.send(hi, 'gemini-3.8-flash', [], {});
  assert.equal(hostOf(pinned.requests[0]), 'us-central1-aiplatform.googleapis.com');

  // A Claude model's own region comes first, in both naming orders, and never over a configured location.
  setEnv({
    CLOUD_ML_REGION: 'us-east5',
    VERTEX_REGION_CLAUDE_4_5_SONNET: 'europe-west1',
    VERTEX_REGION_CLAUDE_HAIKU_4_5: 'asia-southeast1',
  });
  for (const [model, config, host] of [
    ['claude-sonnet-4-5@20250929', {}, 'europe-west1-aiplatform.googleapis.com'],
    ['claude-haiku-4-5', {}, 'asia-southeast1-aiplatform.googleapis.com'],
    ['claude-opus-4-8', {}, 'us-east5-aiplatform.googleapis.com'],
    ['claude-sonnet-4-5', { location: 'global' }, 'aiplatform.googleapis.com'],
  ]) {
    const { provider, requests } = recordingProvider(config, () => claudeSse());
    await provider.send(hi, model, [], {});
    assert.equal(hostOf(requests[0]), host, model);
  }

  // An environment region is validated like a configured one before any host is built.
  setEnv({ GOOGLE_CLOUD_LOCATION: 'evil.example.com#' });
  const invalid = recordingProvider({}, () => geminiSse());
  await assert.rejects(invalid.provider.send(hi, 'gemini-3.8-flash', [], {}), /location is invalid/);
  assert.equal(invalid.requests.length, 0);
});

test('Vertex moves an environment region to global when it lacks the model, never a configured one', async (t) => {
  const setEnv = regionEnv(t, { CLOUD_ML_REGION: 'us-east5' });
  const hi = [{ role: 'user', content: 'hi' }];
  const notFound = () =>
    Response.json(
      { error: { code: 404, message: 'Publisher Model `gemini-3.6-flash` was not found.', status: 'NOT_FOUND' } },
      { status: 404 }
    );
  // 404 in the environment's region: retried once on global.
  for (const [model, ok] of [
    ['gemini-3.6-flash', () => geminiSse('global-ok')],
    ['claude-sonnet-5-5', () => claudeSse('global-ok')],
  ]) {
    const { provider, requests } = recordingProvider({}, (url) =>
      new URL(url).host === 'aiplatform.googleapis.com' ? ok() : notFound()
    );
    const result = await provider.send(hi, model, [], {});
    assert.equal(result.content, 'global-ok', model);
    assert.equal(hostOf(requests[0]), 'us-east5-aiplatform.googleapis.com', model);
    assert.equal(hostOf(requests.at(-1)), 'aiplatform.googleapis.com', model);
    assert.match(requests.at(-1).url, /\/locations\/global\//, model);
  }
  // Served only on global (a listed open model, a Flex request): the environment's region is not tried.
  const chunk = {
    id: 'r1',
    object: 'chat.completion.chunk',
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'open-ok' }, finish_reason: 'stop' }],
  };
  const openModel = recordingProvider(
    {},
    () =>
      new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  assert.equal((await openModel.provider.send(hi, 'deepseek-ai/deepseek-v3.2-maas', [], {})).content, 'open-ok');
  assert.equal(hostOf(openModel.requests[0]), 'aiplatform.googleapis.com');
  setEnv({ CLOUD_ML_REGION: 'us-central1' });
  const flex = recordingProvider({}, () => geminiSse());
  await flex.provider.send(hi, 'gemini-3.8-flash', [], { modelParameters: { serviceTier: 'flex' } });
  assert.equal(hostOf(flex.requests[0]), 'aiplatform.googleapis.com');

  // A configured region stays: no retry elsewhere, and the error says where else to look.
  const pinned = recordingProvider({ location: 'us-east5' }, notFound);
  await assert.rejects(pinned.provider.send(hi, 'gemini-3.6-flash', [], {}), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    assert.match(error.message, /If us-east5 does not serve it, use the global location or a region that does/);
    return true;
  });
  assert.ok(pinned.requests.every((request) => hostOf(request) === 'us-east5-aiplatform.googleapis.com'));
  const onGlobal = recordingProvider({ location: 'global' }, notFound);
  await assert.rejects(onGlobal.provider.send(hi, 'gemini-3.6-flash', [], {}), /use a region that does/);
});

test('Vertex keeps the region fallback on the account the send started with', async (t) => {
  regionEnv(t, { CLOUD_ML_REGION: 'us-east5' });
  const accountA = serviceAccount({ client_email: 'a@project-a.iam.gserviceaccount.com', project_id: 'project-a' });
  const accountB = serviceAccount({ client_email: 'b@project-b.iam.gserviceaccount.com', project_id: 'project-b' });
  const requests = [];
  const provider = new VertexAIProvider({
    apiKey: JSON.stringify(accountA),
    fetchFn: async (url, init = {}) => {
      if (url === VERTEX_TOKEN_URI) {
        const iss = decodeJwtPart(new URLSearchParams(init.body).get('assertion').split('.')[1]).iss;
        return Response.json({ access_token: `token-for-${iss}`, expires_in: 3600 });
      }
      requests.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') });
      if (new URL(url).host === 'aiplatform.googleapis.com') return claudeSse('as-the-other-account');
      // The credential switches while the environment's region answers 404.
      provider.config.apiKey = JSON.stringify(accountB);
      return Response.json({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, { status: 404 });
    },
  });
  await assert.rejects(
    claudeRequest(provider),
    (error) => error?.code === 'EVERTEXAUTH' && /credential changed during the request/.test(error.message)
  );
  assert.equal(requests.length, 1, 'the global retry never runs as the new account');
  assert.match(requests[0].url, /^https:\/\/us-east5-aiplatform\.googleapis\.com\/v1\/projects\/project-a\//);
  assert.equal(requests[0].authorization, `Bearer token-for-${accountA.client_email}`);
});

test('Vertex refuses a Claude model on the global endpoint that is not served there', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  for (const [model, variable] of [
    ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
    ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
    ['claude-opus-4-1@20250805', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
    ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
  ]) {
    const { provider, requests } = recordingProvider({ location: 'global' }, () => claudeSse());
    await assert.rejects(
      provider.send(hi, model, [], {}),
      new RegExp(`not served on the global endpoint.*us-east5.*${variable}`),
      model
    );
    assert.equal(requests.length, 0, model);
  }
  for (const model of ['claude-3-7-sonnet', 'claude-3-5-sonnet-v2', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
    const { provider, requests } = recordingProvider({ location: 'global' }, () => claudeSse());
    await provider.send(hi, model, [], {});
    assert.equal(requests.length, 1, model);
  }
});

test('Vertex express mode sends Gemini with the API key on the global endpoint, and refuses other models', async (t) => {
  regionEnv(t, { CLOUD_ML_REGION: 'us-east5' });
  const hi = [{ role: 'user', content: 'hi' }];
  const express = (config = {}) => {
    const requests = [];
    const provider = new VertexAIProvider({
      authMode: 'api-key',
      apiKey: 'AQ.express-key',
      ...config,
      fetchFn: async (url, init = {}) => {
        requests.push({ url: String(url), headers: new Headers(init.headers) });
        return geminiSse('express-ok');
      },
    });
    return { provider, requests };
  };
  const { provider, requests } = express();
  assert.equal(await provider.isAvailable(), true);
  assert.equal((await provider.send(hi, 'gemini-3.8-flash', [], {})).content, 'express-ok');
  assert.equal(requests.length, 1, 'no token request');
  assert.equal(
    requests[0].url,
    'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
  );
  assert.equal(requests[0].headers.get('x-goog-api-key'), 'AQ.express-key');
  assert.equal(requests[0].headers.get('authorization'), null);

  for (const model of ['claude-sonnet-5-5', 'zai-org/glm-5-maas']) {
    const refused = express();
    await assert.rejects(
      refused.provider.send(hi, model, [], {}),
      /needs a service-account key or the gcloud login: a Vertex AI express mode API key serves Gemini models only/,
      model
    );
    assert.equal(refused.requests.length, 0, model);
  }
  const regional = express({ location: 'europe-west4' });
  await assert.rejects(regional.provider.send(hi, 'gemini-3.8-flash', [], {}), /serves only the global location/);
  assert.equal(regional.requests.length, 0);
  const keyless = express({ apiKey: undefined, apiKeyEnv: 'MIXDOG_TEST_UNSET_VERTEX_KEY' });
  assert.equal(await keyless.provider.isAvailable(), false);
});

test('a Flex send waits out a slow first chunk that times a Standard send out at 60s', async () => {
  const hi = [{ role: 'user', content: 'hi' }];
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // Headers arrive at once; the first chunk follows after `delayMs` of (mocked) time.
  const slowFirstChunk = (delayMs) => {
    const body = geminiSse().body;
    return new Response(
      new ReadableStream({
        async start(controller) {
          const bytes = await new Response(body).arrayBuffer();
          setTimeout(() => {
            try {
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            } catch {
              // The reader was cancelled by a first-chunk timeout.
            }
          }, delayMs);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };
  const run = async (modelParameters, firstChunkMs) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let calls = 0;
      const { provider, requests } = recordingProvider({ location: 'global', sleepFn: async () => {} }, () =>
        ++calls === 1 ? slowFirstChunk(firstChunkMs) : geminiSse('replayed')
      );
      let outcome = null;
      const sent = provider.send(hi, 'gemini-3.8-flash', [], { modelParameters }).then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error })
      );
      await flush();
      mock.timers.tick(60_001);
      await flush();
      const afterSixtySeconds = { requests: requests.length, settled: outcome !== null };
      // Past the 300s semantic-idle window: only the first-byte allowance may govern a Flex wait.
      mock.timers.tick(firstChunkMs - 60_001);
      await flush();
      await sent;
      return { afterSixtySeconds, requests: requests.length, outcome };
    } finally {
      mock.timers.reset();
    }
  };

  const standard = await run({}, 120_000);
  assert.equal(standard.afterSixtySeconds.requests, 2, 'Standard: timed out at 60s and replayed');
  assert.equal(standard.outcome.value?.content, 'replayed');

  const flex = await run({ serviceTier: 'flex' }, 400_000);
  assert.deepEqual(flex.afterSixtySeconds, { requests: 1, settled: false }, 'Flex: still waiting at 60s');
  assert.equal(flex.requests, 1, 'Flex: no replay');
  assert.equal(flex.outcome.value?.content, 'ok');
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
    (error) =>
      error?.code === 'EVERTEXAUTH' && /Vertex AI authentication failed: service account rejected/.test(error.message)
  );
});
