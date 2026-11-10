import test from 'node:test';
import assert from 'node:assert/strict';
import { fastCapableFor, makeWebSearchCapableFor } from './model-capabilities.mjs';

test('gemini web-search fallback covers every current generation, not only 3', () => {
  const capable = makeWebSearchCapableFor(webSearchProviderFamily, () => null);
  assert.equal(capable('gemini', { id: 'gemini-4-argon' }), true);
  assert.equal(capable('gemini', { id: 'gemini-12-pro' }), true);
  assert.equal(capable('gemini', { id: 'gemini-2.5-flash' }), true);
  assert.equal(capable('gemini', { id: 'gemini-1.5-pro' }), false);
  assert.equal(capable('gemini', { id: 'gemini-4-embedding' }), false);
});

test('a route row fast-mode declaration beats the id rule both ways', () => {
  assert.equal(fastCapableFor('anthropic', { id: 'claude-opus-5', supportsFastMode: false }), false);
  assert.equal(fastCapableFor('anthropic-oauth', { id: 'claude-nova-9', supportsFastMode: true }), true);
  assert.equal(fastCapableFor('openai', { id: 'gpt-5.5', supportsFastMode: false }), false);
  assert.equal(fastCapableFor('openai', { id: 'vortex-1', supportsFastMode: true }), true);
});
import { isWebSearchCapableProvider, webSearchProviderFamily } from './workflow.mjs';

const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily, () => null);

test('providers normalize to their hosted web-search family', () => {
  assert.equal(webSearchProviderFamily('antigravity-oauth'), 'gemini');
  assert.equal(webSearchProviderFamily('gemini-api'), 'gemini');
  assert.equal(webSearchProviderFamily('openai-oauth'), 'openai');
  assert.equal(webSearchProviderFamily('grok-oauth'), 'xai');
  assert.equal(webSearchProviderFamily('anthropic-oauth'), 'anthropic');
  assert.equal(webSearchProviderFamily('constructor'), '');
  assert.equal(isWebSearchCapableProvider('antigravity-oauth'), true);
  assert.equal(isWebSearchCapableProvider('cursor-oauth'), false);
});

test('antigravity follows the gemini family model rule', () => {
  assert.equal(webSearchCapableFor('antigravity-oauth', { id: 'gemini-3.8-flash' }), true);
  assert.equal(webSearchCapableFor('antigravity-oauth', { id: 'gemini-2.5-pro' }), true);
  assert.equal(webSearchCapableFor('antigravity-oauth', { id: 'claude-opus-5.5' }), false);
  assert.equal(webSearchCapableFor('antigravity-oauth', { id: 'gpt-oss-120b-medium' }), false);
  assert.equal(webSearchCapableFor('antigravity-oauth', { id: 'gemini-12-flash' }), true);
  assert.equal(webSearchCapableFor('cursor-oauth', { id: 'gpt-5', supportsWebSearch: true }), false);
});

// [provider, id the family regex accepts, id the family regex rejects]
const FAMILIES = [
  ['openai-oauth', 'gpt-5.5', 'gpt-3.5-turbo'],
  ['openai', 'gpt-5.5', 'gpt-4-turbo'],
  ['grok-oauth', 'grok-4.5', 'grok-imagine-video'],
  ['xai', 'grok-4.5', 'grok-2-image'],
  ['gemini', 'gemini-3.8-flash', 'gemini-1.5-pro'],
  ['antigravity-oauth', 'gemini-3.8-flash', 'nebula-1'],
  ['anthropic', 'claude-opus-5-5', 'claude-3-5-sonnet-20241022'],
  ['anthropic-oauth', 'claude-opus-5-5', 'claude-3-opus'],
];

test('an id released after this code was written is capable with no code change', () => {
  for (const [provider, id] of [
    ['openai-oauth', 'gpt-9.2-sol'],
    ['openai', 'o7-pro'],
    ['xai', 'grok-11'],
    ['grok-oauth', 'grok-11-fast'],
    ['gemini', 'gemini-14-flash'],
    ['anthropic', 'claude-nova-9'],
    ['anthropic-oauth', 'claude-opus-9-1'],
  ]) {
    assert.equal(webSearchCapableFor(provider, { id }), true, `${provider}/${id}`);
  }
});

test('a row’s own supportsWebSearch flag wins both ways in every family', () => {
  for (const [provider, accepted, rejected] of FAMILIES) {
    assert.equal(webSearchCapableFor(provider, { id: rejected }), false, `${provider}/${rejected} regex`);
    assert.equal(
      webSearchCapableFor(provider, { id: rejected, supportsWebSearch: true }),
      true,
      `${provider}/${rejected} true`
    );
    assert.equal(webSearchCapableFor(provider, { id: accepted }), true, `${provider}/${accepted} regex`);
    assert.equal(
      webSearchCapableFor(provider, { id: accepted, supportsWebSearch: false }),
      false,
      `${provider}/${accepted} false`
    );
  }
});

test('a web_search tool in any row tool list admits an id the regex rejects', () => {
  for (const [provider, , rejected] of FAMILIES) {
    for (const row of [
      { supportedTools: ['web_search'] },
      { tools: [{ type: 'web_search_preview' }] },
      { capabilities: { tools: [{ name: 'web_search' }] } },
    ]) {
      assert.equal(webSearchCapableFor(provider, { id: rejected, ...row }), true, `${provider}/${rejected}`);
    }
    assert.equal(webSearchCapableFor(provider, { id: rejected, supportedTools: [] }), false, provider);
  }
});

test('the provider catalog row decides before the id regex, and the route row before the catalog', () => {
  const rows = new Map();
  const catalogWebSearchCapableFor = makeWebSearchCapableFor(
    webSearchProviderFamily,
    (id, provider) => rows.get(`${provider}/${id}`) || null
  );
  for (const [provider, accepted, rejected] of FAMILIES) {
    rows.set(`${provider}/${rejected}`, { supportsWebSearch: true });
    rows.set(`${provider}/${accepted}`, { supportsWebSearch: false });
    assert.equal(catalogWebSearchCapableFor(provider, { id: rejected }), true, `${provider}/${rejected} catalog true`);
    assert.equal(catalogWebSearchCapableFor(provider, rejected), true, `${provider}/${rejected} bare id`);
    assert.equal(
      catalogWebSearchCapableFor(provider, { id: accepted }),
      false,
      `${provider}/${accepted} catalog false`
    );
    assert.equal(
      catalogWebSearchCapableFor(provider, { id: accepted, supportsWebSearch: true }),
      true,
      `${provider}/${accepted} route row wins`
    );
    assert.equal(
      catalogWebSearchCapableFor(provider, { id: rejected, supportsWebSearch: false }),
      false,
      `${provider}/${rejected} route row wins`
    );
  }
  rows.set('openai-oauth/gpt-6.1-sol', { supportedTools: ['web_search'] });
  assert.equal(catalogWebSearchCapableFor('openai-oauth', { id: 'gpt-6.1-sol' }), true);
});

test('a catalog silent on web search leaves the id fallback in charge', () => {
  const silent = makeWebSearchCapableFor(webSearchProviderFamily, () => ({ supportsVision: true }));
  assert.equal(silent('gemini', { id: 'gemini-3.8-flash' }), true);
  assert.equal(silent('gemini', { id: 'gemini-1.5-flash' }), false);
});

test('a catalog row outranks the id fallback for a future id, both ways', () => {
  const catalog = (supportsWebSearch) =>
    makeWebSearchCapableFor(webSearchProviderFamily, () => ({ supportsWebSearch }));
  assert.equal(catalog(false)('openai', { id: 'gpt-9.2-sol' }), false);
  assert.equal(catalog(true)('anthropic', { id: 'claude-3-opus' }), true);
});

test('fast mode follows a catalog declaration for a future id before any helper', async () => {
  assert.equal(fastCapableFor('openai', { id: 'gpt-9.2-sol', supportsFastMode: true }), true);
});
