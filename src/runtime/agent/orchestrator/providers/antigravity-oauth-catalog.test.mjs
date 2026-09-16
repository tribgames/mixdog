import test from 'node:test';
import assert from 'node:assert/strict';

import {
  antigravityQuotaWindows,
  fetchAvailableModels,
  fetchUserQuotaSummary,
  normalizeAntigravityCatalog,
  resolveAntigravityWireModel,
} from './antigravity-oauth-catalog.mjs';
import { ANTIGRAVITY_MODELS, antigravityHeaders } from './antigravity-oauth-tokens.mjs';

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

test('tiered wire ids collapse into one picker model per label', () => {
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
  assert.deepEqual(byId['gemini-3.5-flash-lite'].reasoningLevels, []);
  // Bare Gemini 3 keeps the thinkingLevel surface.
  assert.deepEqual(byId['gemini-3-flash'].reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(byId['claude-opus-4-6-thinking'].display, 'Claude Opus 4.6 (Thinking)');
  assert.equal(byId['claude-opus-4-6-thinking'].family, undefined);
  assert.equal(byId['gpt-oss-120b-medium'].display, 'GPT-OSS 120B (Medium)');
  assert.deepEqual(byId['gpt-oss-120b-medium'].reasoningLevels, []);
});

test('wire resolution consumes the effort for tiered families only', () => {
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
  assert.deepEqual(resolveAntigravityWireModel('claude-opus-4-6-thinking', 'high', models), {
    model: 'claude-opus-4-6-thinking',
    effort: null,
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
  assert.deepEqual(windows, [
    { label: '5H', usedPct: 50, resetAt: Date.parse('2026-09-04T12:00:00Z'), source: 'antigravity-quota-summary' },
    { label: '7D', usedPct: 12, resetAt: Date.parse(RESET), source: 'antigravity-quota-summary' },
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
            { window: '5h', remainingFraction: 0.1, resetTime: firstReset },
            { window: '5h', remainingFraction: 0.9, resetTime: laterReset },
            { window: 'weekly', remainingFraction: 0.8, resetTime: firstReset },
            { window: 'weekly', remainingFraction: 0.2, resetTime: laterReset },
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
