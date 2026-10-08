import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWebSearchCapableFor } from './model-capabilities.mjs';
import { isWebSearchCapableProvider, webSearchProviderFamily } from './workflow.mjs';

const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily);

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
  assert.equal(webSearchCapableFor('cursor-oauth', { id: 'gpt-5', supportsWebSearch: true }), false);
});
