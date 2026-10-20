import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightMentions } from './markdown-mentions.ts';

const text = (value) => ({ type: 'text', value });
const el = (tagName, ...children) => ({ type: 'element', tagName, properties: {}, children });
const root = (...children) => ({ type: 'root', children });
const pills = (node, out = []) => {
  if (node.type === 'element' && node.properties?.className?.includes('agent-room-mention')) {
    out.push(node.children[0].value);
  }
  for (const child of node.children ?? []) pills(child, out);
  return out;
};

test('member mentions are wrapped, case-insensitively and by whole token', () => {
  const tree = root(el('p', text('hi @Bobo and @mixy, not @Bobot or a@bobo or @Zed')));
  assert.deepEqual(pills(highlightMentions(tree, ['Bobo', 'Mixy'])), ['@Bobo', '@mixy']);
});

test('code, pre and links are untouched', () => {
  const tree = root(el('p', el('code', text('@Bobo')), el('a', text('@Bobo'))), el('pre', el('code', text('@Bobo'))));
  const out = highlightMentions(tree, ['Bobo']);
  assert.equal(out, tree);
  assert.deepEqual(pills(out), []);
});

test('no members leaves the tree as is', () => {
  const tree = root(el('p', text('@Bobo')));
  assert.equal(highlightMentions(tree, []), tree);
});
