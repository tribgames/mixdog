import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Catalog rows by `${provider}:${model}`; an unlisted model has no catalog row.
const catalogRows = new Map();
const catalogUrl = new URL('../../../shared/llm/model-catalog.mjs', import.meta.url).href;
const realCatalog = await import(catalogUrl);
mock.module(catalogUrl, {
  namedExports: {
    ...realCatalog,
    getModelMetadataSync: (id, provider) => catalogRows.get(`${provider}:${id}`) ?? null,
  },
});
const effortRow = (...values) => ({ supportsReasoning: true, reasoningOptions: [{ type: 'effort', values }] });

const {
  antigravityModelFamily,
  antigravityOutputLimit,
  antigravityQuotaWindows,
  fetchAvailableModels,
  fetchUserQuotaSummary,
  normalizeAntigravityCatalog,
  resolveAntigravityWireModel,
} = await import('./antigravity-oauth-catalog.mjs');
const { ANTIGRAVITY_MODELS, antigravityHeaders } = await import('./antigravity-oauth-tokens.mjs');

const RESET = '2026-09-14T21:34:37Z';
const quota = (remainingFraction) => ({ quotaInfo: { remainingFraction, resetTime: RESET } });
const gemini = (displayName, extra = {}) => ({
  displayName,
  maxTokens: 1048576,
  supportsImages: true,
  supportsThinking: true,
  modelProvider: 'MODEL_PROVIDER_GOOGLE',
  ...quota(1),
  ...extra,
});

// Shape observed from the live gateway: tiered flash ids, aliases sharing one
// label, IDE-internal entries, and an image model without a context window.
const RAW = {
  'gemini-3.8-flash-high': gemini('Gemini 3.8 Flash (High)'),
  'gemini-3.8-flash-medium': gemini('Gemini 3.8 Flash (Medium)', quota(0.4)),
  'gemini-3.8-flash-low': gemini('Gemini 3.8 Flash (Low)'),
  'gemini-3.8-flash-tiered': gemini(''),
  'gemini-3.5-flash-low': gemini('Gemini 3.5 Flash (Medium)'),
  'gemini-3.5-flash-extra-low': gemini('Gemini 3.5 Flash (Low)'),
  'gemini-3-flash-agent': gemini('Gemini 3.5 Flash (High)'),
  'gemini-3-flash': gemini('Gemini 3 Flash'),
  'gemini-2.5-flash': gemini('Gemini 3.5 Flash Lite'),
  'gemini-2.5-flash-lite': gemini('Gemini 3.5 Flash Lite'),
  'gemini-3.5-flash-lite': gemini('Gemini 3.5 Flash Lite'),
  'gemini-3.1-pro-high': gemini('Gemini 3.1 Pro (High)', quota(0.75)),
  'gemini-pro-agent': gemini('Gemini 3.1 Pro (High)'),
  'gemini-3.1-pro-low': gemini('Gemini 3.1 Pro (Low)'),
  'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image', modelProvider: 'MODEL_PROVIDER_GOOGLE' },
  'claude-opus-4-6-thinking': {
    displayName: 'Claude Opus 4.6 (Thinking)',
    maxTokens: 250000,
    supportsImages: true,
    supportsThinking: true,
    modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
    quotaInfo: { resetTime: RESET },
  },
  'gpt-oss-120b-medium': {
    displayName: 'GPT-OSS 120B (Medium)',
    maxTokens: 131072,
    supportsThinking: true,
    modelProvider: 'MODEL_PROVIDER_OPENAI',
    ...quota(0.9),
  },
  chat_23310: { maxTokens: 32768, quotaInfo: { remainingFraction: 1 } },
  tab_flash_lite_preview: { maxTokens: 16384, quotaInfo: { remainingFraction: 1 } },
};

test('catalog rows keep the gateway-declared maxOutputTokens, the smallest across a record\'s wire ids', () => {
  catalogRows.clear();
  const models = normalizeAntigravityCatalog({
    'gemini-3.8-flash-high': gemini('Gemini 3.8 Flash (High)', { maxOutputTokens: 65536 }),
    'gemini-3.8-flash-low': gemini('Gemini 3.8 Flash (Low)', { maxOutputTokens: 65535 }),
    'gemini-2.5-flash': gemini('Gemini 2.5 Flash', { maxOutputTokens: 65535 }),
    'gemini-3-flash': gemini('Gemini 3 Flash'),
    'claude-opus-5-5': {
      displayName: 'Claude Opus 5.5',
      maxTokens: 250000,
      maxOutputTokens: 128000,
      supportsThinking: true,
      modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
      quotaInfo: { resetTime: RESET },
    },
  });
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId['gemini-3.8-flash'].maxOutputTokens, 65535);
  assert.equal(byId['gemini-2.5-flash'].maxOutputTokens, 65535);
  assert.equal('maxOutputTokens' in byId['gemini-3-flash'], false);
  assert.equal(antigravityOutputLimit('gemini-3.8-flash-high', models), 65535);
  assert.equal(antigravityOutputLimit('gemini-3.8-flash', models), 65535);
  assert.equal(antigravityOutputLimit('claude-opus-5-5', models), 128000);
  assert.equal(antigravityOutputLimit('gemini-3-flash', models), null);
  assert.equal(antigravityOutputLimit('never-listed', models), null);
  // The curated offline list declares nothing.
  assert.equal(antigravityOutputLimit('gemini-3.8-flash-high', ANTIGRAVITY_MODELS), null);
});

test('tiered wire ids collapse into one picker model per label', () => {
  catalogRows.clear();
  const models = normalizeAntigravityCatalog(RAW);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'claude-opus-4-6-thinking',
    'gemini-3-flash',
    'gemini-3.1-pro',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gpt-oss-120b-medium',
  ]);
  assert.equal(byId['gemini-3.8-flash'].display, 'Gemini 3.8 Flash');
  assert.deepEqual(byId['gemini-3.8-flash'].reasoningLevels, ['low', 'medium', 'high']);
  assert.deepEqual(byId['gemini-3.8-flash'].wire, {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  });
  assert.equal(byId['gemini-3.8-flash'].family, 'gemini-flash');
  assert.equal(byId['gemini-3.8-flash'].contextWindow, 1048576);
  // Tiers follow the gateway's label, not the id suffix.
  assert.deepEqual(byId['gemini-3.5-flash'].wire, {
    low: 'gemini-3.5-flash-extra-low',
    medium: 'gemini-3.5-flash-low',
    high: 'gemini-3-flash-agent',
  });
  // Duplicate labels keep the id that carries the labelled version.
  assert.deepEqual(byId['gemini-3.1-pro'].wire, { low: 'gemini-3.1-pro-low', high: 'gemini-3.1-pro-high' });
  assert.equal(byId['gemini-3.5-flash-lite'].wire, 'gemini-3.5-flash-lite');
  // The gateway flags this fixture as thinking-capable, so a bare id keeps the
  // thinkingLevel surface (no catalog ladder here); the gateway never takes `minimal`.
  assert.deepEqual(byId['gemini-3.5-flash-lite'].reasoningLevels, ['low', 'medium', 'high']);
  assert.deepEqual(byId['gemini-3-flash'].reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(byId['claude-opus-4-6-thinking'].display, 'Claude Opus 4.6 (Thinking)');
  assert.equal(byId['claude-opus-4-6-thinking'].family, undefined);
  assert.equal(byId['gpt-oss-120b-medium'].display, 'GPT-OSS 120B (Medium)');
  assert.deepEqual(byId['gpt-oss-120b-medium'].reasoningLevels, []);
});

test('a bare Gemini id of any generation offers the levels its catalog row declares, nothing invented', () => {
  catalogRows.clear();
  catalogRows.set('gemini:gemini-4-flash', effortRow('low', 'medium', 'high', 'xhigh'));
  catalogRows.set('gemini:gemini-9-hyper-pro', effortRow('minimal', 'low', 'high'));
  catalogRows.set('gemini:gemini-2.5-pro', effortRow('low', 'high'));
  const byId = Object.fromEntries(
    normalizeAntigravityCatalog({
      'gemini-4-flash': gemini('Gemini 4 Flash'),
      'gemini-9-hyper-pro': gemini('Gemini 9 Hyper Pro'),
      'gemini-4.2-pro': gemini('Gemini 4.2 Pro'),
      'gemini-2.5-pro': gemini('Gemini 2.5 Pro'),
      'gemini-4-lite': gemini('Gemini 4 Lite', { supportsThinking: false }),
    }).map((m) => [m.id, m])
  );
  assert.deepEqual(byId['gemini-4-flash'].reasoningLevels, ['low', 'medium', 'high']);
  assert.deepEqual(byId['gemini-9-hyper-pro'].reasoningLevels, ['low', 'high']);
  assert.deepEqual(byId['gemini-2.5-pro'].reasoningLevels, ['low', 'high']);
  // No catalog ladder at all: the gateway-accepted levels, value judged by the server.
  assert.deepEqual(byId['gemini-4.2-pro'].reasoningLevels, ['low', 'medium', 'high']);
  // A model the gateway does not flag as thinking-capable has none.
  assert.deepEqual(byId['gemini-4-lite'].reasoningLevels, []);
  const models = Object.values(byId);
  assert.deepEqual(resolveAntigravityWireModel('gemini-4-flash', 'high', models), {
    model: 'gemini-4-flash',
    effort: 'high',
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-4.2-pro', 'medium', models), {
    model: 'gemini-4.2-pro',
    effort: 'medium',
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-4-lite', 'high', models), {
    model: 'gemini-4-lite',
    effort: null,
  });
});

test('bare Gemini ids with no catalog row keep low/medium/high and pass the effort through', () => {
  catalogRows.clear();
  const models = normalizeAntigravityCatalog({
    'gemini-3-flash': gemini('Gemini 3 Flash'),
    'gemini-4-argon': gemini('Gemini 4 Argon'),
  });
  for (const model of models) {
    assert.deepEqual(model.reasoningLevels, ['low', 'medium', 'high'], model.id);
    assert.deepEqual(
      resolveAntigravityWireModel(model.id, 'high', models),
      { model: model.id, effort: 'high' },
      model.id
    );
  }
});

const byIdLevels = (models, id) => models.find((m) => m.id === id)?.reasoningLevels;

test('wire resolution consumes the effort for tiered families only', () => {
  catalogRows.clear();
  const models = normalizeAntigravityCatalog(RAW);
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', 'low', models), {
    model: 'gemini-3.8-flash-low',
    effort: null,
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', undefined, models), {
    model: 'gemini-3.8-flash-high',
    effort: null,
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.1-pro', 'medium', models), {
    model: 'gemini-3.1-pro-high',
    effort: null,
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-3-flash', 'low', models), {
    model: 'gemini-3-flash',
    effort: 'low',
  });
  // A bare Claude thinking id keeps its effort for thinkingLevel.
  assert.deepEqual(byIdLevels(models, 'claude-opus-4-6-thinking'), ['low', 'medium', 'high']);
  assert.deepEqual(resolveAntigravityWireModel('claude-opus-4-6-thinking', 'high', models), {
    model: 'claude-opus-4-6-thinking',
    effort: 'high',
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash-medium', 'high', models), {
    model: 'gemini-3.8-flash-medium',
    effort: 'high',
  });
});

test('the curated fallback resolves the same way as a live catalog', () => {
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', 'medium', ANTIGRAVITY_MODELS), {
    model: 'gemini-3.8-flash-medium',
    effort: null,
  });
  assert.deepEqual(resolveAntigravityWireModel('gemini-3.1-pro', 'low', ANTIGRAVITY_MODELS), {
    model: 'gemini-3.1-pro-low',
    effort: null,
  });
  for (const model of ANTIGRAVITY_MODELS) assert.equal(model.provider, 'antigravity-oauth');
});

test('the curated fallback sends Gemini 4 Argon by its tier wire id, never the bare id the gateway 404s', () => {
  assert.equal(antigravityModelFamily('gemini-4-argon', ANTIGRAVITY_MODELS), 'gemini-pro');
  assert.equal(antigravityModelFamily('gemini-4-argon-high', ANTIGRAVITY_MODELS), 'gemini-pro');
  for (const effort of ['low', 'medium', 'high']) {
    assert.deepEqual(resolveAntigravityWireModel('gemini-4-argon', effort, ANTIGRAVITY_MODELS), {
      model: `gemini-4-argon-${effort}`,
      effort: null,
    });
  }
  assert.deepEqual(resolveAntigravityWireModel('gemini-4-argon', undefined, ANTIGRAVITY_MODELS), {
    model: 'gemini-4-argon-high',
    effort: null,
  });
});

test('the live gateway tier labels for Argon collapse into the same record as the curated fallback', () => {
  catalogRows.clear();
  const live = normalizeAntigravityCatalog({
    'gemini-4-argon-low': gemini('Gemini 4 Argon (Low)'),
    'gemini-4-argon-medium': gemini('Gemini 4 Argon (Medium)'),
    'gemini-4-argon-high': gemini('Gemini 4 Argon (High)'),
  });
  const curated = ANTIGRAVITY_MODELS.find((entry) => entry.id === 'gemini-4-argon');
  assert.deepEqual(live, [curated]);
});

test('sends resolve against the last live catalog even after its TTL, before the curated list', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-ag-catalog-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  try {
    const live = [{ id: 'gemini-9-live', provider: 'antigravity-oauth', wire: { high: 'gemini-9-live-high' } }];
    const fetchedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(join(dir, 'antigravity-oauth-models.json'), JSON.stringify({ version: 2, fetchedAt, models: live }));
    const fresh = await import(`./antigravity-oauth-catalog.mjs?stale=${Date.now()}`);
    assert.deepEqual(fresh.resolveAntigravityWireModel('gemini-9-live', 'low'), {
      model: 'gemini-9-live-high',
      effort: null,
    });
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

const GEMINI_GROUP = {
  displayName: 'Gemini Models',
  description: 'Models within this group: Gemini Flash, Gemini Pro',
};
const CLAUDE_GPT_GROUP = {
  displayName: 'Claude and GPT models',
  description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
};

test('quota windows map Gemini 5-hour and weekly summary buckets to 5H/7D', () => {
  const windows = antigravityQuotaWindows({
    groups: [
      {
        ...GEMINI_GROUP,
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit',
            window: 'weekly',
            resetTime: RESET,
            remainingFraction: 0.88,
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit',
            window: '5h',
            resetTime: '2026-09-04T12:00:00Z',
            remainingFraction: 0.5,
          },
        ],
      },
      {
        ...CLAUDE_GPT_GROUP,
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.07, resetTime: RESET },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 0.05, resetTime: RESET },
        ],
      },
    ],
  });
  // Each group's buckets gate its own models: the 3p pair Claude/GPT, the
  // Gemini pair every model the 3p pair does not claim.
  const gemini = { except: ['claude', 'gpt'] };
  const thirdParty = { models: ['claude', 'gpt'] };
  assert.deepEqual(windows, [
    {
      label: '5H',
      usedPct: 50,
      resetAt: Date.parse('2026-09-04T12:00:00Z'),
      source: 'antigravity-quota-summary',
      ...gemini,
    },
    { label: '7D', usedPct: 12, resetAt: Date.parse(RESET), source: 'antigravity-quota-summary', ...gemini },
    {
      label: '5H Claude/GPT',
      usedPct: 95,
      resetAt: Date.parse(RESET),
      source: 'antigravity-quota-summary',
      ...thirdParty,
    },
    {
      label: '7D Claude/GPT',
      usedPct: 93,
      resetAt: Date.parse(RESET),
      source: 'antigravity-quota-summary',
      ...thirdParty,
    },
  ]);
});

test('quota windows show the Claude/GPT buckets by bucket id, even without the Gemini group or its display text', () => {
  const group = {
    displayName: 'Renamed',
    buckets: [
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.25, resetTime: RESET },
      { bucketId: '3p-5h', window: '5h', remainingFraction: 0.5, resetTime: RESET },
    ],
  };
  const thirdParty = { source: 'antigravity-quota-summary', models: ['claude', 'gpt'] };
  assert.deepEqual(antigravityQuotaWindows({ groups: [group] }), [
    { label: '5H Claude/GPT', usedPct: 50, resetAt: Date.parse(RESET), ...thirdParty },
    { label: '7D Claude/GPT', usedPct: 75, resetAt: Date.parse(RESET), ...thirdParty },
  ]);
  // A group whose text names Claude but whose buckets carry other ids is not mapped.
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [{ ...CLAUDE_GPT_GROUP, buckets: [{ bucketId: 'other', window: 'weekly', remainingFraction: 0.1 }] }],
    }),
    []
  );
});

test('quota windows add the separate Gemini 4 Argon weekly bucket as 7D Argon', () => {
  const argonGroup = {
    displayName: 'Gemini 4 Argon',
    description: 'For paid Pro plans, Argon quota is separate.',
    buckets: [
      {
        bucketId: 'gemini-argon-wtu-weekly',
        displayName: 'Gemini 4 Argon Weekly Limit',
        window: 'weekly',
        resetTime: '2026-10-24T08:11:47Z',
        remainingFraction: 0.75,
      },
    ],
  };
  const gemini = {
    ...GEMINI_GROUP,
    buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.88, resetTime: RESET }],
  };
  const argonRow = {
    label: '7D Argon',
    usedPct: 25,
    resetAt: Date.parse('2026-10-24T08:11:47Z'),
    source: 'antigravity-quota-summary',
    models: ['argon'],
  };
  // Argon draws on its own group's bucket, so the shared Gemini rows leave it out.
  assert.deepEqual(antigravityQuotaWindows({ groups: [gemini, argonGroup] }), [
    { label: '7D', usedPct: 12, resetAt: Date.parse(RESET), source: 'antigravity-quota-summary', except: ['argon'] },
    argonRow,
  ]);
  // The Argon limit shows even when the shared Gemini group is absent.
  assert.deepEqual(antigravityQuotaWindows({ groups: [argonGroup] }), [argonRow]);
  // Shared Gemini rows also follow their bucket ids when the group is renamed.
  assert.deepEqual(antigravityQuotaWindows({ groups: [{ ...gemini, displayName: 'Renamed' }] }), [
    { label: '7D', usedPct: 12, resetAt: Date.parse(RESET), source: 'antigravity-quota-summary' },
  ]);
  // The bucket id, not the group's display text, selects it.
  assert.deepEqual(antigravityQuotaWindows({ groups: [{ ...argonGroup, displayName: 'Renamed' }] }), [argonRow]);
  const decoy = {
    displayName: 'Argon Preview',
    buckets: [{ bucketId: 'other-weekly', window: 'weekly', remainingFraction: 0.1, resetTime: RESET }],
  };
  assert.deepEqual(antigravityQuotaWindows({ groups: [decoy, { displayName: 'Argon', buckets: [] }, argonGroup] }), [
    argonRow,
  ]);
});

test('quota windows treat remainingFraction 0 as exhausted and omit missing fields instead of inferring them', () => {
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [
        {
          ...GEMINI_GROUP,
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: RESET },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0 },
          ],
        },
      ],
    }),
    [
      { label: '5H', usedPct: 100, resetAt: Date.parse(RESET), source: 'antigravity-quota-summary' },
      { label: '7D', usedPct: 100, source: 'antigravity-quota-summary' },
    ]
  );

  // Reset-only and unknown windows are not guessed into 5H/7D or 100%.
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [
        {
          ...GEMINI_GROUP,
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', resetTime: RESET },
            { bucketId: 'gemini-daily', window: 'daily', remainingFraction: 0.2, resetTime: RESET },
          ],
        },
      ],
    }),
    []
  );

  // A present 5-hour bucket does not invent a weekly row.
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [
        {
          ...GEMINI_GROUP,
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25 }],
        },
      ],
    }),
    [{ label: '5H', usedPct: 75, source: 'antigravity-quota-summary' }]
  );

  assert.deepEqual(antigravityQuotaWindows({}), []);
  assert.deepEqual(antigravityQuotaWindows({ groups: null }), []);
  assert.deepEqual(antigravityQuotaWindows(RAW), []);
});

test('quota windows omit lookalike labels and keep usedPct/resetAt on the same selected bucket', () => {
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [
        {
          displayName: 'Gemini Flash',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '15h',
              remainingFraction: 0.1,
              resetTime: RESET,
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: '7d',
              remainingFraction: 0.2,
              resetTime: RESET,
            },
            { bucketId: 'week', displayName: 'Weekly Limit', window: 'week', remainingFraction: 0.3, resetTime: RESET },
          ],
        },
        {
          ...GEMINI_GROUP,
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '15h',
              remainingFraction: 0.4,
              resetTime: RESET,
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: '7d',
              remainingFraction: 0.5,
              resetTime: RESET,
            },
          ],
        },
      ],
    }),
    []
  );

  const firstReset = '2026-01-01T00:00:00Z';
  const laterReset = '2030-01-01T00:00:00Z';
  assert.deepEqual(
    antigravityQuotaWindows({
      groups: [
        {
          ...GEMINI_GROUP,
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1, resetTime: firstReset },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: laterReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: firstReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.2, resetTime: laterReset },
          ],
        },
      ],
    }),
    [
      { label: '5H', usedPct: 90, resetAt: Date.parse(firstReset), source: 'antigravity-quota-summary' },
      { label: '7D', usedPct: 20, resetAt: Date.parse(firstReset), source: 'antigravity-quota-summary' },
    ]
  );
});

test('fetchAvailableModels posts the project with the hub identity', async () => {
  let seen = null;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return Response.json({ models: RAW });
  };
  const models = await fetchAvailableModels({ accessToken: 'token', projectId: 'proj', fetchFn });
  assert.equal(seen.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { project: 'proj' });
  assert.equal(seen.init.headers.Authorization, 'Bearer token');
  assert.equal(seen.init.headers['User-Agent'], antigravityHeaders()['User-Agent']);
  assert.ok('gemini-3.8-flash-high' in models);
  await assert.rejects(
    fetchAvailableModels({
      accessToken: 'token',
      projectId: 'proj',
      fetchFn: async () => new Response('denied', { status: 403 }),
    }),
    /fetchAvailableModels failed: 403 denied/
  );
});

test('fetchUserQuotaSummary posts the project with the hub identity', async () => {
  let seen = null;
  const summary = { groups: [{ ...GEMINI_GROUP, buckets: [] }] };
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return Response.json(summary);
  };
  assert.deepEqual(await fetchUserQuotaSummary({ accessToken: 'token', projectId: 'proj', fetchFn }), summary);
  assert.equal(seen.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { project: 'proj' });
  assert.equal(seen.init.headers.Authorization, 'Bearer token');
  assert.equal(seen.init.headers['User-Agent'], antigravityHeaders()['User-Agent']);
  await assert.rejects(
    fetchUserQuotaSummary({
      accessToken: 'token',
      projectId: 'proj',
      fetchFn: async () => new Response('denied', { status: 403 }),
    }),
    /retrieveUserQuotaSummary failed: 403 denied/
  );
});
