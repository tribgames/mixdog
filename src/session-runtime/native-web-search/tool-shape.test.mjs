import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeWebSearchTool } from './tool-shape.mjs';

test('a site filter naming several domains allows each domain on every provider shape', () => {
  const site = 'docs.claude.com OR platform.claude.com OR anthropic.com';
  const domains = ['docs.claude.com', 'platform.claude.com', 'anthropic.com'];
  assert.deepEqual(nativeWebSearchTool({ site }, 'web_search', 'xai').filters, { allowed_domains: domains });
  assert.deepEqual(nativeWebSearchTool({ site }, 'web_search', 'anthropic').allowed_domains, domains);
  assert.deepEqual(nativeWebSearchTool({ site }, 'web_search', 'openai').filters, { allowed_domains: domains });
  assert.deepEqual(
    nativeWebSearchTool(
      { site: 'site:docs.claude.com, https://anthropic.com/news | docs.claude.com' },
      'web_search',
      'xai'
    ).filters,
    { allowed_domains: ['docs.claude.com', 'anthropic.com'] }
  );
});

test('a single site keeps one allowed domain and no site adds no filter', () => {
  assert.deepEqual(
    nativeWebSearchTool({ site: 'https://Example.com/docs' }, 'web_search', 'anthropic').allowed_domains,
    ['example.com']
  );
  assert.equal(nativeWebSearchTool({}, 'web_search', 'xai').filters, undefined);
});
