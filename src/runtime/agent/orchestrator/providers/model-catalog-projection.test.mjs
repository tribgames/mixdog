import assert from 'node:assert/strict';
import test from 'node:test';

import {
    projectLitellmCatalog,
    projectModelsDevCatalog,
} from './model-catalog-projection.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';

const isoDay = (date) => date.toISOString().slice(0, 10);
const NOW = new Date();
// Dates are derived rather than literal so the absolute staleness cut, which
// measures against wall-clock now, cannot turn these fixtures stale later.
const RECENT = isoDay(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)));
const OLD = isoDay(new Date(Date.UTC(NOW.getUTCFullYear() - 2, NOW.getUTCMonth(), 1)));

/** Shaped like the published models.dev payload: the fields the lookups read,
 *  wrapped in the prose and metadata they never touch. */
function modelsDevFixture() {
    return {
        anthropic: {
            id: 'anthropic',
            name: 'Anthropic',
            doc: 'https://docs.anthropic.com',
            env: ['ANTHROPIC_API_KEY'],
            models: {
                'claude-opus-9-1': {
                    id: 'claude-opus-9-1',
                    name: 'Claude Opus 9.1',
                    description: 'Prose no lookup reads. '.repeat(24),
                    family: 'claude-opus',
                    release_date: RECENT,
                    last_updated: RECENT,
                    knowledge: '2026-01',
                    open_weights: false,
                    temperature: true,
                    structured_output: true,
                    attachment: true,
                    tool_call: true,
                    reasoning: true,
                    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                    interleaved: { field: 'thinking' },
                    modalities: { input: ['text', 'image'], output: ['text'] },
                    limit: { context: 200000, output: 64000 },
                    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
                },
                'claude-opus-8-0': {
                    id: 'claude-opus-8-0',
                    name: 'Claude Opus 8',
                    description: 'Superseded by the row above. '.repeat(24),
                    family: 'claude-opus',
                    release_date: OLD,
                    knowledge: '2024-01',
                    tool_call: true,
                    modalities: { input: ['text'], output: ['text'] },
                    limit: { context: 200000, output: 32000 },
                    cost: { input: 15, output: 75 },
                },
            },
        },
    };
}

test('projection keeps every models.dev field a lookup reads', () => {
    const source = modelsDevFixture();
    const row = projectModelsDevCatalog(source).anthropic.models['claude-opus-9-1'];
    const original = source.anthropic.models['claude-opus-9-1'];

    assert.deepEqual(row.cost, original.cost, 'pricing drives every cost figure');
    assert.deepEqual(row.limit, original.limit, 'limits drive context/output sizing');
    assert.deepEqual(row.modalities, original.modalities, 'vision + coding-fit read both directions');
    assert.deepEqual(row.reasoning_options, original.reasoning_options);
    assert.equal(row.reasoning, true);
    assert.equal(row.interleaved.field, 'thinking');
    assert.equal(row.tool_call, true);
    assert.equal(row.family, 'claude-opus');
    assert.equal(row.release_date, RECENT);
});

test('projection drops the models.dev payload no lookup reads', () => {
    const row = projectModelsDevCatalog(modelsDevFixture()).anthropic.models['claude-opus-9-1'];

    for (const field of ['description', 'knowledge', 'open_weights', 'temperature',
        'structured_output', 'attachment', 'last_updated', 'name']) {
        assert.equal(field in row, false, `${field} has no reader and must not stay resident`);
    }
});

test('an explicit tool_call:false survives, because absent means something else', () => {
    const source = modelsDevFixture();
    source.anthropic.models['claude-opus-8-0'].tool_call = false;
    const projected = projectModelsDevCatalog(source);

    assert.equal(projected.anthropic.models['claude-opus-8-0'].tool_call, false);
});

test('a cost-less row stays cost-less rather than gaining an empty object', () => {
    const source = modelsDevFixture();
    delete source.anthropic.models['claude-opus-8-0'].cost;
    const projected = projectModelsDevCatalog(source);

    assert.equal('cost' in projected.anthropic.models['claude-opus-8-0'], false);
});

test('the sanitizer reaches the same verdict on a projected catalog', () => {
    const source = modelsDevFixture();
    const models = [
        { id: 'claude-opus-9-1', mode: 'chat', contextWindow: 200000, outputTokens: 64000 },
        { id: 'claude-opus-8-0', mode: 'chat', contextWindow: 200000, outputTokens: 32000 },
    ];
    const options = { provider: 'anthropic' };

    const fromFull = sanitizeModelList(models, { ...options, _testCatalog: source });
    const fromProjected = sanitizeModelList(models, {
        ...options,
        _testCatalog: projectModelsDevCatalog(source),
    });

    assert.deepEqual(
        fromProjected.map((row) => row.id),
        fromFull.map((row) => row.id),
        'narrowing the resident shape must not change which models survive',
    );
    assert.deepEqual(fromProjected.map((row) => row.id), ['claude-opus-9-1']);
});

test('projection keeps every LiteLLM field a lookup reads', () => {
    const source = {
        'anthropic/claude-opus-9-1': {
            litellm_provider: 'anthropic',
            mode: 'chat',
            max_input_tokens: 200000,
            max_tokens: 200000,
            max_output_tokens: 64000,
            input_cost_per_token: 5e-6,
            output_cost_per_token: 25e-6,
            cache_read_input_token_cost: 0.5e-6,
            cache_creation_input_token_cost: 6.25e-6,
            supports_vision: true,
            supports_function_calling: true,
            supports_prompt_caching: true,
            supports_reasoning: true,
            reasoning_content_field: 'thinking',
            reasoning_options: [{ type: 'effort', values: ['high'] }],
            // Never read by _normalize.
            deprecation_date: '2027-01-01',
            input_cost_per_pixel: 0.001,
            supported_regions: ['us-east-1', 'eu-west-1'],
            supports_audio_input: false,
        },
    };

    const row = projectLitellmCatalog(source)['anthropic/claude-opus-9-1'];

    assert.equal(row.litellm_provider, 'anthropic', 'the provider guard depends on this');
    assert.equal(row.mode, 'chat');
    assert.equal(row.max_input_tokens, 200000);
    assert.equal(row.max_output_tokens, 64000);
    assert.equal(row.input_cost_per_token, 5e-6);
    assert.equal(row.cache_creation_input_token_cost, 6.25e-6);
    assert.equal(row.supports_vision, true);
    assert.equal(row.reasoning_content_field, 'thinking');
    assert.deepEqual(row.reasoning_options, source['anthropic/claude-opus-9-1'].reasoning_options);

    for (const field of ['deprecation_date', 'input_cost_per_pixel', 'supported_regions',
        'supports_audio_input']) {
        assert.equal(field in row, false, `${field} has no reader and must not stay resident`);
    }
});

test('projection tolerates the shapes a published catalog actually contains', () => {
    assert.deepEqual(projectModelsDevCatalog({ broken: null }), {});
    assert.deepEqual(projectModelsDevCatalog({ noModels: { name: 'x' } }), {});
    assert.deepEqual(projectLitellmCatalog({ broken: null }), {});
    assert.equal(projectModelsDevCatalog(null), null);
    assert.equal(projectLitellmCatalog(undefined), undefined);
});
