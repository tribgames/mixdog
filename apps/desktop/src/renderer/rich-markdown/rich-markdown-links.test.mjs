import test from 'node:test';
import assert from 'node:assert/strict';
import { richMarkdownLinkTarget } from './rich-markdown-links.ts';

const PROJECT = 'C:/Project/notes';

test('local links resolve against the document folder, decoded exactly once', () => {
  const target = (href) => richMarkdownLinkTarget(href, PROJECT, 'docs/guide.md');
  assert.deepEqual(target('a%23b.md'), { kind: 'file', rel: 'docs/a#b.md' });
  assert.deepEqual(target('100%25.md'), { kind: 'file', rel: 'docs/100%.md' });
  assert.deepEqual(target('my%20notes.md#L3'), { kind: 'file', rel: 'docs/my notes.md', line: 3 });
  assert.deepEqual(target('../top.md'), { kind: 'file', rel: 'top.md' });
  assert.deepEqual(richMarkdownLinkTarget('a%23b.md', PROJECT, 'root.md'), { kind: 'file', rel: 'a#b.md' });
  assert.deepEqual(target('#Some%20Heading'), { kind: 'anchor', slug: 'Some%20Heading' });
  assert.deepEqual(target('https://example.com'), { kind: 'web', url: 'https://example.com' });
});
