import test from 'node:test';
import assert from 'node:assert/strict';
import { containerInner, elementSpans, textNodes, topLevelElements } from './portable-xml.mjs';

test('text nodes preserve source spans, attributes, escaping, and empty runs', () => {
  const first = '<w:t xml:space="preserve"> A&amp;B </w:t>';
  const empty = '<w:t></w:t>';
  const xml = `${first}<w:br/>${empty}`;
  assert.deepEqual(textNodes(xml, 'w:t'), [
    { start: 0, end: first.length, attrs: ' xml:space="preserve"', text: ' A&B ' },
    { start: first.length + 7, end: xml.length, attrs: '', text: '' },
  ]);
  assert.deepEqual(textNodes('<w:t/>', 'w:t'), []);
});

test('top-level elements exclude nested matches and retain self-closing siblings in source order', () => {
  const nested = '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>';
  const paragraph = '<w:p><w:r/></w:p>';
  const fragment = `${nested}${paragraph}<w:p/>`;
  assert.deepEqual(topLevelElements(fragment, ['w:p']), [
    { name: 'w:p', start: nested.length, end: nested.length + paragraph.length, xml: paragraph },
    { name: 'w:p', start: nested.length + paragraph.length, end: fragment.length, xml: '<w:p/>' },
  ]);
  assert.deepEqual(topLevelElements('<w:p>', ['w:p']), []);
});

test('container lookup skips empty siblings, balances nested containers, and respects the starting offset', () => {
  const inner = 'a<w:p>b</w:p><w:p/>c';
  const first = `<w:p/>x<w:p>${inner}</w:p>`;
  const xml = `${first}<w:p>last</w:p>`;
  assert.deepEqual(containerInner(xml, 'w:p'), { start: 12, end: 12 + inner.length, inner });
  assert.deepEqual(containerInner(xml, 'w:p', first.length), {
    start: first.length + 5,
    end: first.length + 9,
    inner: 'last',
  });
  assert.equal(containerInner('<w:p/>', 'w:p'), null);
  assert.equal(containerInner('<w:p>unclosed', 'w:p'), null);
});

test('element spans preserve attributes and both empty and paired elements without matching longer names', () => {
  const first = '<c r="A1"/>';
  const second = '<c r="B1"><v>7</v></c>';
  const fragment = `${first}${second}<cols/>`;
  assert.deepEqual(elementSpans(fragment, 'c'), [
    { start: 0, end: first.length, attrs: ' r="A1"', xml: first },
    { start: first.length, end: first.length + second.length, attrs: ' r="B1"', xml: second },
  ]);
  assert.deepEqual(elementSpans('<c>unclosed', 'c'), []);
});
