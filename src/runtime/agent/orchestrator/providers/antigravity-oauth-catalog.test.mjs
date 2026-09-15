import test from 'node:test';
import assert from 'node:assert/strict';

import {
    antigravityQuotaWindows,
    fetchAvailableModels,
    normalizeAntigravityCatalog,
    resolveAntigravityWireModel,
} from './antigravity-oauth-catalog.mjs';
import { ANTIGRAVITY_MODELS, antigravityHeaders } from './antigravity-oauth-tokens.mjs';

const RESET = '2026-09-14T21:34:37Z';
const quota = (remainingFraction) => ({ quotaInfo: { remainingFraction, resetTime: RESET } });
const gemini = (displayName, extra = {}) => ({
    displayName, maxTokens: 1048576, supportsImages: true, supportsThinking: true,
    modelProvider: 'MODEL_PROVIDER_GOOGLE', ...quota(1), ...extra,
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
        displayName: 'Claude Opus 4.6 (Thinking)', maxTokens: 250000, supportsImages: true, supportsThinking: true,
        modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { resetTime: RESET },
    },
    'gpt-oss-120b-medium': {
        displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, supportsThinking: true,
        modelProvider: 'MODEL_PROVIDER_OPENAI', ...quota(0.9),
    },
    chat_23310: { maxTokens: 32768, quotaInfo: { remainingFraction: 1 } },
    tab_flash_lite_preview: { maxTokens: 16384, quotaInfo: { remainingFraction: 1 } },
};

test('tiered wire ids collapse into one picker model per label', () => {
    const models = normalizeAntigravityCatalog(RAW);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), [
        'claude-opus-4-6-thinking', 'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
        'gemini-3.8-flash', 'gpt-oss-120b-medium',
    ]);
    assert.equal(byId['gemini-3.8-flash'].display, 'Gemini 3.8 Flash');
    assert.deepEqual(byId['gemini-3.8-flash'].reasoningLevels, ['low', 'medium', 'high']);
    assert.deepEqual(byId['gemini-3.8-flash'].wire, {
        low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high',
    });
    assert.equal(byId['gemini-3.8-flash'].family, 'gemini-flash');
    assert.equal(byId['gemini-3.8-flash'].contextWindow, 1048576);
    // Tiers follow the gateway's label, not the id suffix.
    assert.deepEqual(byId['gemini-3.5-flash'].wire, {
        low: 'gemini-3.5-flash-extra-low', medium: 'gemini-3.5-flash-low', high: 'gemini-3-flash-agent',
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
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', 'low', models), { model: 'gemini-3.8-flash-low', effort: null });
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', undefined, models), { model: 'gemini-3.8-flash-high', effort: null });
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.1-pro', 'medium', models), { model: 'gemini-3.1-pro-high', effort: null });
    assert.deepEqual(resolveAntigravityWireModel('gemini-3-flash', 'low', models), { model: 'gemini-3-flash', effort: 'low' });
    assert.deepEqual(resolveAntigravityWireModel('claude-opus-4-6-thinking', 'high', models), { model: 'claude-opus-4-6-thinking', effort: null });
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash-medium', 'high', models), { model: 'gemini-3.8-flash-medium', effort: 'high' });
});

test('the curated fallback resolves the same way as a live catalog', () => {
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.8-flash', 'medium', ANTIGRAVITY_MODELS), { model: 'gemini-3.8-flash-medium', effort: null });
    assert.deepEqual(resolveAntigravityWireModel('gemini-3.1-pro', 'low', ANTIGRAVITY_MODELS), { model: 'gemini-3.1-pro-low', effort: null });
    for (const model of ANTIGRAVITY_MODELS) assert.equal(model.provider, 'antigravity-oauth');
});

test('quota windows group the most-used model per family and treat reset-only counters as exhausted', () => {
    const windows = antigravityQuotaWindows(RAW);
    const byLabel = Object.fromEntries(windows.map((w) => [w.label, w]));
    assert.deepEqual(Object.keys(byLabel), ['FLASH', 'PRO']);
    assert.equal(byLabel.FLASH.usedPct, 60);
    assert.equal(byLabel.PRO.usedPct, 25);
    assert.equal(byLabel.FLASH.resetAt, Date.parse(RESET));
    assert.equal(byLabel.FLASH.source, 'antigravity-models');
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
        fetchAvailableModels({ accessToken: 'token', projectId: 'proj', fetchFn: async () => new Response('denied', { status: 403 }) }),
        /fetchAvailableModels failed: 403 denied/,
    );
});
